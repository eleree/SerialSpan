const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Manifest = require('../static/js/esp32-manifest.js');

test('vendored Espressif flasher bundle stays pinned to the reviewed release hash', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '../static/vendor/esptool-js-0.7.0.js'));
    const hash = crypto.createHash('sha256').update(bundle).digest('hex');
    assert.equal(hash, '00ebe6fb0b202976d3e2a3c6b9a6bd438c26a81d2af6739c95ac276a64c1a84e');
    for (const name of ['esptool-js-0.7.0.LICENSE.txt', 'pako-2.1.0.LICENSE.txt', 'atob-lite-2.0.0.LICENSE.txt']) {
        assert(fs.existsSync(path.join(__dirname, '../static/vendor', name)), 'missing vendored license: ' + name);
    }
});

function bytes(values) { return Uint8Array.from(values); }
function file(name, value) {
    const data = bytes(value);
    return { name, size: data.length, async arrayBuffer() { return data.slice().buffer; } };
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function manifest(overrides = {}) {
    const boot = bytes([1, 2, 3, 4]);
    const app = bytes([9, 8, 7, 6]);
    return {
        format: Manifest.FORMAT,
        chip: 'ESP32-C3',
        version: 'test-1',
        flashMode: 'dio',
        flashFreq: '40m',
        flashSize: 'detect',
        images: [
            { file: 'bootloader.bin', address: '0x0', sha256: sha(boot) },
            { file: 'app.bin', address: '0x1000', sha256: sha(app) }
        ],
        ...overrides
    };
}

test('ESP32 manifest accepts an explicit C3 image layout and produces ordered byte images', async () => {
    const parsed = Manifest.parse(JSON.stringify(manifest()));
    const checked = await Manifest.verify(parsed, [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6])],
        'ESP32-C3 (revision v0.4)', '4MB', async data => sha(data));
    assert.equal(checked.chip, 'ESP32-C3');
    assert.equal(checked.totalBytes, 8);
    assert.equal(checked.flashSize, '4MB');
    assert.deepEqual(checked.fileArray.map(image => [image.address, [...image.data]]), [
        [0, [1, 2, 3, 4]], [0x1000, [9, 8, 7, 6]]
    ]);
});

test('ESP32 manifest accepts the detected S3 revision name only when the package targets S3', async () => {
    const parsed = Manifest.parse(JSON.stringify(manifest({ chip: 'ESP32-S3' })));
    const checked = await Manifest.verify(parsed, [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6])],
        'ESP32-S3 (QFN56) (revision v0.2)', '8MB', async data => sha(data));
    assert.equal(checked.chip, 'ESP32-S3');
    await assert.rejects(Manifest.verify(parsed, [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6])],
        'ESP32-C3 (revision v0.4)', '8MB', async data => sha(data)), /芯片与清单不匹配/);
});

test('ESP32 manifest rejects unknown format, chip, keys, traversal names, and unaligned addresses', () => {
    assert.throws(() => Manifest.parse('{'), /JSON/);
    assert.throws(() => Manifest.parse(JSON.stringify(manifest({ format: 'other' }))), /格式/);
    assert.throws(() => Manifest.parse(JSON.stringify(manifest({ chip: 'ESP32' }))), /ESP32-C3/);
    assert.throws(() => Manifest.parse(JSON.stringify({ ...manifest(), flashFrequence: '40m' })), /不支持的字段/);
    assert.throws(() => Manifest.parse(JSON.stringify(manifest({ images: [{ ...manifest().images[0], file: '../app.bin' }] }))), /纯文件名/);
    assert.throws(() => Manifest.parse(JSON.stringify(manifest({ images: [{ ...manifest().images[0], address: '0x1001' }] }))), /4 KiB/);
});

test('ESP32 manifest rejects overlapping ranges, missing files, and hash mismatches before flashing', async () => {
    const overlap = manifest({ images: [
        { file: 'first.bin', address: '0x0', sha256: sha(bytes([1])) },
        { file: 'second.bin', address: '0x0', sha256: sha(bytes([2])) }
    ] });
    const parsedOverlap = Manifest.parse(JSON.stringify(overlap));
    await assert.rejects(Manifest.verify(parsedOverlap, [file('first.bin', [1]), file('second.bin', [2])],
        'ESP32-C3', '4MB', async data => sha(data)), /重叠/);

    const parsed = Manifest.parse(JSON.stringify(manifest()));
    await assert.rejects(Manifest.verify(parsed, [file('bootloader.bin', [1, 2, 3, 4])],
        'ESP32-C3', '4MB', async data => sha(data)), /缺少清单/);
    await assert.rejects(Manifest.verify(parsed, [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6]), file('unused.bin', [5])],
        'ESP32-C3', '4MB', async data => sha(data)), /未列在清单/);
    await assert.rejects(Manifest.verify(parsed, [file('bootloader.bin', [0, 0, 0, 0]), file('app.bin', [9, 8, 7, 6])],
        'ESP32-C3', '4MB', async data => sha(data)), /SHA-256/);
});

test('ESP32 manifest validates detected chip and flash bounds before producing write requests', async () => {
    const parsed = Manifest.parse(JSON.stringify(manifest()));
    const files = [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6])];
    await assert.rejects(Manifest.verify(parsed, files, 'ESP32', '4MB', async data => sha(data)), /芯片与清单不匹配/);
    await assert.rejects(Manifest.verify(parsed, files, 'ESP32-C3', undefined, async data => sha(data)), /无法检测 Flash/);
    const tooLarge = Manifest.parse(JSON.stringify(manifest({
        images: [{ ...manifest().images[0], address: '0x400000' }]
    })));
    await assert.rejects(Manifest.verify(tooLarge, [file('bootloader.bin', [1, 2, 3, 4])],
        'ESP32-C3', '4MB', async data => sha(data)), /超出设备 Flash/);
});

test('Manual images preserve explicit addresses, bytes and Flash settings without a JSON manifest', async () => {
    const result = await Manifest.prepareManual([
        { file: 'app.bin', address: '0x20000' }, { file: 'boot.bin', address: '0x0' }
    ], [file('boot.bin', [1, 0, 0xff]), file('app.bin', [0xc0, 0xdb, 7])],
    'ESP32-S3 (QFN56) (revision v0.2)', '8MB', { flashMode: 'qio', flashFreq: '80m' }, async data => sha(data));
    assert.equal(result.hashMode, 'computed');
    assert.equal(result.flashMode, 'qio');
    assert.equal(result.flashFreq, '80m');
    assert.deepEqual(result.fileArray.map(image => [image.address, [...image.data]]), [
        [0x20000, [0xc0, 0xdb, 7]], [0, [1, 0, 0xff]]
    ]);
    assert.equal(result.images[0].sha256, sha(bytes([0xc0, 0xdb, 7])));
});

test('Manual images reject missing/unaligned/overflowing addresses, overlaps and wrong selections', async () => {
    const files = [file('a.bin', [1, 2]), file('b.bin', [3, 4])];
    const check = (layout, selected = files, chip = 'ESP32-S3', size = '8MB') => Manifest.prepareManual(
        layout, selected, chip, size, { flashMode: 'dio', flashFreq: '40m' }, async data => sha(data));
    await assert.rejects(check([{ file: 'a.bin', address: '' }], [files[0]]), /地址/);
    await assert.rejects(check([{ file: 'a.bin', address: '10000' }], [files[0]]), /地址/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x1001' }], [files[0]]), /对齐/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x800000' }], [files[0]]), /超出/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x0' }, { file: 'b.bin', address: '0x0' }]), /重叠/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x0' }]), /不一致/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x0' }], [files[1]]), /缺少/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x0' }], [files[0]], 'ESP32'), /chip/);
    await assert.rejects(check([{ file: 'a.bin', address: '0x0' }], [files[0]], 'ESP32-S3', ''), /容量/);
    await assert.rejects(check([]), /images/);
});

test('Manual images bound file count and allocation before reading oversized or empty files', async () => {
    const settings = { flashMode: 'dio', flashFreq: '40m' };
    const huge = { name: 'huge.bin', size: 32 * 1024 * 1024 + 1,
        async arrayBuffer() { throw new Error('oversized allocation attempted'); } };
    await assert.rejects(Manifest.prepareManual([{ file: huge.name, address: '0x0' }], [huge],
        'ESP32-S3', '64MB', settings, sha), /32 MiB/);
    await assert.rejects(Manifest.prepareManual([{ file: 'empty.bin', address: '0x0' }], [file('empty.bin', [])],
        'ESP32-S3', '8MB', settings, sha), /为空/);
    const nine = Array.from({ length: 9 }, (_, i) => ({ file: i + '.bin', address: '0x' + (i * 4096).toString(16) }));
    await assert.rejects(Manifest.prepareManual(nine, [], 'ESP32-S3', '8MB', settings, sha), /images/);
});

function flasherPage(remoteBridge = null) {
    const vm = require('node:vm');
    const { Element } = require('./browser-harness.cjs');
    const elements = new Map();
    const defaults = { esp32FlashMode: 'dio', esp32FlashFreq: '40m' };
    const sandbox = { ShareSerialESP32Manifest: Manifest, Uint8Array, console,
        createFlasherSDKLoader: () => () => sandbox.loadSDK(),
        loadSDK: async () => { throw new Error('test SDK unavailable'); },
        SerialConfig: require('../static/js/serial-config.js'),
        WebSocket: { OPEN: 1, CLOSING: 2 }, clearInterval, setInterval,
        document: {
            getElementById(id) {
                if (!elements.has(id)) { const e = new Element(); e.value = defaults[id] || ''; e.files = []; elements.set(id, e); }
                return elements.get(id);
            }, createElement() { return new Element(); }
        }
    };
    if (remoteBridge) sandbox.ShareSerialRemote = remoteBridge;
    const context = vm.createContext(sandbox);
    const script = fs.readFileSync(path.join(__dirname, '../static/js/esp32-flasher.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    if (!remoteBridge) run(`Object.assign(state,{ws:{readyState:1,send(value){(globalThis.outgoing??=[]).push(JSON.parse(value))},close(){}},grantId:'grant',localId:'ABC23',remoteId:'remote',
        portId:'usb',access:'control',paused:false,flashProtocol:1,serialSignalsProtocol:1,
        serialConfig:{baudRate:115200},device:{fail(){}},loader:{},chipName:'ESP32-S3',flashSize:'8MB',
        flashActive:true,flashOwnerId:'remote',flashSessionId:'session'});updateControls();`);
    return { elements, run, sandbox };
}

test('Remote ESP32 tool adopts the existing Remote grant and does not bind another connection form', () => {
    const socket={readyState:1,bufferedAmount:0,sent:[],send(value){this.sent.push(JSON.parse(value))},close(){this.readyState=3}};
    const serialConfig={baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'};
    const connectMessage={type:'connect',version:3,requestId:'request',localId:'ABC23',remoteId:'REM23',portId:'usb',
        access:'control',grantId:'existing-grant',writeEpoch:4,paused:false,flashActive:false,flashOwnerId:'',
        flashProtocol:1,serialSignalsProtocol:1,configProtocol:1,serialConfig,configRevision:2,configuring:false};
    const snapshot={ws:socket,localId:'ABC23',remoteId:'REM23',portId:'usb',isConnected:true,isPending:false,pendingRequestId:'',
        grantId:'existing-grant',writeEpoch:4,access:'control',paused:false,flashActive:false,flashOwnerId:'',flashSessionId:'',
        flashProtocol:1,serialSignalsProtocol:1,serialConfig,configRevision:2,configuring:false,lastConnectMessage:connectMessage};
    let listener;
    const bridge={getSnapshot:()=>snapshot,subscribe(callback){listener=callback;callback({snapshot,message:null});return()=>{}},disconnect(){}};
    const page=flasherPage(bridge);
    assert.equal(page.run('state.ws===ShareSerialRemote.getSnapshot().ws'),true);
    assert.equal(page.run('state.grantId'),'existing-grant');
    assert.equal(page.run('state.remoteId'),'REM23');
    assert.equal(page.elements.get('connectBtn').listeners.click,undefined,'the shared connection form has one owner');
    assert.deepEqual(socket.sent,[],'adopting the existing grant must not send a second connection request');
    assert.equal(typeof listener,'function');
});

function selectManual(page, files) {
    page.elements.get('esp32ImageFiles').files = files;
    page.run('resetImageSelection()');
    return page.elements.get('esp32ImageRows').children.map(tr => tr.children[2].children[0]);
}

function typeAddress(input, value) { input.value = value; input.listeners.input(); }

test('Remote manual address editing invalidates prior confirmation and passes actual offsets to the loader', async () => {
    const page = flasherPage();
    const inputs = selectManual(page, [file('a.bin', [1, 2]), file('b.bin', [3, 4])]);
    typeAddress(inputs[0], '0x0'); typeAddress(inputs[1], '0x10000');
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified.images[1].address'), 0x10000);
    assert.match(page.elements.get('esp32ManifestSummary').textContent, /SHA-256 已计算/);
    page.run('elements.esp32ConfirmFlash.checked=true;updateControls()');
    assert.equal(page.elements.get('esp32FlashBtn').disabled, false);
    typeAddress(inputs[1], '0x20000');
    assert.equal(page.run('state.verified'), null);
    assert.equal(page.elements.get('esp32ConfirmFlash').checked, false);
    assert.equal(page.elements.get('esp32FlashBtn').disabled, true);
    await page.run('verifyFirmware()');
    page.run(`state.loader.writeFlash=async options=>{globalThis.written=options.fileArray.map(image=>image.address)};
        state.loader.after=async()=>{};cleanupTransport=async()=>{};restoreOriginalConfig=async()=>{};
        endFlashSession=async()=>{};elements.esp32ConfirmFlash.checked=true;`);
    await page.run('flashFirmware()');
    assert.equal(JSON.stringify(page.sandbox.written), '[0,131072]');
});

test('BIN row overlaps cannot be confirmed and unchecked files are excluded', async () => {
    const page = flasherPage();
    selectManual(page, [file('bootloader.bin', [1, 2, 3, 4]), file('app.bin', [9, 8, 7, 6])]);
    const rows = page.elements.get('esp32ImageRows').children;
    typeAddress(rows[0].children[2].children[0], '0x0');
    typeAddress(rows[1].children[2].children[0], '0x0');
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified'), null);
    assert.match(page.elements.get('errorMessage').textContent, /重叠/);
    const include = rows[0].children[0].children[0]; include.checked = false; include.listeners.change();
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified.images.length'), 1);
    assert.equal(page.run('state.verified.images[0].address'), 0);
    assert.equal(page.run('state.verified.images[0].sha256'), sha(bytes([9, 8, 7, 6])));
});

test('A form change during asynchronous hashing cannot restore a stale verified address', async () => {
    const page = flasherPage();
    const inputs = selectManual(page, [file('a.bin', [1])]); typeAddress(inputs[0], '0x0');
    let release;
    const slow = { name: 'a.bin', size: 1, arrayBuffer: () => new Promise(resolve => { release = () => resolve(bytes([1]).buffer); }) };
    page.elements.get('esp32ImageFiles').files = [slow];
    page.sandbox.slowFile = slow;
    page.run('state.layout[0].fileObject = slowFile');
    const verifying = page.run('verifyFirmware()');
    assert.equal(typeof release, 'function');
    typeAddress(inputs[0], '0x1000');
    release(); await verifying;
    assert.equal(page.run('state.verified'), null);
    assert.equal(page.elements.get('esp32FlashBtn').disabled, true);
});

test('Disconnecting during BIN hashing discards the result instead of restoring the old layout', async () => {
    const page = flasherPage();
    let release;
    const slow = { name: 'app.bin', size: 1,
        arrayBuffer: () => new Promise(resolve => { release = () => resolve(bytes([1]).buffer); }) };
    const inputs = selectManual(page, [slow]); typeAddress(inputs[0], '0x10000');
    const reading = page.run('verifyFirmware()');
    page.run("connectionLost('test disconnect')");
    release(); await reading;
    assert.equal(page.run('state.verified'), null);
    assert.equal(page.run('state.layout.filter(row=>row.fileObject).length'), 0);
    assert.equal(page.elements.get('esp32FlashBtn').disabled, true);
});

test('Manual Flash parameter changes clear confirmation and excessive file selection disables verification', async () => {
    const page = flasherPage();
    const inputs = selectManual(page, [file('a.bin', [1])]); typeAddress(inputs[0], '0x0');
    await page.run('verifyFirmware()');
    page.run('elements.esp32ConfirmFlash.checked=true;updateControls()');
    page.elements.get('esp32FlashFreq').value = '80m';
    page.elements.get('esp32FlashFreq').listeners.change();
    assert.equal(page.run('state.verified'), null);
    assert.equal(page.elements.get('esp32ConfirmFlash').checked, false);
    page.elements.get('esp32ImageFiles').files = Array.from({ length: 9 }, (_, i) => file(i + '.bin', [1]));
    page.run('resetImageSelection()');
    assert.equal(page.elements.get('esp32VerifyBtn').disabled, true);
});

test('Desktop-style rows select a file independently while preserving its typed address', async () => {
    const page = flasherPage();
    const inputs = selectManual(page, []);
    assert.equal(inputs.length, 8);
    typeAddress(inputs[2], '0x2000');
    const row = page.elements.get('esp32ImageRows').children[2];
    const picker = row.children[1].children[0].children[2];
    picker.files = [file('image.bin', [0xc0, 0xff, 1])];
    picker.listeners.change();
    assert.equal(page.run('state.layout[2].file'), 'image.bin');
    assert.equal(page.run('state.layout[2].address'), '0x2000');
    assert.equal(page.run('state.layout[2].selected'), true);
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified.fileArray.length'), 1);
    assert.equal(page.run('state.verified.fileArray[0].address'), 0x2000);
});

test('Replacing a BIN row clears confirmation and hashes the newly selected bytes', async () => {
    const page = flasherPage();
    const inputs = selectManual(page, []); typeAddress(inputs[0], '0x0');
    let picker = page.elements.get('esp32ImageRows').children[0].children[1].children[0].children[2];
    picker.files = [file('first.bin', [1, 2, 3, 4])]; picker.listeners.change();
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified.images[0].sha256'), sha(bytes([1, 2, 3, 4])));
    page.run('elements.esp32ConfirmFlash.checked=true;updateControls()');
    picker = page.elements.get('esp32ImageRows').children[0].children[1].children[0].children[2];
    picker.files = [file('replacement.bin', [5, 6, 7, 8])]; picker.listeners.change();
    assert.equal(page.run('state.verified'), null);
    assert.equal(page.elements.get('esp32ConfirmFlash').checked, false);
    await page.run('verifyFirmware()');
    assert.equal(page.run('state.verified.images[0].file'), 'replacement.bin');
    assert.equal(page.run('state.verified.images[0].sha256'), sha(bytes([5, 6, 7, 8])));
});

test('ESP32 page exposes only BIN selection and has no manifest importer or source selector', () => {
    const html = fs.readFileSync(path.join(__dirname, '../static/remote.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../static/js/esp32-flasher.js'), 'utf8');
    assert.doesNotMatch(html, /esp32FirmwareMode|esp32ManifestFile|application\/json|导入清单/);
    assert.doesNotMatch(script, /readManifestFile|firmwareModeChanged|effectiveManifest/);
    const page = flasherPage();
    assert.equal(page.elements.has('esp32FirmwareMode'), false);
    assert.equal(page.elements.has('esp32ManifestFile'), false);
    assert.equal(page.elements.get('esp32ImageRows').children.length, 8);
});

test('STOP remains available while busy and immediately disconnects and invalidates the flash owner', async () => {
    const page = flasherPage();
    page.run('state.busy=true;state.device.fail=()=>{globalThis.deviceFailed=true};updateControls()');
    assert.equal(page.elements.get('esp32StopBtn').disabled, false);
    await page.elements.get('esp32StopBtn').listeners.click();
    assert.equal(page.run('state.flashSessionId'), '');
    assert.equal(page.run('state.grantId'), '');
    assert.equal(page.run('state.device'), null);
    assert.equal(page.sandbox.deviceFailed, true);
    assert.equal(page.sandbox.outgoing[0].type, 'disconnect');
    assert.equal(page.elements.get('esp32FlashBtn').disabled, true);
});

test('SDK preparation fails without locking the serial port and can be retried', async () => {
    const page = flasherPage();
    page.run(`state.flashActive=false;state.flashSessionId='';globalThis.starts=0;
        beginFlashSession=async()=>{starts++;throw new Error('test lock refused')};`);
    await page.run('startDeviceDetection()');
    assert.equal(page.run('starts'), 0);
    assert.match(page.elements.get('errorMessage').textContent, /准备失败/);
    assert.equal(page.run('state.busy'), false);
    assert.equal(page.elements.get('esp32ConnectBtn').disabled, false);
    page.sandbox.loadSDK = async () => ({ ESPLoader: class {}, Transport: class {} });
    await page.run('startDeviceDetection()');
    assert.equal(page.run('starts'), 1);
    assert.match(page.elements.get('errorMessage').textContent, /test lock refused/);
});

test('STOP during SDK preparation fences a late load even after a new connection is approved', async () => {
    const page = flasherPage();
    let release;
    page.sandbox.loadSDK = () => new Promise(resolve => { release = resolve; });
    page.run(`state.flashActive=false;state.flashSessionId='';globalThis.starts=0;
        beginFlashSession=async()=>{starts++;throw new Error('must not run')};`);
    const preparing = page.run('startDeviceDetection()');
    assert.equal(page.run('state.preparingTool && state.busy'), true);
    await page.elements.get('esp32StopBtn').listeners.click();
    assert.equal(page.run('state.busy'), false);
    page.run(`state.ws={readyState:1,send(){},close(){}};state.grantId='new-grant';state.paused=false;`);
    release({ ESPLoader: class {}, Transport: class {} });
    await preparing;
    assert.equal(page.run('starts'), 0);
    assert.equal(page.run('state.grantId'), 'new-grant');
});

function prepareFlashTest(page) {
    page.run(`state.verified={chip:'ESP32-S3',totalBytes:400,images:[{file:'boot.bin',size:100},{file:'app.bin',size:300}],fileArray:[]};
        elements.esp32ConfirmFlash.checked=true;globalThis.phases=[];
        state.loader.after=async()=>{phases.push('reset')};
        restoreOriginalConfig=async()=>{phases.push('restore');return true};
        cleanupTransport=async()=>{phases.push('cleanup')};
        endFlashSession=async()=>{phases.push('release');state.flashActive=false;state.flashSessionId=''};`);
}

test('Compressed multi-image progress is weighted by raw image size and waits for reset and lock release', async () => {
    const page = flasherPage();
    prepareFlashTest(page);
    page.run(`state.loader.writeFlash=async options=>{globalThis.progress=options.reportProgress};
        state.loader.after=()=>new Promise(resolve=>{globalThis.resetDone=resolve});
        endFlashSession=()=>new Promise(resolve=>{globalThis.releaseDone=()=>{state.flashActive=false;state.flashSessionId='';resolve()}});`);
    const writing = page.run('flashFirmware()');
    page.run('progress(0,5,10)');
    assert.equal(page.elements.get('esp32Progress').value, 12);
    page.run('progress(0,10,10)');
    assert.equal(page.elements.get('esp32Progress').value, 25);
    page.run('progress(1,20,40)');
    assert.equal(page.elements.get('esp32Progress').value, 62);
    page.run('progress(1,40,40)');
    assert.equal(page.elements.get('esp32Progress').value, 99);
    page.run('progress(9,1,2);progress(1,NaN,40);progress(1,1,0)');
    assert.equal(page.elements.get('esp32Progress').value, 99);
    await new Promise(setImmediate);
    assert.equal(page.elements.get('successMessage').classList.contains('hidden'), true);
    page.run('resetDone()');
    await new Promise(setImmediate);
    assert.equal(page.elements.get('esp32Progress').value, 99);
    assert.equal(page.elements.get('successMessage').classList.contains('hidden'), true);
    page.run('releaseDone()');
    await writing;
    assert.equal(page.elements.get('esp32Progress').value, 100);
    assert.match(page.elements.get('successMessage').textContent, /烧录完成/);
    assert.equal(page.run('state.busy'), false);
});

test('Reset, configuration restoration and lock release errors cannot report successful flashing', async t => {
    for (const phase of ['reset', 'restore', 'release']) await t.test(phase, async () => {
        const page = flasherPage();
        prepareFlashTest(page);
        page.run(`state.loader.writeFlash=async options=>options.reportProgress(1,40,40)`);
        if (phase === 'reset') page.run(`state.loader.after=async()=>{throw new Error('reset rejected')}`);
        if (phase === 'restore') page.run('restoreOriginalConfig=async()=>false');
        if (phase === 'release') page.run(`endFlashSession=async()=>{throw new Error('release rejected')}`);
        await page.run('flashFirmware()');
        assert.equal(page.elements.get('esp32Progress').value, 99);
        assert.equal(page.elements.get('successMessage').classList.contains('hidden'), true);
        assert.equal(page.elements.get('errorMessage').classList.contains('hidden'), false);
        assert.match(page.elements.get('errorMessage').textContent, /收尾未完成/);
        assert.equal(page.run('state.busy'), false);
        if (phase === 'release') assert.equal(page.run('state.grantId'), '');
    });
});

test('A stopped write cannot update progress or clear a new connection and its selected files', async () => {
    const page = flasherPage();
    prepareFlashTest(page);
    page.run(`state.loader.writeFlash=options=>{globalThis.progress=options.reportProgress;return new Promise(resolve=>{globalThis.writeDone=resolve})}`);
    const writing = page.run('flashFirmware()');
    page.run('progress(0,5,10)');
    await page.elements.get('esp32StopBtn').listeners.click();
    page.run(`state.ws={readyState:1,send(){},close(){}};state.grantId='new-grant';state.paused=false;state.flashActive=false;`);
    selectManual(page, [file('new.bin', [1])]);
    const progress = page.elements.get('esp32Progress').value;
    page.run('progress(1,40,40);writeDone()');
    await writing;
    assert.equal(page.elements.get('esp32Progress').value, progress);
    assert.equal(page.run('state.grantId'), 'new-grant');
    assert.equal(page.run('state.layout[0].file'), 'new.bin');
    assert.equal(page.run('state.busy'), false);
    assert.deepEqual(Array.from(page.sandbox.phases), [], 'old cleanup must not affect the new connection');
});
