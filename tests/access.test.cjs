const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser } = require('./browser-harness.cjs');

function configurableRemote(access = 'control') {
    const page = remoteRequest(access);
    pending(page);
    page.run(`handleServerMessage({type:'connect',version:3,requestId:'request',grantId:'request',localId:'ABC23',portId:'usb',access:'${access}',writeEpoch:1,paused:false,
        configProtocol:1,configRevision:1,configuring:false,serialConfig:{baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}});`);
    return page;
}

test('Remote distinguishes edited parameters from Local-confirmed settings until an explicit apply succeeds', () => {
    const page = configurableRemote();
    assert.match(page.elements.get('configCurrent').textContent, /115200 baud/);
    page.elements.get('baudRate').value = '19200';
    page.elements.get('baudRate').listeners.change();
    assert.match(page.elements.get('configStatus').textContent, /未应用.*应用参数/);
    assert.match(page.elements.get('configCurrent').textContent, /115200 baud/);
    assert.doesNotMatch(page.elements.get('configCurrent').textContent, /19200/);
    assert.equal(page.sockets[0].messages.length, 1, 'a dropdown edit must not configure the device');
    assert.equal(page.elements.get('sendBtn').disabled, false);
    page.elements.get('applyConfigBtn').click();
    page.sandbox.operation = page.sockets[0].messages.at(-1).requestId;
    assert.match(page.elements.get('configStatus').textContent, /正在修改/);
    assert.match(page.elements.get('configCurrent').textContent, /115200 baud/);
    page.run("handleServerMessage({type:'serial_config_result',version:3,requestId:operation,grantId:'request',localId:'ABC23',portId:'usb',success:true,writeEpoch:3,paused:false,configProtocol:1,configRevision:2,configuring:false,serialConfig:{baudRate:19200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}});");
    assert.match(page.elements.get('configCurrent').textContent, /19200 baud/);
    assert.equal(page.elements.get('configStatus').textContent, '当前参数已同步');
    assert.equal(page.sockets[0].messages.length, 2);
});

test('Remote configuration needs control, current capability and an explicit apply action', () => {
    for (const mode of ['read', 'legacy', 'paused']) {
        const page = mode === 'legacy' ? remoteRequest('control') : configurableRemote(mode === 'read' ? 'read' : 'control');
        if (mode === 'legacy') { pending(page); grant(page, 'control'); }
        if (mode === 'paused') page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',writeEpoch:2,paused:true});");
        assert.equal(page.elements.get('applyConfigBtn').disabled, true);
        assert.equal(page.elements.get('baudRate').disabled, true);
        page.run('requestSerialConfig()');
        assert.equal(page.sockets[0].messages.length, 1);
    }
    const page = configurableRemote();
    assert.equal(page.elements.get('baudRate').value, '115200');
    assert.equal(page.elements.get('applyConfigBtn').disabled, false);
    page.elements.get('baudRate').value = '9600';
    assert.equal(page.sockets[0].messages.length, 1, 'editing must not apply automatically');
    page.elements.get('applyConfigBtn').click();
    const request = page.sockets[0].messages.at(-1);
    assert.equal(request.type, 'set_serial_config');
    assert.equal(request.serialConfig.baudRate, 9600);
    assert.equal(request.grantId, 'request');
    assert.equal(request.writeEpoch, 1);
    assert.equal(request.configRevision, 1);
    assert.equal(page.elements.get('sendBtn').disabled, true);
    assert.equal(page.elements.get('applyConfigBtn').disabled, true);
});

test('Remote accepts only its matching configuration result and never replays a blocked send', () => {
    const page = configurableRemote();
    page.elements.get('baudRate').value = '9600'; page.run('requestSerialConfig()');
    const request = page.sockets[0].messages.at(-1);
    page.sandbox.operation = request.requestId;
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',portId:'usb',writeEpoch:2,paused:false,configProtocol:1,configRevision:1,configuring:true,configId:'operation',serialConfig:{baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}});elements.sendInput.value='A';sendData();");
    assert.equal(page.sockets[0].messages.length, 2);
    for (const alteration of [{ requestId: 'other' }, { grantId: 'previous' }, { portId: 'other' }, { localId: 'OTHER' }]) {
        page.sandbox.alteration = alteration;
        page.run("handleServerMessage({type:'serial_config_result',requestId:operation,grantId:'request',localId:'ABC23',portId:'usb',success:true,...alteration});");
        assert.equal(page.run('pendingConfig'), request.requestId);
    }
    page.run("handleServerMessage({type:'serial_config_result',version:3,requestId:operation,grantId:'request',localId:'ABC23',portId:'usb',success:true,writeEpoch:3,paused:false,configProtocol:1,configRevision:2,configuring:false,serialConfig:{baudRate:9600,dataBits:7,stopBits:2,parity:'even',flowControl:'hardware'}});");
    assert.equal(page.run('pendingConfig'), null);
    assert.equal(page.elements.get('baudRate').value, '9600');
    assert.equal(page.elements.get('dataBits').value, '7');
    assert.equal(page.elements.get('sendBtn').disabled, false);
    assert.equal(page.sockets[0].messages.length, 2, 'completion must not resend data');
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',portId:'usb',writeEpoch:2,paused:false,configProtocol:1,configRevision:1,configuring:true,serialConfig:{baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}});");
    assert.equal(page.elements.get('baudRate').value, '9600');
    assert.equal(page.elements.get('sendBtn').disabled, false);
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',portId:'usb',writeEpoch:4,paused:false,configProtocol:1,configRevision:1,configuring:false,serialConfig:{baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}});");
    assert.equal(page.elements.get('baudRate').value, '9600', 'new epoch cannot roll back parameter revision');
    assert.equal(page.run('writeEpoch'), 3);
});

test('Rejected Remote configuration releases its request controls and malformed settings never leave the page', () => {
    const page = configurableRemote();
    page.elements.get('baudRate').value = '0'; page.run('requestSerialConfig()');
    assert.equal(page.sockets[0].messages.length, 1);
    page.elements.get('baudRate').value = '9600'; page.run('requestSerialConfig()');
    page.sandbox.operation = page.sockets[0].messages.at(-1).requestId;
    page.run("handleServerMessage({type:'error',requestId:operation,code:'stale_configuration'});");
    assert.equal(page.run('pendingConfig'), null);
    assert.equal(page.elements.get('applyConfigBtn').disabled, false);
    assert.equal(page.elements.get('sendBtn').disabled, false);
    assert.match(page.elements.get('errorMessage').textContent, /其他端修改/);
    page.run("handleServerMessage({type:'permission_revoked'});requestSerialConfig();");
    assert.equal(page.run('pendingConfig'), null);
    assert.equal(page.sockets[0].messages.length, 2);
    assert.equal(page.elements.get('applyConfigBtn').disabled, true);
});

function remoteRequest(access = 'read') {
    const page = browser('remote.js');
    page.sandbox.initialize();
    page.elements.get('localIdInput').value = 'ABC23';
    page.elements.get('accessSelect').value = access;
    page.elements.get('connectBtn').click();
    return page;
}

function pending(page, id = 'request') {
    page.run(`handleServerMessage({type:'connect_pending',requestId:'${id}',localId:'ABC23',remoteId:'REM23',access:'read',expiresIn:60,version:3});`);
}

function grant(page, access = 'read', id = 'request') {
    page.run(`handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'${id}',localId:'ABC23',portId:'usb',access:'${access}',version:3});`);
}

function localRequest(access = 'control') {
    const page = browser('local.js');
    page.run("connectWebSocket(); isOpen=true; registered=true;writeEpoch=1; localId='ABC23'; elements.portSelect.value='usb';");
    page.run(`handleServerMessage({type:'connection_request',requestId:'request',localId:'ABC23',portId:'usb',remoteId:'REM23',access:'${access}',version:3});`);
    return page;
}

test('Remote pending request has no data or write access and can be cancelled', () => {
    const page = remoteRequest();
    assert.deepEqual(page.sockets[0].messages[0], { type: 'connect', localId: 'ABC23', access: 'read', version: 3, rxReplayProtocol: 1, flashProtocol: 1 });
    pending(page);
    assert.equal(page.run('isConnected'), false);
    assert.equal(page.elements.get('sendBtn').disabled, true);
    page.run("handleServerMessage({type:'data',localId:'ABC23',portId:'usb',data:'QQ=='});");
    assert.equal(page.run('records.length'), 0);
    page.elements.get('sendInput').value = 'AT';
    page.run('sendData()');
    assert.equal(page.sockets[0].messages.length, 1);
    page.elements.get('cancelConnectBtn').click();
    assert.equal(page.sockets[0].messages[1].type, 'disconnect');
    assert.equal(page.run('isPending'), false);
    grant(page); // late grant after local cancellation cannot restore access
    assert.equal(page.run('isConnected'), false);
});

test('Remote ignores mismatched grants and read permission disables every send path', () => {
    const page = remoteRequest();
    pending(page);
    grant(page, 'control', 'stale');
    assert.equal(page.run('isConnected'), false);
    grant(page);
    assert.equal(page.run('isConnected'), true);
    assert.equal(page.elements.get('sendBtn').disabled, true);
    page.elements.get('sendInput').value = 'AT';
    page.run('sendData()');
    page.presets[0].click();
    assert.equal(page.sockets[0].messages.length, 1);
    page.run("handleServerMessage({type:'data',localId:'ABC23',portId:'usb',data:'QQ=='});");
    assert.equal(page.run('records[0].text'), 'A');
});

test('Control grant enables sends and revocation removes permission', () => {
    const page = remoteRequest('control');
    pending(page);
    grant(page, 'control');
    page.elements.get('sendInput').value = 'AT';
    page.run('sendData()');
    assert.equal(page.sockets[0].messages[1].type, 'send');
    page.run("handleServerMessage({type:'permission_revoked'});");
    assert.equal(page.run('isConnected'), false);
    assert.equal(page.run('access'), '');
    assert.equal(page.elements.get('sendBtn').disabled, true);
    page.run('sendData()');
    assert.equal(page.sockets[0].messages.length, 2);
});

test('Denied and expired requests return Remote to a retryable state', () => {
    for (const code of ['connection_denied', 'approval_timeout', 'local_disconnected']) {
        const page = remoteRequest(); pending(page);
        page.run(`handleServerMessage({type:'error',code:'${code}',error:'Request ended'});`);
        assert.equal(page.run('isPending'), false);
        assert.equal(page.elements.get('connectBtn').disabled, false);
        assert.equal(page.elements.get('accessSelect').disabled, false);
        grant(page); assert.equal(page.run('isConnected'), false);
    }
});

test('Local decision UI defaults to least privilege and permits retry after a capacity error', () => {
    const page = localRequest();
    const row = page.elements.get('pendingList').children[0];
    row.children[2].click(); // control approval
    assert.deepEqual(page.sockets[0].messages[0], { type: 'approve', requestId: 'request', access: 'control' });
    page.run("decideRequest('request','read');");
    assert.equal(page.sockets[0].messages.length, 1);
    page.run("handleServerMessage({type:'error',requestId:'request',code:'too_many_remotes',error:'Capacity reached'});");
    page.elements.get('pendingList').children[0].children[1].click(); // downgrade to read
    assert.equal(page.sockets[0].messages[1].access, 'read');
    page.run("handleServerMessage({type:'remote_connected',grantId:'request',requestId:'request',remoteId:'REM23',portId:'usb',access:'read'});");
    assert.equal(page.run('pendingRequests.size'), 0);
    assert.equal(page.run("connectedRemotes.get('REM23').access"), 'read');
});

test('Local rejects unsolicited or altered grants and rejects an application', () => {
    const page = localRequest('read');
    page.run("handleServerMessage({type:'remote_connected',grantId:'request',requestId:'request',remoteId:'REM23',portId:'usb',access:'control'});");
    assert.equal(page.run('connectedRemotes.size'), 0);
    page.elements.get('pendingList').children[0].children[1].click(); // approve read
    page.run("handleServerMessage({type:'remote_connected',grantId:'request',requestId:'request',remoteId:'REM23',portId:'usb',access:'control'});");
    assert.equal(page.run('connectedRemotes.size'), 0);
    const denied = localRequest('read');
    denied.elements.get('pendingList').children[0].children[2].click();
    assert.deepEqual(denied.sockets[0].messages[0], { type: 'reject', requestId: 'request' });
    denied.run("handleServerMessage({type:'request_cancelled',requestId:'request'});");
    assert.equal(denied.run('pendingRequests.size'), 0);
});

test('Local requires the authorization-capable protocol before sharing', () => {
    const page = browser('local.js');
    page.run("connectWebSocket(); isOpen=true; shareEnabled=true; localId='ABC23'; handleServerMessage({type:'register',localId:'ABC23'});");
    assert.equal(page.run('registered'), false);
    assert.equal(page.sockets[0].messages[0].type, 'unregister');
    page.run("handleServerMessage({type:'register',localId:'ABC23',version:2,paused:false,writeEpoch:1});");
    assert.equal(page.run('registered'), false);
    page.run("handleServerMessage({type:'register',writeEpoch:1,paused:false,localId:'ABC23',version:3});");
    assert.equal(page.run('registered'), true);
});

test('Local permits only its approved controller to reach the serial writer', async () => {
    const page = localRequest();
    const writes = [];
    page.sandbox.fakeWriter = { write: async bytes => writes.push([...bytes]) };
    page.run("writer=fakeWriter; decideRequest('request','control'); handleServerMessage({type:'remote_connected',grantId:'request',requestId:'request',remoteId:'REM23',portId:'usb',access:'control'});");
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'OTHER',portId:'usb',data:'QQ=='});");
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'uart',data:'QQ=='});");
    page.run("connectedRemotes.set('READ2',{grantId:'request',portId:'usb',access:'read'}); handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'READ2',portId:'usb',data:'QQ=='});");
    page.run("for(let i=0;i<257;i++) handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'OTHER',portId:'usb',data:'QQ=='});");
    assert.equal(page.sockets[0].readyState, 1); // invalid traffic cannot exhaust the physical-write queue
    await page.run('writeChain');
    assert.equal(writes.length, 0);
    page.run("handleServerMessage({type:'send',grantId:'wrong',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'QQ=='});handleServerMessage({type:'send',grantId:'request',writeEpoch:2,remoteId:'REM23',portId:'usb',data:'QQ=='});");
    await page.run('writeChain');
    assert.equal(writes.length, 0);
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'Qg=='});");
    await page.run('writeChain');
    assert.deepEqual(writes, [[66]]);
});

test('Remote rejects grants from an incompatible protocol or with unknown permission', () => {
    for (const response of [{version:1,access:'control'}, {version:2,access:'control'}, {version:3,access:'admin'}]) {
        const page=remoteRequest('control'); pending(page);
        page.sandbox.response=response;
        page.run("handleServerMessage({type:'connect',grantId:'request',writeEpoch:1,paused:false,requestId:'request',localId:'ABC23',portId:'usb',...response});");
        assert.equal(page.run('isConnected'), false);
        assert.equal(page.sockets[0].messages.at(-1).type, 'disconnect');
    }
});

test('Remote pause retains RX and approval; resume updates epoch without replaying a command', () => {
    const page=remoteRequest('control');pending(page);grant(page,'control');
    page.elements.get('sendInput').value='A';
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',paused:true,writeEpoch:2});sendData();handleServerMessage({type:'data',localId:'ABC23',portId:'usb',data:'Qg=='});");
    assert.equal(page.run('isConnected'),true);assert.equal(page.run('records.length'),1);
    assert.equal(page.elements.get('sendBtn').disabled,true);assert.equal(page.sockets[0].messages.length,1);
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',paused:false,writeEpoch:3});");
    assert.equal(page.sockets[0].messages.length,1);assert.equal(page.elements.get('sendBtn').disabled,false);
    page.run('sendData()');assert.equal(page.sockets[0].messages.at(-1).writeEpoch,3);
    assert.equal(page.sockets[0].messages.at(-1).grantId,'request');
    page.run("handleServerMessage({type:'write_state',version:3,localId:'ABC23',paused:true,writeEpoch:2});");
    assert.equal(page.elements.get('sendBtn').disabled,false);
});

test('Local revoke button stops queued writes immediately before server reply', async () => {
    const page = localRequest();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const writes = [];
    page.sandbox.fakeWriter = { write: async bytes => { await blocked; writes.push([...bytes]); } };
    page.run("writer=fakeWriter; decideRequest('request','control'); handleServerMessage({type:'remote_connected',grantId:'request',requestId:'request',remoteId:'REM23',portId:'usb',access:'control'});");
    page.run("handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'QQ=='}); handleServerMessage({type:'send',grantId:'request',writeEpoch:1,remoteId:'REM23',portId:'usb',data:'Qg=='});");
    await Promise.resolve();
    page.elements.get('remoteList').children[0].children[1].click();
    assert.equal(page.sockets[0].messages.at(-1).type, 'revoke');
    assert.equal(page.run('connectedRemotes.size'), 0);
    release(); await page.run('writeChain');
    assert.deepEqual(writes, [[65]]);
});
