// Local owns the physical serial port and its configuration.
let ws = null;
let localId = '';
let port = null;
let reader = null;
let writer = null;
let isOpen = false;
let isOpening = false;
let registered = false;
let writeChain = Promise.resolve();
let pendingWrites = 0;
let readTask = null;
let idRetries = 0;
let shareEnabled = false;
let isClosing = false;
const AUTO_ACCEPT_STORAGE_KEY = 'shareserial.local.autoAccept.v1';
function loadAutoAcceptPreference() {
    try { return globalThis.localStorage?.getItem(AUTO_ACCEPT_STORAGE_KEY) === 'true'; }
    catch { return false; }
}
function saveAutoAcceptPreference(value) {
    try { globalThis.localStorage?.setItem(AUTO_ACCEPT_STORAGE_KEY, value ? 'true' : 'false'); }
    catch { /* Local storage can be unavailable in restricted browser profiles. */ }
}
let autoAccept = loadAutoAcceptPreference();
let reconnectAttempts = 0;
let noticeVersion = 0;
let remoteWritesPaused = false, remoteWriteGeneration = 0, writeEpoch = 0;
let writeStatePending = null, writeStateSequence = 0, writeSequence = 0;
const MAX_PENDING_WRITES = 256;
const MAX_RX_REPLAY_IN_FLIGHT = 8;
const MAX_RX_REPLAY_SOCKET_BACKLOG = 256 * 1024;
let rxReplayBuffer = null, rxReplayEnabled = false;
let registrationRXSeq = 0;
const rxReplayTransfers = new Map();
let flashSession = null;
const cancelledSignalRequests = new Map();
const RESOURCE_LIMIT_MESSAGES = {
    daily_quota_exceeded: '公共共享服务的当日流量额度已用尽，共享已停止。',
    message_rate_limited: '共享消息过于频繁，共享已停止，请降低数据频率后重试。',
    connection_rate_limited: '开启共享或连接申请过于频繁，共享已停止，请稍后重试。',
    bandwidth_limited: '共享流量达到服务上限，共享已停止，请降低数据速率或减少远端。',
    send_queue_limited: '共享数据积压超过上限，共享已停止，请检查网络和接收端。'
};
const connectedRemotes = new Map();
const pendingRequests = new Map();
const serialPeers = new Map();
const periodicSender = new SerialTools.PeriodicSender({setTimer:setTimeout,clearTimer:clearTimeout,onChange:(running,reason)=>{
    updateState();
    if (!running && reason !== 'settled') log('定时发送已停止');
}});
let peerWriteGeneration = -1;
let serialP2PEnabled = false;

function closeSerialPeers() {
    for (const peer of serialPeers.values()) peer.close();
    serialPeers.clear(); serialP2PEnabled = false;
}
function addSerialPeer(message) {
    const remote = connectedRemotes.get(message.remoteId);
    if (!serialP2PEnabled || message.serialP2PProtocol !== 1) {
        if (remote) remote.p2pDiagnostic = {reason:globalThis.SerialP2P?.supported() ? 'peer_unsupported' : 'webrtc_unavailable', configuration:globalThis.SerialP2P?.configuration().configuration};
        log('Remote ' + message.remoteId + '：P2P 未协商，使用中转；请检查两侧页面版本和浏览器支持。');
        return;
    }
    const socket = ws, id = localId;
    let peer, diagnosticEventKey = '';
    peer = new SerialP2P.Peer({ role: 'local', localId: id, remoteId: message.remoteId,
        canAssess: () => !flashSession && !serialConfigPending && !readSuspended && !pendingWrites && !periodicSender.running && !rxReplayTransfers.size,
        retryProtocol: message.serialP2PRetryProtocol,
        txRelayProtocol: message.serialP2PTXRelayProtocol,
        portId: message.portId, grantId: message.grantId,
        sendWS: value => socket.send(JSON.stringify(value)),
        valid: () => registered && shareEnabled && isOpen && ws === socket && socket.readyState === WebSocket.OPEN &&
            connectedRemotes.get(message.remoteId)?.grantId === message.grantId,
        canTX: epoch => canWrite(message.remoteId, message.portId, message.grantId, epoch),
        deliverTX: value => handleServerMessage(value), deliverRX: () => {},
        onDiagnostic: value => {
            if (connectedRemotes.get(message.remoteId)?.grantId !== message.grantId) return;
            remote.p2pDiagnostic = value;
            const key = value.phase+'|'+value.reason;
            if (SerialP2P.diagnosticEvent(value) && key !== diagnosticEventKey) { diagnosticEventKey = key; log('Remote '+message.remoteId+'：'+SerialP2P.describe(value)); }
            updateRemoteList();
        },
        onState: () => updateRemoteList(), onError: value => log('Remote ' + message.remoteId + '：' + value) });
    serialPeers.set(message.remoteId, peer);
}

const elements = {};
for (const id of ['localId', 'copyBtn', 'wsDot', 'wsStatus', 'portSelect', 'refreshBtn',
    'openPortBtn', 'closePortBtn', 'remoteList', 'pendingList', 'logContent', 'errorMessage', 'successMessage',
    'baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'shareBtn', 'sharingState', 'autoAccept',
    'portState', 'sendInput', 'sendBtn', 'hexSend', 'lineEnding', 'takeControlBtn', 'controlOwner', 'writeStatus',
    'rxCount', 'txCount', 'clearCountsBtn', 'periodicInterval', 'periodicSendBtn', 'periodicStatus', 'lastActivity', 'logFilter', 'hexModeBtn', 'pauseLogBtn', 'clearLogBtn', 'exportLogBtn', 'exportSystemLogBtn',
    'pendingCount', 'remoteCount']) {
    elements[id] = document.getElementById(id);
}

window.addEventListener('DOMContentLoaded', () => {
    if (!navigator.serial || !window.isSecureContext) {
        showError('共享串口需要支持 Web Serial API 的桌面浏览器和可信 HTTPS 环境。');
        return;
    }
    elements.refreshBtn.addEventListener('click', refreshPorts);
    elements.openPortBtn.addEventListener('click', openPort);
    elements.closePortBtn.addEventListener('click', closePort);
    elements.copyBtn.addEventListener('click', copyId);
    elements.shareBtn.addEventListener('click', () => shareEnabled ? stopSharing() : startSharing());
    elements.autoAccept.checked = autoAccept;
    elements.sendBtn.addEventListener('click', sendLocalData);
    elements.sendInput.addEventListener('keydown', event => { if (event.key === 'Enter') sendLocalData(); });
    elements.takeControlBtn.addEventListener('click', toggleRemoteWrites);
    elements.autoAccept.addEventListener('change', () => {
        autoAccept = elements.autoAccept.checked;
        elements.autoAccept.checked = autoAccept;
        saveAutoAcceptPreference(autoAccept);
        log('自动接受申请已' + (autoAccept ? '开启；多个获批发送端与本机统一排队。' : '关闭。'));
        processAutoRequests();
    });
    elements.logFilter.addEventListener('change', redrawLog);
    elements.hexModeBtn.addEventListener('click', () => { hexDisplay = !hexDisplay; elements.hexModeBtn.textContent = hexDisplay ? '文本显示' : 'HEX 显示'; redrawLog(); });
    elements.pauseLogBtn.addEventListener('click', () => { followLog = !followLog; elements.pauseLogBtn.textContent = followLog ? '暂停滚动' : '继续滚动'; if (followLog) scrollLog(); });
    elements.clearLogBtn.addEventListener('click', clearLog);
    elements.clearCountsBtn.addEventListener('click', clearCounts);
    elements.exportSystemLogBtn.addEventListener('click', exportSystemLog);
    elements.periodicSendBtn.addEventListener('click', togglePeriodicSend);
    elements.exportLogBtn.addEventListener('click', exportLog);
    updateState();
});

function showError(message) {
    noticeVersion++;
    elements.successMessage.classList.add('hidden');
    elements.errorMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.errorMessage.classList.remove('hidden');
    log(message);
}
function showSuccess(message, persistent = false) {
    const version = ++noticeVersion;
    elements.errorMessage.classList.add('hidden');
    elements.successMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.successMessage.classList.remove('hidden');
    if (!persistent) setTimeout(() => { if (noticeVersion === version) elements.successMessage.classList.add('hidden'); }, 3000);
}
function log(message) {
    retainRecord({ kind: 'EVENT', text: globalThis.ShareSerialI18n?.text(message) ?? message }, eventRecords, 500);
}

function connectWebSocket() {
    log('正在连接服务器');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.host + '/ws/local');
    ws = socket;
    socket.onopen = () => {
        if (ws !== socket) return;
        elements.wsDot.classList.replace('disconnected', 'connected');
        elements.wsStatus.textContent = '已连接服务器';
        log('已连接服务器' + (isOpen ? '，正在用原连接 ID ' + localId + ' 重新注册；远程端需要重新申请授权。' : ''));
        // Reuse the existing ID when reconnecting an open physical port.
        if (isOpen && shareEnabled) registerPort();
        updateState();
    };
    socket.onmessage = event => {
        if (ws !== socket) return;
        try { handleServerMessage(JSON.parse(event.data)); }
        catch (error) { showError('处理服务器消息失败：' + error.message); }
    };
    socket.onclose = event => {
        if (ws !== socket) return;
        closeSerialPeers();
        registered = false;
        rxReplayEnabled = false;
        for (const transfer of rxReplayTransfers.values()) if (transfer.retryTimer) clearTimeout(transfer.retryTimer);
        rxReplayTransfers.clear();
        cancelLocalConfiguration('local_disconnected', true);
        remoteWriteGeneration++;
        flashSession = null;
        writeStatePending = null;
        connectedRemotes.clear();
        pendingRequests.clear();
        updatePendingList();
        updateRemoteList();
        elements.wsDot.classList.replace('connected', 'disconnected');
        if (event?.code === 4008 && shareEnabled) {
            haltForResourceLimit(event.reason);
        }
        const reconnectDelay = Math.min(3000 * 2 ** Math.min(reconnectAttempts++, 4), 30000);
        elements.wsStatus.textContent = shareEnabled ? '连接断开，正在重连' : '未共享';
        log('服务器连接已断开（代码 ' + (event?.code ?? 1006) + '），' + (shareEnabled ? reconnectDelay / 1000 + ' 秒后重连。' : '共享已停止。') +
            (isOpen ? '串口仍打开，远程授权已清除。' : ''));
        updateState();
        if (shareEnabled) setTimeout(() => { if (shareEnabled && ws === socket) connectWebSocket(); }, reconnectDelay);
    };
    socket.onerror = () => { if (ws === socket) log('共享连接失败，可能网络异常或服务已达连接上限；本机收发不受影响。'); };
}

function haltForResourceLimit(code) {
    closeSerialPeers();
    cancelLocalConfiguration('local_disconnected', true);
    remoteWriteGeneration++;
    flashSession = null;
    writeStatePending = null;
    shareEnabled = false;
    registered = false;
    resetRXReplay();
    autoAccept = false;
    elements.autoAccept.checked = false;
    saveAutoAcceptPreference(false);
    connectedRemotes.clear();
    pendingRequests.clear();
    updatePendingList();
    updateRemoteList();
    showError(RESOURCE_LIMIT_MESSAGES[code] || '共享服务资源达到上限，共享已停止。');
    updateState();
}

function startSharing() {
    if (serialConfigTask || readSuspended) { showError('请等待串口参数修改完成'); return; }
    if (!isOpen || isClosing) { showError('请先打开串口'); return; }
    shareEnabled = true;
    rxReplayBuffer = RxReplay.create();
    rxReplayEnabled = false;
    rxReplayTransfers.clear();
    reconnectAttempts = 0;
    if (!localId) { localId = generateLocalId(); idRetries = 0; }
    updateState();
    if (ws && ws.readyState === WebSocket.OPEN) registerPort();
    else if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === 3) connectWebSocket();
}

function stopSharing() {
    closeSerialPeers();
    cancelLocalConfiguration('configuration_cancelled', true);
    remoteWriteGeneration++;
    flashSession = null;
    remoteWritesPaused = false;
    writeStatePending = null;
    writeEpoch = 0;
    shareEnabled = false;
    registered = false;
    resetRXReplay();
    connectedRemotes.clear();
    pendingRequests.clear();
    if (ws && ws.readyState === WebSocket.OPEN && localId) {
        ws.send(JSON.stringify({ type: 'unregister' }));
    }
    const socket = ws;
    ws = null;
    if (socket) socket.close();
    elements.wsDot.classList.replace('connected', 'disconnected');
    elements.wsStatus.textContent = '未共享';
    localId = '';
    updatePendingList();
    updateRemoteList();
    updateState();
    log('已停止远程共享，本机串口仍可独立收发。');
}

function resetRXReplay() {
    rxReplayBuffer = null;
    rxReplayEnabled = false;
    for (const transfer of rxReplayTransfers.values()) if (transfer.retryTimer) clearTimeout(transfer.retryTimer);
    rxReplayTransfers.clear();
}

function registerPort() {
    if (serialConfigTask || readSuspended) return;
    if (!isOpen || !shareEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    registered = false;
    registrationRXSeq = rxReplayBuffer?.sequence || 0;
    ws.send(JSON.stringify({
        type: 'register', localId, version: 3, paused: remoteWritesPaused,
        serialP2PProtocol: globalThis.SerialP2P?.supported() ? 1 : 0,
        serialP2PRetryProtocol: globalThis.SerialP2P?.supported() ? 1 : 0,
        serialP2PTXRelayProtocol: globalThis.SerialP2P?.supported() ? 1 : 0,
        ...(rxReplayBuffer ? { rxReplayProtocol: 1, rxStreamId: rxReplayBuffer.streamId, rxSeq: registrationRXSeq } : {}),
        ...(SerialConfig.valid(activeSerialConfig) ? { configProtocol: 1, serialConfig: activeSerialConfig } : {}),
        serialSignalsProtocol: typeof port?.setSignals === 'function' ? 1 : 0,
        flashProtocol: typeof port?.setSignals === 'function' && SerialConfig.valid(activeSerialConfig) ? 1 : 0,
        ports: [{ portId: elements.portSelect.value, name: elements.portSelect.options[0].textContent }]
    }));
}

function handleServerMessage(message) {
    if (message.type.startsWith('p2p_serial_')) { serialPeers.get(message.remoteId)?.handle(message); return; }
    switch (message.type) {
        case 'register':
            if (!isOpen || !shareEnabled || message.localId !== localId) return;
            if (message.version !== 3 || typeof message.paused !== 'boolean' || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < 1) {
                registered = false;
                showError('服务端不支持连接授权，请同时更新服务端与浏览器页面。');
                ws.send(JSON.stringify({ type: 'unregister' }));
                return;
            }
            registered = true;
            serialP2PEnabled = message.serialP2PProtocol === 1 && globalThis.SerialP2P?.supported();
            rxReplayEnabled = message.rxReplayProtocol === 1 && message.rxStreamId === rxReplayBuffer?.streamId &&
                (Number.isSafeInteger(message.rxSeq) || message.rxSeq === undefined) && (message.rxSeq ?? 0) === registrationRXSeq;
            if (rxReplayEnabled && rxReplayBuffer.sequence > (message.rxSeq ?? 0)) {
                ws.send(JSON.stringify({ type: 'rx_head', portId: elements.portSelect.value,
                    rxStreamId: rxReplayBuffer.streamId, rxSeq: rxReplayBuffer.sequence }));
            }
            writeEpoch = message.writeEpoch;
            remoteWritesPaused = message.paused;
            writeStatePending = null;
            if (message.configProtocol === 1) receiveSerialState(message);
            reconnectAttempts = 0;
            idRetries = 0;
            elements.localId.textContent = message.localId;
            log('服务器已确认共享，连接 ID：' + message.localId);
            showSuccess('串口已共享');
            updateState();
            break;
        case 'unregister':
            break;
        case 'remote_connected':
            if (!isOpen || !registered) return;
            const approved = pendingRequests.get(message.requestId);
            if (!approved || message.grantId !== message.requestId || !['read', 'control'].includes(approved.decision) || approved.remoteId !== message.remoteId || approved.portId !== message.portId || approved.decision !== message.access) return;
            pendingRequests.delete(message.requestId);
            updatePendingList();
            connectedRemotes.set(message.remoteId, { portId: message.portId, access: message.access, grantId: message.grantId });
            addSerialPeer(message);
            updateRemoteList();
            log('远程端已连接：' + message.remoteId);
            break;
        case 'remote_disconnected':
            serialPeers.get(message.remoteId)?.close(); serialPeers.delete(message.remoteId);
            cancelRXReplayTransfer(message.remoteId);
            connectedRemotes.delete(message.remoteId);
            updateRemoteList();
            log('远程端已断开：' + message.remoteId);
            processAutoRequests();
            break;
        case 'connection_request':
            if (!isOpen || !registered || message.localId !== localId || message.portId !== elements.portSelect.value) return;
            pendingRequests.set(message.requestId, message);
            updatePendingList();
            processAutoRequests();
            break;
        case 'resume_rx':
            beginRXReplay(message);
            break;
        case 'rx_ack':
            acknowledgeRXReplay(message);
            break;
        case 'request_cancelled':
            pendingRequests.delete(message.requestId);
            updatePendingList();
            processAutoRequests();
            break;
        case 'send':
            if (!writer || !isOpen) return;
            if (!canWrite(message.remoteId, message.portId, message.grantId, message.writeEpoch, message.flashSessionId)) return;
            if (pendingWrites >= 256) {
                showError('串口写入积压，共享连接将重新建立。');
                ws.close(1013, 'Serial writer busy');
                return;
            }
            enqueueWrite(SerialData.fromBase64(message.data), 'Remote ' + message.remoteId, message);
            break;
        case 'flash_state':
            receiveFlashState(message);
            break;
        case 'begin_flash':
            beginFlashSession(message);
            break;
        case 'end_flash':
            endFlashSession(message);
            break;
        case 'set_serial_signals':
            enqueueRemoteSignals(message);
            break;
        case 'cancel_serial_signals':
            rememberCancelledSignal(message.requestId);
            break;
        case 'write_state':
            if (!registered || !writeStatePending || message.requestId !== writeStatePending.requestId || message.localId !== localId || message.version !== 3 || typeof message.paused !== 'boolean' || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch <= writeEpoch) return;
            if (message.paused !== writeStatePending.paused) return;
            writeEpoch = message.writeEpoch;
            remoteWritesPaused = message.paused;
            writeStatePending = null;
            log(remoteWritesPaused ? '远端发送已暂停，连接和接收保留；本机可继续发送。' : '远端发送已恢复；暂停前的旧命令不会重放。');
            updateRemoteList();
            break;
        case 'serial_config_state':
            receiveSerialState(message);
            break;
        case 'set_serial_config':
            beginSerialConfiguration(message);
            break;
        case 'cancel_serial_config':
            if (serialConfigPending?.id === message.configId) cancelLocalConfiguration(message.code);
            break;
        case 'sharing_stopped':
            cancelLocalConfiguration(message.code, true);
            stopSharing();
            showError('串口参数修改失败或超时，共享已停止，请检查设备和当前参数。');
            break;
        case 'error':
            if (message.code === 'p2p_not_authorized' && message.grantId && message.remoteId &&
                connectedRemotes.get(message.remoteId)?.grantId !== message.grantId) return;
            if (writeStatePending && message.requestId === writeStatePending.requestId) writeStatePending = null;
            if (RESOURCE_LIMIT_MESSAGES[message.code]) { haltForResourceLimit(message.code); return; }
            if (pendingRequests.has(message.requestId)) {
                delete pendingRequests.get(message.requestId).decision;
                updatePendingList();
            }
            if (message.code === 'local_id_in_use' && isOpen && shareEnabled && idRetries++ < 5) {
                const previousId = localId;
                localId = generateLocalId();
                log('原连接 ID ' + previousId + ' 被服务器判定占用，尝试新 ID ' + localId + '；等待服务器确认。');
                registerPort();
            } else {
                showError({
                    too_many_remotes: '已授权连接已达上限，请先撤销不需要的连接。',
                    request_not_found: '该申请已结束，请让远程端重新申请。',
                    request_expired: '该申请已过期。',
                    permission_denied: '无法批准或撤销该连接。',
                    protocol_mismatch: '请刷新 Local、Remote 页面，并使用协议 v3 服务端。'
                }[message.code] || message.error);
            }
            updateState();
            break;
    }
}

function canWrite(remoteId, portId, grantId, epoch, flashSessionId = '') {
    if (serialConfigPending || readSuspended) return false;
    const remote = connectedRemotes.get(remoteId);
    if (flashSession?.starting) {
        if (flashSessionId) return false;
    } else if (flashSession ? flashSession.id !== flashSessionId || flashSession.ownerRemoteId !== remoteId : !!flashSessionId) return false;
    return registered && !remoteWritesPaused && !writeStatePending && remote?.access === 'control' &&
        !!grantId && grantId === remote.grantId && epoch === writeEpoch && remote.portId === portId && portId === elements.portSelect.value;
}

function receiveFlashState(message) {
    if (!registered || message.localId !== localId || message.portId !== elements.portSelect.value ||
        message.version !== 3 || typeof message.flashActive !== 'boolean' ||
        !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < writeEpoch || typeof message.paused !== 'boolean') return;
    if (message.flashActive && (!message.flashSessionId || !message.flashOwnerId)) return;
    const previous = flashSession;
    const wasActive = !!previous;
    remoteWritesPaused = message.paused;
    const starting = !!message.flashStarting;
    const ending = !!message.flashEnding;
    if (message.flashActive && starting) {
        flashSession = { id: message.flashSessionId, ownerRemoteId: message.flashOwnerId, starting: true,
            ending: false, previousEpoch: previous?.previousEpoch ?? writeEpoch, pendingEpoch: message.writeEpoch };
    } else if (message.flashActive && ending) {
        flashSession = { id: message.flashSessionId, ownerRemoteId: message.flashOwnerId, starting: false,
            ending: true, previousEpoch: previous?.previousEpoch ?? writeEpoch, pendingEpoch: previous?.pendingEpoch };
    } else {
        writeEpoch = message.writeEpoch;
        flashSession = message.flashActive ? { id: message.flashSessionId, ownerRemoteId: message.flashOwnerId,
            starting: false, ending: false } : null;
        remoteWriteGeneration++;
    }
    if (flashSession && !wasActive) log('Remote ' + flashSession.ownerRemoteId + ' 正在申请独占串口进行 ESP32 烧录；本机与其他远端发送暂时停用。');
    else if (!flashSession && wasActive) log('ESP32 烧录串口锁已释放；本机与获批远端发送已恢复。');
    updateRemoteList();
    updateState();
}

function flashMessageAuthorized(message) {
    const remote = connectedRemotes.get(message.remoteId);
    return flashSession && flashSession.id === message.flashSessionId && flashSession.ownerRemoteId === message.remoteId &&
        registered && isOpen && !remoteWritesPaused && !writeStatePending && message.writeEpoch === writeEpoch &&
        message.localId === localId && message.portId === elements.portSelect.value &&
        remote?.access === 'control' && remote.grantId === message.grantId && remote.portId === message.portId;
}

function sendFlashResult(message, success, code = '') {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'flash_result', requestId: message.requestId, flashSessionId: message.flashSessionId,
        localId: message.localId, remoteId: message.remoteId, portId: message.portId, grantId: message.grantId,
        writeEpoch: message.writeEpoch, success, code }));
}

function rememberCancelledSignal(requestId) {
    if (!requestId) return;
    const now = Date.now();
    for (const [id, expiresAt] of cancelledSignalRequests) if (expiresAt <= now) cancelledSignalRequests.delete(id);
    while (cancelledSignalRequests.size >= 64) cancelledSignalRequests.delete(cancelledSignalRequests.keys().next().value);
    cancelledSignalRequests.set(requestId, now + 30000);
}

function beginFlashSession(message) {
    const remote = connectedRemotes.get(message.remoteId);
    const valid = registered && isOpen && !isClosing && !serialConfigTask && !readSuspended &&
        flashSession?.id === message.flashSessionId && flashSession.ownerRemoteId === message.remoteId && flashSession.starting &&
        message.localId === localId && message.portId === elements.portSelect.value && message.writeEpoch === flashSession.pendingEpoch &&
        remote?.access === 'control' && remote.grantId === message.grantId && remote.portId === message.portId &&
        !remoteWritesPaused && typeof port?.setSignals === 'function';
    if (!valid) {
        sendFlashResult(message, false, 'flash_unsupported');
        log('Remote ESP32 烧录未能锁定串口：串口状态或控制信号能力无效。');
        return;
    }
    const sessionId = message.flashSessionId;
    const queuedWrites = writeChain;
    queuedWrites.then(() => {
        if (!flashSession || flashSession.id !== sessionId || !flashSession.starting) return;
        if (pendingWrites !== 0 || !registered || !isOpen || remoteWritesPaused ||
            connectedRemotes.get(message.remoteId)?.grantId !== message.grantId || message.writeEpoch !== flashSession.pendingEpoch) {
            sendFlashResult(message, false, 'serial_busy');
            return;
        }
        flashSession.starting = false;
        flashSession.pendingEpoch = undefined;
        writeEpoch = message.writeEpoch;
        remoteWriteGeneration++;
        log('串口已锁定给 Remote ' + message.remoteId + '，普通本机及远端发送已暂停。');
        sendFlashResult(message, true);
        updateState();
    });
}

function endFlashSession(message) {
    if (!flashMessageAuthorized(message) || !flashSession || flashSession.ending) {
        sendFlashResult(message, false, 'stale_flash_session');
        return;
    }
    const sessionId = flashSession.id;
    flashSession.ending = true;
    writeChain.then(() => {
        if (!flashSession || flashSession.id !== sessionId) return;
        log('Remote 烧录操作已结束，正在释放串口锁。');
        sendFlashResult(message, true);
    });
}

function enqueueRemoteSignals(message) {
    if (!flashMessageAuthorized(message) || typeof port?.setSignals !== 'function' ||
        (message.dataTerminalReady === undefined && message.requestToSend === undefined)) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'serial_signals_result',
            requestId: message.requestId, flashSessionId: message.flashSessionId, portId: message.portId,
            grantId: message.grantId, writeEpoch: message.writeEpoch, success: false, code: 'signals_unsupported' }));
        return;
    }
    if (pendingWrites >= MAX_PENDING_WRITES) {
        ws.send(JSON.stringify({ type: 'serial_signals_result', requestId: message.requestId,
            flashSessionId: message.flashSessionId, portId: message.portId, grantId: message.grantId,
            writeEpoch: message.writeEpoch, success: false, code: 'serial_busy' }));
        return;
    }
    const generation = remoteWriteGeneration;
    pendingWrites++;
    writeChain = writeChain.then(async () => {
        if (cancelledSignalRequests.delete(message.requestId) || generation !== remoteWriteGeneration || !flashMessageAuthorized(message)) {
            throw new Error('stale_flash_session');
        }
        const signals = {};
        if (typeof message.dataTerminalReady === 'boolean') signals.dataTerminalReady = message.dataTerminalReady;
        if (typeof message.requestToSend === 'boolean') signals.requestToSend = message.requestToSend;
        await port.setSignals(signals);
    }).then(() => sendSerialSignalsResult(message, true), error => {
        sendSerialSignalsResult(message, false, error?.message === 'stale_flash_session' ? error.message : 'signals_failed');
    }).finally(() => { pendingWrites--; updateState(); });
    updateState();
}

function sendSerialSignalsResult(message, success, code = '') {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'serial_signals_result',
        requestId: message.requestId, flashSessionId: message.flashSessionId, portId: message.portId,
        grantId: message.grantId, writeEpoch: message.writeEpoch, success, code }));
}

function decideRequest(requestId, access) {
    if (!pendingRequests.has(requestId) || !registered || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (pendingRequests.get(requestId).decision !== undefined) return;
    pendingRequests.get(requestId).decision = access;
    ws.send(JSON.stringify(access ? { type: 'approve', requestId, access } : { type: 'reject', requestId }));
    updatePendingList();
}

function processAutoRequests() {
    if (!autoAccept || !registered) return;
    for (const [id, request] of pendingRequests) {
        if (request.decision !== undefined || request.autoTried) continue;
        request.autoTried = true;
        decideRequest(id, request.access);
    }
}

function toggleRemoteWrites() {
    if (!registered || !ws || ws.readyState !== WebSocket.OPEN || writeStatePending) return;
    const paused = !remoteWritesPaused;
    if (paused) cancelLocalConfiguration('writes_paused');
    remoteWriteGeneration++;
    remoteWritesPaused = true;
    autoAccept = false;
    elements.autoAccept.checked = false;
    saveAutoAcceptPreference(false);
    writeStatePending = { requestId: 'write-state-' + (++writeStateSequence), paused };
    ws.send(JSON.stringify({ type: 'set_write_state', version: 3, ...writeStatePending }));
    updateRemoteList();
    log(paused ? '已立即暂停远端写入并关闭自动接受；在途字节不能撤回。' : '正在请求恢复远端写入，等待服务器确认。');
}

function revokeRemote(remoteId) {
    serialPeers.get(remoteId)?.close(); serialPeers.delete(remoteId);
    if (serialConfigPending && (!serialConfigPending.remoteId || serialConfigPending.remoteId === remoteId)) cancelLocalConfiguration('permission_revoked');
    if (connectedRemotes.get(remoteId)?.access === 'control') {
        autoAccept = false;
        elements.autoAccept.checked = false;
        saveAutoAcceptPreference(false);
    }
    connectedRemotes.delete(remoteId);
    updateRemoteList();
    log('已撤销远程端授权：' + remoteId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'revoke', remoteId }));
}

function canLocalWrite() {
    return isOpen && !isClosing && !!writer && !serialConfigPending && !readSuspended && !flashSession;
}

function enqueueWrite(data, source, remote = null, stillValid = () => true) {
    const bytes = new Uint8Array(data);
    if (!bytes.length || bytes.length > SerialData.MAX_SEND_BYTES || pendingWrites >= MAX_PENDING_WRITES) throw new Error('串口写入队列或单次数据超出上限');
    const activeWriter = writer, generation = remoteWriteGeneration, order = ++writeSequence;
    const grant = remote ? { remoteId: remote.remoteId, portId: remote.portId, grantId: remote.grantId,
        epoch: remote.writeEpoch, flashSessionId: remote.flashSessionId || '' } : null;
    pendingWrites++;
    writeChain = writeChain.then(async () => {
        if (!isOpen || isClosing || writer !== activeWriter) return;
        if (!stillValid()) return;
        if (grant && (generation !== remoteWriteGeneration || !canWrite(grant.remoteId, grant.portId, grant.grantId, grant.epoch, grant.flashSessionId))) {
            log('已跳过发送 #' + order + ' ' + source + '：授权或远端发送状态已变化。');
            return;
        }
        await activeWriter.write(bytes);
        recordSerial('TX', bytes, source, order);
        return true;
    }).catch(error => showError('串口写入失败 #' + order + ' ' + source + '：' + error.message))
      .finally(() => { pendingWrites--; updateState(); });
    updateState();
    return writeChain;
}

function localSendBytes() {
    if (!elements.sendInput.value) throw new Error('请输入发送内容');
    const bytes = SerialData.parseSendInput(elements.sendInput.value, elements.hexSend.checked, false);
    const suffix = { none: [], cr: [13], lf: [10], crlf: [13, 10] }[elements.lineEnding.value || 'none'];
    if (!suffix || bytes.length + suffix.length > SerialData.MAX_SEND_BYTES) throw new Error('单次发送最多 16 KiB（含行尾）');
    const payload = new Uint8Array(bytes.length + suffix.length);
    payload.set(bytes); payload.set(suffix, bytes.length); return payload;
}

function togglePeriodicSend() {
    if (periodicSender.running) { periodicSender.stop(); return; }
    try {
        const payload = localSendBytes(), activeWriter = writer;
        periodicSender.start(elements.periodicInterval.value,
            current => enqueueWrite(payload, '本机定时', null, current),
            () => canLocalWrite() && writer === activeWriter);
    } catch (error) { showError(error.message); }
}

function sendLocalData() {
    if (!canLocalWrite()) { showError('请先打开串口'); return; }
    if (!elements.sendInput.value) return;
    if (pendingWrites >= MAX_PENDING_WRITES) { showError('串口写入队列已满，请等待当前发送完成。'); return; }
    try {
        return enqueueWrite(localSendBytes(), '本机');
    } catch (error) { showError(error.message); }
}

function updatePendingList() {
    elements.pendingCount.textContent = String(pendingRequests.size);
    elements.pendingList.replaceChildren();
    if (!pendingRequests.size) {
        const item = document.createElement('li');
        item.className = 'empty-state';
        item.textContent = '暂无连接申请';
        elements.pendingList.appendChild(item);
    }
    for (const [requestId, request] of pendingRequests) {
        const item = document.createElement('li');
        item.className = 'remote-item';
        const label = document.createElement('span');
        label.textContent = 'Remote ' + request.remoteId + ' 申请' + (request.access === 'control' ? '完全控制' : '只读') + '（60 秒内有效）';
        item.appendChild(label);
        const choices = request.access === 'control'
            ? [['允许只读', 'read'], ['允许控制', 'control'], ['拒绝', null]]
            : [['允许只读', 'read'], ['拒绝', null]];
        for (const [text, access] of choices) {
            const button = document.createElement('button');
            button.textContent = text;
            button.className = access ? 'btn-success' : 'btn-danger';
            button.disabled = request.decision !== undefined;
            button.addEventListener('click', () => decideRequest(requestId, access));
            item.appendChild(button);
        }
        elements.pendingList.appendChild(item);
    }
    updateState();
}

function updateRemoteList() {
    updateState();
    elements.remoteCount.textContent = String(connectedRemotes.size);
    elements.remoteList.textContent = '';
    if (connectedRemotes.size === 0) {
        const item = document.createElement('li');
        item.className = 'empty-state';
        item.textContent = '暂无远程端连接';
        elements.remoteList.appendChild(item);
    }
    for (const [remoteId, remote] of connectedRemotes) {
        const item = document.createElement('li');
        item.className = 'remote-item';
        const label = document.createElement('span');
        const peer=serialPeers.get(remoteId);
        const route=peer?.direct?(peer.txViaRelay?'RX直连 / TX中转':'直连'):'中转';
        label.textContent = 'Remote: ' + remoteId + ' → ' + remote.portId + '（' + (remote.access === 'control' ? remoteWritesPaused ? '完全控制，已暂停' : '完全控制' : '只读') + '） · ' + route;
        label.title = globalThis.SerialP2P?.describe(remote.p2pDiagnostic) || '当前使用服务器中转';
        const revoke = document.createElement('button');
        revoke.className = 'btn-danger';
        revoke.textContent = '撤销授权';
        revoke.addEventListener('click', () => {
            revokeRemote(remoteId);
        });
        item.append(label, revoke);
        elements.remoteList.appendChild(item);
    }
    updateState();
    globalThis.NetworkReference?.notifyTargets();
}

function getNetworkAssessmentTargets() {
    if (!connectedRemotes.size) return [{id:'server',label:'本页',mode:'server',valid:()=>!connectedRemotes.size}];
    return [...connectedRemotes].map(([id,remote])=>{
        const peer=serialPeers.get(id),direct=!!peer?.direct,txViaRelay=!!peer?.txViaRelay,attempt=peer?.attempt,grant=remote.grantId;
        return {id,label:'Remote '+id+(txViaRelay?'（TX 中转）':''),mode:direct&&!txViaRelay?'p2p':'server',
            valid:()=>connectedRemotes.get(id)?.grantId===grant&&serialPeers.get(id)===peer&&!!peer?.direct===direct&&!!peer?.txViaRelay===txViaRelay&&(!direct||peer.attempt===attempt),
            assess:options=>peer.assessNetwork(options)};
    });
}

async function getConnectionDiagnostics() {
    return Promise.all([...connectedRemotes].map(async ([id, remote]) => ({remoteId:id,
        ...(serialPeers.has(id) ? await serialPeers.get(id).link.stats() : {mode:'websocket'}), diagnostic:remote.p2pDiagnostic})));
}

async function refreshPorts() {
    try {
        port = await navigator.serial.requestPort();
        const info = port.getInfo();
        const portId = info.usbVendorId !== undefined && info.usbProductId !== undefined
            ? info.usbVendorId.toString(16).toUpperCase() + ':' + info.usbProductId.toString(16).toUpperCase()
            : 'selected-port';
        const option = document.createElement('option');
        option.value = portId;
        option.textContent = '串口设备 (' + portId + ')';
        elements.portSelect.replaceChildren(option);
        elements.portSelect.disabled = false;
    } catch (error) {
        if (error.name !== 'NotFoundError') showError('选择串口失败：' + error.message);
    }
}

async function openPort() {
    if (isOpen || isOpening || isClosing) return;
    if (!port) { showError('请先选择串口'); return; }
    isOpening = true;
    elements.openPortBtn.disabled = true;
    elements.refreshBtn.disabled = true;
    try {
        const config = SerialConfig.read(elements);
        await port.open(config);
        activeSerialConfig = config;
        isOpen = true;
        log('串口已打开：' + elements.baudRate.value + ' baud，数据位 ' + elements.dataBits.value +
            '，停止位 ' + elements.stopBits.value + '，校验 ' + elements.parity.value + '，流控 ' + elements.flowControl.value);
        writer = port.writable.getWriter();
        localId = '';
        idRetries = 0;
        elements.portSelect.disabled = true;
        elements.openPortBtn.classList.add('hidden');
        elements.closePortBtn.classList.remove('hidden');
        for (const id of ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl']) elements[id].disabled = true;
        rxDecoder = new TextDecoder();
        updateState();
        readTask = readData();
    } catch (error) {
        showError('打开串口失败：' + error.message);
        if (isOpen) await closePort();
    } finally {
        isOpening = false;
        elements.openPortBtn.disabled = false;
        elements.refreshBtn.disabled = isOpen;
        updateState();
    }
}

async function closePort() {
    if (isClosing) return;
    isClosing = true;
    isOpen = false;
    stopSharing();
    elements.closePortBtn.disabled = true;
    if (serialConfigTask) await serialConfigTask;
    if (reader) {
        try { await reader.cancel(); } catch (error) { log(error.message); }
    }
    if (readTask) await readTask;
    await writeChain;
    if (writer) { writer.releaseLock(); writer = null; }
    if (port) {
        try { await port.close(); }
        catch (error) { showError('关闭串口失败：' + error.message); }
    }
    port = null;
    activeSerialConfig = null;
    serialConfigRevision = 0;
    localId = '';
    connectedRemotes.clear();
    pendingRequests.clear();
    updatePendingList();
    updateRemoteList();
    elements.openPortBtn.classList.remove('hidden');
    elements.closePortBtn.classList.add('hidden');
    elements.closePortBtn.disabled = false;
    elements.portSelect.disabled = false;
    elements.portSelect.replaceChildren();
    elements.refreshBtn.disabled = false;
    for (const id of ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl']) elements[id].disabled = false;
    log('串口已关闭');
    isClosing = false;
    updateState();
}

function cancelRXReplayTransfer(remoteId) {
    const transfer = rxReplayTransfers.get(remoteId);
    if (transfer?.retryTimer) clearTimeout(transfer.retryTimer);
    rxReplayTransfers.delete(remoteId);
}

function beginRXReplay(message) {
    const remote = connectedRemotes.get(message.remoteId);
    if (!isOpen || !registered || !rxReplayEnabled || !rxReplayBuffer || !remote ||
        remote.portId !== message.portId || remote.grantId !== message.grantId ||
        message.localId !== localId || message.rxStreamId !== rxReplayBuffer.streamId ||
        (message.resumeSeq !== undefined && !Number.isSafeInteger(message.resumeSeq)) || !Number.isSafeInteger(message.throughSeq) ||
        (message.resumeSeq ?? 0) >= message.throughSeq) return;
    cancelRXReplayTransfer(message.remoteId);
    const transfer = {
        remoteId: message.remoteId, portId: message.portId, grantId: message.grantId,
        streamId: message.rxStreamId, resumeSeq: message.resumeSeq ?? 0, throughSeq: message.throughSeq,
        frames: [], nextIndex: 0, inFlight: new Set(), completeSent: false, retryTimer: null,
        budget: RxReplay.createReplayBudget()
    };
    if (message.throughSeq > rxReplayBuffer.sequence) {
        transfer.gapFrom = transfer.resumeSeq + 1;
        transfer.gapTo = message.throughSeq;
    } else {
        const result = RxReplay.resume(rxReplayBuffer, transfer.resumeSeq, message.throughSeq);
        transfer.frames = result.frames;
        transfer.gapFrom = result.gapFrom;
        transfer.gapTo = result.gapTo;
    }
    rxReplayTransfers.set(message.remoteId, transfer);
    log('Remote ' + message.remoteId + ' 开始补传 RX：' + (transfer.resumeSeq + 1) + '–' + transfer.throughSeq +
        (transfer.gapFrom ? '，缓存缺口 ' + transfer.gapFrom + '–' + transfer.gapTo : ''));
    if (transfer.gapFrom) {
        ws.send(JSON.stringify({ type: 'replay_gap', targetRemoteId: transfer.remoteId, portId: transfer.portId,
            grantId: transfer.grantId, rxStreamId: transfer.streamId, gapFrom: transfer.gapFrom, gapTo: transfer.gapTo }));
    }
    sendRXReplayWindow(transfer);
}

function sendRXReplayWindow(transfer) {
    if (rxReplayTransfers.get(transfer.remoteId) !== transfer || transfer.retryTimer || !registered || !rxReplayEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    while (transfer.nextIndex < transfer.frames.length && transfer.inFlight.size < MAX_RX_REPLAY_IN_FLIGHT) {
        if (ws.bufferedAmount > MAX_RX_REPLAY_SOCKET_BACKLOG) {
            if (!transfer.retryTimer) transfer.retryTimer = setTimeout(() => { transfer.retryTimer = null; sendRXReplayWindow(transfer); }, 50);
            return;
        }
        const frame = transfer.frames[transfer.nextIndex];
        const payload = JSON.stringify({ type: 'replay_data', targetRemoteId: transfer.remoteId, portId: transfer.portId,
            grantId: transfer.grantId, rxStreamId: transfer.streamId, rxSeq: frame.sequence,
            data: SerialData.toBase64(frame.data) });
        const delay = RxReplay.replayBudgetDelay(transfer.budget, payload.length);
        if (delay > 0) {
            transfer.retryTimer = setTimeout(() => { transfer.retryTimer = null; sendRXReplayWindow(transfer); }, delay);
            return;
        }
        transfer.nextIndex++;
        transfer.inFlight.add(frame.sequence);
        ws.send(payload);
    }
    if (transfer.nextIndex === transfer.frames.length && transfer.inFlight.size === 0 && !transfer.completeSent) {
        transfer.completeSent = true;
        ws.send(JSON.stringify({ type: 'replay_complete', targetRemoteId: transfer.remoteId,
            portId: transfer.portId, grantId: transfer.grantId, rxStreamId: transfer.streamId,
            throughSeq: transfer.throughSeq }));
        log('Remote ' + transfer.remoteId + ' RX 补传完成：' + transfer.throughSeq);
        rxReplayTransfers.delete(transfer.remoteId);
    }
}

function acknowledgeRXReplay(message) {
    const transfer = rxReplayTransfers.get(message.remoteId);
    const remote = connectedRemotes.get(message.remoteId);
    if (!transfer || !remote || message.localId !== localId || message.portId !== transfer.portId ||
        message.grantId !== transfer.grantId || message.rxStreamId !== transfer.streamId ||
        !Number.isSafeInteger(message.rxSeq) || !transfer.inFlight.delete(message.rxSeq)) return;
    sendRXReplayWindow(transfer);
}

async function readData() {
    while (isOpen && !readSuspended && port && port.readable) {
        const activeReader = port.readable.getReader();
        reader = activeReader;
        try {
            while (isOpen && !readSuspended) {
                const { value, done } = await activeReader.read();
                if (done) break;
                if (!value || !value.length) continue;
                recordSerial('RX', value, '设备');
                if (shareEnabled && rxReplayBuffer) {
                    for (let offset = 0; offset < value.length; offset += SerialData.MAX_SEND_BYTES) {
                        const cached = RxReplay.append(rxReplayBuffer, value.subarray(offset, offset + SerialData.MAX_SEND_BYTES));
                        if (cached.removedFrames && !rxReplayBuffer.warnedEviction) {
                            rxReplayBuffer.warnedEviction = true;
                            log('弱网 RX 缓存达到上限，较早数据可能无法补传；Remote 重连后会显示具体缺口');
                        }
                        if (!registered || !ws || ws.readyState !== WebSocket.OPEN || !localId) continue;
                        if (ws.bufferedAmount > 1024 * 1024) {
                            showError('共享网络发送积压，正在重连；本机接收继续。');
                            ws.close(1013, 'Shared data backlog');
                            break;
                        }
                        const outgoing = { type: 'data', portId: elements.portSelect.value,
                            data: SerialData.toBase64(cached.frame.data) };
                        if (rxReplayEnabled) {
                            outgoing.rxStreamId = cached.frame.streamId;
                            outgoing.rxSeq = cached.frame.sequence;
                        }
                        if (serialP2PEnabled && rxReplayEnabled) {
                            outgoing.serialP2PProtocol = 1;
                            outgoing.directRemotes = [];
                            for (const [id, peer] of serialPeers) {
                                if (peer.sendRX(cached.frame.sequence, cached.frame.data)) outgoing.directRemotes.push(id);
                            }
                            // Pending approvals may already be processed by the Hub while
                            // their response is still in flight to this Local page.
                            if (!pendingRequests.size && outgoing.directRemotes.length === connectedRemotes.size) delete outgoing.data;
                        }
                        ws.send(JSON.stringify(outgoing));
                    }
                }
            }
        } catch (error) {
            if (isOpen && !readSuspended) {
                showError('串口读取失败：' + error.message);
                // Yield before retrying recoverable Web Serial stream errors.
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        } finally {
            activeReader.releaseLock();
            if (reader === activeReader) reader = null;
        }
    }
    // A device removal makes readable null; withdraw the stale server session.
    if (isOpen && !readSuspended) {
        showError('串口已不可读，请重新选择设备');
        setTimeout(closePort, 0);
    }
}

function generateLocalId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    // The alphabet has 32 characters, so masking introduces no modulo bias.
    return Array.from(bytes, byte => chars[byte & 31]).join('');
}

async function copyId() {
    if (!registered || !localId) return;
    try {
        await navigator.clipboard.writeText(localId);
        showSuccess('共享码已复制');
    } catch (error) { showError('复制失败：' + error.message); }
}

function updateState() {
    if (peerWriteGeneration !== remoteWriteGeneration) {
        peerWriteGeneration = remoteWriteGeneration;
        for (const peer of serialPeers.values()) peer.cancelWrites?.();
    }
    if (periodicSender.running && !canLocalWrite()) periodicSender.stop('unavailable');
    const writers = [...connectedRemotes.values()].filter(remote => remote.access === 'control').length;
    elements.portState.textContent = isClosing ? '正在关闭串口' : serialConfigPending || readSuspended ? '正在修改串口参数' : isOpen ? '串口已打开' : '串口未打开';
    elements.localId.textContent = registered ? localId : shareEnabled ? '等待注册' : '未共享';
    elements.copyBtn.disabled = !registered;
    elements.shareBtn.disabled = !isOpen || isClosing || (!shareEnabled && !!serialConfigTask);
    elements.shareBtn.textContent = shareEnabled ? '停止共享' : '开启共享';
    elements.autoAccept.disabled = isClosing;
    elements.wsStatus.textContent = registered ? '共享已就绪' : shareEnabled ? '正在连接共享服务器' : '本地模式';
    elements.wsDot.classList.toggle('connected', registered);
    elements.wsDot.classList.toggle('disconnected', !registered);
    elements.sharingState.textContent = registered ? '共享已开启。远端通过共享码申请访问。' : shareEnabled ? '连接恢复后会重新注册；本机收发可继续。' : '本机调试可直接使用。开启共享后可接入远端。';
    elements.sendBtn.disabled = !canLocalWrite() || periodicSender.running;
    elements.periodicSendBtn.textContent = periodicSender.running ? '停止定时' : periodicSender.busy ? '等待本次发送结束' : '定时发送';
    elements.periodicSendBtn.disabled = !periodicSender.running && (!canLocalWrite() || periodicSender.busy);
    elements.periodicInterval.disabled = periodicSender.running;
    elements.periodicStatus.textContent = periodicSender.running ? '发送中 · ' + periodicSender.interval + ' ms' : '未开启';
    for (const id of ['sendInput','hexSend','lineEnding']) elements[id].disabled = periodicSender.running;
    elements.takeControlBtn.disabled = !registered || !!writeStatePending;
    elements.takeControlBtn.textContent = writeStatePending ? '正在确认…' : remoteWritesPaused ? '恢复远端操作' : '暂停远端操作';
    elements.controlOwner.textContent = flashSession ? 'Remote ' + flashSession.ownerRemoteId + ' 正在烧录 ESP32' : remoteWritesPaused ? '远端发送已暂停' : '本机 + ' + writers + ' 个远端可发送';
    elements.writeStatus.textContent = flashSession ? 'ESP32 烧录占用串口；暂停或撤销会中止烧录会话' : pendingWrites ? '统一队列待完成：' + pendingWrites : '本机与获批发送端按到达顺序排队';
}

const eventRecords = [], dataRecords = [];
const renderedRows = new Map();
let recordSequence = 0, retainedBytes = 0, rxBytes = 0, txBytes = 0;
function clearCounts() {
    rxBytes = 0; txBytes = 0;
    elements.rxCount.textContent = '0 B'; elements.txCount.textContent = '0 B';
}
let hexDisplay = false, followLog = true, renderScheduled = false;
const pendingRecords = new Map();
let rxDecoder = new TextDecoder();

function retainRecord(record, list, limit) {
    record.id = ++recordSequence;
    record.time = new Date().toLocaleTimeString();
    record.retained = true;
    list.push(record);
    while (list.length > limit || (list === dataRecords && retainedBytes > 2 * 1024 * 1024)) {
        const removed = list.shift();
        removed.retained = false;
        pendingRecords.delete(removed.id);
        if (removed.bytes) retainedBytes -= removed.bytes.length;
        renderedRows.get(removed.id)?.remove();
        renderedRows.delete(removed.id);
    }
    if (list === eventRecords) return;
    pendingRecords.set(record.id, record);
    if (!renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            for (const item of pendingRecords.values()) if (item.retained) renderRecord(item);
            pendingRecords.clear();
            if (followLog) scrollLog();
        });
    }
}
function recordSerial(kind, data, source, writeOrder) {
    const bytes = new Uint8Array(data);
    const text = kind === 'RX' ? rxDecoder.decode(bytes, { stream: true }) : new TextDecoder().decode(bytes);
    retainedBytes += bytes.length;
    if (kind === 'RX') rxBytes += bytes.length; else txBytes += bytes.length;
    elements.rxCount.textContent = rxBytes.toLocaleString() + ' B';
    elements.txCount.textContent = txBytes.toLocaleString() + ' B';
    elements.lastActivity.textContent = new Date().toLocaleTimeString();
    retainRecord({ kind, bytes, text, source, writeOrder }, dataRecords, 2000);
}

function recordText(record) {
    return record.kind === 'EVENT' ? record.text : ((record.writeOrder ? '#' + record.writeOrder + ' ' : '') + record.source + '  ' + (hexDisplay ? SerialData.formatHex(record.bytes) : record.text));
}

function renderRecord(record) {
    const filter = elements.logFilter.value || 'all';
    if (filter !== 'all' && record.kind !== filter) return;
    const row = document.createElement('div'); row.className = 'terminal-row ' + record.kind;
    const time = document.createElement('span'); time.className = 'terminal-time'; time.textContent = record.time;
    const label = document.createElement('span'); label.className = 'terminal-label'; label.textContent = record.kind === 'EVENT' ? '事件' : record.kind;
    const content = document.createElement('span'); content.className = 'terminal-content'; content.textContent = recordText(record);
    row.append(time, label, content); elements.logContent.appendChild(row); renderedRows.set(record.id, row);
}

function scrollLog() { const area = document.getElementById('logArea'); area.scrollTop = area.scrollHeight; }
function visibleRecords() { return [...dataRecords].sort((a, b) => a.id - b.id); }
function redrawLog() {
    elements.logContent.replaceChildren(); renderedRows.clear(); pendingRecords.clear();
    for (const record of visibleRecords()) renderRecord(record);
    if (followLog) scrollLog();
}
function clearLog() {
    for (const record of dataRecords) record.retained = false;
    dataRecords.length = 0; retainedBytes = 0; pendingRecords.clear();
    redrawLog();
}
function exportLog() {
    const filter = elements.logFilter.value || 'all';
    const text = visibleRecords().filter(record => filter === 'all' || record.kind === filter)
        .map(record => '[' + record.time + '] ' + record.kind + ' ' + recordText(record)).join('\n');
    if (!text) { showError('没有串口收发记录可导出'); return; }
    downloadTextFile(text, 'serial-io-');
}
function exportSystemLog() {
    const text = eventRecords.map(record => '[' + record.time + '] EVENT ' + record.text).join('\n');
    if (!text) { showError('没有系统日志可导出'); return; }
    downloadTextFile(text, 'system-log-');
}
function downloadTextFile(text, prefix) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = prefix + Date.now() + '.txt';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
