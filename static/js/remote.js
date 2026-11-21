// Remote requests authorized operations; Local owns all physical serial calls.
let ws = null;
let localId = '';
let remoteId = '';
let connectedPortId = '';
let isConnected = false;
let isPending = false;
let pendingRequestId = '';
let connectSent = false;
let grantId = '', writeEpoch = 0, remoteWritesPaused = false;
let access = '';
let flashProtocol = 0, serialSignalsProtocol = 0, flashSessionId = '';
let lastConnectMessage = null;
let hexMode = false;
let records = [];
const systemRecords = [];
const MAX_SYSTEM_RECORDS = 500;
const remoteToolListeners = new Set();
let rxReplayEnabled = false, rxReplaying = false, rxStreamId = '', lastRxSeq = 0, rxCursorLocalId = '';
let rxDecoder = new TextDecoder();
let serialConfig = null, configRevision = 0, configuring = false, pendingConfig = null;
let flashActive = false, flashOwnerId = '';
let serialPeer = null, serialReceiver = null;
let p2pDiagnostic = null;
let rxBytes = 0, txBytes = 0;
const periodicSender = new SerialTools.PeriodicSender({setTimer:setTimeout,clearTimer:clearTimeout,onChange:()=>updateWritePermission()});
const REMOTE_CONNECTION_STORAGE_KEY = 'shareserial.remote.connection.v1';
const REMOTE_RECONNECT_DELAYS = [3000, 6000, 12000, 24000, 30000];
function loadRemoteConnectionPreference() {
    try {
        const value = JSON.parse(globalThis.localStorage?.getItem(REMOTE_CONNECTION_STORAGE_KEY) || 'null');
        return {
            localId: /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(value?.localId || '') ? value.localId : '',
            access: ['read', 'control'].includes(value?.access) ? value.access : 'read',
            autoReconnect: value?.autoReconnect !== false
        };
    } catch { return { localId: '', access: 'read', autoReconnect: true }; }
}
const savedRemoteConnection = loadRemoteConnectionPreference();
let reconnectLocalId = savedRemoteConnection.localId;
let reconnectAccess = savedRemoteConnection.access;
let autoReconnectEnabled = savedRemoteConnection.autoReconnect;
let autoReconnectWanted = false, autoReconnectTimer = null, autoReconnectAttempts = 0;
function saveRemoteConnectionPreference() {
    try {
        globalThis.localStorage?.setItem(REMOTE_CONNECTION_STORAGE_KEY, JSON.stringify({
            localId: reconnectLocalId, access: reconnectAccess, autoReconnect: autoReconnectEnabled
        }));
    } catch { /* Local storage can be unavailable in restricted browser profiles. */ }
}
function clearRemoteReconnectTimer() {
    if (autoReconnectTimer !== null) clearTimeout(autoReconnectTimer);
    autoReconnectTimer = null;
}
function disableRemoteReconnect() {
    autoReconnectWanted = false;
    autoReconnectEnabled = false;
    clearRemoteReconnectTimer();
    if (elements.autoReconnect) elements.autoReconnect.checked = false;
    saveRemoteConnectionPreference();
}
function scheduleRemoteReconnect() {
    if (!autoReconnectWanted || !autoReconnectEnabled || autoReconnectTimer !== null || !reconnectLocalId) return;
    const delay = REMOTE_RECONNECT_DELAYS[Math.min(autoReconnectAttempts, REMOTE_RECONNECT_DELAYS.length - 1)];
    autoReconnectAttempts = Math.min(autoReconnectAttempts + 1, REMOTE_RECONNECT_DELAYS.length - 1);
    elements.wsStatus.textContent = '连接断开，' + Math.ceil(delay / 1000) + ' 秒后自动重连';
    retainRecord({ direction:'EVENT', bytes:new Uint8Array(), text:'连接断开，' + Math.ceil(delay / 1000) + ' 秒后自动重连并重新申请权限' });
    autoReconnectTimer = setTimeout(() => {
        autoReconnectTimer = null;
        if (!autoReconnectWanted || !autoReconnectEnabled || isConnected || isPending) return;
        elements.localIdInput.value = reconnectLocalId;
        elements.accessSelect.value = reconnectAccess;
        connectToLocal(true);
    }, delay);
}

function closeSerialPeer() {
    serialPeer?.close(); serialPeer = null;
    serialReceiver?.close(); serialReceiver = null;
}
function addSerialPeer(message) {
    if (message.serialP2PProtocol !== 1 || !globalThis.SerialP2P?.supported()) {
        p2pDiagnostic = {reason:globalThis.SerialP2P?.supported() ? 'peer_unsupported' : 'webrtc_unavailable', configuration:globalThis.SerialP2P?.configuration().configuration};
        elements.wsStatus.textContent = '中转'; elements.wsStatus.title = globalThis.SerialP2P?.describe(p2pDiagnostic) || '双方未协商 P2P';
        return;
    }
    const socket = ws, authorization = grantId, targetLocal = localId, targetPort = connectedPortId;
    let diagnosticEventKey = '';
    serialReceiver = new SerialP2P.Receiver({ cursor: () => lastRxSeq,
        deliver: value => handleServerMessage(value, true),
        replaying: value => {
            rxReplaying = value;
            if (!value && elements.errorMessage.textContent === SerialP2P.RX_STALL_MESSAGE) elements.errorMessage.classList.add('hidden');
        },
        resume: sequence => {
            if (isConnected && ws === socket && grantId === authorization && socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: 'p2p_serial_resume', portId: targetPort, grantId: authorization, rxStreamId, resumeSeq: sequence }));
        }, onError: showError });
    if (rxReplaying) serialReceiver.begin(message.rxSeq);
    serialPeer = new SerialP2P.Peer({ role: 'remote', localId: targetLocal, remoteId: message.remoteId,
        canAssess: () => !flashActive && !configuring && !pendingConfig && !periodicSender.running && !rxReplaying,
        retryProtocol: message.serialP2PRetryProtocol,
        txRelayProtocol: message.serialP2PTXRelayProtocol,
        portId: targetPort, grantId: authorization,
        sendWS: value => socket.send(JSON.stringify(value)),
        valid: () => isConnected && ws === socket && socket.readyState === WebSocket.OPEN && grantId === authorization && connectedPortId === targetPort,
        canTX: epoch => isConnected && grantId === authorization && epoch === writeEpoch && access === 'control' &&
            !remoteWritesPaused && !flashActive && !configuring && !pendingConfig,
        deliverTX: () => {},
        deliverRX: (sequence, bytes) => serialReceiver?.receive({ type: 'data', localId: targetLocal,
            portId: targetPort, data: SerialData.toBase64(bytes), rxStreamId, rxSeq: sequence }, true),
        onState: direct => {
            if (isConnected && grantId === authorization) elements.wsStatus.textContent = direct ? serialPeer?.txViaRelay ? 'RX直连 / TX中转' : '直连' : '中转';
            globalThis.NetworkReference?.notifyTargets();
        },
        onDiagnostic: value => {
            if (!isConnected || ws !== socket || grantId !== authorization) return;
            p2pDiagnostic = value; elements.wsStatus.title = SerialP2P.describe(value);
            const key = value.phase+'|'+value.reason;
            if (SerialP2P.diagnosticEvent(value) && key !== diagnosticEventKey) {
                diagnosticEventKey = key;
                retainRecord({direction:'EVENT',bytes:new Uint8Array(),time:new Date().toLocaleTimeString(),text:'P2P：'+SerialP2P.describe(value)});
            }
        },
        onError: showError });
    elements.wsStatus.textContent = '中转';
}
const MAX_RECORDS = 2000;
const elements = {};
for (const id of ['wsDot', 'wsStatus', 'localIdInput', 'connectBtn', 'disconnectBtn',
    'connectSection', 'connectedTopInfo', 'connectedLocalId', 'rxData', 'sendInput', 'sendBtn',
    'remoteWorkspace', 'remotePageTitle', 'remoteSerialTab', 'remoteFlashTab', 'remoteSerialPanel', 'esp32Panel',
    'clearRxBtn', 'clearTxBtn', 'hexModeBtn', 'exportBtn', 'exportSystemLogBtn', 'hexSend', 'sendCR',
    'errorMessage', 'successMessage', 'accessSelect', 'autoReconnect', 'cancelConnectBtn', 'approvalStatus', 'connectedAccess',
    'rxCount', 'txCount', 'clearCountsBtn', 'periodicInterval', 'periodicSendBtn', 'periodicStatus',
    'baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'applyConfigBtn', 'configStatus', 'configCurrent']) {
    elements[id] = document.getElementById(id);
}

window.addEventListener('DOMContentLoaded', () => {
    elements.clearCountsBtn.addEventListener('click', clearCounts);
    elements.periodicSendBtn.addEventListener('click', togglePeriodicSend);
    elements.connectBtn.addEventListener('click', () => connectToLocal());
    elements.disconnectBtn.addEventListener('click', disconnectFromLocal);
    elements.cancelConnectBtn.addEventListener('click', disconnectFromLocal);
    elements.sendBtn.addEventListener('click', sendData);
    elements.clearRxBtn.addEventListener('click', clearRx);
    elements.clearTxBtn.addEventListener('click', () => { elements.sendInput.value = ''; });
    elements.hexModeBtn.addEventListener('click', toggleHexMode);
    elements.exportBtn.addEventListener('click', exportData);
    elements.exportSystemLogBtn.addEventListener('click', exportSystemLog);
    elements.applyConfigBtn.addEventListener('click', requestSerialConfig);
    elements.remoteSerialTab.addEventListener('click', event => { event.preventDefault(); switchRemoteTool('serial'); });
    elements.remoteFlashTab.addEventListener('click', event => { event.preventDefault(); switchRemoteTool('esp32'); });
    window.addEventListener('popstate', () => switchRemoteTool(location.pathname === '/remote/esp32' ? 'esp32' : 'serial', false));
    elements.localIdInput.value = reconnectLocalId;
    elements.accessSelect.value = reconnectAccess;
    elements.autoReconnect.checked = autoReconnectEnabled;
    switchRemoteTool(location.pathname === '/remote/esp32' ? 'esp32' : 'serial', false);
    elements.autoReconnect.addEventListener('change', () => {
        autoReconnectEnabled = elements.autoReconnect.checked;
        if (autoReconnectEnabled) {
            reconnectLocalId = isConnected || isPending ? localId : elements.localIdInput.value.trim().toUpperCase();
            reconnectAccess = isConnected ? access : elements.accessSelect.value || reconnectAccess || 'read';
            autoReconnectWanted = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(reconnectLocalId);
            if (autoReconnectWanted && !isConnected && !isPending) scheduleRemoteReconnect();
        } else {
            autoReconnectWanted = false;
            clearRemoteReconnectTimer();
        }
        saveRemoteConnectionPreference();
    });
    for (const field of SerialConfig.fields) elements[field].addEventListener('change', updateConfigControls);
    elements.localIdInput.addEventListener('keydown', event => { if (event.key === 'Enter') connectToLocal(); });
    elements.sendInput.addEventListener('keydown', event => { if (event.key === 'Enter') sendData(); });
    elements.localIdInput.addEventListener('input', event => {
        event.target.value = event.target.value.toUpperCase();
        if (!isConnected && !isPending && event.target.value !== reconnectLocalId) {
            clearRemoteReconnectTimer();
            autoReconnectWanted = false;
            reconnectLocalId = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(event.target.value) ? event.target.value : '';
            reconnectAccess = elements.accessSelect.value || 'read';
            saveRemoteConnectionPreference();
        }
    });
    elements.accessSelect.addEventListener('change', () => {
        if (isConnected || isPending) return;
        clearRemoteReconnectTimer();
        autoReconnectWanted = false;
        reconnectAccess = elements.accessSelect.value || 'read';
        saveRemoteConnectionPreference();
    });
    for (const button of document.querySelectorAll('.preset-commands button')) {
        button.addEventListener('click', () => {
            elements.sendInput.value = button.dataset.cmd;
            elements.hexSend.checked = false;
            elements.sendCR.checked = true;
            sendData();
        });
    }
    setDisconnected();
    elements.wsStatus.textContent = '按需连接共享服务';
    if (autoReconnectEnabled && reconnectLocalId) {
        autoReconnectWanted = true;
        autoReconnectTimer = setTimeout(() => {
            autoReconnectTimer = null;
            if (autoReconnectWanted && autoReconnectEnabled && !isConnected && !isPending) connectToLocal(true);
        }, 0);
    }
});

function switchRemoteTool(tool, updateAddress = true) {
    const activeTool = tool === 'esp32' ? 'esp32' : 'serial';
    elements.remoteWorkspace.dataset.activeTool = activeTool;
    elements.remotePageTitle.textContent = activeTool === 'esp32' ? 'ESP32 烧录工具箱' : '远程串口助手';
    document.title = 'ShareSerial - ' + elements.remotePageTitle.textContent;
    elements.remoteSerialPanel.classList.toggle('hidden', activeTool !== 'serial');
    elements.esp32Panel.classList.toggle('hidden', activeTool !== 'esp32');
    elements.remoteSerialTab.setAttribute('aria-current', activeTool === 'serial' ? 'page' : 'false');
    elements.remoteFlashTab.setAttribute('aria-current', activeTool === 'esp32' ? 'page' : 'false');
    if (activeTool === 'esp32' && !isConnected && !isPending) elements.accessSelect.value = 'control';
    const target = activeTool === 'esp32' ? '/remote/esp32' : '/remote';
    if (updateAddress && location.pathname !== target) history.pushState({ remoteTool: activeTool }, '', target);
    notifyRemoteToolListeners();
}

function remoteToolSnapshot() {
    return {
        ws, localId, remoteId, portId: connectedPortId, isConnected, isPending, pendingRequestId,
        grantId, writeEpoch, access, paused: remoteWritesPaused, flashActive, flashOwnerId,
        flashSessionId, flashProtocol, serialSignalsProtocol, serialConfig: serialConfig ? { ...serialConfig } : null,
        configRevision, configuring, lastConnectMessage
    };
}

function notifyRemoteToolListeners(message = null) {
    const update = { snapshot: remoteToolSnapshot(), message };
    for (const listener of remoteToolListeners) {
        try { listener(update); } catch (error) { console.error('Remote tool state update failed', error); }
    }
}

function showError(message) {
    elements.successMessage.classList.add('hidden');
    elements.errorMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.errorMessage.classList.remove('hidden');
}
function showSuccess(message) {
    elements.errorMessage.classList.add('hidden');
    elements.successMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.successMessage.classList.remove('hidden');
    setTimeout(() => elements.successMessage.classList.add('hidden'), 3000);
}

function setDisconnected() {
    periodicSender.stop('disconnected');
    closeSerialPeer();
    p2pDiagnostic = null; elements.wsStatus.title = '';
    elements.successMessage.classList.add('hidden');
    isConnected = false;
    isPending = false;
    pendingRequestId = '';
    connectSent = false;
    grantId = ''; writeEpoch = 0; remoteWritesPaused = false;
    remoteId = ''; flashProtocol = 0; serialSignalsProtocol = 0; flashSessionId = ''; lastConnectMessage = null;
    rxReplayEnabled = false;
    rxReplaying = false;
    flashActive = false; flashOwnerId = '';
    access = '';
    connectedPortId = '';
    rxDecoder = new TextDecoder();
    elements.connectSection.classList.remove('hidden');
    elements.connectedTopInfo.classList.add('hidden');
    elements.connectBtn.disabled = false;
    elements.connectBtn.textContent = '申请连接';
    elements.localIdInput.disabled = false;
    elements.accessSelect.disabled = false;
    elements.approvalStatus.classList.add('hidden');
    elements.cancelConnectBtn.classList.add('hidden');
    elements.connectedAccess.textContent = '';
    elements.sendBtn.disabled = true;
    serialConfig = null; configRevision = 0; configuring = false; pendingConfig = null;
    updateWritePermission();
    elements.connectedAccess.textContent = '';
    globalThis.NetworkReference?.notifyTargets();
    notifyRemoteToolListeners();
}

function getNetworkAssessmentTargets() {
    if (!isConnected) return [{id:'server',label:'本页',mode:'server',valid:()=>!isConnected}];
    const peer=serialPeer,grant=grantId,direct=!!peer?.direct,txViaRelay=!!peer?.txViaRelay,attempt=peer?.attempt,target=localId;
    return [{id:'local:'+target,label:'Local '+target+(direct&&txViaRelay?'（TX 中转）':''),mode:direct&&!txViaRelay?'p2p':'server',
        valid:()=>isConnected&&localId===target&&grantId===grant&&serialPeer===peer&&!!peer?.direct===direct&&!!peer?.txViaRelay===txViaRelay&&(!direct||peer.attempt===attempt),
        assess:options=>peer.assessNetwork(options)}];
}

async function getConnectionDiagnostics() {
    return serialPeer ? {...await serialPeer.link.stats(), txViaRelay:serialPeer.txViaRelay, diagnostic:p2pDiagnostic} : {mode:'websocket', diagnostic:p2pDiagnostic};
}

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.host + '/ws/remote');
    ws = socket;
    notifyRemoteToolListeners();
    socket.onopen = () => {
        if (ws !== socket) return;
        elements.wsDot.classList.replace('disconnected', 'connected');
        elements.wsStatus.textContent = '已连接服务器';
        sendConnectionRequest();
        notifyRemoteToolListeners();
    };
    socket.onmessage = event => {
        if (ws !== socket) return;
        try {
            const message = JSON.parse(event.data);
            handleServerMessage(message);
            notifyRemoteToolListeners(message);
        }
        catch (error) { showError('处理服务器消息失败：' + error.message); }
    };
    socket.onclose = event => {
        if (ws !== socket) return;
        const shouldRetry = autoReconnectWanted && autoReconnectEnabled && event?.code !== 4008;
        ws = null;
        setDisconnected();
        elements.wsDot.classList.replace('connected', 'disconnected');
        elements.wsStatus.textContent = '连接已断开，点击申请连接重试';
        if (event?.code === 4008) {
            disableRemoteReconnect();
            showError(resourceLimitMessage(event.reason));
        } else if (shouldRetry) scheduleRemoteReconnect();
    };
    socket.onerror = () => { if (ws === socket) showError('连接失败，网络异常或共享服务已达连接上限，请稍后重试。'); };
}

function resourceLimitMessage(code) {
    return {
        daily_quota_exceeded: '公共共享服务的当日流量额度已用尽，请稍后或更换自托管服务。',
        message_rate_limited: '共享消息过于频繁，连接已停止，请降低发送频率后重试。',
        connection_rate_limited: '共享连接申请过于频繁，连接已停止，请稍后重试。',
        bandwidth_limited: '共享流量达到服务上限，连接已停止，请降低数据速率或减少远端后重试。',
        send_queue_limited: '共享数据积压超过上限，连接已停止，请检查网络和接收端。'
    }[code] || '共享服务资源达到上限，连接已停止，请稍后重试。';
}

function releaseTransport() {
    const socket = ws;
    ws = null;
    if (socket) socket.close();
    elements.wsDot.classList.replace('connected', 'disconnected');
    elements.wsStatus.textContent = '按需连接共享服务';
}

function handleServerMessage(message, fromTransport = false) {
    if (serialPeer && message.type.startsWith('p2p_serial_')) {
        if (message.portId !== connectedPortId || message.grantId !== grantId || (message.localId && message.localId !== localId)) return;
        if (message.type === 'p2p_serial_head' && message.rxStreamId === rxStreamId) serialReceiver.observe(message.rxSeq);
        else if (message.type === 'p2p_serial_replay' && message.rxStreamId === rxStreamId) serialReceiver.begin(message.throughSeq);
        else serialPeer.handle(message);
        return;
    }
    if (serialReceiver && message.type === 'data' && !fromTransport) {
        if (message.localId === localId && message.portId === connectedPortId && message.rxStreamId === rxStreamId) serialReceiver.receive(message);
        return;
    }
    switch (message.type) {
        case 'connect_pending':
            if (!isPending || message.localId !== localId) return;
            if (message.version !== 3) { disconnectFromLocal(); showError('请更新页面和服务端至协议 v3'); return; }
            pendingRequestId = message.requestId;
            elements.approvalStatus.textContent = '等待 Local 批准；你的远程编号为 ' + message.remoteId + '（最多等待 ' + message.expiresIn + ' 秒）';
            elements.approvalStatus.classList.remove('hidden');
            break;
        case 'connect':
            if (!isPending || !pendingRequestId || message.requestId !== pendingRequestId) return;
            if (message.version !== 3 || !['read', 'control'].includes(message.access) || typeof message.grantId !== 'string' || !message.grantId || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < 1 || typeof message.paused !== 'boolean') {
                disconnectFromLocal(); showError('服务端未返回有效授权，请更新服务端'); return;
            }
            isPending = false;
            pendingRequestId = '';
            access = message.access;
            grantId = message.grantId;
            writeEpoch = message.writeEpoch;
            remoteWritesPaused = message.paused;
            isConnected = true;
            reconnectLocalId = localId;
            reconnectAccess = access;
            autoReconnectWanted = autoReconnectEnabled;
            autoReconnectAttempts = 0;
            clearRemoteReconnectTimer();
            saveRemoteConnectionPreference();
            connectedPortId = message.portId;
            localId = message.localId;
            remoteId = message.remoteId || '';
            flashProtocol = message.flashProtocol || 0;
            serialSignalsProtocol = message.serialSignalsProtocol || 0;
            flashSessionId = message.flashSessionId || '';
            lastConnectMessage = { ...message };
            flashActive = message.flashActive === true;
            flashOwnerId = message.flashOwnerId || '';
            rxReplayEnabled = message.rxReplayProtocol === 1 && /^[0-9a-f]{32}$/.test(message.rxStreamId || '') &&
                (Number.isSafeInteger(message.rxSeq) || message.rxSeq === undefined);
            if (rxReplayEnabled) {
                const currentRxSeq = message.rxSeq ?? 0;
                if (rxCursorLocalId === localId && rxStreamId === message.rxStreamId) {
                    if (lastRxSeq > currentRxSeq) {
                        rxStreamId = message.rxStreamId;
                        lastRxSeq = currentRxSeq;
                        rxReplaying = false;
                    } else rxReplaying = lastRxSeq < currentRxSeq;
                } else {
                    rxCursorLocalId = localId;
                    rxStreamId = message.rxStreamId;
                    lastRxSeq = currentRxSeq;
                    rxReplaying = false;
                }
            }
            elements.connectedLocalId.textContent = localId;
            elements.connectSection.classList.add('hidden');
            elements.connectedTopInfo.classList.remove('hidden');
            acceptSerialState(message);
            updateWritePermission();
            addSerialPeer(message);
            if (flashProtocol === 1 && ws?.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'get_ports', localId }));
            globalThis.NetworkReference?.notifyTargets();
            showSuccess(access === 'control' ? remoteWritesPaused ? '已获准完全控制，Local 当前暂停远端写入' : '已获准完全控制' : '已获准只读访问串口');
            break;
        case 'flash_state':
            if (!isConnected || message.localId !== localId || message.portId !== connectedPortId ||
                typeof message.flashActive !== 'boolean' || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < writeEpoch ||
                typeof message.paused !== 'boolean') return;
            {
                const wasFlashing = flashActive;
                flashActive = message.flashActive;
                flashOwnerId = message.flashOwnerId || '';
                flashSessionId = message.flashSessionId || '';
                writeEpoch = message.writeEpoch;
                remoteWritesPaused = message.paused;
                updateWritePermission();
                if (flashActive) showError('Remote ' + flashOwnerId + ' 正在烧录 ESP32；本页普通串口发送和参数修改暂时停用。');
                else if (wasFlashing) showSuccess('ESP32 烧录会话已结束，串口控制已恢复。');
            }
            break;
        case 'write_state':
            if (!isConnected || message.localId !== localId || message.version !== 3 || typeof message.paused !== 'boolean' || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch <= writeEpoch) return;
            const pauseChanged = remoteWritesPaused !== message.paused;
            if (message.configProtocol === 1 && !acceptSerialState(message)) return;
            writeEpoch = message.writeEpoch;
            remoteWritesPaused = message.paused;
            updateWritePermission();
            if (access === 'control' && pauseChanged) {
                if (remoteWritesPaused) showError('Local 已暂停远端发送，仍可接收数据。本次未执行的命令不会自动重发。');
                else showSuccess('远端发送已恢复，请按需重新发送。');
            }
            break;
        case 'serial_config_result':
            if (!isConnected || !pendingConfig || message.requestId !== pendingConfig || message.grantId !== grantId ||
                message.localId !== localId || message.portId !== connectedPortId || typeof message.success !== 'boolean') return;
            if (!acceptSerialState(message)) return;
            pendingConfig = null;
            updateWritePermission();
            if (message.success) showSuccess('串口参数已应用');
            else showError(configurationError(message.code));
            break;
        case 'serial_config_state':
            if (!isConnected || message.localId !== localId || message.portId !== connectedPortId) return;
            if (acceptSerialState(message)) updateWritePermission();
            break;
        case 'data':
            if (isConnected && message.localId === localId && message.portId === connectedPortId) {
                const sequenced = rxReplayEnabled && message.rxStreamId === rxStreamId && Number.isSafeInteger(message.rxSeq) && message.rxSeq > 0;
                if (rxReplayEnabled && !sequenced) {
                    showError('本地 RX 序号或数据流不匹配，已忽略该帧');
                    break;
                }
                if (!rxReplayEnabled) {
                    displayRxData(SerialData.fromBase64(message.data));
                    break;
                }
                if (message.rxSeq <= lastRxSeq) {
                    acknowledgeRXFrame(message.rxSeq);
                    break;
                }
                if (message.rxSeq > lastRxSeq + 1) {
                    showRXGap(lastRxSeq + 1, message.rxSeq - 1);
                    lastRxSeq = message.rxSeq - 1;
                }
                displayRxData(SerialData.fromBase64(message.data));
                lastRxSeq = message.rxSeq;
                acknowledgeRXFrame(message.rxSeq);
            }
            break;
        case 'rx_gap':
            if (isConnected && rxReplayEnabled && message.localId === localId && message.portId === connectedPortId &&
                message.rxStreamId === rxStreamId && Number.isSafeInteger(message.gapFrom) && Number.isSafeInteger(message.gapTo) &&
                message.gapFrom > 0 && message.gapTo >= message.gapFrom) {
                const from = Math.max(message.gapFrom, lastRxSeq + 1);
                if (from <= message.gapTo) showRXGap(from, message.gapTo);
                lastRxSeq = Math.max(lastRxSeq, message.gapTo);
                serialReceiver?.noteProgress();
            }
            break;
        case 'replay_complete':
            if (isConnected && rxReplayEnabled && message.localId === localId && message.portId === connectedPortId &&
                message.rxStreamId === rxStreamId && message.throughSeq === lastRxSeq) { rxReplaying = false; serialReceiver?.complete(); }
            break;
        case 'disconnect':
            disableRemoteReconnect();
            releaseTransport();
            setDisconnected();
            break;
        case 'local_disconnected':
            {
            const shouldRetry = autoReconnectWanted && autoReconnectEnabled;
            releaseTransport();
            setDisconnected();
            showError('本地串口已关闭或离线，请等待重新共享后连接');
            if (shouldRetry) scheduleRemoteReconnect();
            }
            break;
        case 'permission_revoked':
            disableRemoteReconnect();
            releaseTransport();
            setDisconnected();
            showError('Local 已撤销你的访问权限');
            break;
        case 'error':
            if (message.code === 'p2p_not_authorized' && message.grantId && message.grantId !== grantId) return;
            periodicSender.stop('server_error');
            if (serialPeer && message.txSeq) { serialPeer.failTX(message.txSeq, '发送未获批准：' + (message.code || message.error)); return; }
            if (pendingConfig && message.requestId === pendingConfig) {
                pendingConfig = null;
                updateWritePermission();
                showError(configurationError(message.code));
                return;
            }
            const resourceError = ['daily_quota_exceeded', 'message_rate_limited', 'connection_rate_limited', 'bandwidth_limited', 'send_queue_limited'].includes(message.code);
            const retryableLocalState = ['local_not_found', 'local_disconnected'].includes(message.code);
            const shouldRetry = autoReconnectWanted && autoReconnectEnabled && retryableLocalState;
            if (resourceError || isPending && !retryableLocalState || ['connection_denied', 'approval_timeout', 'too_many_requests'].includes(message.code)) disableRemoteReconnect();
            if (isPending || resourceError || retryableLocalState) { releaseTransport(); setDisconnected(); }
            elements.connectBtn.disabled = false;
            elements.connectBtn.textContent = '连接';
            showError(resourceError ? resourceLimitMessage(message.code) : {
                connection_denied: 'Local 已拒绝本次连接申请。',
                approval_timeout: '等待批准超时，请重新申请。',
                too_many_requests: 'Local 的待批准申请已满，请稍后重试。',
                local_not_found: '连接 ID 不存在或共享端已离线。',
                local_disconnected: 'Local 已停止共享，请等待恢复后重新申请。',
                approval_required: '需要 Local 批准后才能访问串口。',
                read_only: '当前为只读权限，不能发送数据。',
                writes_paused: 'Local 已暂停远端发送，本次数据未转发。',
                p2p_tx_relay: 'Remote TX 已切到中转，直连接收保持可用；未完成命令不会自动重发。',
                flash_busy: 'ESP32 烧录会话正在独占串口，本次数据未转发。',
                stale_write_state: '发送状态已变化，本次数据未转发，请确认后重新发送。',
                stale_grant: '发送授权已变化，请重新申请连接。',
                protocol_mismatch: '请刷新 Local、Remote 页面，并使用协议 v3 服务端。'
            }[message.code] || message.error);
            if (shouldRetry) scheduleRemoteReconnect();
            break;
    }
}

function connectToLocal(automatic = false) {
    if (isPending || isConnected) return;
    const requestedLocalId = (automatic ? reconnectLocalId : elements.localIdInput.value).trim().toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(requestedLocalId)) {
        showError('请输入有效的 5 位连接 ID');
        return;
    }
    const requestedAccess = automatic ? reconnectAccess : elements.accessSelect.value || 'read';
    if (!['read', 'control'].includes(requestedAccess)) { showError('请选择只读或完全控制权限'); return; }
    if (rxCursorLocalId && rxCursorLocalId !== requestedLocalId) {
        rxCursorLocalId = ''; rxStreamId = ''; lastRxSeq = 0; rxReplaying = false;
    }
    if (!automatic) {
        clearRemoteReconnectTimer();
        autoReconnectEnabled = elements.autoReconnect.checked;
        autoReconnectAttempts = 0;
    }
    localId = requestedLocalId;
    reconnectLocalId = requestedLocalId;
    reconnectAccess = requestedAccess;
    elements.localIdInput.value = requestedLocalId;
    elements.accessSelect.value = requestedAccess;
    autoReconnectWanted = autoReconnectEnabled;
    saveRemoteConnectionPreference();
    isPending = true;
    connectSent = false;
    pendingRequestId = '';
    elements.connectBtn.disabled = true;
    elements.connectBtn.textContent = '等待批准...';
    elements.localIdInput.disabled = true;
    elements.accessSelect.disabled = true;
    elements.cancelConnectBtn.classList.remove('hidden');
    notifyRemoteToolListeners();
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === 3) connectWebSocket();
    sendConnectionRequest();
}

function sendConnectionRequest() {
    if (!isPending || connectSent || !ws || ws.readyState !== WebSocket.OPEN) return;
    connectSent = true;
    const request = { type: 'connect', localId, access: elements.accessSelect.value || 'read', version: 3, rxReplayProtocol: 1, flashProtocol: 1 };
    if (globalThis.SerialP2P?.supported()) { request.serialP2PProtocol = 1; request.serialP2PRetryProtocol = 1; request.serialP2PTXRelayProtocol = 1; }
    if (rxCursorLocalId === localId && rxStreamId) {
        request.resumeStreamId = rxStreamId;
        request.resumeSeq = lastRxSeq;
    }
    ws.send(JSON.stringify(request));
}

function acknowledgeRXFrame(sequence) {
    if (!rxReplaying || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rx_ack', localId, portId: connectedPortId, grantId,
        rxStreamId, rxSeq: sequence }));
}

function showRXGap(from, to) {
    const text = '弱网缓存缺口：序号 ' + from + '–' + to + ' 未能补回';
    const record = { direction: 'EVENT', bytes: new Uint8Array(), time: new Date().toLocaleTimeString(), text };
    retainRecord(record);
    showError(text);
}

function updateWritePermission() {
    if (!canRemoteSend()) serialPeer?.cancelWrites?.();
    if (periodicSender.running && !canRemoteSend()) periodicSender.stop('unavailable');
    elements.sendBtn.disabled = !isConnected || access !== 'control' || remoteWritesPaused || flashActive || periodicSender.running;
    if (configuring || pendingConfig) elements.sendBtn.disabled = true;
    elements.periodicSendBtn.textContent = periodicSender.running ? '停止定时' : periodicSender.busy ? '等待本次发送结束' : '定时发送';
    elements.periodicSendBtn.disabled = !periodicSender.running && (!canRemoteSend() || periodicSender.busy);
    elements.periodicInterval.disabled = periodicSender.running;
    elements.periodicStatus.textContent = periodicSender.running ? '发送中 · ' + periodicSender.interval + ' ms' : '未开启';
    for (const id of ['sendInput','hexSend','sendCR','clearTxBtn']) elements[id].disabled = periodicSender.running;
    for (const button of document.querySelectorAll('.preset-commands button')) button.disabled = !canRemoteSend() || periodicSender.running;
    elements.connectedAccess.textContent = flashActive ? 'ESP32 烧录中（串口已占用）' : access === 'control' ? remoteWritesPaused ? '完全控制（Local 已暂停）' : '完全控制' : '只读';
    updateConfigControls();
}

function acceptSerialState(message) {
    if (message.localId !== localId || message.portId !== connectedPortId || message.version !== 3 || message.configProtocol !== 1 || !SerialConfig.valid(message.serialConfig) ||
        !Number.isSafeInteger(message.configRevision) || message.configRevision < 1 ||
        message.configRevision < configRevision ||
        !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < writeEpoch ||
        typeof message.configuring !== 'boolean' || typeof message.paused !== 'boolean' ||
        (message.configuring && (typeof message.configId !== 'string' || !message.configId))) return false;
    serialConfig = { ...message.serialConfig };
    configRevision = message.configRevision;
    configuring = message.configuring;
    writeEpoch = message.writeEpoch;
    remoteWritesPaused = message.paused;
    SerialConfig.display(elements, serialConfig);
    return true;
}

function updateConfigControls() {
    const editable = isConnected && access === 'control' && !!serialConfig && !remoteWritesPaused && !flashActive && !configuring && !pendingConfig;
    const draft = !!serialConfig && SerialConfig.fields.some(field => elements[field].value !== String(serialConfig[field]));
    for (const field of SerialConfig.fields) elements[field].disabled = !editable;
    elements.applyConfigBtn.disabled = !editable;
    elements.configCurrent.textContent = isConnected && serialConfig ? 'Local 已确认：' + SerialConfig.describe(serialConfig) : '';
    elements.configStatus.textContent = !isConnected ? '连接后查看当前参数' : !serialConfig ? '此 Local 暂不支持远程修改参数' :
        configuring || pendingConfig ? '正在修改参数，收发暂时停止' : flashActive ? '另一个 Remote 正在独占串口烧录 ESP32' : remoteWritesPaused ? 'Local 已暂停远端操作' : access === 'read' ? '只读权限' :
        draft ? '有未应用的修改，请点击“应用参数”' : '当前参数已同步';
}

function configurationError(code) {
    return { serial_busy: '串口还有写入未完成，请稍后再修改参数。', configuration_busy: '其他参数修改尚未完成，请稍后重试。',
        stale_configuration: '串口参数已被其他端修改，请核对后重新应用。', writes_paused: 'Local 已暂停远端操作。',
        permission_revoked: '参数修改授权已撤销。', stale_grant: '参数修改授权已过期，请重新连接。',
        stale_write_state: '远端操作状态已变化，请核对后重试。', configuration_unsupported: '请更新 Local 页面后再修改串口参数。',
        invalid_configuration: '串口参数无效。', configuration_timeout: '参数修改超时，共享已停止，请检查 Local。',
        configuration_cancelled: '参数修改已取消。', configuration_failed: '参数修改失败，请查看 Local 日志确认串口状态。'
    }[code] || '参数修改未成功，请核对连接和权限后重试。';
}

function requestSerialConfig() {
    if (!isConnected || access !== 'control' || !serialConfig || remoteWritesPaused || configuring || pendingConfig || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        const config = SerialConfig.read(elements);
        pendingConfig = crypto.randomUUID();
        ws.send(JSON.stringify({ type: 'set_serial_config', configProtocol: 1, requestId: pendingConfig,
            portId: connectedPortId, grantId, writeEpoch, configRevision, serialConfig: config }));
        updateWritePermission();
    } catch (error) { pendingConfig = null; updateWritePermission(); showError(error.message); }
}

function disconnectFromLocal() {
    if (globalThis.ShareSerialESP32?.ownsSession?.()) {
        void globalThis.ShareSerialESP32.disconnectGracefully();
        return;
    }
    performRemoteDisconnect();
}

function performRemoteDisconnect() {
    disableRemoteReconnect();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'disconnect' }));
    releaseTransport();
    setDisconnected();
    showSuccess('已断开连接');
}

function recordText(record) {
    return record.direction === 'EVENT' ? record.text : hexMode ? SerialData.formatHex(record.bytes) : record.text;
}

function renderRecord(record) {
    const row = document.createElement('div');
    row.className = 'terminal-row ' + record.direction;
    const timestamp = document.createElement('span');
    timestamp.className = 'terminal-time';
    timestamp.textContent = record.time;
    const label = document.createElement('span');
    label.className = 'terminal-label';
    label.textContent = record.direction === 'TX' ? 'TX（已提交）' : record.direction;
    const content = document.createElement('span');
    content.className = 'terminal-content';
    content.textContent = recordText(record);
    row.append(timestamp, label, content);
    elements.rxData.appendChild(row);
}

function addRecord(direction, data) {
    const bytes = new Uint8Array(data);
    if (direction === 'RX') rxBytes += bytes.length; else if (direction === 'TX') txBytes += bytes.length;
    elements.rxCount.textContent = rxBytes.toLocaleString() + ' B';
    elements.txCount.textContent = txBytes.toLocaleString() + ' B';
    const record = {
        direction, bytes, time: new Date().toLocaleTimeString(),
        text: direction === 'RX' ? rxDecoder.decode(bytes, { stream: true }) : new TextDecoder().decode(bytes)
    };
    retainRecord(record);
}

function retainRecord(record) {
    record.time ||= new Date().toLocaleTimeString();
    if (record.direction === 'EVENT') {
        record.text = globalThis.ShareSerialI18n?.text(record.text) ?? record.text;
        systemRecords.push(record);
        if (systemRecords.length > MAX_SYSTEM_RECORDS) systemRecords.shift();
        return;
    }
    records.push(record);
    renderRecord(record);
    if (records.length > MAX_RECORDS) {
        records.shift();
        elements.rxData.firstChild.remove();
    }
    requestAnimationFrame(() => { elements.rxData.scrollTop = elements.rxData.scrollHeight; });
}
function displayRxData(bytes) {
    if (flashActive && flashOwnerId === remoteId && globalThis.ShareSerialESP32?.shouldConsumeRx?.()) {
        globalThis.ShareSerialESP32.receive(bytes);
        return;
    }
    addRecord('RX', bytes);
}

function canRemoteSend() {
    return isConnected && !!ws && ws.readyState === WebSocket.OPEN && access === 'control' &&
        !remoteWritesPaused && !flashActive && !configuring && !pendingConfig;
}

async function submitRemoteBytes(bytes, current = () => true) {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) { showError('未连接到本地串口'); return false; }
    if (access !== 'control') { showError('当前为只读权限，不能发送数据'); return false; }
    if (remoteWritesPaused) { showError('Local 已暂停远端发送，仍可接收数据'); return false; }
    if (flashActive) { showError('ESP32 烧录会话正在独占串口；请等待结束后再发送'); return false; }
    if (configuring || pendingConfig) { showError('串口参数正在修改，请完成后重新发送'); return false; }
    if (!current()) return false;
    const socket = ws, authorization = grantId, epoch = writeEpoch, peer = serialPeer;
    try {
        if ((ws.bufferedAmount || 0) > 65536) throw new Error('共享发送积压，已停止本次发送；请稍后重试');
        if (serialPeer?.direct && !serialPeer?.txViaRelay) {
            await peer.sendTX(bytes, epoch, current);
        }
        else {
            const payload = JSON.stringify({ type: 'send', portId: connectedPortId, data: SerialData.toBase64(bytes), grantId, writeEpoch });
            if ((ws.bufferedAmount || 0) + new TextEncoder().encode(payload).length > 65536) throw new Error('共享发送积压，已停止本次发送；请稍后重试');
            ws.send(payload);
        }
        if (ws !== socket || grantId !== authorization) return false;
        addRecord('TX', bytes);
        return true;
    } catch (error) {
        if (error?.code === 'P2P_TX_RELAY') return false;
        if (ws === socket && serialPeer === peer && isConnected && grantId === authorization && writeEpoch === epoch && current()) showError(error.message);
        return false;
    }
}

function sendData() {
    if (!elements.sendInput.value) return Promise.resolve(false);
    try { return submitRemoteBytes(SerialData.parseSendInput(elements.sendInput.value, elements.hexSend.checked, elements.sendCR.checked)); }
    catch (error) { showError(error.message); return Promise.resolve(false); }
}

function togglePeriodicSend() {
    if (periodicSender.running) { periodicSender.stop(); return; }
    try {
        if (!elements.sendInput.value) throw new Error('请输入发送内容');
        const payload = SerialData.parseSendInput(elements.sendInput.value, elements.hexSend.checked, elements.sendCR.checked);
        const socket = ws, authorization = grantId, epoch = writeEpoch;
        periodicSender.start(elements.periodicInterval.value, current => submitRemoteBytes(payload,current),
            () => canRemoteSend() && ws === socket && grantId === authorization && writeEpoch === epoch);
    } catch (error) { showError(error.message); }
}

function clearCounts() {
    rxBytes = 0; txBytes = 0;
    elements.rxCount.textContent = '0 B'; elements.txCount.textContent = '0 B';
}

function clearRx() {
    records = [];
    rxDecoder = new TextDecoder();
    elements.rxData.replaceChildren();
}

function toggleHexMode() {
    hexMode = !hexMode;
    elements.hexModeBtn.textContent = hexMode ? '文本显示' : 'HEX 显示';
    elements.rxData.replaceChildren();
    for (const record of records) renderRecord(record);
    requestAnimationFrame(() => { elements.rxData.scrollTop = elements.rxData.scrollHeight; });
}

function exportData() {
    const received = records.filter(record => record.direction === 'RX');
    if (!received.length) { showError('没有接收数据可导出'); return; }
    const text = received.map(record => '[' + record.time + '] ' + recordText(record)).join('\n');
    downloadTextFile(text, 'serial_data_');
    showSuccess('已导出保留的接收记录');
}
function exportSystemLog() {
    const text = systemRecords.map(record => '[' + record.time + '] EVENT ' + recordText(record)).join('\n');
    if (!text) { showError('没有系统日志可导出'); return; }
    downloadTextFile(text, 'remote-system-log-');
}
function downloadTextFile(text, prefix) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = prefix + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

globalThis.ShareSerialRemote = Object.freeze({
    getSnapshot: remoteToolSnapshot,
    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Remote tool listener must be a function');
        remoteToolListeners.add(listener);
        listener({ snapshot: remoteToolSnapshot(), message: null });
        return () => remoteToolListeners.delete(listener);
    },
    send(message) {
        if (!ws || ws.readyState !== WebSocket.OPEN || !isConnected) throw new Error('Remote 连接当前不可用');
        ws.send(JSON.stringify(message));
    },
    disconnect: performRemoteDisconnect
});
