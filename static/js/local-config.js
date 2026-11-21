// Configuration is a bounded operation owned by the Local page. Server state
// freezes new sends; physical changes start only with an empty write queue.
let activeSerialConfig = null, serialConfigRevision = 0, serialConfigPending = null;
let serialConfigTask = null, readSuspended = false;

function receiveSerialState(message) {
    if (!registered || message.localId !== localId || message.portId !== elements.portSelect.value || message.version !== 3 ||
        message.configProtocol !== 1 || !SerialConfig.valid(message.serialConfig) ||
        !Number.isSafeInteger(message.configRevision) || message.configRevision < 1 || message.configRevision < serialConfigRevision ||
        !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < writeEpoch ||
        typeof message.configuring !== 'boolean' || typeof message.paused !== 'boolean') return;
    if (message.configuring && !message.configId) return;
    writeEpoch = message.writeEpoch;
    serialConfigRevision = message.configRevision;
    remoteWritesPaused = message.paused;
    if (message.configuring) {
        if (!serialConfigPending || serialConfigPending.id !== message.configId) {
            if (serialConfigTask) { stopSharing(); showError('串口参数修改状态冲突，共享已停止'); return; }
            serialConfigPending = { id: message.configId, epoch: message.writeEpoch, cancelled: false, socket: ws };
            remoteWriteGeneration++;
        }
    } else {
        serialConfigPending = null;
        SerialConfig.display(elements, message.serialConfig);
    }
    updateState();
}

function replySerialConfiguration(operation, success, config, code = '', portOpen = true) {
    if (operation.replied || ws !== operation.socket || !registered || ws?.readyState !== WebSocket.OPEN) return;
    operation.replied = true;
    ws.send(JSON.stringify({ type: 'serial_config_result', configProtocol: 1, configId: operation.id,
        portId: operation.portId || elements.portSelect.value, flashSessionId: operation.flashSessionId || '',
        success, portOpen, serialConfig: config, code }));
}

function cancelLocalConfiguration(code, forget = false) {
    const operation = serialConfigPending;
    if (!operation) return;
    operation.cancelled = true;
    operation.code = code || 'configuration_cancelled';
    if (!forget && !serialConfigTask) replySerialConfiguration(operation, false, activeSerialConfig, operation.code);
    if (forget) serialConfigPending = null;
}

function canConfigureSerial(operation, message, physicalPort) {
    const remote = connectedRemotes.get(message.remoteId);
    const flashAuthorized = flashSession ? flashSession.id === message.flashSessionId && flashSession.ownerRemoteId === message.remoteId : !message.flashSessionId;
    return serialConfigPending === operation && !operation.cancelled && registered && shareEnabled && isOpen && !isClosing &&
        port === physicalPort && ws === operation.socket && ws?.readyState === WebSocket.OPEN &&
        !remoteWritesPaused && !writeStatePending && message.writeEpoch === writeEpoch &&
        flashAuthorized &&
        remote?.access === 'control' && !!message.grantId && remote.grantId === message.grantId &&
        remote.portId === message.portId && message.portId === elements.portSelect.value;
}

function beginSerialConfiguration(message) {
    const operation = serialConfigPending;
    if (!operation || operation.id !== message.configId || serialConfigTask || operation.replied) return;
    operation.remoteId = message.remoteId;
    operation.portId = elements.portSelect.value;
    operation.flashSessionId = message.flashSessionId || '';
    if (message.configProtocol !== 1 || message.version !== 3 || message.localId !== localId ||
        message.configRevision !== serialConfigRevision || !SerialConfig.valid(message.serialConfig) ||
        !SerialConfig.valid(activeSerialConfig) || !canConfigureSerial(operation, message, port)) {
        replySerialConfiguration(operation, false, activeSerialConfig, 'configuration_cancelled');
        return;
    }
    log('收到 Remote ' + message.remoteId + ' 参数修改：' + SerialConfig.describe(activeSerialConfig) + ' → ' + SerialConfig.describe(message.serialConfig));
    if (pendingWrites !== 0) {
        showError('Remote ' + message.remoteId + ' 修改参数未执行：串口还有写入未完成。');
        replySerialConfiguration(operation, false, activeSerialConfig, 'serial_busy');
        return;
    }
    serialConfigTask = runSerialConfiguration(operation, message, port).finally(() => {
        serialConfigTask = null;
        updateState();
        if (shareEnabled && !registered && !readSuspended && ws?.readyState === WebSocket.OPEN) registerPort();
    });
}

async function runSerialConfiguration(operation, message, physicalPort) {
    const previous = { ...activeSerialConfig }, desired = { ...message.serialConfig };
    let phase = 'reading', closed = false, openedNew = false;
    function checkAuthorization() {
        if (!canConfigureSerial(operation, message, physicalPort)) throw new Error('参数修改已取消或授权状态已变化');
    }
    function restartReading(config) {
        activeSerialConfig = config;
        SerialConfig.display(elements, config);
        writer = physicalPort.writable.getWriter();
        readSuspended = false;
        rxDecoder = new TextDecoder();
        readTask = readData();
    }
    try {
        checkAuthorization();
        readSuspended = true;
        updateState();
        if (reader) await reader.cancel();
        if (readTask) await readTask;
        checkAuthorization();
        if (writer) { writer.releaseLock(); writer = null; }
        phase = 'closing';
        await physicalPort.close();
        closed = true;
        phase = 'closed';
        checkAuthorization();
        await physicalPort.open(desired);
        openedNew = true;
        closed = false;
        phase = 'opened';
        checkAuthorization();
        restartReading(desired);
        replySerialConfiguration(operation, true, desired);
        log('Remote ' + message.remoteId + ' 已修改串口参数：' + desired.baudRate + ' baud，数据位 ' + desired.dataBits +
            '，停止位 ' + desired.stopBits + '，校验 ' + desired.parity + '，流控 ' + desired.flowControl);
        showSuccess('Remote ' + message.remoteId + ' 已修改串口参数：' + SerialConfig.describe(previous) + ' → ' + SerialConfig.describe(desired), true);
    } catch (error) {
        if (isClosing || port !== physicalPort) { readSuspended = false; return; }
        try {
            // A failed close has uncertain device state. Do not claim rollback.
            if (phase === 'closing') throw new Error('原串口未能关闭');
            if (openedNew) {
                if (writer) { writer.releaseLock(); writer = null; }
                await physicalPort.close();
                closed = true;
            }
            if (isClosing || port !== physicalPort) { readSuspended = false; return; }
            if (closed) await physicalPort.open(previous);
            if (isClosing || port !== physicalPort) { readSuspended = false; return; }
            if (!writer) restartReading(previous);
            else {
                activeSerialConfig = previous;
                readSuspended = false;
                readTask = readData();
            }
            replySerialConfiguration(operation, false, previous, operation.code || 'configuration_failed');
            showError('Remote ' + message.remoteId + ' 修改参数失败或取消，已保留/恢复原参数 ' + SerialConfig.describe(previous) + '：' + error.message);
        } catch (rollbackError) {
            replySerialConfiguration(operation, false, previous, 'configuration_failed', false);
            isOpen = false;
            readSuspended = false;
            stopSharing();
            showError('串口参数修改及恢复失败，已停止共享：' + rollbackError.message);
            setTimeout(closePort, 0);
        }
    }
}
