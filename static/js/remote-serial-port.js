export const REMOTE_FLASH_BLOCK_BYTES = 2048;

export function createFlasherSDKLoader({
    // Chrome can retain a failed module URL. A manual retry needs a fresh URL.
    importModule = attempt => import('/static/vendor/esptool-js-0.7.0.js' + (attempt ? '?retry=' + attempt : '')),
    timeoutMs = 180000,
    schedule = setTimeout,
    cancel = clearTimeout
} = {}) {
    let pending = null;
    let attempt = 0;
    return function load() {
        if (pending) return pending;
        let timer;
        pending = new Promise((resolve, reject) => {
            timer = schedule(() => reject(new Error('烧录工具准备超时，请检查网络后重试。')), timeoutMs);
            const currentAttempt = attempt++;
            Promise.resolve().then(() => importModule(currentAttempt)).then(module => {
                if (typeof module?.ESPLoader !== 'function' || typeof module?.Transport !== 'function') {
                    throw new Error('烧录工具加载不完整，请刷新页面后重试。');
                }
                resolve(module);
            }).catch(reject);
        }).catch(error => {
            pending = null;
            throw error;
        }).finally(() => cancel(timer));
        return pending;
    };
}

export function configureRemoteTransport(transport) {
    const read = transport.read.bind(transport);
    // The bundled ROM sync uses 100 ms for direct USB. Relayed replies can
    // arrive later; keep longer erase/write budgets and return as soon as data arrives.
    transport.read = (timeout = 30000) => read(Number.isFinite(timeout) ? Math.max(30000, timeout) : 30000);
    return transport;
}

export function createRemoteSerialPort(handlers) {
    let opened = false;
    let readable = null;
    let readableController = null;

    function createReadable() {
        readable = new ReadableStream({
            start(controller) { readableController = controller; },
            cancel() { readableController = null; }
        });
        return readable;
    }

    const device = {
        get readable() { return readable; },
        get writable() {
            if (!opened) return null;
            return new WritableStream({
                write(chunk) {
                    if (!opened) throw new Error('远端串口已关闭');
                    return handlers.write(Uint8Array.from(chunk));
                }
            });
        },
        getInfo() { return {}; },
        async open(options = {}) {
            if (opened) throw new Error('远端串口已打开');
            if (!Number.isSafeInteger(options.baudRate) || options.baudRate <= 0) throw new Error('波特率无效');
            await handlers.setBaudRate(options.baudRate);
            opened = true;
            createReadable();
        },
        async close() {
            opened = false;
            const controller = readableController;
            readableController = null;
            readable = null;
            try { controller?.close(); } catch {}
        },
        async setBaudRate(baudRate) {
            if (!opened) throw new Error('远端串口尚未打开');
            await handlers.setBaudRate(baudRate);
        },
        async setSignals(signals = {}) {
            if (!opened) throw new Error('远端串口尚未打开');
            const safe = {};
            if (typeof signals.dataTerminalReady === 'boolean') safe.dataTerminalReady = signals.dataTerminalReady;
            if (typeof signals.requestToSend === 'boolean') safe.requestToSend = signals.requestToSend;
            if (!Object.keys(safe).length) throw new Error('没有可设置的串口控制信号');
            await handlers.setSignals(safe);
        },
        push(data) {
            if (!opened || !readableController) return false;
            try { readableController.enqueue(Uint8Array.from(data)); return true; }
            catch { return false; }
        },
        fail(error) {
            const controller = readableController;
            readableController = null;
            try { controller?.error(error instanceof Error ? error : new Error(String(error))); } catch {}
        },
        get opened() { return opened; }
    };

    return device;
}
