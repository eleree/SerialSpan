const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, Element } = require('./browser-harness.cjs');
const SerialConfig = require('../static/js/serial-config.js');
const {setImmediate:turn}=require('node:timers/promises');

function localPeriodicFixture(){
    const page=browser('local.js'),writes=[];
    page.sandbox.testWriter={write:async bytes=>{writes.push([...bytes])}};
    page.run("writer=testWriter;isOpen=true;elements.sendInput.value='中';elements.lineEnding.value='crlf';elements.periodicInterval.value='100';updateState()");
    return {page,writes};
}

test('Local periodic sends preserve UTF-8 and line endings, snapshot input and clear counts independently',async()=>{
    const {page,writes}=localPeriodicFixture();
    page.run('togglePeriodicSend()');await page.run('writeChain');await turn();
    assert.deepEqual(writes,[[228,184,173,13,10]]);assert.equal(page.run('txBytes'),5);
    page.run("elements.sendInput.value='changed'");
    const timer=page.timers.filter(t=>t.delay===100&&!t.cancelled).at(-1);assert(timer);
    timer.callback();await page.run('writeChain');await turn();
    assert.deepEqual(writes[1],[228,184,173,13,10]);assert.equal(page.run('txBytes'),10);
    page.run('periodicSender.stop()');const count=writes.length;
    timer.callback();await turn();assert.equal(writes.length,count);
    page.run("recordSerial('RX',Uint8Array.of(228),'设备');clearCounts()");
    const logs=page.run('dataRecords.length');
    assert.equal(page.run('rxBytes+txBytes'),0);assert.equal(page.run('dataRecords.length'),logs);
    page.run("recordSerial('RX',Uint8Array.of(184,173),'设备')");
    assert.equal(page.run('dataRecords.at(-1).text'),'中');assert.equal(page.run('rxBytes'),2);
    page.run('clearLog()');assert.equal(page.run('rxBytes'),2);
});

test('Stopping Local periodic sends cancels a queued cycle before hardware and network loss permits standalone sends',async()=>{
    const {page,writes}=localPeriodicFixture();let release;
    page.sandbox.testWriter.write=async bytes=>{writes.push([...bytes]);if(writes.length===1)await new Promise(resolve=>{release=resolve})};
    page.run("enqueueWrite(Uint8Array.of(1),'本机');togglePeriodicSend()");await turn();assert(release);
    page.run('periodicSender.stop()');release();await page.run('writeChain');await turn();
    assert.deepEqual(writes,[[1]]);assert.equal(page.run('periodicSender.busy'),false);
    page.run("connectWebSocket();shareEnabled=true;registered=true;togglePeriodicSend()");await page.run('writeChain');await turn();
    page.run('stopSharing()');assert.equal(page.run('periodicSender.running'),true);
    page.timers.filter(t=>t.delay===100&&!t.cancelled).at(-1).callback();await page.run('writeChain');await turn();
    assert.equal(writes.length,3);
    page.run("serialConfigPending={id:'config'};updateState()");assert.equal(page.run('periodicSender.running'),false);
    page.run('serialConfigPending=null;updateState()');assert.equal(page.run('periodicSender.running'),false);
});

function remotePeriodicFixture(){
    const page=browser('remote.js');
    page.run("isConnected=true;ws=new WebSocket('wss://localhost/ws/remote');localId='ABC23';connectedPortId='usb';grantId='grant';writeEpoch=1;access='control';elements.sendInput.value='中';elements.sendCR.checked=true;elements.periodicInterval.value='100';updateWritePermission()");
    return page;
}

test('Remote restores a saved monitor target and reconnects with a fresh approval request',async()=>{
    const storage=new Map([['shareserial.remote.connection.v1',JSON.stringify({localId:'ABC23',access:'read',autoReconnect:true})]]);
    const page=browser('remote.js',{storage});page.sandbox.initialize();
    assert.equal(page.elements.get('localIdInput').value,'ABC23');
    assert.equal(page.elements.get('accessSelect').value,'read');
    const startup=page.run('autoReconnectTimer');assert.equal(startup.delay,0);startup.callback();await turn();
    assert.equal(page.sockets.length,1);
    assert.deepEqual(page.sockets[0].messages.find(message=>message.type==='connect'),{
        type:'connect',localId:'ABC23',access:'read',version:3,rxReplayProtocol:1,flashProtocol:1
    });
    page.run('elements.autoReconnect.listeners.change()');
    assert.equal(page.run('reconnectAccess'),'read','toggling reconnect while pending keeps the requested access');
    page.run("handleServerMessage({type:'connect_pending',localId:'ABC23',requestId:'REQ1',remoteId:'REM23',version:3,expiresIn:60});handleServerMessage({type:'connect',requestId:'REQ1',localId:'ABC23',portId:'usb',access:'read',grantId:'old-grant',writeEpoch:1,paused:false,version:3})");
    assert.equal(page.run('isConnected'),true);
    page.sockets[0].readyState=3;page.sockets[0].onclose({code:1006});
    assert.equal(page.run('grantId'),'');assert.equal(page.run('autoReconnectWanted'),true);
    const retry=page.run('autoReconnectTimer');assert.equal(retry.delay,3000);retry.callback();await turn();
    assert.equal(page.sockets.length,2);
    const retryRequest=page.sockets[1].messages.find(message=>message.type==='connect');
    assert.equal(retryRequest.localId,'ABC23');assert.equal(retryRequest.access,'read');assert.equal('grantId' in retryRequest,false);
    page.run('disconnectFromLocal()');
    assert.equal(page.run('autoReconnectWanted'),false);assert.equal(page.run('autoReconnectEnabled'),false);
    assert.equal(JSON.parse(storage.get('shareserial.remote.connection.v1')).autoReconnect,false);
});

test('Remote saves only the selected monitoring target, permission and reconnect preference',()=>{
    const storage=new Map(),page=browser('remote.js',{storage});page.sandbox.initialize();
    page.run("elements.localIdInput.value='DEF45';elements.accessSelect.value='control';connectToLocal()");
    assert.deepEqual(JSON.parse(storage.get('shareserial.remote.connection.v1')),
        {localId:'DEF45',access:'control',autoReconnect:true});
    assert.equal(page.sockets[0].messages.find(message=>message.type==='connect').grantId,undefined);
});

test('Remote retries an offline Local but stops after a manual approval denial',async()=>{
    const storage=new Map([['shareserial.remote.connection.v1',JSON.stringify({localId:'ABC23',access:'read',autoReconnect:true})]]);
    const page=browser('remote.js',{storage});page.sandbox.initialize();
    page.run('autoReconnectTimer.callback()');
    assert.equal(page.run('isPending'),true);
    page.run("handleServerMessage({type:'error',code:'local_not_found',error:'offline'})");
    assert.equal(page.run('autoReconnectWanted'),true);
    const retry=page.run('autoReconnectTimer');assert.equal(retry.delay,3000);retry.callback();
    assert.equal(page.sockets.length,2);assert.equal(page.run('isPending'),true);
    page.run("handleServerMessage({type:'error',code:'connection_denied',error:'denied'})");
    assert.equal(page.run('autoReconnectWanted'),false);assert.equal(page.run('autoReconnectEnabled'),false);
    assert.equal(page.run('autoReconnectTimer'),null);
    assert.equal(JSON.parse(storage.get('shareserial.remote.connection.v1')).autoReconnect,false);
});

test('Remote periodic counts encoded bytes and stops on pause, a new grant and disconnect',async()=>{
    const page=remotePeriodicFixture();
    page.run('togglePeriodicSend()');await turn();
    assert.equal(page.run('txBytes'),4);assert.equal(page.sockets[0].messages.length,1);
    const timer=page.timers.filter(t=>t.delay===100&&!t.cancelled).at(-1);assert(timer);
    page.run('remoteWritesPaused=true;updateWritePermission()');assert.equal(page.run('periodicSender.running'),false);
    page.run('remoteWritesPaused=false;updateWritePermission()');timer.callback();await turn();assert.equal(page.sockets[0].messages.length,1);
    page.run('togglePeriodicSend()');await turn();const next=page.timers.filter(t=>t.delay===100&&!t.cancelled).at(-1);
    page.run("grantId='new'");next.callback();await turn();assert.equal(page.run('periodicSender.running'),false);assert.equal(page.sockets[0].messages.length,2);
    page.run('setDisconnected()');assert.equal(page.elements.get('periodicSendBtn').disabled,true);
    page.run("access='read';isConnected=true;updateWritePermission();togglePeriodicSend()");assert.equal(page.run('periodicSender.running'),false);assert.equal(page.sockets[0].messages.length,2);
});

test('Remote uses the server FIFO for TX while a split P2P connection keeps direct RX',async()=>{
    const page=remotePeriodicFixture();let directCalls=0;
    page.sandbox.directTX=()=>{directCalls++;return Promise.resolve()};
    page.run('serialPeer={direct:true,txViaRelay:true,sendTX:directTX}');
    assert.equal(await page.run('submitRemoteBytes(Uint8Array.of(0,255))'),true);
    assert.equal(directCalls,0);
    assert.equal(page.sockets[0].messages.filter(message=>message.type==='send').length,1);
    assert.equal(page.sockets[0].messages.find(message=>message.type==='send').data,'AP8=');
    assert.equal(page.run('txBytes'),2);
});

test('Remote clear counts preserves the RX cursor, streamed decoder and history; failed TX is not counted',async()=>{
    const page=remotePeriodicFixture();
    page.run("rxReplayEnabled=true;rxStreamId='stream';handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'stream',rxSeq:1,data:'5A=='});clearCounts()");
    assert.equal(page.run('lastRxSeq'),1);assert.equal(page.run('records.length'),1);
    page.run("handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'stream',rxSeq:1,data:'5A=='});handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'stream',rxSeq:2,data:'uK0='})");
    assert.equal(page.run('rxBytes'),2);assert.equal(page.run('records.length'),2);assert.equal(page.run('records.at(-1).text'),'中');
    page.run('clearRx()');assert.equal(page.run('rxBytes'),2);
    page.sandbox.failedTX=()=>Promise.reject(Error('not submitted'));
    page.run('serialPeer={direct:true,sendTX:failedTX}');await page.run('sendData()');
    assert.equal(page.run('txBytes'),0);assert.equal(page.run("records.filter(r=>r.direction==='TX').length"),0);
});

test('Remote periodic stops at a bounded socket backlog without counting or submitting another frame',async()=>{
    const page=remotePeriodicFixture();page.sockets[0].bufferedAmount=65536;
    page.run('togglePeriodicSend()');await turn();
    assert.equal(page.run('periodicSender.running'),false);assert.equal(page.run('txBytes'),0);assert.equal(page.sockets[0].messages.length,0);
    assert.match(page.elements.get('errorMessage').textContent,/积压/);
});

test('A retired P2P grant error cannot overwrite Local status or stop a current Remote periodic job',async()=>{
    const local=browser('local.js');
    local.run("connectedRemotes.set('DEF45',{grantId:'new'});elements.errorMessage.textContent='current notice';handleServerMessage({type:'error',code:'p2p_not_authorized',remoteId:'DEF45',grantId:'old',error:'late'})");
    assert.equal(local.elements.get('errorMessage').textContent,'current notice');
    local.run("handleServerMessage({type:'error',code:'p2p_not_authorized',remoteId:'DEF45',grantId:'new',error:'current error'})");
    assert.equal(local.elements.get('errorMessage').textContent,'current error');
    const remote=remotePeriodicFixture();remote.run("togglePeriodicSend();elements.errorMessage.textContent='current notice'");await turn();
    remote.run("handleServerMessage({type:'error',code:'p2p_not_authorized',grantId:'old',error:'late'})");
    assert.equal(remote.run('periodicSender.running'),true);assert.equal(remote.elements.get('errorMessage').textContent,'current notice');
    remote.run("handleServerMessage({type:'error',code:'p2p_not_authorized',grantId:'grant',error:'current error'})");
    assert.equal(remote.run('periodicSender.running'),false);assert.equal(remote.elements.get('errorMessage').textContent,'current error');
});

test('A stopped periodic in-flight submission is counted once after successful completion',async()=>{
    const page=remotePeriodicFixture();let release;
    page.sandbox.pendingTX=()=>new Promise(resolve=>{release=resolve});
    page.run('serialPeer={direct:true,sendTX:pendingTX};togglePeriodicSend()');await turn();assert(release);
    page.run('periodicSender.stop()');release();await turn();
    assert.equal(page.run('txBytes'),4);assert.equal(page.run('periodicSender.running||periodicSender.busy'),false);
    assert.equal(page.run("records.filter(r=>r.direction==='TX').length"),1);
});

test('Local write-generation changes and Remote pause clear only pending P2P writes',()=>{
    const {page}=localPeriodicFixture();let localClears=0,remoteClears=0;
    page.sandbox.clearPeerWrites=()=>{localClears++};
    page.run("serialPeers.set('DEF45',{direct:true,cancelWrites:clearPeerWrites});remoteWriteGeneration++;updateState();updateState()");
    assert.equal(localClears,1);assert.equal(page.run("serialPeers.get('DEF45').direct"),true);
    const remote=remotePeriodicFixture();remote.sandbox.clearPeerWrites=()=>{remoteClears++};
    remote.run('serialPeer={direct:true,cancelWrites:clearPeerWrites};remoteWritesPaused=true;updateWritePermission()');
    assert.equal(remoteClears,1);assert.equal(remote.run('serialPeer.direct'),true);
});

test('Network assessment targets bind each peer, route and grant without requiring serial write permission',()=>{
    const local=browser('local.js');
    local.run("connectedRemotes.set('DEF45',{grantId:'grant'});serialPeers.set('DEF45',{direct:true,attempt:0,assessNetwork:()=>Promise.resolve({})});window.savedTarget=getNetworkAssessmentTargets()[0]");
    assert.equal(local.run('savedTarget.mode'),'p2p');assert.equal(local.run('savedTarget.valid()'),true);
    local.run("serialPeers.get('DEF45').txViaRelay=true");assert.equal(local.run('savedTarget.valid()'),false);
    assert.equal(local.run('getNetworkAssessmentTargets()[0].mode'),'server');
    assert.match(local.run('getNetworkAssessmentTargets()[0].label'),/TX 中转/);
    local.run("serialPeers.get('DEF45').txViaRelay=false;serialPeers.get('DEF45').direct=false");
    assert.equal(local.run('getNetworkAssessmentTargets()[0].mode'),'server');
    const remote=remotePeriodicFixture();
    remote.run("access='read';serialPeer={direct:true,attempt:0,assessNetwork:()=>Promise.resolve({})};window.savedTarget=getNetworkAssessmentTargets()[0]");
    assert.equal(remote.run('savedTarget.mode'),'p2p');assert.equal(remote.run('savedTarget.valid()'),true);
    remote.run("serialPeer.txViaRelay=true");assert.equal(remote.run('savedTarget.valid()'),false);
    assert.equal(remote.run('getNetworkAssessmentTargets()[0].mode'),'server');
    assert.match(remote.run('getNetworkAssessmentTargets()[0].label'),/TX 中转/);
    remote.run("serialPeer.txViaRelay=false;grantId='new'");assert.equal(remote.run('savedTarget.valid()'),false);
});

test('Serial configuration accepts supported combinations and rejects coercion or unsupported values', () => {
    const base = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
    for (const baudRate of [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]) {
        for (const dataBits of [7, 8]) for (const stopBits of [1, 2]) for (const parity of ['none', 'odd', 'even']) for (const flowControl of ['none', 'hardware']) {
            assert.equal(SerialConfig.valid({ baudRate, dataBits, stopBits, parity, flowControl }), true);
        }
    }
    for (const invalid of [null, {}, { ...base, baudRate: '115200' }, { ...base, baudRate: 0 },
        { ...base, dataBits: 6 }, { ...base, stopBits: 3 }, { ...base, parity: 'mark' }, { ...base, flowControl: 'software' }]) {
        assert.equal(SerialConfig.valid(invalid), false);
    }
});

async function configurableLocal(options = {}) {
    const page = browser('local.js');
    const opens = [], closes = [], writes = [], signals = [];
    let opened = false, current, stream, input, locked = false;
    const deviceWriter = {
        async write(bytes) { if (options.writeBarrier) await options.writeBarrier; writes.push({ baudRate: current.baudRate, bytes: [...bytes] }); },
        releaseLock() { locked = false; }
    };
    const device = {
        async open(config) {
            opens.push({ ...config });
            if (options.openHook) await options.openHook(config, opens.length);
            if (opened) throw new Error('already open');
            opened = true; current = { ...config }; stream = null;
        },
        async close() {
            if (locked || stream?.locked) throw new Error('streams still locked');
            closes.push(current?.baudRate);
            if (options.closeHook) await options.closeHook(closes.length);
            opened = false; stream = null;
        },
        async setSignals(value) { signals.push({ ...value }); },
        get readable() {
            if (!opened) return null;
            if (!stream) stream = new ReadableStream({ start(controller) { input = controller; }, cancel() { stream = null; } });
            return stream;
        },
        get writable() { return opened ? { getWriter() { if (locked) throw new Error('writer already locked'); locked = true; return deviceWriter; } } : null; }
    };
    page.sandbox.fakePort = device;
    page.sandbox.initialize();
    const option = new Element(); option.textContent = 'USB'; page.elements.get('portSelect').appendChild(option);
    page.run("port=fakePort;elements.portSelect.value='usb';elements.lineEnding.value='none';");
    await page.run('openPort()');
    shareStandalone(page);
    page.run("receiveSerialState({version:3,configProtocol:1,localId,portId:'usb',writeEpoch:1,paused:false,configRevision:1,configuring:false,serialConfig:activeSerialConfig});connectedRemotes.set('REM23',{portId:'usb',access:'control',grantId:'grant'});");
    function begin(overrides = {}) {
        page.run("receiveSerialState({version:3,configProtocol:1,localId,portId:'usb',writeEpoch:2,paused:false,configRevision:1,configuring:true,configId:'operation',serialConfig:activeSerialConfig});");
        page.sandbox.configOverrides = overrides;
        page.run("handleServerMessage({type:'set_serial_config',version:3,configProtocol:1,configId:'operation',localId,portId:'usb',remoteId:'REM23',grantId:'grant',writeEpoch:2,configRevision:1,serialConfig:{baudRate:9600,dataBits:7,stopBits:2,parity:'even',flowControl:'hardware'},...configOverrides});");
        return page.run('serialConfigTask');
    }
    function result() { return page.sockets[0].messages.findLast(message => message.type === 'serial_config_result'); }
    function finish() {
        const response = result();
        page.sandbox.configCompletion = response;
        page.run("receiveSerialState({version:3,configProtocol:1,localId,portId:'usb',writeEpoch:3,paused:remoteWritesPaused,configRevision:configCompletion.success?2:1,configuring:false,serialConfig:configCompletion.serialConfig});");
    }
    return { page, device, opens, closes, writes, signals, begin, result, finish, get opened() { return opened; }, receive: bytes => input.enqueue(new Uint8Array(bytes)) };
}

test('Local applies all authorized serial settings through unlocked streams and preserves the shared session', async () => {
    const fixture = await configurableLocal();
    const { page } = fixture;
    const id = page.run('localId');
    await fixture.begin();
    assert.equal(fixture.result().success, true);
    assert.equal(fixture.result().portOpen, true);
    assert.match(page.elements.get('successMessage').textContent, /Remote REM23.*115200.*9600/);
    for (const timer of page.timers.filter(item => item.delay === 3000)) timer.callback();
    assert.equal(page.elements.get('successMessage').classList.contains('hidden'), false, 'an earlier transient notice must not hide the parameter-change result');
    assert.match(page.run("eventRecords.map(record=>record.text).join('\\n')"), /收到 Remote REM23.*115200.*9600/);
    assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 9600]);
    assert.deepEqual(fixture.opens[1], { baudRate: 9600, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'hardware' });
    assert.equal(page.run('localId'), id);
    assert.equal(page.run('connectedRemotes.size'), 1);
    assert.equal(page.elements.get('sendBtn').disabled, true, 'must await server completion state');
    fixture.finish();
    assert.equal(page.elements.get('baudRate').value, '9600');
    assert.equal(page.elements.get('sendBtn').disabled, false);
    page.run("elements.sendInput.value='41 00 FF';elements.hexSend.checked=true;sendLocalData();");
    await page.run('writeChain');
    assert.deepEqual(fixture.writes, [{ baudRate: 9600, bytes: [65, 0, 255] }]);
    fixture.receive([0xE4]); fixture.receive([0xB8, 0xAD]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.run("dataRecords.filter(record=>record.kind==='RX').map(record=>record.text).join('')"), '中');
    await page.run('closePort()');
});

test('Local rejects configuration while a physical write is in flight without closing the port', async () => {
    let release;
    const fixture = await configurableLocal({ writeBarrier: new Promise(resolve => { release = resolve; }) });
    fixture.page.run("elements.sendInput.value='A';sendLocalData();");
    await fixture.begin();
    assert.equal(fixture.result().success, false);
    assert.equal(fixture.result().code, 'serial_busy');
    assert.equal(fixture.opens.length, 1);
    assert.equal(fixture.closes.length, 0);
    release(); await fixture.page.run('writeChain'); fixture.finish();
    assert.deepEqual(fixture.writes, [{ baudRate: 115200, bytes: [65] }]);
    await fixture.page.run('closePort()');
});

test('Local rolls back a rejected parameter change and stops sharing if rollback also fails', async () => {
    for (const failRollback of [false, true]) {
        const fixture = await configurableLocal({ async openHook(config, count) { if (config.baudRate === 9600 || failRollback && count > 1) throw new Error('device rejected settings'); } });
        await fixture.begin();
        assert.equal(fixture.result().success, false);
        assert.equal(fixture.result().portOpen, !failRollback);
        assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 9600, 115200]);
        if (failRollback) {
            assert.equal(fixture.page.run('shareEnabled || registered || isOpen'), false);
            assert.equal(fixture.page.run('ws'), null);
        } else {
            assert.match(fixture.page.elements.get('errorMessage').textContent, /恢复原参数.*115200/);
            assert.equal(fixture.page.run('activeSerialConfig.baudRate'), 115200);
            fixture.finish();
            assert.equal(fixture.page.run('canLocalWrite()'), true);
        }
        await fixture.page.run('closePort()');
    }
});

test('Local verifies configuration identity, grant, port, revision and epoch before touching hardware', async () => {
    for (const altered of [{ remoteId: 'OTHER' }, { grantId: 'old' }, { portId: 'other' }, { writeEpoch: 1 },
        { configRevision: 0 }, { localId: 'OTHER' }, { serialConfig: { baudRate: 9600 } }]) {
        const fixture = await configurableLocal();
        await fixture.begin(altered);
        assert.equal(fixture.opens.length, 1, JSON.stringify(altered));
        assert.equal(fixture.closes.length, 0);
        assert.equal(fixture.result().success, false);
        await fixture.page.run('closePort()');
    }
});

test('Local locks sends for an approved remote flash session and serializes reset signals with flash bytes', async () => {
    const fixture = await configurableLocal();
    const { page } = fixture;
    const registration = page.sockets[0].messages.find(message => message.type === 'register');
    assert.equal(registration.serialSignalsProtocol, 1);
    assert.equal(registration.flashProtocol, 1);

    page.run("receiveFlashState({version:3,localId,portId:'usb',writeEpoch:2,paused:false,flashActive:true,flashStarting:true,flashSessionId:'flash-1',flashOwnerId:'REM23'});");
    assert.equal(page.run('canLocalWrite()'), false, 'Local send must be disabled while the flash session is being acquired');
    page.run("handleServerMessage({type:'begin_flash',requestId:'start-1',flashSessionId:'flash-1',localId,remoteId:'REM23',portId:'usb',grantId:'grant',writeEpoch:2});");
    await page.run('writeChain');
    const startResult = page.sockets[0].messages.findLast(message => message.type === 'flash_result');
    assert.equal(startResult.success, true);

    page.run("handleServerMessage({type:'set_serial_signals',requestId:'signals-1',flashSessionId:'flash-1',localId,remoteId:'REM23',portId:'usb',grantId:'grant',writeEpoch:2,requestToSend:true,dataTerminalReady:false});");
    await page.run('writeChain');
    assert.deepEqual(fixture.signals, [{ requestToSend: true, dataTerminalReady: false }]);
    assert.equal(page.sockets[0].messages.findLast(message => message.type === 'serial_signals_result').success, true);

    page.run("handleServerMessage({type:'send',remoteId:'REM23',portId:'usb',grantId:'grant',writeEpoch:2,flashSessionId:'flash-1',data:'QQ=='});");
    await page.run('writeChain');
    assert.deepEqual(fixture.writes.at(-1).bytes, [65]);
    page.run("receiveFlashState({version:3,localId,portId:'usb',writeEpoch:3,paused:false,flashActive:false});");
    assert.equal(page.run('canLocalWrite()'), true, 'Local send must resume when the flash session releases its lock');
    await page.run('closePort()');
});

test('Local drains pre-existing FIFO writes before confirming an exclusive flash session', async () => {
    let releaseWrite;
    const writeBarrier = new Promise(resolve => { releaseWrite = resolve; });
    const fixture = await configurableLocal({ writeBarrier });
    const { page } = fixture;
    page.run("enqueueWrite(new Uint8Array([65]),'Remote REM23',{remoteId:'REM23',portId:'usb',grantId:'grant',writeEpoch:1});");
    await new Promise(resolve => setImmediate(resolve));
    page.run("receiveFlashState({version:3,localId,portId:'usb',writeEpoch:2,paused:false,flashActive:true,flashStarting:true,flashSessionId:'flash-2',flashOwnerId:'REM23'});");
    page.run("handleServerMessage({type:'begin_flash',requestId:'start-2',flashSessionId:'flash-2',localId,remoteId:'REM23',portId:'usb',grantId:'grant',writeEpoch:2});");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.sockets[0].messages.some(message => message.type === 'flash_result'), false);
    releaseWrite();
    await page.run('writeChain');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.writes, [{ baudRate: 115200, bytes: [65] }]);
    assert.equal(page.sockets[0].messages.findLast(message => message.type === 'flash_result').success, true);
    await page.run('closePort()');
});

test('Revocation during port close prevents opening the requested settings and restores the original port', async () => {
    let release, started;
    const closing = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const fixture = await configurableLocal({ async closeHook(count) { if (count === 1) { started(); await barrier; } } });
    const task = fixture.begin(); await closing;
    fixture.page.run("revokeRemote('REM23');");
    release(); await task;
    assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 115200]);
    assert.equal(fixture.result().success, false);
    assert.equal(fixture.result().code, 'permission_revoked');
    assert.equal(fixture.page.run('connectedRemotes.size'), 0);
    await fixture.page.run('closePort()');
});

test('Pausing during an in-flight open restores original settings without reviving old sends', async () => {
    let release, started;
    const opening = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const fixture = await configurableLocal({ async openHook(config) { if (config.baudRate === 9600) { started(); await barrier; } } });
    const task = fixture.begin(); await opening;
    fixture.page.run('toggleRemoteWrites();'); release(); await task;
    assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 9600, 115200]);
    assert.equal(fixture.result().success, false);
    assert.equal(fixture.page.run('activeSerialConfig.baudRate'), 115200);
    assert.equal(fixture.page.run('remoteWritesPaused'), true);
    assert.equal(fixture.writes.length, 0);
    await fixture.page.run('closePort()');
});

test('Closing Local during configuration waits for the in-flight driver call and never reopens a closed session', async () => {
    let release, started;
    const opening = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const fixture = await configurableLocal({ async openHook(config) { if (config.baudRate === 9600) { started(); await barrier; } } });
    const task = fixture.begin(); await opening;
    const closing = fixture.page.run('closePort()');
    release(); await task; await closing;
    assert.equal(fixture.opened, false);
    assert.equal(fixture.page.run('port'), null);
    assert.equal(fixture.page.run('registered || isOpen'), false);
    assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 9600]);
    assert.equal(fixture.result(), undefined);
});

test('A dropped sharing connection cancels configuration and re-registers only the restored physical settings', async () => {
    let release, started;
    const closing = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const fixture = await configurableLocal({ async closeHook(count) { if (count === 1) { started(); await barrier; } } });
    const task = fixture.begin(); await closing;
    fixture.page.sockets[0].close(); release(); await task;
    assert.equal(fixture.page.run('activeSerialConfig.baudRate'), 115200);
    assert.equal(fixture.result(), undefined);
    fixture.page.timers.filter(timer => timer.delay === 3000).at(-1).callback(); fixture.page.sockets[1].onopen();
    const registration = fixture.page.sockets[1].messages.find(message => message.type === 'register');
    assert.equal(registration.serialConfig.baudRate, 115200);
    assert.equal(registration.configProtocol, 1);
    await fixture.page.run('closePort()');
});

test('A server cancellation stops the next physical step even before the disconnect notification arrives', async () => {
    let release, started;
    const closing = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const fixture = await configurableLocal({ async closeHook(count) { if (count === 1) { started(); await barrier; } } });
    const task = fixture.begin(); await closing;
    fixture.page.run("handleServerMessage({type:'cancel_serial_config',configId:'operation',code:'permission_revoked'});");
    assert.equal(fixture.page.run('connectedRemotes.size'), 1, 'disconnect notification intentionally delayed');
    release(); await task;
    assert.deepEqual(fixture.opens.map(config => config.baudRate), [115200, 115200]);
    assert.equal(fixture.result().success, false);
    await fixture.page.run('closePort()');
});

test('A stale Local configuration request cannot consume a newer configuration transaction', async () => {
    const fixture = await configurableLocal();
    await fixture.begin({ configId: 'previous-operation' });
    assert.equal(fixture.opens.length, 1);
    assert.equal(fixture.closes.length, 0);
    assert.equal(fixture.result(), undefined);
    assert.equal(fixture.page.run('serialConfigPending.id'), 'operation');
    await fixture.page.run('closePort()');
});

test('HEX mode redraw preserves bytes, timestamps, directions and count', () => {
    const page = browser('remote.js');
    page.run("displayRxData(new Uint8Array([65, 0, 255])); addRecord('TX', new Uint8Array([66]));");
    const original = page.run('JSON.stringify(records)');
    for (let i = 0; i < 10; i++) page.run('toggleHexMode()');
    assert.equal(page.run('JSON.stringify(records)'), original);
    assert.equal(page.elements.get('rxData').children.length, 2);
});

test('UTF-8 split across serial chunks decodes as one character', () => {
    const page = browser('remote.js');
    page.run('displayRxData(new Uint8Array([0xE4])); displayRxData(new Uint8Array([0xB8, 0xAD]));');
    assert.equal(page.run("records.map(record => record.text).join('')"), '中');
});

test('display history is bounded', () => {
    const page = browser('remote.js');
    page.run('for (let i = 0; i < 2001; i++) displayRxData(new Uint8Array([65]));');
    assert.equal(page.run('records.length'), 2000);
    assert.equal(page.elements.get('rxData').children.length, 2000);
});

test('Remote requests read access without config, and socket loss resets subscription', () => {
    const page = browser('remote.js');
    page.run("connectWebSocket(); elements.localIdInput.value='ABC23'; elements.accessSelect.value='read'; connectToLocal();");
    assert.deepEqual(page.sockets[0].messages[0], { type: 'connect', localId: 'ABC23', access: 'read', version: 3, rxReplayProtocol: 1, flashProtocol: 1 });
    page.run("isPending=true; pendingRequestId='request'; handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',access:'control',version:3});");
    assert.equal(page.run('isConnected'), true);
    page.sockets[0].close();
    assert.equal(page.run('isConnected'), false);
    assert.equal(page.run('connectedPortId'), '');
    assert.equal(page.elements.get('sendBtn').disabled, true);
    assert.equal(page.elements.get('successMessage').classList.contains('hidden'), true);
});

test('Remote resumes an approved RX stream with a cumulative cursor and ignores duplicate frames', async () => {
    const page = browser('remote.js');
    const streamId = 'a'.repeat(32);
    page.elements.get('localIdInput').value = 'ABC23';
    page.run('connectToLocal()');
    page.run("handleServerMessage({type:'connect_pending',requestId:'req1',localId:'ABC23',remoteId:'REM23',version:3});");
    page.run(`handleServerMessage({type:'connect',requestId:'req1',grantId:'grant1',writeEpoch:1,paused:false,localId:'ABC23',portId:'usb',access:'read',version:3,rxReplayProtocol:1,rxStreamId:'${streamId}',rxSeq:10});`);
    page.run(`handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',rxSeq:11,data:'AA=='})`);
    assert.equal(page.run('lastRxSeq'), 11);
    assert.equal(page.run('records.length'), 1);

    page.sockets[0].close();
    page.elements.get('localIdInput').value = 'ABC23';
    page.run('connectToLocal()');
    const resume = page.sockets[1].messages[0];
    assert.equal(resume.resumeStreamId, streamId);
    assert.equal(resume.resumeSeq, 11);
    page.run("handleServerMessage({type:'connect_pending',requestId:'req2',localId:'ABC23',remoteId:'REM24',version:3});");
    page.run(`handleServerMessage({type:'connect',requestId:'req2',grantId:'grant2',writeEpoch:1,paused:false,localId:'ABC23',portId:'usb',access:'read',version:3,rxReplayProtocol:1,rxStreamId:'${streamId}',rxSeq:13});`);
    assert.equal(page.run('rxReplaying'), true);
    page.run(`handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',rxSeq:12,data:'AQ=='})`);
    page.run(`handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',rxSeq:12,data:'AQ=='})`);
    page.run(`handleServerMessage({type:'data',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',rxSeq:13,data:'Ag=='})`);
    assert.equal(page.run('records.length'), 3);
    assert.equal(page.run('lastRxSeq'), 13);
    assert.deepEqual(page.sockets[1].messages.filter(message => message.type === 'rx_ack').map(message => message.rxSeq), [12, 12, 13]);
    page.run(`handleServerMessage({type:'replay_complete',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',throughSeq:13})`);
    assert.equal(page.run('rxReplaying'), false);
    assert.equal(page.run('records.length'), 3, 'duplicate replay did not create another record');
    page.sandbox.URL = { createObjectURL(blob) { page.sandbox.exportedBlob = blob; return 'blob:rx-log'; }, revokeObjectURL() {} };
    page.run(`handleServerMessage({type:'rx_gap',localId:'ABC23',portId:'usb',rxStreamId:'${streamId}',gapFrom:14,gapTo:16})`);
    assert.equal(page.run("systemRecords.at(-1).direction"), 'EVENT');
    page.run('exportData()');
    assert.doesNotMatch(await page.sandbox.exportedBlob.text(), /14.*16/);
    page.sandbox.URL = { createObjectURL(blob) { page.sandbox.exportedSystemBlob=blob; return 'blob:system'; }, revokeObjectURL() {} };
    page.run('exportSystemLog()');
    assert.match(await page.sandbox.exportedSystemBlob.text(), /14.*16/);
    for(let i=0;i<501;i++)page.run("retainRecord({direction:'EVENT',bytes:new Uint8Array(),text:'system event'})");
    assert.equal(page.run('systemRecords.length'),500);
    assert.equal(page.run('records.length'),3,'system events are kept outside the serial record stream');
    page.run('clearRx()');
    assert.equal(page.run('records.length'),0);
    assert.equal(page.run('systemRecords.length'),500,'clearing RX preserves the system log');
});

test('Remote opens no idle connection and releases a cancelled request without retry timers', () => {
    const page = browser('remote.js');
    page.sandbox.initialize();
    assert.equal(page.sockets.length, 0);
    page.elements.get('localIdInput').value = 'bad';
    page.elements.get('connectBtn').click();
    assert.equal(page.sockets.length, 0);
    page.elements.get('localIdInput').value = 'ABC23';
    page.elements.get('connectBtn').click();
    assert.equal(page.sockets.length, 1);
    assert.equal(page.sockets[0].messages.length, 1);
    page.sockets[0].onopen();
    assert.equal(page.sockets[0].messages.length, 1);
    page.elements.get('cancelConnectBtn').click();
    assert.equal(page.sockets[0].readyState, 3);
    page.timers.forEach(timer => timer.callback());
    assert.equal(page.sockets.length, 1);
    page.sockets[0].onopen();
    assert.equal(page.run('isPending'), false);
    assert.equal(page.sockets[0].messages.length, 2);
});

test('Remote tool tabs update the URL and panel without replacing the socket or grant', () => {
    const page=browser('remote.js');
    page.run("connectWebSocket();isConnected=true;isPending=false;localId='ABC23';remoteId='REM23';connectedPortId='usb';grantId='active-grant';writeEpoch=7;access='control';");
    const socket=page.sockets[0];
    page.run("window.remoteSwitchSocket=ws;switchRemoteTool('esp32');switchRemoteTool('serial')");
    assert.equal(page.sockets.length,1,'tool navigation must not open another Remote WebSocket');
    assert.equal(page.run('ws===window.remoteSwitchSocket'),true);
    assert.equal(socket.readyState,1,'tool navigation must not disconnect the existing WebSocket');
    assert.equal(page.run('ShareSerialRemote.getSnapshot().grantId'),'active-grant');
    assert.deepEqual(page.historyCalls,['/remote/esp32','/remote']);
    assert.equal(page.elements.get('esp32Panel').classList.contains('hidden'),true);
    assert.equal(page.elements.get('remoteSerialPanel').classList.contains('hidden'),false);
});

test('Local resource close stops sharing and auto-accept while retaining its physical port', () => {
    const page = browser('local.js');
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=true;writeEpoch=1;autoAccept=true;connectedRemotes.set('REM23',{grantId:'request',access:'control',portId:'usb'});");
    page.sockets[0].onclose({ code: 4008, reason: 'bandwidth_limited' });
    assert.equal(page.run('isOpen'), true);
    assert.equal(page.run('shareEnabled'), false);
    assert.equal(page.run('registered'), false);
    assert.equal(page.run('autoAccept'), false);
    assert.equal(page.run('connectedRemotes.size'), 0);
    assert.equal(page.timers.some(timer => timer.delay === 3000), false);
    assert.match(page.elements.get('errorMessage').textContent, /流量达到服务上限/);
});

test('Remote quota errors release control and show the actual resource reason', () => {
    const page = browser('remote.js');
    page.run("connectWebSocket();isPending=true;pendingRequestId='r';handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'r',localId:'ABC23',portId:'usb',access:'control',version:3});handleServerMessage({type:'error',code:'daily_quota_exceeded',error:'opaque'});");
    assert.equal(page.run('isConnected'), false);
    assert.equal(page.sockets[0].readyState, 3);
    assert.equal(page.elements.get('sendBtn').disabled, true);
    assert.match(page.elements.get('errorMessage').textContent, /当日流量额度已用尽/);
});

test('Local resource error invalidates queued remote writes before the socket close arrives', async () => {
    const page = browser('local.js');
    const writes = [];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    page.sandbox.fakeWriter = { async write(bytes) { await blocked; writes.push([...bytes]); } };
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=true;writeEpoch=1;autoAccept=true;writer=fakeWriter;elements.portSelect.value='usb';connectedRemotes.set('REM23',{grantId:'request',access:'control',portId:'usb'});");
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'QQ=='});handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'Qg=='});");
    await Promise.resolve();
    page.run("handleServerMessage({type:'error',code:'bandwidth_limited'});");
    release();
    await page.run('writeChain');
    assert.deepEqual(writes, [[65]]);
    assert.equal(page.run('registered'), false);
    assert.equal(page.run('autoAccept'), false);
    assert.equal(page.run('isOpen'), true);
    assert.equal(page.sockets[0].readyState, 1);
});

test('bad HEX is not sent, and valid HEX plus CR produces correct bytes', () => {
    const page = browser('remote.js');
    page.run("connectWebSocket(); isPending=true; pendingRequestId='request'; handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',access:'control',version:3});");
    page.elements.get('hexSend').checked = true;
    page.elements.get('sendInput').value = 'G1';
    page.run('sendData()');
    assert.equal(page.sockets[0].messages.length, 0);
    page.elements.get('sendInput').value = '41';
    page.elements.get('sendCR').checked = true;
    page.run('sendData()');
    assert.equal(page.sockets[0].messages[0].data, Buffer.from([65, 13]).toString('base64'));
});

test('preset AT command sends a real CR and clear TX clears the input', () => {
    const page = browser('remote.js');
    const button = page.presets[0];
    assert.equal(button.dataset.cmd, 'AT');
    page.sandbox.initialize();
    page.run("connectWebSocket(); isPending=true; pendingRequestId='request'; handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',access:'control',version:3});");
    button.click();
    assert.equal(page.sockets[0].messages[0].data, Buffer.from('AT\r').toString('base64'));
    page.elements.get('clearTxBtn').click();
    assert.equal(page.elements.get('sendInput').value, '');
});

test('local re-registers an open port after reconnect', () => {
    const page = browser('local.js');
    const option = new Element();
    option.textContent = 'USB';
    page.elements.get('portSelect').appendChild(option);
    page.elements.get('portSelect').value = 'usb';
    page.run("isOpen=true; shareEnabled=true; localId='ABC23'; connectWebSocket();");
    page.sockets[0].onopen();
    assert.equal(page.sockets[0].messages[0].type, 'register');
    page.sockets[0].close();
    page.timers.find(timer => timer.delay === 3000).callback();
    page.sockets[1].onopen();
    assert.equal(page.sockets[1].messages[0].localId, 'ABC23');
    const logs=page.run("eventRecords.map(record=>record.text).join('|')");assert.equal(page.elements.get('logContent').textContent,'');
    assert.match(logs, /代码 1006/);
    assert.match(logs, /原连接 ID ABC23 重新注册/);
    assert.match(logs, /远程端需要重新申请授权/);
});

test('Local explains ID collisions without displaying an unconfirmed replacement as shared', () => {
    const page = browser('local.js');
    page.sandbox.crypto = { getRandomValues: bytes => bytes.fill(0) };
    const option = new Element();
    option.textContent = 'USB';
    page.elements.get('portSelect').appendChild(option);
    page.run("connectWebSocket(); isOpen=true; shareEnabled=true; localId='ABC23'; elements.localId.textContent='等待注册'; elements.portSelect.value='usb'; handleServerMessage({type:'error',code:'local_id_in_use'});");
    const next = page.run('localId');
    assert.notEqual(next, 'ABC23');
    assert.match(page.run("eventRecords.map(record=>record.text).join('|')"), new RegExp('ABC23 被服务器判定占用，尝试新 ID ' + next));
    assert.equal(page.elements.get('localId').textContent, '等待注册');
    assert.equal(page.sockets[0].messages.at(-1).localId, next);
    page.sandbox.confirmedId = next;
    page.run("handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId:confirmedId});");
    assert.equal(page.elements.get('localId').textContent, next);
    assert.match(page.run("eventRecords.map(record=>record.text).join('|')"), new RegExp('服务器已确认共享，连接 ID：' + next));
});

test('late registration ACK cannot restore a closed Local display', () => {
    const page = browser('local.js');
    page.elements.get('localId').textContent = '------';
    page.run("isOpen=false; localId=''; handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId:'ABC23'});");
    assert.equal(page.elements.get('localId').textContent, '------');
    assert.equal(page.run('registered'), false);
});

test('local serial writes stay ordered and closing withdraws registration', async () => {
    const page = browser('local.js');
    const writes = [];
    let closed = false;
    page.sandbox.fakeWriter = { write: async bytes => { writes.push([...bytes]); }, releaseLock() {} };
    page.sandbox.fakePort = { close: async () => { closed = true; } };
    page.run("connectWebSocket(); isOpen=true; localId='ABC23'; registered=true;writeEpoch=1; writer=fakeWriter; connectedRemotes.set('REM23',{grantId:'request',portId:'usb',access:'control'}); elements.portSelect.value='usb'; port=fakePort;");
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'QQ=='}); handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'Qg=='});");
    await page.run('writeChain');
    assert.deepEqual(writes, [[65], [66]]);
    assert.equal(page.run('pendingWrites'), 0);
    await page.run('closePort()');
    assert.equal(page.sockets[0].messages[0].type, 'unregister');
    assert.equal(page.run('isOpen'), false);
    assert.equal(page.run('localId'), '');
    assert.equal(closed, true);
});

test('Local disconnect notification releases the Remote transport and clears its grant', () => {
    const page = browser('remote.js');
    page.run("connectWebSocket(); isPending=true; pendingRequestId='request'; handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',access:'control',version:3});");
    assert.equal(page.run('isConnected'), true);
    page.run("handleServerMessage({type:'local_disconnected',localId:'ABC23',portId:'usb'});");
    assert.equal(page.run('isConnected'), false);
    assert.equal(page.run('connectedPortId'), '');
    assert.equal(page.elements.get('sendBtn').disabled, true);
    assert.equal(page.sockets[0].readyState, 3);
    page.elements.get('sendInput').value = 'AT';
    page.run('sendData()');
    assert.equal(page.sockets[0].messages.length, 0);
});

test('Remote accepts only RX for its current Local and port', () => {
    const page = browser('remote.js');
    page.run("connectWebSocket(); isPending=true; pendingRequestId='request'; handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',access:'control',version:3});");
    page.run("handleServerMessage({type:'data',localId:'DEF45',portId:'usb',data:'QQ=='});");
    page.run("handleServerMessage({type:'data',localId:'ABC23',portId:'uart',data:'QQ=='});");
    assert.equal(page.run('records.length'), 0);
    page.run("handleServerMessage({type:'data',localId:'ABC23',portId:'usb',data:'QQ=='});");
    assert.equal(page.run('records.length'), 1);
    assert.equal(page.run('records[0].text'), 'A');
    page.run("setDisconnected(); handleServerMessage({type:'data',localId:'ABC23',portId:'usb',data:'Qg=='});");
    assert.equal(page.run('records.length'), 1);
});

test('Remote serial page disables ordinary TX and parameter changes while ESP32 flash owns the port', () => {
    const page = browser('remote.js');
    page.sandbox.initialize();
    page.run("isConnected=true;localId='ABC23';connectedPortId='usb';grantId='grant';access='control';writeEpoch=1;remoteWritesPaused=false;serialConfig={baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'};updateWritePermission();");
    assert.equal(page.elements.get('sendBtn').disabled, false);
    page.run("handleServerMessage({type:'flash_state',localId:'ABC23',portId:'usb',writeEpoch:2,paused:false,flashActive:true,flashOwnerId:'OTH23',version:3});");
    assert.equal(page.elements.get('sendBtn').disabled, true);
    assert.match(page.elements.get('connectedAccess').textContent, /ESP32 烧录中/);
    assert.match(page.elements.get('configStatus').textContent, /独占串口烧录/);
});

test('Local ignores a previous registration ACK and accepts the current one', () => {
    const page = browser('local.js');
    page.elements.get('localId').textContent = '------';
    page.run("isOpen=true; shareEnabled=true; localId='DEF45'; handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId:'ABC23'});");
    assert.equal(page.run('registered'), false);
    assert.equal(page.elements.get('localId').textContent, '------');
    page.run("handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId:'DEF45'});");
    assert.equal(page.run('registered'), true);
    assert.equal(page.elements.get('localId').textContent, 'DEF45');
});

test('Local bounds queued writes and stops them when transport authorization is lost', async () => {
    const page = browser('local.js');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const writes = [];
    page.sandbox.fakeWriter = { write: async bytes => { await blocked; writes.push([...bytes]); } };
    page.run("connectWebSocket(); isOpen=true; registered=true;writeEpoch=1; writer=fakeWriter; connectedRemotes.set('REM23',{grantId:'request',portId:'usb',access:'control'}); elements.portSelect.value='usb';");
    try {
        page.run("for(let i=0;i<256;i++) handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'QQ=='});");
        assert.equal(page.sockets[0].readyState, 1);
        await Promise.resolve(); // let the first write reach the physical writer
        page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'Qg=='});");
        assert.equal(page.sockets[0].readyState, 3);
    } finally {
        release();
        await page.run('writeChain');
    }
    assert.equal(writes.length, 1);
    assert.equal(writes.some(bytes => bytes[0] === 66), false);
});

test('Local forwards registered reads in bounded byte-preserving chunks', async () => {
    const bytes = Uint8Array.from({ length: 16385 }, (_, i) => i & 255);
    for (const registered of [false, true]) {
        const page = browser('local.js');
        let read = false;
        page.sandbox.fakePort = { readable: { getReader: () => ({
            async read() {
                if (!read) { read = true; return { value: bytes, done: false }; }
                page.run('isOpen=false');
                return { done: true };
            },
            releaseLock() {}
        }) } };
        page.elements.get('portSelect').value = 'usb';
        page.run("connectWebSocket(); isOpen=true; localId='ABC23'; port=fakePort;");
        page.run(`registered=${registered};shareEnabled=${registered};rxReplayEnabled=${registered};rxReplayBuffer=${registered ? "RxReplay.create('stream-serial')" : 'null'};`);
        await page.run('readData()');
        const messages = page.sockets[0].messages;
        if (registered) {
            assert.deepEqual(messages.map(message => Buffer.from(message.data, 'base64').length), [16384, 1]);
            assert.deepEqual(Buffer.concat(messages.map(message => Buffer.from(message.data, 'base64'))), Buffer.from(bytes));
            assert.equal(messages.every(message => message.type === 'data' && message.portId === 'usb'), true);
            assert.deepEqual(messages.map(message => message.rxSeq), [1, 2]);
            assert.equal(messages.every(message => message.rxStreamId === 'stream-serial'), true);
        } else {
            assert.equal(messages.length, 0);
        }
    }
});

test('Local caches RX during registration but never forwards before the server confirms sharing', async () => {
    const page = browser('local.js');
    const bytes = Uint8Array.from([0, 255, 13]);
    let read = false;
    page.sandbox.fakePort = { readable: { getReader: () => ({
        async read() {
            if (!read) { read = true; return { value: bytes, done: false }; }
            page.run('isOpen=false');
            return { done: true };
        },
        releaseLock() {}
    }) } };
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=false;localId='ABC23';port=fakePort;elements.portSelect.value='usb';rxReplayBuffer=RxReplay.create('f'.repeat(32));");
    await page.run('readData()');
    assert.equal(page.run('rxReplayBuffer.sequence'), 1);
    assert.equal(page.sockets[0].messages.some(message => message.type === 'data'), false);
    page.run("isOpen=true;handleServerMessage({type:'register',localId:'ABC23',version:3,writeEpoch:1,paused:false,rxReplayProtocol:1,rxStreamId:'" + "f".repeat(32) + "',rxSeq:0});");
    assert.equal(page.run('registered && rxReplayEnabled'), true);
    assert.equal(page.sockets[0].messages.some(message => message.type === 'data'), false);
    assert.equal(page.sockets[0].messages.at(-1).type, 'rx_head');
    assert.equal(page.sockets[0].messages.at(-1).rxSeq, 1);
});

test('Local sends live P2P RX while the same Remote is receiving WSS backfill',async()=>{
    const page=browser('local.js'),direct=[];let read=false;
    page.sandbox.fakePort={readable:{getReader:()=>({async read(){if(!read){read=true;return {value:Uint8Array.of(0,255,13),done:false}}page.run('isOpen=false');return {done:true}},releaseLock(){}})}};
    page.sandbox.directSend=(sequence,bytes)=>{direct.push({sequence,bytes:[...bytes]});return true};
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=true;localId='ABC23';port=fakePort;elements.portSelect.value='usb';rxReplayEnabled=true;serialP2PEnabled=true;rxReplayBuffer=RxReplay.create('f'.repeat(32));connectedRemotes.set('DEF45',{portId:'usb',grantId:'grant'});rxReplayTransfers.set('DEF45',{});serialPeers.set('DEF45',{sendRX:directSend});");
    await page.run('readData()');
    assert.deepEqual(direct,[{sequence:1,bytes:[0,255,13]}]);
    const message=page.sockets[0].messages.find(m=>m.type==='data');
    assert.deepEqual(message.directRemotes,['DEF45']);assert.equal(message.data,undefined);
    assert.equal(page.run("rxReplayTransfers.has('DEF45')"),true);
});

test('Local replays RX in an acknowledged bounded window and marks expired bytes as a gap', () => {
    const page = browser('local.js');
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=true;localId='ABC23';elements.portSelect.value='usb';rxReplayEnabled=true;rxReplayBuffer=RxReplay.create('b'.repeat(32));connectedRemotes.set('REM23',{portId:'usb',access:'read',grantId:'grant'});");
    page.run('for(let i=0;i<10;i++) RxReplay.append(rxReplayBuffer,[i]);');
    page.run("handleServerMessage({type:'resume_rx',localId:'ABC23',remoteId:'REM23',portId:'usb',grantId:'grant',rxStreamId:rxReplayBuffer.streamId,resumeSeq:0,throughSeq:10});");
    const socket = page.sockets[0];
    assert.deepEqual(socket.messages.filter(message => message.type === 'replay_data').map(message => message.rxSeq), [1,2,3,4,5,6,7,8]);
    for (let sequence = 1; sequence <= 10; sequence++) {
        page.run(`handleServerMessage({type:'rx_ack',localId:'ABC23',remoteId:'REM23',portId:'usb',grantId:'grant',rxStreamId:rxReplayBuffer.streamId,rxSeq:${sequence}})`);
    }
    assert.deepEqual(socket.messages.filter(message => message.type === 'replay_data').map(message => message.rxSeq), [1,2,3,4,5,6,7,8,9,10]);
    assert.equal(socket.messages.at(-1).type, 'replay_complete');

    page.run("rxReplayBuffer=RxReplay.create('c'.repeat(32));for(let i=0;i<RxReplay.MAX_FRAMES+1;i++)RxReplay.append(rxReplayBuffer,[i]);connectedRemotes.set('REM24',{portId:'usb',access:'read',grantId:'grant24'});handleServerMessage({type:'resume_rx',localId:'ABC23',remoteId:'REM24',portId:'usb',grantId:'grant24',rxStreamId:rxReplayBuffer.streamId,resumeSeq:0,throughSeq:rxReplayBuffer.sequence});");
    const gapMessages = socket.messages.filter(message => message.type === 'replay_gap');
    assert.equal(gapMessages.at(-1).gapFrom, 1);
    assert.equal(gapMessages.at(-1).gapTo, 1);
    assert.equal(socket.messages.filter(message => message.type === 'replay_data').at(-1).rxSeq, 9);
});

test('Local paces large RX replay frames to protect the shared service byte budget', () => {
    const page = browser('local.js');
    page.run("connectWebSocket();isOpen=true;shareEnabled=true;registered=true;localId='ABC23';elements.portSelect.value='usb';rxReplayEnabled=true;rxReplayBuffer=RxReplay.create('c'.repeat(32));connectedRemotes.set('REM23',{portId:'usb',access:'read',grantId:'grant'});for(let i=0;i<3;i++)RxReplay.append(rxReplayBuffer,new Uint8Array(16384));handleServerMessage({type:'resume_rx',localId:'ABC23',remoteId:'REM23',portId:'usb',grantId:'grant',rxStreamId:rxReplayBuffer.streamId,resumeSeq:0,throughSeq:3});");
    const socket = page.sockets[0];
    assert.deepEqual(socket.messages.filter(message => message.type === 'replay_data').map(message => message.rxSeq), [1]);
    assert.equal(page.run("rxReplayTransfers.get('REM23').nextIndex"), 1);
    assert.ok(page.timers.some(timer => !timer.cancelled && timer.delay > 0));
    page.run("cancelRXReplayTransfer('REM23')");
});

async function standaloneLocal(options = {}) {
    const page = browser('local.js', options);
    const writes = [];
    let input;
    const fakeWriter = { async write(bytes) { writes.push([...bytes]); input.enqueue(new Uint8Array(bytes)); }, releaseLock() {} };
    page.sandbox.fakePort = {
        open: async () => {}, close: async () => {},
        readable: new ReadableStream({ start(controller) { input = controller; } }),
        writable: { getWriter: () => fakeWriter }
    };
    const option = new Element(); option.textContent = 'USB'; page.elements.get('portSelect').appendChild(option);
    page.sandbox.initialize();
    page.run("port=fakePort;elements.portSelect.value='usb';elements.baudRate.value='115200';elements.dataBits.value='8';elements.stopBits.value='1';elements.parity.value='none';elements.flowControl.value='none';elements.lineEnding.value='none';");
    await page.run('openPort()');
    return { page, writes, fakeWriter };
}

function shareStandalone(page) {
    page.run('startSharing()'); page.sockets.at(-1).onopen();
    page.run("handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId,rxReplayProtocol:1,rxStreamId:rxReplayBuffer.streamId,rxSeq:registrationRXSeq});");
}

test('Local opens, sends binary and receives without a server or remote connection', async () => {
    const { page, writes } = await standaloneLocal();
    assert.equal(page.sockets.length, 0);
    assert.equal(page.run('registered'), false);
    assert.equal(page.elements.get('localId').textContent, '未共享');
    page.run("elements.sendInput.value='41 00 FF';elements.hexSend.checked=true;elements.lineEnding.value='crlf';elements.sendBtn.click();");
    await page.run('writeChain');
    assert.deepEqual(writes, [[65, 0, 255, 13, 10]]);
    assert.equal(page.run('rxBytes'), 5);
    assert.equal(page.run('txBytes'), 5);
    assert.equal(page.run("dataRecords.find(record=>record.kind==='TX').source"), '本机');
    assert.equal(page.sockets.length, 0);
    await page.run('closePort()');
});

test('Local serial selector keeps the compact browser-provided VID/PID label', async () => {
    const page=browser('local.js');
    page.sandbox.navigator.serial.requestPort=async()=>({getInfo:()=>({usbVendorId:0x10c4,usbProductId:0xea60})});
    await page.run('refreshPorts()');
    const option=page.elements.get('portSelect').children[0];
    assert.equal(option.value,'10C4:EA60');
    assert.equal(option.textContent,'串口设备 (10C4:EA60)');
    assert.doesNotMatch(option.textContent,/COM/,'do not present a USB identifier as a system COM number');
});

test('Stopping sharing preserves local serial operation and rejects a late registration ACK', async () => {
    const { page, writes } = await standaloneLocal();
    shareStandalone(page);
    const oldId = page.run('localId');
    page.run("autoAccept=true;elements.autoAccept.checked=true;stopSharing();");
    assert.equal(page.run('isOpen && !!writer'), true);
    assert.equal(page.run('autoAccept'), true);
    assert.equal(page.sockets[0].messages.at(-1).type, 'unregister');
    page.sandbox.oldId = oldId;
    page.run("handleServerMessage({type:'register',writeEpoch:1,paused:false,version:3,localId:oldId});elements.sendInput.value='A';sendLocalData();");
    await page.run('writeChain');
    assert.equal(page.run('registered'), false);
    assert.deepEqual(writes, [[65]]);
    const timersBeforeClose = page.timers.filter(timer => timer.delay === 3000).length;
    page.sockets[0].close();
    assert.equal(page.timers.filter(timer => timer.delay === 3000).length, timersBeforeClose);
    await page.run('closePort()');
});

test('Network loss withdraws remote control while local serial sends continue', async () => {
    const { page, writes } = await standaloneLocal();
    shareStandalone(page);
    page.run("connectedRemotes.set('REM23',{grantId:'request',portId:'usb',access:'control'});updateState();");
    assert.equal(page.elements.get('sendBtn').disabled, false);
    page.sockets[0].close();
    page.run("elements.sendInput.value='offline';sendLocalData();");
    await page.run('writeChain');
    assert.deepEqual(writes[0], [...Buffer.from('offline')]);
    assert.equal(page.run('isOpen && !registered && connectedRemotes.size===0'), true);
    await page.run('closePort()');
});

test('Local stays writable with Remote writers; pausing keeps subscriptions and disables auto-accept', async () => {
    const { page, writes } = await standaloneLocal(); shareStandalone(page);
    page.run("autoAccept=true;connectedRemotes.set('REM23',{grantId:'request',portId:'usb',access:'control'});elements.sendInput.value='A';sendLocalData();");
    await page.run('writeChain');
    assert.deepEqual(writes, [[65]]);
    page.run('toggleRemoteWrites();sendLocalData();');
    await page.run('writeChain');
    assert.deepEqual(writes, [[65],[65]]);
    assert.equal(page.run('autoAccept'), false);
    assert.equal(page.run('remoteWritesPaused'), true);
    assert.equal(page.run('connectedRemotes.size'), 1);
    assert.equal(page.sockets[0].messages.some(message=>message.type==='revoke'),false);
    assert.equal(page.sockets[0].messages.filter(message=>message.type==='set_write_state').at(-1).paused,true);
    await page.run('closePort()');
});

function incoming(page, id, access) {
    page.run(`handleServerMessage({type:'connection_request',requestId:'${id}',localId,remoteId:'${id}',portId:'usb',access:'${access}',version:3});`);
}

function confirmWriteState(page) {
    page.sandbox.stateAck=page.sockets[0].messages.filter(message=>message.type==='set_write_state').at(-1);
    page.run("handleServerMessage({...stateAck,type:'write_state',localId,writeEpoch:writeEpoch+1});");
}

test('Multiple Remote writers and Local use one FIFO without interleaving and retain source/order logs', async () => {
    const {page,writes,fakeWriter}=await standaloneLocal();shareStandalone(page);
    let release,active=0,peak=0;const blocked=new Promise(resolve=>{release=resolve;});
    fakeWriter.write=async bytes=>{active++;peak=Math.max(peak,active);writes.push([...bytes]);if(writes.length===1)await blocked;active--;};
    page.run("connectedRemotes.set('A',{grantId:'ga',portId:'usb',access:'control'});connectedRemotes.set('B',{grantId:'gb',portId:'usb',access:'control'});handleServerMessage({type:'send',remoteId:'A',grantId:'ga',writeEpoch:1,portId:'usb',data:'QQD/'});elements.sendInput.value='B';sendLocalData();handleServerMessage({type:'send',remoteId:'B',grantId:'gb',writeEpoch:1,portId:'usb',data:'Qw=='});");
    await Promise.resolve();assert.equal(writes.length,1);assert.equal(page.run('pendingWrites'),3);
    release();await page.run('writeChain');
    assert.deepEqual(writes,[[65,0,255],[66],[67]]);assert.equal(peak,1);
    assert.equal(page.run("JSON.stringify(dataRecords.filter(r=>r.kind==='TX').map(r=>[r.writeOrder,r.source]))"),JSON.stringify([[1,'Remote A'],[2,'本机'],[3,'Remote B']]));
    await page.run('closePort()');
});

test('Pause/resume invalidates old Remote queue entries while Local writes and new sends remain usable', async () => {
    const {page,writes,fakeWriter}=await standaloneLocal();shareStandalone(page);
    let release;const blocked=new Promise(resolve=>{release=resolve;});
    fakeWriter.write=async bytes=>{writes.push([...bytes]);if(writes.length===1)await blocked;};
    page.run("connectedRemotes.set('A',{grantId:'ga',portId:'usb',access:'control'});connectedRemotes.set('B',{grantId:'gb',portId:'usb',access:'control'});handleServerMessage({type:'send',remoteId:'A',grantId:'ga',writeEpoch:1,portId:'usb',data:'QQ=='});handleServerMessage({type:'send',remoteId:'B',grantId:'gb',writeEpoch:1,portId:'usb',data:'Qg=='});elements.sendInput.value='C';sendLocalData();");
    await Promise.resolve();page.run('toggleRemoteWrites()');
    assert.equal(page.run('remoteWritesPaused'),true);assert.equal(page.run('connectedRemotes.size'),2);
    confirmWriteState(page);page.run('toggleRemoteWrites()');
    assert.equal(page.run('remoteWritesPaused'),true); // Resume waits for server ACK.
    confirmWriteState(page);
    page.run("handleServerMessage({type:'send',remoteId:'B',grantId:'gb',writeEpoch:3,portId:'usb',data:'RA=='});");
    release();await page.run('writeChain');
    assert.deepEqual(writes,[[65],[67],[68]]);
    assert.equal(page.run("JSON.stringify(dataRecords.filter(r=>r.kind==='TX').map(r=>r.writeOrder))"),'[1,3,4]');
    assert.match(page.run("eventRecords.map(record=>record.text).join('|')"),/已跳过发送 #2 Remote B/);
    assert.equal(page.run('connectedRemotes.size'),2);assert.equal(page.run('autoAccept'),false);
    await page.run('closePort()');
});

test('Revoking then regranting the same Remote ID cannot revive its old queued writes', async () => {
    const {page,writes,fakeWriter}=await standaloneLocal();shareStandalone(page);
    let release;const blocked=new Promise(resolve=>{release=resolve;});
    fakeWriter.write=async bytes=>{writes.push([...bytes]);if(writes.length===1)await blocked;};
    page.run("connectedRemotes.set('A',{grantId:'old',portId:'usb',access:'control'});handleServerMessage({type:'send',remoteId:'A',grantId:'old',writeEpoch:1,portId:'usb',data:'QQ=='});handleServerMessage({type:'send',remoteId:'A',grantId:'old',writeEpoch:1,portId:'usb',data:'Qg=='});");
    await Promise.resolve();
    page.run("revokeRemote('A');connectedRemotes.set('A',{grantId:'new',portId:'usb',access:'control'});handleServerMessage({type:'send',remoteId:'A',grantId:'new',writeEpoch:1,portId:'usb',data:'Qw=='});");
    release();await page.run('writeChain');assert.deepEqual(writes,[[65],[67]]);
    await page.run('closePort()');
});

test('Auto-accept approves multiple readers and writers without reserving exclusive control', async () => {
    const { page } = await standaloneLocal(); shareStandalone(page);
    incoming(page,'READ1','read');
    assert.equal(page.sockets[0].messages.filter(message=>message.type==='approve').length,0);
    page.run('elements.autoAccept.checked=true;');page.elements.get('autoAccept').listeners.change();
    incoming(page,'CTRL1','control');incoming(page,'CTRL2','control');incoming(page,'READ2','read');
    const approvals=page.sockets[0].messages.filter(message=>message.type==='approve');
    assert.deepEqual(approvals.map(message=>[message.requestId,message.access]),[['READ1','read'],['CTRL1','control'],['CTRL2','control'],['READ2','read']]);
    assert.equal(page.elements.get('sendBtn').disabled,false);
    page.run("handleServerMessage({type:'remote_connected',grantId:'CTRL1',requestId:'CTRL1',remoteId:'CTRL1',portId:'usb',access:'control'});");
    incoming(page,'CTRL3','control');
    assert.equal(page.run("pendingRequests.get('CTRL2').decision"),'control');
    assert.equal(page.run("pendingRequests.get('CTRL3').decision"),'control');
    page.run('toggleRemoteWrites()');
    assert.equal(page.run('autoAccept'),false);
    incoming(page,'CTRL4','control');
    assert.equal(page.run("pendingRequests.get('CTRL4').decision"),undefined);
    await page.run('closePort()');
});

test('Local auto-accept preference persists in this browser and pauses still clear it', async () => {
    const storage = new Map();
    const {page:first}=await standaloneLocal({storage});
    shareStandalone(first);
    first.run('elements.autoAccept.checked=true;elements.autoAccept.listeners.change()');
    assert.equal(storage.get('shareserial.local.autoAccept.v1'), 'true');
    first.run('stopSharing()');
    assert.equal(first.run('autoAccept'),true);
    assert.equal(first.elements.get('autoAccept').checked,true);
    await first.run('closePort()');

    const reopened = browser('local.js', { storage });
    reopened.sandbox.initialize();
    assert.equal(reopened.elements.get('autoAccept').checked, true);
    reopened.run("connectWebSocket();isOpen=true;shareEnabled=true;localId='ABC23';elements.portSelect.value='usb';handleServerMessage({type:'connection_request',requestId:'REQ01',localId:'ABC23',remoteId:'REM23',portId:'usb',access:'read',version:3})");
    assert.equal(reopened.sockets[0].messages.filter(message=>message.type==='approve').length, 0,
        'stored auto-accept cannot approve before the Local registration is active');
    reopened.run("registered=true;handleServerMessage({type:'connection_request',requestId:'REQ02',localId:'ABC23',remoteId:'REM24',portId:'usb',access:'read',version:3})");
    assert.equal(reopened.sockets[0].messages.find(message=>message.requestId==='REQ02')?.access, 'read');
    reopened.run('toggleRemoteWrites()');
    assert.equal(reopened.run('autoAccept'), false);
    assert.equal(storage.get('shareserial.local.autoAccept.v1'), 'false');
});

test('A grant arriving after pause retains its subscription without enabling remote writes', async () => {
    const { page,writes }=await standaloneLocal();shareStandalone(page);
    page.run('autoAccept=true;');incoming(page,'CTRL1','control');
    page.run("toggleRemoteWrites();handleServerMessage({type:'remote_connected',grantId:'CTRL1',requestId:'CTRL1',remoteId:'CTRL1',portId:'usb',access:'control'});handleServerMessage({type:'send',grantId:'CTRL1',writeEpoch:1,remoteId:'CTRL1',portId:'usb',data:'QQ=='});");
    await page.run('writeChain');
    assert.equal(page.run('autoAccept'),false);
    incoming(page,'CTRL2','control');
    assert.equal(page.sockets[0].messages.filter(message=>message.type==='approve').length,1);
    assert.equal(page.run('connectedRemotes.size'),1);
    assert.equal(writes.length,0);
    assert.equal(page.elements.get('sendBtn').disabled,false);
    await page.run('closePort()');
});

test('Approving a Remote writer does not wait for existing Local writes to drain', async () => {
    const { page,fakeWriter }=await standaloneLocal();shareStandalone(page);
    let release;const blocked=new Promise(resolve=>{release=resolve;});
    fakeWriter.write=async()=>{await blocked;};
    page.run("elements.sendInput.value='A';sendLocalData();autoAccept=true;");incoming(page,'CTRL1','control');
    assert.equal(page.sockets[0].messages.filter(message=>message.type==='approve').length,1);
    assert.equal(page.run('pendingWrites'),1);
    release();await page.run('writeChain');
    assert.equal(page.elements.get('sendBtn').disabled,false);
    await page.run('closePort()');
});

test('Local enforces encoded-byte limit including CRLF and refuses malformed HEX', async () => {
    const { page, writes } = await standaloneLocal();
    for (const input of ['F', 'GG']) {
        page.elements.get('sendInput').value = input;
        page.run('elements.hexSend.checked=true;sendLocalData()');
    }
    page.run("elements.hexSend.checked=false;elements.sendInput.value='A'.repeat(16383);elements.lineEnding.value='crlf';sendLocalData();");
    await page.run('writeChain');
    assert.equal(writes.length, 0);
    page.run("elements.sendInput.value='A'.repeat(16382);sendLocalData();");
    await page.run('writeChain');
    assert.equal(writes[0].length, 16384);
    assert.deepEqual(writes[0].slice(-2), [13,10]);
    await page.run('closePort()');
});

test('Local history and unpainted rows stay bounded while critical events survive data traffic', () => {
    const page = browser('local.js');
    const paint = [];
    page.sandbox.requestAnimationFrame = callback => paint.push(callback);
    page.run("log('critical disconnect');for(let i=0;i<140;i++)recordSerial('RX',new Uint8Array(16384),'设备');");
    assert.equal(page.run('retainedBytes'), 2 * 1024 * 1024);
    assert.equal(page.run('dataRecords.length'), 128);
    assert.equal(page.run('eventRecords.length'), 1);
    assert.equal(page.run('pendingRecords.size'), 128);
    assert.equal(paint.length, 1);
    paint[0]();
    assert.doesNotMatch(page.elements.get('logContent').textContent, /critical disconnect/);assert.match(page.run("eventRecords.map(record=>record.text).join('|')"),/critical disconnect/);
    page.run("for(let i=0;i<2100;i++)recordSerial('TX',new Uint8Array([65]),'本机');");
    assert.equal(page.run('dataRecords.length'), 2000);
    assert.equal(page.run('eventRecords.length'), 1);
    page.run("for(let i=0;i<600;i++)log('event '+i);");
    assert.equal(page.run('eventRecords.length'), 500);
});

test('Granting a Remote does not cancel an already queued Local write', async () => {
    const { page,writes }=await standaloneLocal();
    page.run("elements.sendInput.value='A';sendLocalData();connectedRemotes.set('REM23',{grantId:'request',portId:'usb',access:'control'});");
    await page.run('writeChain');assert.deepEqual(writes,[[65]]);
    await page.run('closePort()');
});

test('Closing the physical port skips remaining queued Local writes', async () => {
    const {page,writes,fakeWriter}=await standaloneLocal();
    let release;const blocked=new Promise(resolve=>{release=resolve;});
    fakeWriter.write=async bytes=>{writes.push([...bytes]);if(writes.length===1)await blocked;};
    page.run("elements.sendInput.value='A';sendLocalData();elements.sendInput.value='B';sendLocalData();");
    await Promise.resolve();const closing=page.run('closePort()');release();await closing;
    assert.deepEqual(writes,[[65]]);assert.equal(page.run('isOpen'),false);
});

test('Local log filters and HEX toggles preserve bytes, sources and split UTF-8', async () => {
    const page = browser('local.js');
    page.run("log('event');recordSerial('RX',new Uint8Array([0xe4,0xb8]),'设备');recordSerial('RX',new Uint8Array([0xad]),'设备');recordSerial('TX',new Uint8Array([0,255]),'本机');");
    assert.equal(page.run("dataRecords.filter(r=>r.kind==='RX').map(r=>r.text).join('')"), '中');
    page.run("hexDisplay=true;elements.logFilter.value='TX';redrawLog();");
    assert.equal(page.elements.get('logContent').children.length, 1);
    assert.match(page.elements.get('logContent').textContent, /本机  00 FF/);
    page.run("hexDisplay=false;elements.logFilter.value='EVENT';redrawLog();");
    assert.equal(page.elements.get('logContent').children.length, 0);
    assert.match(page.run("eventRecords.map(record=>record.text).join('|')"), /event/);
    page.sandbox.URL = { createObjectURL(blob) { page.sandbox.exportedSystemBlob=blob; return 'blob:system'; }, revokeObjectURL() {} };
    page.run("elements.logFilter.value='all';exportLog()");
    assert.doesNotMatch(await page.sandbox.exportedSystemBlob.text(), /event/);
    page.run('exportSystemLog()');
    assert.match(await page.sandbox.exportedSystemBlob.text(), /EVENT event/);
    page.run('clearLog()');
    assert.equal(page.run('dataRecords.length'),0);
    assert.equal(page.run('eventRecords.length'),1,'clearing the serial log preserves system events');
});
