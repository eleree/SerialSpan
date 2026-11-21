import { createRemoteSerialPort, configureRemoteTransport, createFlasherSDKLoader, REMOTE_FLASH_BLOCK_BYTES } from '/static/js/remote-serial-port.js';

const Manifest = globalThis.ShareSerialESP32Manifest;
const loadFlasherSDK = createFlasherSDKLoader();
const sharedRemote = globalThis.ShareSerialRemote || null;
const elements = Object.fromEntries([
    'errorMessage', 'successMessage', 'esp32HeaderStatus', 'esp32State', 'esp32ChipBadge', 'esp32ConnectBtn',
    'esp32DisconnectBtn', 'esp32DeviceInfo', 'esp32ChipName', 'esp32FlashSize', 'esp32PortName',
    'esp32ImageFiles', 'esp32VerifyBtn', 'esp32ManifestStatus', 'esp32ManifestSummary', 'esp32ConfirmFlash',
    'esp32FlashBtn', 'esp32Progress', 'esp32ProgressText', 'esp32Log', 'esp32ClearLogBtn',
    'connectSection', 'connectedTopInfo', 'localIdInput', 'accessSelect', 'connectBtn', 'cancelConnectBtn',
    'approvalStatus', 'connectedLocalId', 'connectedAccess', 'disconnectBtn',
    'esp32FirmwareHelp',
    'esp32FlashMode', 'esp32FlashFreq', 'esp32Layout', 'esp32ImageRows',
    'esp32BatchFilesBtn', 'esp32StopBtn', 'esp32RunStatus'
].map(id => [id, document.getElementById(id)]));

const state = {
    ws: null, localId: '', remoteId: '', portId: '', portName: '', grantId: '', writeEpoch: 0, access: '', paused: true,
    flashProtocol: 0, serialSignalsProtocol: 0, serialConfig: null, configRevision: 0,
    configuring: false, pendingConfig: null, pendingFlash: null, pendingSignals: new Map(),
    flashSessionId: '', flashActive: false, flashStarting: false, flashEnding: false, flashOwnerId: '',
    device: null, transport: null, loader: null, chipName: '', flashSize: '',
    verified: null, busy: false, keepalive: 0, logLines: [], originalSerialConfig: null,
    layout: [], layoutInputs: [], firmwareRevision: 0,
    preparingTool: false, toolPreparationVersion: 0, flashTask: null
};
const MAX_LOG_LINES = 500;
const SUPPORTED_CHIPS = new Set(['ESP32-C3', 'ESP32-S3']);

function showError(message) {
    elements.successMessage.classList.add('hidden');
    elements.errorMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.errorMessage.classList.remove('hidden');
}

function showSuccess(message) {
    elements.errorMessage.classList.add('hidden');
    elements.successMessage.textContent = globalThis.ShareSerialI18n?.text(message) ?? message;
    elements.successMessage.classList.remove('hidden');
}

function clearNotice() {
    elements.errorMessage.classList.add('hidden');
    elements.successMessage.classList.add('hidden');
}

function appendLog(message, localize = true) {
    const raw = String(message ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '�');
    const text = localize ? globalThis.ShareSerialI18n?.text(raw) ?? raw : raw;
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        state.logLines.push(new Date().toLocaleTimeString() + '  ' + line);
    }
    if (state.logLines.length > MAX_LOG_LINES) state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);
    elements.esp32Log.textContent = state.logLines.join('\n');
    elements.esp32Log.scrollTop = elements.esp32Log.scrollHeight;
}

function connected() { return !!state.ws && state.ws.readyState === WebSocket.OPEN && !!state.grantId; }

function syncSharedRemote({ snapshot, message }) {
    const hadGrant = !!state.grantId;
    state.ws = snapshot.ws;
    if (!snapshot.isConnected) {
        if (state.grantId || state.device || state.flashActive) connectionLost('Remote 连接已断开');
        else {
            state.localId = snapshot.localId || '';
            state.pendingRequestId = snapshot.pendingRequestId || '';
            state.access = snapshot.access || '';
            updateControls();
        }
        return;
    }
    state.localId = snapshot.localId;
    state.remoteId = snapshot.remoteId;
    state.portId = snapshot.portId;
    state.grantId = snapshot.grantId;
    state.writeEpoch = snapshot.writeEpoch;
    state.access = snapshot.access;
    state.paused = snapshot.paused;
    state.flashProtocol = snapshot.flashProtocol;
    state.serialSignalsProtocol = snapshot.serialSignalsProtocol;
    state.serialConfig = snapshot.serialConfig ? { ...snapshot.serialConfig } : null;
    state.configRevision = snapshot.configRevision;
    state.configuring = snapshot.configuring;
    const flashToolActive = document.getElementById('remoteWorkspace')?.dataset.activeTool === 'esp32';
    if (flashToolActive && snapshot.isConnected && !state.device && !state.flashActive) {
        elements.esp32ManifestStatus.textContent = snapshot.access !== 'control' ?
            'ESP32 烧录需要完全控制；请断开后重新申请完全控制。' :
            snapshot.flashProtocol !== 1 || snapshot.serialSignalsProtocol !== 1 ?
                'Local 页面或串口控制信号能力较旧，当前连接不能烧录。' : '获批控制并检测芯片后可校验固件。';
    }
    if (message?.type !== 'flash_state') {
        state.flashActive = snapshot.flashActive;
        state.flashOwnerId = snapshot.flashOwnerId;
        state.flashSessionId = snapshot.flashSessionId;
    }
    const connectMessage = message?.type === 'connect' ? message : !hadGrant ? snapshot.lastConnectMessage : null;
    if (message && message.type !== 'data') handleServerMessage(message);
    else if (connectMessage) handleServerMessage(connectMessage);
    updateControls();
}

function setHeaderStatus(text) {
    elements.esp32HeaderStatus.textContent = text;
}

function setState(label) {
    elements.esp32State.textContent = label;
    setHeaderStatus(state.flashActive ? '远端烧录会话 · ' + label : connected() ? '已连接 ' + state.localId : label);
    const chip = Manifest.normalizedChip(state.chipName);
    const supported = !!state.device && SUPPORTED_CHIPS.has(chip);
    elements.esp32ChipBadge.textContent = supported ? chip : state.device ? '不支持' : '未检测';
    elements.esp32ChipName.textContent = state.chipName || '';
    elements.esp32FlashSize.textContent = state.flashSize || '未检测';
    elements.esp32PortName.textContent = state.portName || '等待连接';
    elements.esp32DeviceInfo.classList.toggle('hidden', !state.device);
    const canControl = connected() && state.access === 'control' && !state.paused &&
        state.flashProtocol === 1 && state.serialSignalsProtocol === 1 && !!state.serialConfig && !state.configuring;
    const ownsFlash = state.flashActive && state.flashOwnerId === state.remoteId && !!state.flashSessionId;
    const canInspectImages = canControl && supported && ownsFlash && !state.busy && !state.flashStarting && !state.flashEnding;
    const canEditImages = !state.busy && !state.configuring;
    elements.esp32ConnectBtn.disabled = !canControl || state.busy || state.flashActive;
    elements.esp32DisconnectBtn.disabled = !ownsFlash || state.busy;
    elements.esp32ImageFiles.disabled = !canEditImages;
    elements.esp32FlashMode.disabled = !canEditImages;
    elements.esp32FlashFreq.disabled = !canEditImages;
    elements.esp32BatchFilesBtn.disabled = !canEditImages;
    elements.esp32StopBtn.disabled = !connected();
    elements.esp32RunStatus.textContent = state.busy ? '处理中' : state.verified ? '已就绪' :
        connected() && Number(elements.esp32Progress.value) === 100 ? '已完成' : connected() ? '待操作' : '待连接';
    for (const input of state.layoutInputs) input.disabled = !canEditImages;
    elements.esp32VerifyBtn.disabled = !canInspectImages || !state.layout.some(row => row.selected);
    elements.esp32FlashBtn.disabled = !canInspectImages || !state.verified || !elements.esp32ConfirmFlash.checked;
    elements.esp32ConfirmFlash.disabled = !canInspectImages || !state.verified;
    if (!sharedRemote) {
        elements.connectBtn.disabled = !!state.grantId || !!state.pendingFlash || !!state.localId && !connected();
        elements.localIdInput.disabled = !!state.grantId || !!state.localId && !connected();
        elements.accessSelect.disabled = !!state.grantId || !!state.localId && !connected();
        elements.cancelConnectBtn.classList.toggle('hidden', !state.localId || !!state.grantId);
        elements.disconnectBtn.disabled = !state.grantId && !state.localId;
        if (state.grantId) {
            elements.connectSection.classList.add('hidden');
            elements.connectedTopInfo.classList.remove('hidden');
        } else {
            elements.connectSection.classList.remove('hidden');
            elements.connectedTopInfo.classList.add('hidden');
        }
    }
}

function connectionLost(reason) {
    // Loading the tool has not reserved or touched the serial port yet.
    // Let a new connection proceed, and fence the late module completion.
    if (state.preparingTool) {
        state.toolPreparationVersion++;
        state.preparingTool = false;
        state.busy = false;
    }
    state.firmwareRevision++;
    clearInterval(state.keepalive);
    state.keepalive = 0;
    const device = state.device;
    const transport = state.transport;
    state.device = null;
    state.transport = null;
    state.loader = null;
    device?.fail(new Error(reason || 'Remote 连接已断开'));
    state.flashActive = false;
    state.flashSessionId = '';
    state.flashStarting = false;
    state.flashEnding = false;
    state.flashOwnerId = '';
    state.remoteId = '';
    state.grantId = '';
    state.portId = '';
    state.portName = '';
    state.localId = '';
    state.pendingRequestId = '';
    state.access = '';
    state.paused = true;
    state.flashProtocol = 0;
    state.serialSignalsProtocol = 0;
    state.serialConfig = null;
    state.configRevision = 0;
    state.configuring = false;
    rejectPending(reason || 'Remote 连接已断开');
    state.chipName = '';
    state.flashSize = '';
    state.verified = null;
    state.originalSerialConfig = null;
    clearFirmwareRows();
    elements.esp32ConfirmFlash.checked = false;
    if (state.ws && !sharedRemote) {
        const socket = state.ws;
        state.ws = null;
        if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    if (sharedRemote) state.ws = sharedRemote.getSnapshot().ws;
    if (transport) void transport.disconnect().catch(() => {});
    elements.connectedAccess.textContent = '';
    elements.connectedLocalId.textContent = '';
    elements.approvalStatus.classList.add('hidden');
    setState('尚未连接');
}

function rejectPending(message) {
    const error = new Error(message || 'Remote 操作已取消');
    if (state.pendingConfig) {
        state.pendingConfig.reject(error);
        state.pendingConfig = null;
    }
    if (state.pendingFlash) {
        state.pendingFlash.reject(error);
        state.pendingFlash = null;
    }
    for (const pending of state.pendingSignals.values()) pending.reject(error);
    state.pendingSignals.clear();
}

function acceptSerialState(message) {
    if (message.localId !== state.localId || message.portId !== state.portId || message.version !== 3 ||
        message.configProtocol !== 1 || !SerialConfig.valid(message.serialConfig) ||
        !Number.isSafeInteger(message.configRevision) || message.configRevision < state.configRevision ||
        !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < state.writeEpoch ||
        typeof message.configuring !== 'boolean' || typeof message.paused !== 'boolean') return false;
    state.serialConfig = { ...message.serialConfig };
    state.configRevision = message.configRevision;
    state.writeEpoch = message.writeEpoch;
    state.configuring = message.configuring;
    state.paused = message.paused;
    return true;
}

function applyFlashState(message) {
    if (message.localId !== state.localId || message.portId !== state.portId || message.version !== 3 ||
        typeof message.flashActive !== 'boolean' || typeof message.paused !== 'boolean' ||
        !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < state.writeEpoch) return;
    const wasActive = state.flashActive;
    state.writeEpoch = message.writeEpoch;
    state.paused = message.paused;
    state.flashActive = message.flashActive;
    state.flashStarting = !!message.flashStarting;
    state.flashEnding = !!message.flashEnding;
    state.flashOwnerId = message.flashOwnerId || '';
    if (message.flashSessionId) state.flashSessionId = message.flashSessionId;
    if (!message.flashActive) {
        state.flashSessionId = '';
        if (wasActive) state.device?.fail(new Error('Local 已结束或中止烧录会话'));
    }
    if (message.flashActive && state.flashOwnerId && !message.flashSessionId && !state.flashStarting) {
        state.flashSessionId = '';
    }
    if (message.flashActive && state.flashStarting) setState('正在锁定远端串口…');
    else if (!message.flashActive && wasActive) {
        state.firmwareRevision++;
        clearFirmwareRows();
        state.device?.fail(new Error('ESP32 烧录会话已释放'));
        void cleanupTransport();
        state.chipName = '';
        state.flashSize = '';
        state.verified = null;
        elements.esp32ConfirmFlash.checked = false;
        appendLog('串口烧录会话已释放。');
    }
    setState(state.flashActive ? (state.chipName ? Manifest.normalizedChip(state.chipName) + ' 已连接' : '串口已锁定') : connected() ? '已连接' : '尚未连接');
}

function openSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.host + '/ws/remote');
    state.ws = socket;
    socket.onopen = () => {
        if (state.ws !== socket || !state.localId) return;
        socket.send(JSON.stringify({ type: 'connect', version: 3, localId: state.localId,
            access: state.access, flashProtocol: 1 }));
    };
    socket.onmessage = event => {
        if (state.ws !== socket) return;
        try { handleServerMessage(JSON.parse(event.data)); }
        catch (error) { showError('处理远程串口消息失败：' + (error?.message || error)); }
    };
    socket.onerror = () => { if (state.ws === socket) showError('共享服务连接失败；请检查网络和 Local 在线状态。'); };
    socket.onclose = () => { if (state.ws === socket) connectionLost('共享服务连接断开'); };
}

function connectToLocal() {
    clearNotice();
    if (connected() || state.pendingFlash) return;
    const id = elements.localIdInput.value.trim().toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(id)) {
        showError('请输入有效的 5 位共享码');
        return;
    }
    state.localId = id;
    state.access = elements.accessSelect.value || 'control';
    if (state.access !== 'control') {
        showError('ESP32 烧录需要申请完全控制权限');
        state.localId = '';
        return;
    }
    elements.localIdInput.value = id;
    elements.approvalStatus.textContent = '正在连接共享服务…';
    elements.approvalStatus.classList.remove('hidden');
    setState('正在申请完全控制');
    openSocket();
}

function handleServerMessage(message) {
    switch (message.type) {
        case 'connect_pending':
            if (!state.localId || message.localId !== state.localId || message.version !== 3) return;
            state.pendingRequestId = message.requestId;
            elements.approvalStatus.textContent = '等待 Local 批准完全控制；Remote 编号 ' + message.remoteId + '，申请最多等待 ' + message.expiresIn + ' 秒。';
            elements.approvalStatus.classList.remove('hidden');
            setState('等待 Local 批准');
            break;
        case 'connect':
            if (!state.localId || message.localId !== state.localId ||
                message.version !== 3 || !message.grantId || !Number.isSafeInteger(message.writeEpoch) ||
                typeof message.paused !== 'boolean') {
                showError('Local 未授予有效的完全控制权限。');
                if (!sharedRemote) disconnectFromLocal();
                return;
            }
            if (message.access !== 'control') {
                if (document.getElementById('remoteWorkspace')?.dataset.activeTool === 'esp32')
                    showError('ESP32 烧录需要完全控制权限；断开后重新申请完全控制即可保留当前 Remote 页面。');
                setState('需要完全控制');
                return;
            }
            state.localId = message.localId;
            state.remoteId = message.remoteId;
            state.portId = message.portId;
            state.grantId = message.grantId;
            state.access = message.access;
            state.writeEpoch = message.writeEpoch;
            state.paused = message.paused;
            state.flashProtocol = message.flashProtocol || 0;
            state.serialSignalsProtocol = message.serialSignalsProtocol || 0;
            if (!acceptSerialState(message) || state.flashProtocol !== 1 || state.serialSignalsProtocol !== 1) {
                if (document.getElementById('remoteWorkspace')?.dataset.activeTool === 'esp32')
                    showError('Local 页面或串口能力较旧，无法远程烧录；请更新后重新申请。');
                if (!sharedRemote) disconnectFromLocal();
                return;
            }
            elements.connectedLocalId.textContent = state.localId;
            elements.connectedAccess.textContent = '完全控制' + (state.paused ? '（Local 已暂停）' : '');
            elements.approvalStatus.classList.add('hidden');
            if (!sharedRemote) state.ws.send(JSON.stringify({ type: 'get_ports', localId: state.localId }));
            applyFlashState(message);
            showSuccess('已获准完全控制 Local 串口。');
            appendLog('已连接共享码 ' + state.localId + '，Local 串口 ' + state.portId + '。');
            setState('已连接');
            break;
        case 'port_list':
            if (!connected() || !Array.isArray(message.ports)) return;
            {
                const port = message.ports.find(item => item.portId === state.portId && typeof item.name === 'string');
                if (port) {
                    state.portName = port.name;
                    appendLog('Local 物理串口：' + port.name);
                    setState(state.flashActive ? '串口已锁定' : '已连接');
                }
            }
            break;
        case 'flash_state':
            if (message.localId === state.localId && message.portId === state.portId) applyFlashState(message);
            break;
        case 'flash_result':
            if (message.requestId && state.pendingFlash?.requestId === message.requestId) {
                const pending = state.pendingFlash;
                state.pendingFlash = null;
                if (message.success && message.flashSessionId) {
                    state.flashSessionId = message.flashSessionId;
                    state.flashActive = true;
                    state.flashStarting = false;
                    state.flashEnding = false;
                    pending.resolve(message);
                } else pending.reject(new Error(flashError(message.code)));
                updateControls();
            } else if (state.flashActive && message.flashSessionId === state.flashSessionId && message.success === false) {
                appendLog('烧录会话中止：' + flashError(message.code));
                state.device?.fail(new Error(flashError(message.code)));
                showError(flashError(message.code));
                state.flashActive = false;
                state.flashSessionId = '';
                void cleanupTransport();
                setState('烧录会话已中止');
            }
            break;
        case 'serial_signals_result': {
            const pending = state.pendingSignals.get(message.requestId);
            if (!pending || message.flashSessionId !== state.flashSessionId || message.grantId !== state.grantId ||
                message.localId !== state.localId || message.portId !== state.portId) return;
            state.pendingSignals.delete(message.requestId);
            if (message.success) pending.resolve();
            else pending.reject(new Error(flashError(message.code)));
            break;
        }
        case 'serial_config_state':
            if (acceptSerialState(message)) updateControls();
            break;
        case 'write_state':
            if (message.localId !== state.localId || message.version !== 3 ||
                !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < state.writeEpoch ||
                typeof message.paused !== 'boolean') return;
            if (message.configProtocol === 1 && !acceptSerialState(message)) return;
            state.writeEpoch = message.writeEpoch;
            state.paused = message.paused;
            updateControls();
            break;
        case 'serial_config_result':
            if (!state.pendingConfig || message.requestId !== state.pendingConfig.requestId ||
                message.grantId !== state.grantId || message.localId !== state.localId ||
                message.portId !== state.portId || message.flashSessionId !== state.flashSessionId) return;
            if (!acceptSerialState(message)) {
                state.pendingConfig.reject(new Error('Local 返回的串口参数状态无效'));
                state.pendingConfig = null;
                return;
            }
            {
                const pending = state.pendingConfig;
                state.pendingConfig = null;
                if (message.success) pending.resolve({ ...state.serialConfig });
                else pending.reject(new Error(flashError(message.code)));
            }
            updateControls();
            break;
        case 'data':
            if (sharedRemote || message.localId !== state.localId || message.portId !== state.portId || !state.device) return;
            try { state.device.push(SerialData.fromBase64(message.data)); }
            catch (error) { state.device.fail(error); }
            break;
        case 'error':
            if (message.requestId && state.pendingFlash?.requestId === message.requestId) {
                const pending = state.pendingFlash;
                state.pendingFlash = null;
                if (pending.operation === 'end') {
                    state.flashEnding = false;
                    startFlashKeepalive();
                }
                pending.reject(new Error(flashError(message.code)));
                updateControls();
                return;
            }
            if (message.requestId && state.pendingConfig?.requestId === message.requestId) {
                const pending = state.pendingConfig;
                state.pendingConfig = null;
                pending.reject(new Error(flashError(message.code)));
                updateControls();
                return;
            }
            if (['daily_quota_exceeded', 'message_rate_limited', 'connection_rate_limited', 'bandwidth_limited', 'send_queue_limited'].includes(message.code)) {
                showError('共享服务资源达到上限：' + flashError(message.code));
                connectionLost(flashError(message.code));
                return;
            }
            if (state.localId && !state.grantId) {
                const detail = flashError(message.code);
                connectionLost(detail);
                showError(detail);
                return;
            }
            showError(flashError(message.code) || message.error || '远程串口操作失败');
            break;
        case 'disconnect':
        case 'permission_revoked':
        case 'local_disconnected':
            connectionLost(message.type === 'permission_revoked' ? 'Local 已撤销控制权' : 'Local 连接已断开');
            showError(message.type === 'permission_revoked' ? 'Local 已撤销控制权。' : 'Local 已停止共享或串口离线。');
            break;
    }
}

function flashError(code) {
    return {
        flash_busy: '串口正在被另一个烧录会话占用。',
        flash_unsupported: 'Local 未启用远程烧录，或串口不支持远程控制信号。',
        flash_start_failed: 'Local 未能锁定空闲串口。',
        flash_session_timeout: '烧录会话超时，串口锁已释放。',
        flash_aborted: 'Local 已中止烧录会话。',
        writes_paused: 'Local 已暂停远端操作。',
        stale_flash_session: '烧录会话已结束或授权状态已变化。',
        stale_write_state: '远端写入状态已变化，请重新连接。',
        serial_busy: '串口仍有操作未完成，请稍后重试。',
        configuration_busy: '串口参数正在修改，请稍后重试。',
        serial_signals_timeout: '远程串口控制信号请求超时。',
        signals_failed: 'Local 无法设置串口控制信号。',
        signals_unsupported: 'Local 串口不支持控制信号。',
        configuration_unsupported: 'Local 不支持远程修改串口参数。',
        configuration_failed: 'Local 修改串口参数失败。',
        permission_revoked: 'Local 已撤销远端授权。',
        read_only: '烧录需要完全控制权限。',
        approval_timeout: 'Local 批准超时。',
        connection_denied: 'Local 拒绝了控制申请。',
        local_not_found: '共享码不存在或 Local 已离线。'
    }[code] || code || '远程串口操作失败';
}

function updateControls() {
    if (!sharedRemote) elements.connectedAccess.textContent = state.access === 'control' ? state.paused ? '完全控制（Local 已暂停）' : '完全控制' : '';
    if (state.flashActive && state.flashStarting) setState('正在锁定远端串口…');
    else if (state.busy) setState('正在处理…');
    else if (state.flashActive && state.chipName) setState(Manifest.normalizedChip(state.chipName) + ' 已连接');
    else setState(state.flashActive ? '串口已锁定' : connected() ? '已连接' : '尚未连接');
}

function sendFlashKeepalive() {
    if (!connected() || !state.flashActive || state.flashEnding || !state.flashSessionId) return;
    state.ws.send(JSON.stringify({ type: 'flash_keepalive', flashSessionId: state.flashSessionId,
        grantId: state.grantId, writeEpoch: state.writeEpoch }));
}

function startFlashKeepalive() {
    clearInterval(state.keepalive);
    state.keepalive = setInterval(sendFlashKeepalive, 7000);
}

function beginFlashSession() {
    if (!connected() || state.access !== 'control' || state.paused || state.flashProtocol !== 1 ||
        state.serialSignalsProtocol !== 1 || !state.serialConfig || state.configuring || state.flashActive) {
        return Promise.reject(new Error('需要有效的完全控制授权、Local 烧录能力及未暂停的串口'));
    }
    const requestId = crypto.randomUUID();
    state.pendingFlash = {};
    state.pendingFlash.requestId = requestId;
    state.pendingFlash.operation = 'start';
    const promise = new Promise((resolve, reject) => Object.assign(state.pendingFlash, { resolve, reject }));
    state.ws.send(JSON.stringify({ type: 'begin_flash', requestId, localId: state.localId, portId: state.portId,
        grantId: state.grantId, writeEpoch: state.writeEpoch }));
    updateControls();
    return promise.then(result => {
        state.flashSessionId = result.flashSessionId;
        state.flashActive = true;
        startFlashKeepalive();
        return result;
    });
}

async function endFlashSession() {
    if (!state.flashActive || !state.flashSessionId || !connected()) return;
    if (state.pendingConfig || state.pendingSignals.size) throw new Error('等待当前串口操作完成后再结束会话');
    const requestId = crypto.randomUUID();
    state.flashEnding = true;
    state.pendingFlash = { requestId, operation: 'end' };
    const promise = new Promise((resolve, reject) => Object.assign(state.pendingFlash, { resolve, reject }));
    state.ws.send(JSON.stringify({ type: 'end_flash', requestId, localId: state.localId, portId: state.portId,
        grantId: state.grantId, writeEpoch: state.writeEpoch, flashSessionId: state.flashSessionId }));
    updateControls();
    await promise;
    clearInterval(state.keepalive);
    state.keepalive = 0;
    state.flashEnding = false;
    state.flashActive = false;
    state.flashSessionId = '';
    await cleanupTransport();
    updateControls();
}

function sendFlashData(bytes) {
    if (!connected() || !state.flashActive || state.flashStarting || state.flashEnding || !state.flashSessionId || state.paused) {
        throw new Error('烧录会话已结束或 Local 暂停远端操作');
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > SerialData.MAX_SEND_BYTES) {
        throw new Error('单个 SLIP 串口帧超过 16 KiB 上限，已停止发送');
    }
    if (state.ws.bufferedAmount > 64 * 1024) {
        throw new Error('烧录网络发送积压超过 64 KiB，已停止发送，请检查连接后重新烧录');
    }
    state.ws.send(JSON.stringify({ type: 'flash_send', portId: state.portId, data: SerialData.toBase64(bytes),
        grantId: state.grantId, writeEpoch: state.writeEpoch, flashSessionId: state.flashSessionId }));
}

function setRemoteSignals(signals) {
    if (!state.flashActive || !state.flashSessionId || state.flashEnding) return Promise.reject(new Error('远程烧录会话未激活'));
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => state.pendingSignals.set(requestId, { resolve, reject }));
    state.ws.send(JSON.stringify({ type: 'set_serial_signals', requestId, portId: state.portId,
        grantId: state.grantId, writeEpoch: state.writeEpoch, flashSessionId: state.flashSessionId,
        ...(typeof signals.dataTerminalReady === 'boolean' ? { dataTerminalReady: signals.dataTerminalReady } : {}),
        ...(typeof signals.requestToSend === 'boolean' ? { requestToSend: signals.requestToSend } : {}) }));
    return promise;
}

function setRemoteBaudRate(baudRate) {
    if (!state.flashActive || !state.flashSessionId || state.flashEnding || state.configuring) return Promise.reject(new Error('远端串口当前不能修改波特率'));
    if (!Number.isSafeInteger(baudRate) || !SerialConfig.valid({ ...state.serialConfig, baudRate })) return Promise.reject(new Error('不支持此波特率'));
    if (state.serialConfig?.baudRate === baudRate) return Promise.resolve({ ...state.serialConfig });
    const requestId = crypto.randomUUID();
    const serialConfig = { ...state.serialConfig, baudRate };
    const promise = new Promise((resolve, reject) => { state.pendingConfig = { requestId, resolve, reject }; });
    state.ws.send(JSON.stringify({ type: 'set_serial_config', configProtocol: 1, requestId, portId: state.portId,
        grantId: state.grantId, writeEpoch: state.writeEpoch, configRevision: state.configRevision,
        flashSessionId: state.flashSessionId, serialConfig }));
    updateControls();
    return promise;
}

async function startDeviceDetection() {
    clearNotice();
    if (state.busy || state.flashActive) return;
    if (!connected() || state.access !== 'control' || state.paused) return;
    const preparation = ++state.toolPreparationVersion;
    const socket = state.ws, grantId = state.grantId;
    state.busy = true;
    state.preparingTool = true;
    setState('正在准备烧录工具，可点击停止取消…');
    try {
        const { ESPLoader, Transport } = await loadFlasherSDK();
        if (preparation !== state.toolPreparationVersion || socket !== state.ws || grantId !== state.grantId || !connected()) return;
        state.preparingTool = false;
        setState('正在申请串口锁…');
        const session = await beginFlashSession();
        state.flashSessionId = session.flashSessionId;
        state.originalSerialConfig = { ...state.serialConfig };
        const terminal = {
            clean() { state.logLines = []; elements.esp32Log.textContent = ''; },
            writeLine: message => appendLog(message, false),
            write: message => appendLog(message, false)
        };
        state.device = createRemoteSerialPort({ write: sendFlashData, setSignals: setRemoteSignals, setBaudRate: setRemoteBaudRate });
        state.transport = configureRemoteTransport(new Transport(state.device, false));
        state.loader = new ESPLoader({ transport: state.transport, baudrate: 115200, romBaudrate: 115200,
            terminal, debugLogging: false });
        // Smaller blocks bound wire time on slow links. esptool awaits the
        // device response before advancing; do not pipeline serial commands.
        state.loader.FLASH_WRITE_SIZE = REMOTE_FLASH_BLOCK_BYTES;
        setState('正在远程检测芯片…');
        state.chipName = await state.loader.main();
        appendLog('远端检测到芯片：' + state.chipName);
        if (!SUPPORTED_CHIPS.has(Manifest.normalizedChip(state.chipName))) {
            state.flashSize = '';
            setState('芯片不受支持');
            showError('检测到 ' + state.chipName + '。当前只支持 ESP32-C3 和 ESP32-S3，未执行固件写入。');
            return;
        }
        state.flashSize = await state.loader.detectFlashSize() || '';
        if (!state.flashSize) throw new Error('无法读取远端 Flash 容量，拒绝继续烧录。');
        setState(Manifest.normalizedChip(state.chipName) + ' 已连接');
        showSuccess('远端芯片与 Flash 已检测。选择 BIN、填写地址后校验。');
    } catch (error) {
        if (preparation !== state.toolPreparationVersion) return;
        if (state.preparingTool) {
            showError('烧录工具准备失败：' + (error?.message || error));
            appendLog('烧录工具准备失败，未占用串口；可检查网络后重试。');
            return;
        }
        appendLog('远程检测失败：' + (error?.message || error));
        showError('远程检测失败：' + (error?.message || error));
        try { await state.loader?.after('hard_reset'); } catch {}
        await restoreOriginalConfig();
        await cleanupTransport();
        try { await endFlashSession(); } catch (endError) { appendLog('释放串口锁失败：' + (endError?.message || endError)); }
        state.chipName = '';
        state.flashSize = '';
    } finally {
        if (preparation === state.toolPreparationVersion) {
            state.preparingTool = false;
            state.busy = false;
            updateControls();
        }
    }
}

async function cleanupTransport() {
    const transport = state.transport;
    state.device?.fail(new Error('烧录工具已停止'));
    state.device = null;
    state.transport = null;
    state.loader = null;
    if (transport) {
        try { await transport.disconnect(); }
        catch (error) { appendLog('释放远端串口读取器提示：' + (error?.message || error)); }
    }
}

async function restoreOriginalConfig() {
    const original = state.originalSerialConfig;
    if (!original || !state.flashActive || !state.serialConfig || state.serialConfig.baudRate === original.baudRate) return true;
    try {
        await setRemoteBaudRate(original.baudRate);
        appendLog('已恢复 Local 原波特率 ' + original.baudRate + '。');
    } catch (error) {
        appendLog('未能恢复 Local 原波特率：' + (error?.message || error));
        showError('烧录后未能恢复 Local 原波特率 ' + original.baudRate + '，请在 Remote 串口页核对参数。');
        return false;
    }
    state.originalSerialConfig = null;
    return true;
}

function clearVerified(message = '选择 BIN 并填写写入地址后校验。') {
    clearNotice();
    state.firmwareRevision++;
    state.verified = null;
    elements.esp32ConfirmFlash.checked = false;
    elements.esp32ManifestSummary.classList.add('hidden');
    elements.esp32ManifestSummary.textContent = '';
    elements.esp32ManifestStatus.textContent = message;
    elements.esp32Progress.value = 0;
    elements.esp32ProgressText.textContent = '0%';
    updateControls();
}

function clearFirmwareRows() {
    state.layout = emptyFirmwareRows();
    renderFirmwareRows();
}

function emptyFirmwareRows() {
    return Array.from({ length: Manifest.MAX_IMAGES }, () => ({ file: '', address: '', selected: false, fileObject: null }));
}

function pickFirmwareRow(row, file) {
    if (!file || state.busy) return;
    row.file = file.name;
    row.fileObject = file;
    row.selected = true;
    clearVerified('镜像已改变，请重新校验。');
    renderFirmwareRows();
}

function renderFirmwareRows() {
    state.layoutInputs = [];
    elements.esp32ImageRows.replaceChildren();
    for (const row of state.layout) {
        const tr = document.createElement('tr');
        tr.dataset.file = row.file;
        const selectedCell = document.createElement('td');
        const selected = document.createElement('input');
        selected.type = 'checkbox';
        selected.checked = row.selected;
        selected.ariaLabel = '烧录 ' + (row.file || '本行固件');
        selected.addEventListener('change', () => {
            row.selected = selected.checked;
            clearVerified('烧录文件选择已改变，请重新校验。');
        });
        selectedCell.appendChild(selected);
        const nameCell = document.createElement('td');
        const fileGroup = document.createElement('div');
        fileGroup.className = 'fdt-file-picker';
        const fileName = document.createElement('input');
        fileName.type = 'text';
        fileName.readOnly = true;
        fileName.value = row.file;
        fileName.placeholder = '请选择 .bin 文件';
        fileName.ariaLabel = '固件文件';
        fileName.className = row.file ? 'fdt-loaded-file' : '';
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.bin,application/octet-stream';
        picker.className = 'hidden';
        picker.ariaLabel = '选择 ' + (row.file || '本行固件');
        picker.addEventListener('change', () => pickFirmwareRow(row, picker.files?.[0]));
        const browse = document.createElement('button');
        browse.type = 'button';
        browse.textContent = '…';
        browse.ariaLabel = '浏览固件文件';
        browse.addEventListener('click', () => picker.click());
        fileGroup.append(fileName, browse, picker);
        nameCell.appendChild(fileGroup);
        const addressCell = document.createElement('td');
        const address = document.createElement('input');
        address.type = 'text';
        address.className = 'fdt-address';
        address.value = row.address;
        address.placeholder = '0x…';
        address.maxLength = 10;
        address.spellcheck = false;
        address.ariaLabel = row.file + ' 写入地址';
        address.addEventListener('input', () => {
            row.address = address.value.trim();
            clearVerified('写入地址已改变，请重新校验并确认。');
        });
        addressCell.appendChild(address);
        tr.append(selectedCell, nameCell, addressCell);
        elements.esp32ImageRows.appendChild(tr);
        state.layoutInputs.push(selected, address, fileName, browse, picker);
    }
    elements.esp32Layout.classList.toggle('hidden', state.layout.length === 0);
    updateControls();
}

function selectedFirmwareFiles() {
    return state.layout.filter(row => row.selected).map(row => row.fileObject).filter(Boolean);
}

function renderVerified(packageInfo) {
    const lines = [
        '目标芯片：' + packageInfo.chip,
        '检测 Flash：' + packageInfo.flashSize,
        '总大小：' + packageInfo.totalBytes + ' B',
        '',
        ...packageInfo.images.map(image => image.file + '  @ 0x' + image.address.toString(16).toUpperCase() + '  ' + image.size + ' B  SHA-256 已计算 ' + image.sha256)
    ];
    elements.esp32ManifestSummary.textContent = lines.join('\n');
    elements.esp32ManifestSummary.classList.remove('hidden');
}

async function verifyFirmware() {
    clearNotice();
    if (!state.flashActive || !state.loader || state.paused || state.busy) return;
    state.busy = true;
    clearVerified('正在计算 SHA-256 并检查写入范围…');
    const revision = state.firmwareRevision;
    const sessionId = state.flashSessionId;
    const loader = state.loader;
    setState('正在校验固件…');
    try {
        const rows = state.layout.filter(row => row.selected).map(row => ({ ...row }));
        const files = selectedFirmwareFiles();
        const result = await Manifest.prepareManual(rows, files, state.chipName, state.flashSize,
            { flashMode: elements.esp32FlashMode.value, flashFreq: elements.esp32FlashFreq.value });
        if (revision !== state.firmwareRevision || sessionId !== state.flashSessionId || loader !== state.loader || !state.flashActive || state.paused) return;
        state.verified = result;
        renderVerified(result);
        elements.esp32ManifestStatus.textContent = '芯片与地址范围已校验，所选 BIN 的 SHA-256 已计算。';
        appendLog('固件校验通过：' + result.images.length + ' 个镜像，共 ' + result.totalBytes + ' 字节');
    } catch (error) {
        if (revision !== state.firmwareRevision || sessionId !== state.flashSessionId) return;
        state.verified = null;
        elements.esp32ManifestStatus.textContent = error.message || String(error);
        showError('固件校验失败：' + (error.message || error));
        appendLog('固件校验失败：' + (error.message || error));
    } finally {
        state.busy = false;
        updateControls();
    }
}

function bytesText(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

function flashWriteProgress(images, fileIndex, written, total) {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= images.length ||
        !Number.isFinite(written) || written < 0 || !Number.isFinite(total) || total <= 0) return null;
    const totalBytes = images.reduce((sum, image) => sum + image.size, 0);
    const previous = images.slice(0, fileIndex).reduce((sum, image) => sum + image.size, 0);
    // esptool reports compressed bytes, which cannot be added to raw BIN sizes.
    const current = images[fileIndex].size * Math.min(1, written / total);
    // Reserve completion for reset, parameter restoration and lock release.
    return Math.min(99, Math.floor((previous + current) * 100 / totalBytes));
}

function sameFlashConnection(task) {
    return state.flashTask === task && state.ws === task.socket && state.grantId === task.grantId && connected();
}

function ownsFlashTask(task) {
    return sameFlashConnection(task) && state.flashActive && !state.paused && state.flashSessionId === task.sessionId;
}

async function flashFirmware() {
    clearNotice();
    if (!state.flashActive || !state.loader || !state.verified || !elements.esp32ConfirmFlash.checked || state.busy) return;
    state.busy = true;
    setState('正在远程烧录…');
    elements.esp32Progress.value = 0;
    elements.esp32ProgressText.textContent = '0%';
    const packageInfo = state.verified;
    const task = { socket: state.ws, grantId: state.grantId, sessionId: state.flashSessionId, loader: state.loader };
    state.flashTask = task;
    let written = false, reset = false, releasing = false, completed = false;
    appendLog('开始远程烧录 ' + packageInfo.images.length + ' 个 BIN，共 ' + bytesText(packageInfo.totalBytes) + '。不会执行整片擦除。');
    try {
        await task.loader.writeFlash({
            fileArray: packageInfo.fileArray,
            flashMode: packageInfo.flashMode,
            flashFreq: packageInfo.flashFreq,
            flashSize: packageInfo.flashSize,
            eraseAll: false,
            compress: true,
            reportProgress(fileIndex, written, total) {
                if (!ownsFlashTask(task)) return;
                const percent = flashWriteProgress(packageInfo.images, fileIndex, written, total);
                if (percent === null) return;
                elements.esp32Progress.value = percent;
                elements.esp32ProgressText.textContent = percent + '%';
                elements.esp32State.textContent = '远程烧录 ' + percent + '%';
                setHeaderStatus('远程烧录 ' + percent + '%');
                if (written === total) appendLog(packageInfo.images[fileIndex]?.file + ' 写入完成');
            }
        });
        if (!ownsFlashTask(task)) return;
        written = true;
        appendLog('镜像写入完成，正在请求 Local 远程复位…');
        await task.loader.after('hard_reset');
        if (!ownsFlashTask(task)) return;
        reset = true;
        if (await restoreOriginalConfig() === false) throw new Error('未能恢复 Local 原波特率，请核对串口参数');
        if (!ownsFlashTask(task)) return;
        await cleanupTransport();
        if (!ownsFlashTask(task)) return;
        releasing = true;
        await endFlashSession();
        completed = sameFlashConnection(task);
    } catch (error) {
        if (!sameFlashConnection(task)) return;
        const message = (written ? '镜像已写入，但收尾未完成，请检查设备与 Local 串口状态：' :
            '远程烧录失败，设备可能仍在 Bootloader 模式；请检查 Local 串口和固件后再试：') + (error?.message || error);
        elements.esp32ManifestStatus.textContent = message;
        showError(message);
        appendLog(message);
        if (releasing) connectionLost('释放串口锁失败，已断开共享连接');
        if (ownsFlashTask(task) && !reset) { try { await task.loader.after('hard_reset'); } catch {} }
    } finally {
        if (ownsFlashTask(task)) {
            await restoreOriginalConfig();
            if (ownsFlashTask(task)) await cleanupTransport();
            if (ownsFlashTask(task)) {
                try { await endFlashSession(); }
                catch (error) {
                    appendLog('释放串口锁失败：' + (error?.message || error));
                    if (sameFlashConnection(task)) connectionLost('释放串口锁失败，已断开共享连接');
                }
            }
        }
        if (sameFlashConnection(task)) {
            state.verified = null;
            state.firmwareRevision++;
            clearFirmwareRows();
            elements.esp32ConfirmFlash.checked = false;
            elements.esp32ImageFiles.value = '';
            if (completed) {
                elements.esp32Progress.value = 100;
                elements.esp32ProgressText.textContent = '100%';
                elements.esp32ManifestStatus.textContent = '远程烧录完成，设备已复位，串口锁已释放。';
                showSuccess(packageInfo.chip + ' 远程烧录完成。');
            }
        }
        if (state.flashTask === task) {
            state.flashTask = null;
            state.busy = false;
            updateControls();
        }
    }
}

async function endCurrentSession() {
    if (!state.flashActive || state.busy) return;
    state.busy = true;
    setState('正在释放远端串口…');
    try {
        try { await state.loader?.after('hard_reset'); } catch (error) { appendLog('设备复位提示：' + (error?.message || error)); }
        await restoreOriginalConfig();
        await cleanupTransport();
        await endFlashSession();
        state.chipName = '';
        state.flashSize = '';
        state.verified = null;
        state.firmwareRevision++;
        clearFirmwareRows();
        clearVerified('串口烧录会话已结束。');
        showSuccess('远端串口已释放，Local 与其他 Remote 可继续发送。');
    } catch (error) {
        showError(error?.message || String(error));
    } finally {
        state.busy = false;
        updateControls();
    }
}

function resetImageSelection() {
    clearVerified('文件选择已改变，请重新校验。');
    const files = Array.from(elements.esp32ImageFiles.files || []);
    clearFirmwareRows();
    if (files.length > Manifest.MAX_IMAGES) {
        elements.esp32ManifestStatus.textContent = '最多选择 ' + Manifest.MAX_IMAGES + ' 个镜像。';
        updateControls();
        return;
    }
    state.layout = [...files.map(file => ({ file: file.name, address: '', selected: true, fileObject: file })),
        ...emptyFirmwareRows().slice(files.length)];
    renderFirmwareRows();
}

async function disconnectFromLocal() {
    if (state.flashActive && !state.busy) {
        state.busy = true;
        try {
            try { await state.loader?.after('hard_reset'); } catch {}
            await restoreOriginalConfig();
            await cleanupTransport();
            await endFlashSession();
        } catch {}
        state.busy = false;
    }
    if (sharedRemote) {
        sharedRemote.disconnect();
        showSuccess('已断开共享串口');
        return;
    }
    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'disconnect' }));
    connectionLost('已断开共享串口');
    showSuccess('已断开共享串口');
}

function cancelConnectionRequest() {
    if (!state.localId || state.grantId) return;
    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'disconnect' }));
    connectionLost('已取消连接申请');
    elements.localIdInput.value = '';
}

if (sharedRemote) {
    sharedRemote.subscribe(syncSharedRemote);
    globalThis.ShareSerialESP32 = Object.freeze({
        shouldConsumeRx: () => !!state.device?.opened && state.flashActive && state.flashOwnerId === state.remoteId,
        receive: bytes => { if (state.device?.opened && state.flashActive && state.flashOwnerId === state.remoteId) state.device.push(bytes); },
        ownsSession: () => state.flashActive && state.flashOwnerId === state.remoteId,
        disconnectGracefully: disconnectFromLocal
    });
} else {
    elements.connectBtn.addEventListener('click', connectToLocal);
    elements.localIdInput.addEventListener('keydown', event => { if (event.key === 'Enter') connectToLocal(); });
    elements.localIdInput.addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); });
    elements.cancelConnectBtn.addEventListener('click', cancelConnectionRequest);
    elements.disconnectBtn.addEventListener('click', disconnectFromLocal);
}
elements.esp32ConnectBtn.addEventListener('click', startDeviceDetection);
elements.esp32DisconnectBtn.addEventListener('click', endCurrentSession);
elements.esp32ImageFiles.addEventListener('change', resetImageSelection);
elements.esp32BatchFilesBtn.addEventListener('click', () => elements.esp32ImageFiles.click());
elements.esp32StopBtn.addEventListener('click', disconnectFromLocal);
elements.esp32FlashMode.addEventListener('change', () => clearVerified('Flash 模式已改变，请重新校验。'));
elements.esp32FlashFreq.addEventListener('change', () => clearVerified('Flash 频率已改变，请重新校验。'));
elements.esp32VerifyBtn.addEventListener('click', verifyFirmware);
elements.esp32ConfirmFlash.addEventListener('change', updateControls);
elements.esp32FlashBtn.addEventListener('click', flashFirmware);
elements.esp32ClearLogBtn.addEventListener('click', () => { state.logLines = []; elements.esp32Log.textContent = ''; });

resetImageSelection();
setState('尚未连接');
