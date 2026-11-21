const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadPortModule() {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/remote-serial-port.js'));
    const url = 'data:text/javascript;base64,' + source.toString('base64');
    return import(url);
}

test('Flasher SDK loads on demand, shares concurrent requests, and caches a validated module', async () => {
    const { createFlasherSDKLoader } = await loadPortModule();
    let imports = 0, resolveImport;
    const cleared = [];
    const sdk = { ESPLoader: class {}, Transport: class {} };
    const load = createFlasherSDKLoader({
        importModule() { imports++; return new Promise(resolve => { resolveImport = resolve; }); },
        schedule(callback, timeout) { assert.equal(timeout, 180000); return 42; },
        cancel(timer) { cleared.push(timer); }
    });
    assert.equal(imports, 0, 'page bootstrap must not fetch the flasher bundle');
    const first = load(), second = load();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(imports, 1);
    resolveImport(sdk);
    assert.equal(await first, sdk);
    assert.equal(await load(), sdk);
    assert.equal(imports, 1);
    assert.deepEqual(cleared, [42]);
});

test('Flasher SDK can retry after a network error, invalid module or timeout without accepting a late result', async () => {
    const { createFlasherSDKLoader } = await loadPortModule();
    let attempts = 0, expire, resolveLate;
    const requestedAttempts = [];
    const sdk = { ESPLoader: class {}, Transport: class {} }, cleared = [];
    const load = createFlasherSDKLoader({
        importModule(attempt) {
            requestedAttempts.push(attempt);
            attempts++;
            if (attempts === 1) throw new Error('offline');
            if (attempts === 2) return { ESPLoader: class {} };
            if (attempts === 3) return new Promise(resolve => { resolveLate = resolve; });
            return sdk;
        },
        schedule(callback) { expire = callback; return attempts + 1; },
        cancel(timer) { cleared.push(timer); }
    });
    await assert.rejects(load(), /offline/);
    await assert.rejects(load(), /加载不完整/);
    const timedOut = load();
    await Promise.resolve();
    expire();
    await assert.rejects(timedOut, /准备超时/);
    const retry = load();
    resolveLate({ ESPLoader: class {}, Transport: class {} });
    assert.equal(await retry, sdk, 'the previous timed-out import cannot replace the new attempt');
    assert.equal(await load(), sdk);
    assert.equal(attempts, 4);
    assert.deepEqual(requestedAttempts, [0, 1, 2, 3]);
    assert.deepEqual(cleared, [1, 2, 3, 4]);
});

test('Remote serial adapter preserves binary data, awaits baud and signal RPCs, and never closes the Local port', async () => {
    const { createRemoteSerialPort } = await loadPortModule();
    const writes = [], bauds = [], signals = [];
    const device = createRemoteSerialPort({
        async write(bytes) { writes.push([...bytes]); },
        async setBaudRate(value) { bauds.push(value); },
        async setSignals(value) { signals.push({ ...value }); }
    });
    await device.open({ baudRate: 115200 });
    assert.deepEqual(bauds, [115200]);

    const reader = device.readable.getReader();
    const received = reader.read();
    assert.equal(device.push([0x00, 0xc0, 0xdb, 0xff]), true);
    assert.deepEqual([...(await received).value], [0x00, 0xc0, 0xdb, 0xff]);
    await reader.cancel();
    reader.releaseLock();

    const writer = device.writable.getWriter();
    await writer.write(Uint8Array.from([0x41, 0x00, 0xff]));
    writer.releaseLock();
    await device.setBaudRate(460800);
    await device.setSignals({ dataTerminalReady: false, requestToSend: true });
    assert.deepEqual(writes, [[0x41, 0x00, 0xff]]);
    assert.deepEqual(bauds, [115200, 460800]);
    assert.deepEqual(signals, [{ dataTerminalReady: false, requestToSend: true }]);

    await device.close();
    assert.equal(device.opened, false);
    assert.equal(device.push([1]), false);
    await device.open({ baudRate: 115200 });
    assert.deepEqual(bauds, [115200, 460800, 115200]);
    await device.close();
});

test('ESP32 page places the shared-code bar before its fixed tool sidebar and does not request browser USB', () => {
    const remote = fs.readFileSync(path.join(__dirname, '../static/remote.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../static/css/remote.css'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../static/js/esp32-flasher.js'), 'utf8');
    assert(remote.indexOf('id="connectSection"') < remote.indexOf('class="workspace-body"'));
    assert(remote.includes('id="connectedTopInfo"'));
    assert(remote.includes('id="localIdInput"'));
    assert.match(remote, /id="esp32Panel"[^>]*aria-label="ESP32 串口烧录工具"/);
    assert.match(css, /\.remote-connect-toolbar\s*\{[^}]*position:\s*sticky/s);
    assert.match(css, /\.remote-tools-nav\s*\{[^}]*position:\s*sticky/s);
    assert.doesNotMatch(script + remote, /navigator\.serial|requestPort\s*\(/);
});

test('Remote ROM sync accepts a delayed relayed reply beyond the bundled direct USB deadline', async () => {
    const { createRemoteSerialPort, configureRemoteTransport } = await loadPortModule();
    const bundle = fs.readFileSync(path.join(__dirname, '../static/vendor/esptool-js-0.7.0.js'));
    const { ESPLoader, Transport } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
    let replyTimer;
    const device = createRemoteSerialPort({
        async setBaudRate() {},
        async setSignals() {},
        async write(bytes) {
            assert.equal(bytes[2], 0x08, 'expected a real SLIP-encoded ROM SYNC command');
            const response = [0xc0, 0x01, 0x08, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0xc0];
            replyTimer = setTimeout(() => device.push(Array.from({ length: 8 }, () => response).flat()), 220);
        }
    });
    const transport = configureRemoteTransport(new Transport(device, false));
    await transport.connect(115200);
    const reading = transport.readLoop();
    try {
        const loader = new ESPLoader({ transport, baudrate: 115200,
            terminal: { clean() {}, write() {}, writeLine() {} } });
        await loader.sync();
        assert.equal(loader.syncStubDetected, false);
    } finally {
        clearTimeout(replyTimer);
        await transport.disconnect();
        await reading;
    }
});

test('Remote packet timeout preserves longer operation budgets and read errors', async () => {
    const { configureRemoteTransport } = await loadPortModule();
    const failure = new Error('connection closed');
    const budgets = [];
    const transport = { async read(timeout) { assert.equal(this, transport); budgets.push(timeout); throw failure; } };
    configureRemoteTransport(transport);
    await assert.rejects(transport.read(45000), error => error === failure);
    await assert.rejects(transport.read(100), error => error === failure);
    await assert.rejects(transport.read(), error => error === failure);
    assert.deepEqual(budgets, [45000, 30000, 30000]);
});

test('Compressed flashing waits for each delayed device ACK and preserves bytes across bounded blocks', async () => {
    const { createRemoteSerialPort, configureRemoteTransport, REMOTE_FLASH_BLOCK_BYTES } = await loadPortModule();
    const bundle = fs.readFileSync(path.join(__dirname, '../static/vendor/esptool-js-0.7.0.js'));
    const { ESPLoader, Transport } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
    const image = Uint8Array.from(require('node:crypto').randomBytes(8192));
    const blocks = [];
    const timers = [];
    let releaseFirstACK, firstBlock;
    const firstBlockSeen = new Promise(resolve => { firstBlock = resolve; });
    const device = createRemoteSerialPort({
        async setBaudRate() {}, async setSignals() {},
        async write(wire) {
            const packet = [];
            for (let i = 1; i < wire.length - 1; i++) {
                packet.push(wire[i] === 0xdb ? (wire[++i] === 0xdc ? 0xc0 : 0xdb) : wire[i]);
            }
            const data = Uint8Array.from(packet);
            const view = new DataView(data.buffer);
            const op = data[1];
            const ack = () => device.push([0xc0, 1, op, 2, 0, 0, 0, 0, 0, 0, 0, 0xc0]);
            if (op === 0x10) assert.equal(view.getUint32(16, true), 2048);
            if (op === 0x11) {
                const size = view.getUint32(8, true);
                assert(size <= 2048 && size > 0);
                assert(wire.length <= 2 * (2048 + 24) + 2, 'bounded worst-case SLIP expansion');
                assert.equal(view.getUint32(12, true), blocks.length, 'blocks must advance in order without premature retry');
                blocks.push(data.slice(24));
                if (blocks.length === 1) {
                    releaseFirstACK = ack;
                    firstBlock();
                    return;
                }
            }
            timers.push(setTimeout(ack, 25));
        }
    });
    const transport = configureRemoteTransport(new Transport(device, false));
    await transport.connect(115200);
    const reading = transport.readLoop();
    const loader = new ESPLoader({ transport, baudrate: 115200,
        terminal: { clean() {}, write() {}, writeLine() {} } });
    loader.chip = { CHIP_NAME: 'ESP32-S3', BOOTLOADER_FLASH_OFFSET: 0 };
    loader.IS_STUB = true;
    loader.FLASH_WRITE_SIZE = REMOTE_FLASH_BLOCK_BYTES;
    const writing = loader.writeFlash({ fileArray: [{ address: 0x10000, data: image }],
        flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', compress: true, eraseAll: false });
    try {
        await firstBlockSeen;
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(blocks.length, 1, 'unacknowledged data must not be pipelined on a slow link');
        releaseFirstACK();
        await writing;
        assert(blocks.length > 1);
        assert.deepEqual(require('node:zlib').inflateSync(Buffer.concat(blocks)), Buffer.from(image));
    } finally {
        timers.forEach(clearTimeout);
        await transport.disconnect();
        await reading;
    }
});

test('Flash transport stops at a bounded browser backlog and rejects writes after pause', () => {
    const script = fs.readFileSync(path.join(__dirname, '../static/js/esp32-flasher.js'), 'utf8');
    const sendFunction = script.slice(script.indexOf('function sendFlashData('), script.indexOf('function setRemoteSignals('));
    const sent = [];
    const state = { ws: { bufferedAmount: 0, send: value => sent.push(JSON.parse(value)) },
        flashActive: true, flashSessionId: 'current-session', paused: false,
        portId: 'usb', grantId: 'grant', writeEpoch: 7 };
    const send = new Function('state', 'connected', 'SerialData', sendFunction + '; return sendFlashData;')(
        state, () => true, { MAX_SEND_BYTES: 16384, toBase64: bytes => Buffer.from(bytes).toString('base64') });
    send(Uint8Array.from([0, 0xc0, 0xff]));
    assert.equal(sent[0].data, 'AMD/');
    assert.equal(sent[0].flashSessionId, 'current-session');
    state.ws.bufferedAmount = 65537;
    assert.throws(() => send(Uint8Array.from([1])), /积压/);
    state.ws.bufferedAmount = 0;
    state.paused = true;
    assert.throws(() => send(Uint8Array.from([1])), /暂停/);
    assert.equal(sent.length, 1, 'rejected operations must never enter the WebSocket queue');
});
