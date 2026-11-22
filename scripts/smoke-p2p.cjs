// Native Chromium/WebRTC acceptance against a running ShareSerial server.
// All payloads are synthetic. No serial device, STUN or TURN is used.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
const origin=process.argv[2]||'https://127.0.0.1:12559';
const reportPath=process.argv[3]||'.local/p2p-browser-report.json';
const stress=process.argv.includes('--stress');
const chromePath=process.env.P2P_CHROME||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>fs.existsSync(file));
if(!chromePath)throw Error('Set P2P_CHROME to a Chromium browser executable');
const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shareserial-p2p-browser-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={origin,realWebRTC:true,syntheticData:true,hardwareTested:false,externalICEServers:false};
let chrome,socket,command;
function summarizeRates(values){
    const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
    const round=value=>Math.round(value*1000)/1000;
    return {samples:sorted.length,minimum:round(sorted[0]),median:round(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2),maximum:round(sorted.at(-1))};
}

(async()=>{
    const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
    const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--ignore-certificate-errors',
        '--remote-debugging-port='+port,'--user-data-dir='+temporary,'about:blank'],{stdio:'ignore',windowsHide:true});
    let info;
    for(let i=0;i<100;i++){try{info=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();break}catch{await delay(100)}}
    assert(info,'Chrome did not start');report.browser=info.Browser;
    socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
    let next=0;const pending=new Map(),wire=new Map();
    command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}))});
    socket.addEventListener('message',event=>{
        const message=JSON.parse(event.data);
        if(message.id&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result)}
        if(message.method==='Network.webSocketFrameSent'||message.method==='Network.webSocketFrameReceived'){
            try{const body=JSON.parse(message.params.response.payloadData);if(body.type==='p2p_probe_frame')wire.set(message.sessionId,(wire.get(message.sessionId)||0)+1)}catch{}
        }
    });
    async function evaluate(session,expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
    async function wait(session,expression){for(let i=0;i<180;i++){const value=await evaluate(session,expression);if(value)return value;await delay(100)}throw Error('Timeout '+expression)}
    async function page(role){
        const {browserContextId}=await command('Target.createBrowserContext');
        const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
        const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
        await command('Page.enable',{},sessionId);await command('Runtime.enable',{},sessionId);await command('Network.enable',{},sessionId);
        await command('Security.setIgnoreCertificateErrors',{ignore:true},sessionId);
        await command('Emulation.setLocaleOverride',{locale:'zh-CN'},sessionId);
        await command('Network.setUserAgentOverride',{userAgent:await evaluate(sessionId,'navigator.userAgent'),acceptLanguage:'zh-CN,zh'},sessionId);
        // Record native channels for deliberate malformed/unauthorized frame tests.
        await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.__probeChannels=[];window.__probeSockets=[];const NativeWS=window.WebSocket;window.WebSocket=class extends NativeWS{constructor(...args){super(...args);__probeSockets.push(this)}};const NativeRTC=window.RTCPeerConnection;window.RTCPeerConnection=class extends NativeRTC{createDataChannel(...args){const channel=super.createDataChannel(...args);__probeChannels.push(channel);return channel}};`},sessionId);
        await command('Page.navigate',{url:origin+'/experimental/p2p?role='+role},sessionId);
        await wait(sessionId,'!!window.ShareSerialP2PProbe');return sessionId;
    }
    const local=await page('local');await evaluate(local,"document.getElementById('connect').click()");
    await wait(local,"document.getElementById('status').textContent.includes('共享已开启')");
    const code=(await evaluate(local,'ShareSerialP2PProbe.stats()')).localId;
    const remote=await page('remote');
    await evaluate(remote,`document.getElementById('code').value=${JSON.stringify(code)};document.getElementById('access').value='control';document.getElementById('connect').click()`);
    await wait(local,'ShareSerialP2PProbe.stats().then(s=>s.pending===1)');
    assert.equal(await evaluate(remote,'ShareSerialP2PProbe.stats().then(s=>s.peers.length)'),0);
    assert.equal(await evaluate(remote,'__probeChannels.length'),0);report.noPeerBeforeApproval=true;
    await evaluate(local,"document.querySelector('[data-access=control]').click()");
    await wait(remote,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='p2p')");
    await wait(local,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='p2p')");
    const expectedHashes=new Map();
    const expected=bytes=>{if(!expectedHashes.has(bytes))expectedHashes.set(bytes,crypto.createHash('sha256').update(Uint8Array.from({length:bytes},(_,index)=>(index*31+(index>>>8))&255)).digest('hex'));return expectedHashes.get(bytes)};
    const sent=await evaluate(local,'ShareSerialP2PProbe.start(1048576)');assert.equal(sent.mode,'p2p');assert.equal(sent.sha256,expected(1048576));report.localToRemote=sent;
    const reverse=await evaluate(remote,'ShareSerialP2PProbe.start(262144)');assert.equal(reverse.mode,'p2p');assert.equal(reverse.sha256,expected(262144));report.remoteToLocal=reverse;
    if(stress){
        report.stress={duplexRounds:[],reconnectRounds:[],syntheticBytes:0};
        for(let round=0;round<5;round++){
            const began=performance.now();
            const pair=await Promise.all([evaluate(local,'ShareSerialP2PProbe.start(4194304)'),evaluate(remote,'ShareSerialP2PProbe.start(4194304)')]);
            const wallMilliseconds=performance.now()-began;
            for(const result of pair){assert.equal(result.mode,'p2p');assert.equal(result.bytes,4194304);assert.equal(result.sha256,expected(4194304));report.stress.syntheticBytes+=result.bytes;}
            report.stress.duplexRounds.push({wallMilliseconds:Math.round(wallMilliseconds),aggregateMiBPerSecond:8/(wallMilliseconds/1000),directions:pair.map(result=>({bytes:result.bytes,milliseconds:result.milliseconds,kibPerSecond:result.kibPerSecond}))});
        }
    }
    const direct=await evaluate(remote,'ShareSerialP2PProbe.stats()');report.selectedCandidate=direct.peers[0].candidate;
    assert.equal(direct.peers[0].wsSent,0);assert.equal(direct.peers[0].wsReceived,0);
    assert.equal(wire.get(local)||0,0);assert.equal(wire.get(remote)||0,0);report.noServerDataFramesDuringDirect=true;
    assert.equal(report.selectedCandidate.local,'host');assert.equal(report.selectedCandidate.remote,'host');
    const controlID=direct.peers[0].id;
    const readonly=await page('remote');
    await evaluate(readonly,`document.getElementById('code').value=${JSON.stringify(code)};document.getElementById('connect').click()`);
    await wait(local,'ShareSerialP2PProbe.stats().then(s=>s.pending===1)');
    await evaluate(local,"document.querySelector('[data-access=read]').click()");
    await wait(readonly,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='p2p')");
    const readID=(await evaluate(readonly,'ShareSerialP2PProbe.stats()')).peers[0].id;
    await evaluate(local,`document.getElementById('target').value=${JSON.stringify(readID)}`);
    const readResult=await evaluate(local,'ShareSerialP2PProbe.start(65536)');assert.equal(readResult.sha256,expected(65536));
    assert.equal(await evaluate(readonly,'ShareSerialP2PProbe.start(16).then(()=>false,()=>true)'),true);
    const inject=`(()=>{const text=new TextEncoder().encode(JSON.stringify({op:'begin',id:1234,bytes:32,epoch:1}));const wire=new Uint8Array(text.length+1);wire.set(text,1);__probeChannels[0].send(wire)})()`;
    await evaluate(readonly,inject);await wait(local,'ShareSerialP2PProbe.stats().then(s=>s.denied>=1)');report.readOnlyDirectInjectionRejected=true;
    if(stress){
        const began=performance.now();
        const concurrent=await Promise.all([
            evaluate(local,`(()=>{const target=document.getElementById('target');target.value=${JSON.stringify(controlID)};const first=ShareSerialP2PProbe.start(4194304);target.value=${JSON.stringify(readID)};const second=ShareSerialP2PProbe.start(4194304);return Promise.all([first,second])})()`),
            evaluate(remote,'ShareSerialP2PProbe.start(4194304)')
        ]);
        const wallMilliseconds=performance.now()-began;
        const results=[...concurrent[0],concurrent[1]];
        for(const result of results){assert.equal(result.sha256,expected(4194304));assert.equal(result.mode,'p2p');report.stress.syntheticBytes+=result.bytes;}
        assert.equal(wire.get(local)||0,0);assert.equal(wire.get(remote)||0,0);assert.equal(wire.get(readonly)||0,0);
        report.stress.concurrentStreams={wallMilliseconds:Math.round(wallMilliseconds),aggregateMiBPerSecond:12/(wallMilliseconds/1000),streams:results.map(result=>({peer:result.peer,bytes:result.bytes,milliseconds:result.milliseconds,kibPerSecond:result.kibPerSecond}))};
    }
    await evaluate(local,"document.getElementById('pause').click()");
    await wait(remote,'ShareSerialP2PProbe.stats().then(s=>s.paused)');
    assert.equal(await evaluate(remote,'ShareSerialP2PProbe.start(16).then(()=>false,()=>true)'),true);
    await evaluate(local,'ShareSerialP2PProbe.start(32768)');report.pauseRetainsReceive=true;
    await evaluate(local,"document.getElementById('pause').click()");await wait(remote,'ShareSerialP2PProbe.stats().then(s=>!s.paused)');
    const denied=(await evaluate(local,'ShareSerialP2PProbe.stats()')).denied;
    await evaluate(remote,inject);await wait(local,`ShareSerialP2PProbe.stats().then(s=>s.denied>${denied})`);report.staleEpochRejected=true;
    // Close a native channel while data is queued, then verify that the old
    // transfer aborts without replaying its frames through the relay.
    await evaluate(remote,`(()=>{const ch=__probeChannels[0],send=ch.send.bind(ch);let frames=0;ch.send=data=>{send(data);if(++frames===6)setTimeout(()=>ch.close(),0)};window.__interrupted=ShareSerialP2PProbe.start(4194304).then(()=>({failed:false}),error=>({failed:true,message:error.message}))})()`);
    await wait(remote,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='websocket')");
    await wait(local,`ShareSerialP2PProbe.stats().then(s=>s.peers.find(p=>p.id===${JSON.stringify(controlID)})?.mode==='websocket')`);
    assert.equal((await evaluate(remote,'__interrupted')).failed,true);
    assert.equal(wire.get(local)||0,0);assert.equal(wire.get(remote)||0,0);report.interruptedTransferNotReplayed=true;
    await evaluate(local,`document.getElementById('target').value=${JSON.stringify(controlID)}`);
    const fallback=await evaluate(local,'ShareSerialP2PProbe.start(65536)');assert.equal(fallback.mode,'websocket');assert.equal(fallback.sha256,expected(65536));
    const fallbackReverse=await evaluate(remote,'ShareSerialP2PProbe.start(65536)');assert.equal(fallbackReverse.sha256,expected(65536));
    assert((wire.get(local)||0)>0);report.fallback={...fallback,reverseBytes:fallbackReverse.bytes};
    await evaluate(local,`document.getElementById('target').value=${JSON.stringify(controlID)};[...document.querySelectorAll('#peers .peer')].find(row=>row.textContent.startsWith(${JSON.stringify(controlID)})).querySelector('button').click()`);
    await wait(remote,'ShareSerialP2PProbe.stats().then(s=>s.peers.length===0)');
    assert.equal(await evaluate(remote,'ShareSerialP2PProbe.start(16).then(()=>false,()=>true)'),true);report.revocationStopsPeer=true;
    await evaluate(local,`document.getElementById('target').value=${JSON.stringify(readID)}`);
    await evaluate(local,'ShareSerialP2PProbe.start(32768)');report.otherApprovedPeerUnaffected=true;
    if(stress){
        // Reuse the same real page after disconnect: stale browser callbacks,
        // old approvals and retained UI state must not revive earlier peers.
        for(let round=0;round<10;round++){
            await evaluate(remote,`window.__probeChannels=[];document.getElementById('code').value=${JSON.stringify(code)};document.getElementById('access').value='control';document.getElementById('connect').click()`);
            await wait(local,'ShareSerialP2PProbe.stats().then(s=>s.pending===1)');
            await evaluate(local,"document.querySelector('[data-access=control]').click()");
            await wait(remote,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='p2p')");
            const freshID=(await evaluate(remote,'ShareSerialP2PProbe.stats()')).peers[0].id;
            await evaluate(local,`document.getElementById('target').value=${JSON.stringify(freshID)}`);
            const pair=await Promise.all([evaluate(local,'ShareSerialP2PProbe.start(65536)'),evaluate(remote,'ShareSerialP2PProbe.start(65536)')]);
            for(const result of pair){assert.equal(result.sha256,expected(65536));assert.equal(result.mode,'p2p');report.stress.syntheticBytes+=result.bytes;}
            let endedBy='disconnect';
            if(round===4||round===8){
                const received=(await evaluate(local,'ShareSerialP2PProbe.stats()')).peers.find(peer=>peer.id===freshID).p2pReceived;
                const relayedBefore=wire.get(remote)||0;
                await evaluate(remote,"(()=>{window.__inFlight=ShareSerialP2PProbe.start(4194304).then(()=>({failed:false}),error=>({failed:true,message:error.message}))})()");
                await wait(local,`ShareSerialP2PProbe.stats().then(s=>s.peers.find(p=>p.id===${JSON.stringify(freshID)})?.p2pReceived>${received+16384})`);
                if(round===4){
                    endedBy='in-flight revoke';
                    await evaluate(local,`[...document.querySelectorAll('#peers .peer')].find(row=>row.textContent.startsWith(${JSON.stringify(freshID)})).querySelector('button').click()`);
                }else{
                    endedBy='in-flight WSS close';
                    await evaluate(remote,"__probeSockets.at(-1).close(4000,'test signaling interruption')");
                }
                await wait(remote,'ShareSerialP2PProbe.stats().then(s=>s.peers.length===0)');
                assert.equal((await evaluate(remote,'__inFlight')).failed,true);
                assert.equal(wire.get(remote)||0,relayedBefore,'interrupted old data was relayed');
            }else if(round%2){
                endedBy='WSS close';await evaluate(remote,"__probeSockets.at(-1).close(4000,'test disconnect')");
            }else await evaluate(remote,'ShareSerialP2PProbe.disconnect()');
            await wait(remote,'ShareSerialP2PProbe.stats().then(s=>s.peers.length===0)');
            await wait(local,`ShareSerialP2PProbe.stats().then(s=>s.peers.length===1&&s.peers[0].id===${JSON.stringify(readID)}&&s.pending===0)`);
            report.stress.reconnectRounds.push({round:round+1,endedBy,remainingPeers:1});
        }
        const unsupported=await page('remote');
        await evaluate(unsupported,`window.RTCPeerConnection=undefined;document.getElementById('code').value=${JSON.stringify(code)};document.getElementById('connect').click()`);
        await wait(local,'ShareSerialP2PProbe.stats().then(s=>s.pending===1)');
        await evaluate(local,"document.querySelector('[data-access=read]').click()");
        await wait(unsupported,"ShareSerialP2PProbe.stats().then(s=>s.peers[0]?.mode==='websocket')");
        const unsupportedID=(await evaluate(unsupported,'ShareSerialP2PProbe.stats()')).peers[0].id;
        await wait(local,`ShareSerialP2PProbe.stats().then(s=>s.peers.find(p=>p.id===${JSON.stringify(unsupportedID)})?.mode==='websocket')`);
        await evaluate(local,`document.getElementById('target').value=${JSON.stringify(unsupportedID)}`);
        const received=await evaluate(local,'ShareSerialP2PProbe.start(65536)');assert.equal(received.sha256,expected(65536));assert.equal(received.mode,'websocket');
        report.stress.webRTCUnavailableFallback=true;
        await evaluate(unsupported,'ShareSerialP2PProbe.disconnect()');
        report.rates={unit:'MiB/s',directionMeasurement:'payload bytes / (hash + send + receipt); excludes pattern creation',aggregateMeasurement:'total payload bytes / wall clock; includes preparation and CDP overhead',
            localToRemote:summarizeRates(report.stress.duplexRounds.map(round=>round.directions[0].kibPerSecond/1024)),
            remoteToLocal:summarizeRates(report.stress.duplexRounds.map(round=>round.directions[1].kibPerSecond/1024)),
            duplexAggregate:summarizeRates(report.stress.duplexRounds.map(round=>round.aggregateMiBPerSecond)),
            threeStreamAggregate:Math.round(report.stress.concurrentStreams.aggregateMiBPerSecond*1000)/1000};
    }
    await evaluate(local,'ShareSerialP2PProbe.disconnect()');
    await wait(readonly,'ShareSerialP2PProbe.stats().then(s=>s.peers.length===0)');report.signalingLossClosesDirectPeer=true;
    fs.mkdirSync(path.dirname(path.resolve(reportPath)),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
    if(command&&socket?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});socket.close()}
    if(chrome&&chrome.exitCode===null){const exited=new Promise(resolve=>chrome.once('exit',resolve));await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null)chrome.kill()}
    if(process.platform==='win32'){
        // Edge may retain a profile-specific utility after Browser.close.
        // Only terminate processes of the dedicated temporary test profile.
        const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
        await execute(powershell,['-NoLogo','-NoProfile','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and $_.CommandLine -and $_.CommandLine.Contains($env:SS_P2P_TEST_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"],
            {env:{...process.env,SS_P2P_TEST_PROFILE:temporary},windowsHide:true}).catch(()=>{});
    }
    const parent=fs.realpathSync(os.tmpdir()),target=fs.realpathSync(temporary);
    if(path.dirname(target)===parent&&path.basename(target).startsWith('shareserial-p2p-browser-')){
        for(let attempt=0;attempt<40;attempt++){
            try{fs.rmSync(target,{recursive:true,force:true});break}catch(error){if(attempt===39)throw error;await delay(250)}
        }
    }
});
