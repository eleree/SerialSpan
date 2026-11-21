// Existing Local/Remote pages, native WebRTC, and a simulated browser serial
// device. This does not substitute for Web Serial permission/hardware acceptance.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12560',output=process.argv[3]||'.local/serial-p2p-browser.json';
const mock=`window.__device={writes:[],controller:null,inject(bytes){this.controller.enqueue(Uint8Array.from(bytes))}};
const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.controller=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){this.readable=null;this.writable=null},async setSignals(){}};
Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
let browser;
(async()=>{
    browser=await launch();const {evaluate:ev,wait,page,delay,wire}=browser;
    const report={browser:browser.version,realWebRTC:true,simulatedSerial:true,hardwareTested:false,origin};
    const diagnostics=process.argv.includes('--diagnostics');
    const retry=process.argv.includes('--retry');
    // QA-only: hold the first two native SDP operations past the real 45-second
    // deadline, then let the third fresh PeerConnection negotiate normally.
    const retryMock=retry?`const RetryNativeRTC=window.RTCPeerConnection;let retryInstances=0;window.RTCPeerConnection=class extends RetryNativeRTC{constructor(...args){super(...args);this.qaHold=++retryInstances<=2}async setRemoteDescription(...args){if(this.qaHold)await new Promise(resolve=>setTimeout(resolve,46000));return super.setRemoteDescription(...args)}};`:'';
    const local=await page(origin+'/local',mock+retryMock+(diagnostics?`const DiagnosticNativeRTC=window.RTCPeerConnection;window.RTCPeerConnection=class extends DiagnosticNativeRTC{async setLocalDescription(...args){await super.setLocalDescription(...args);if(this.iceGatheringState!=='complete')await new Promise(resolve=>{const done=()=>{if(this.iceGatheringState==='complete'){this.removeEventListener('icegatheringstatechange',done);clearTimeout(timer);resolve()}};const timer=setTimeout(resolve,5000);this.addEventListener('icegatheringstatechange',done)})}};`:''));
    await ev(local,"document.getElementById('refreshBtn').click()");await wait(local,'!!port');
    await ev(local,"document.getElementById('openPortBtn').click()");await wait(local,'isOpen');
    await ev(local,"document.getElementById('shareBtn').click()");await wait(local,'registered');
    const code=await ev(local,'localId');
    async function connect(access='control',disabled=false){
        const remote=await page(origin+'/remote',disabled?"Object.defineProperty(window,'RTCPeerConnection',{value:undefined});":retry&&!report.retry?retryMock:'');
        await ev(remote,`document.getElementById('localIdInput').value=${JSON.stringify(code)};document.getElementById('accessSelect').value=${JSON.stringify(access)};document.getElementById('connectBtn').click()`);
        await wait(local,'pendingRequests.size===1');assert.equal(await ev(remote,'!!serialPeer'),false);
        const negotiationStarted=performance.now();
        await ev(local,`[...document.querySelectorAll('#pendingList button')].find(b=>b.textContent===${JSON.stringify(access==='control'?'允许控制':'允许只读')}).click()`);
        await wait(remote,'isConnected');
        if(retry&&!report.retry){
            await ev(remote,"elements.hexSend.checked=true;elements.sendCR.checked=false;elements.sendInput.value='A5 00 FF';sendData()");
            await wait(local,'__device.writes.length===1');assert.deepEqual(await ev(local,'__device.writes[0]'),[165,0,255]);
            await ev(local,'__device.writes.length=0');
            await wait(remote,'serialPeer?.direct',130000);
            assert.equal(await ev(local,'__device.writes.length'),0,'connection retry must not replay a relay command');
            report.retry={elapsedMs:Math.round(performance.now()-negotiationStarted),attempt:await ev(remote,'serialPeer.attempt+1'),relayTXDuringNegotiation:true,serialReplay:false};
            assert(report.retry.elapsedMs>=100000);assert.equal(report.retry.attempt,3);
        }else if(!disabled)await wait(remote,'serialPeer?.direct',retry?130000:30000);
        return remote;
    }
    const remote=await connect();await wait(local,'[...serialPeers.values()][0]?.direct');
    report.candidate=(await ev(remote,'serialPeer.link.stats()')).candidate;
    if(diagnostics){
        await wait(remote,'(p2pDiagnostic?.localCandidates?.srflx||0)>0');
        await wait(local,'[...connectedRemotes.values()][0]?.p2pDiagnostic?.localCandidates?.srflx>0');
        const details=await ev(remote,'getConnectionDiagnostics()');
        assert(details.diagnostic.stunConfigured);assert(!/stun:|a=fingerprint|candidate:|grantId/.test(JSON.stringify(details)));
        report.stunCandidates={local:details.diagnostic.localCandidates,remote:details.diagnostic.remoteCandidates};
    }
    if(process.argv.includes('--screenshots')){
        const prefix=path.resolve(output).replace(/\.json$/,'');fs.mkdirSync(path.dirname(prefix),{recursive:true});
        for(const [name,session,width,height] of [['local',local,1440,1000],['remote',remote,1440,1000],['remote-narrow',remote,390,844]]){
            await browser.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},session);
            if(name==='remote-narrow')assert(await ev(session,'elements.wsStatus.getBoundingClientRect().right<=innerWidth'),'connection status overflows narrow viewport');
            const screenshot=await browser.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session);
            fs.writeFileSync(prefix+'-'+name+'.png',Buffer.from(screenshot.data,'base64'));
            await browser.command('Emulation.clearDeviceMetricsOverride',{},session);
        }
    }
    const before=wire.length;
    const payload=Array.from({length:16384},(_,i)=>(i*31+(i>>>8))&255);
    const started=performance.now();
    // Exercise the existing Remote send action and Local's physical write FIFO.
    await ev(remote,`elements.hexSend.checked=true;elements.sendCR.checked=false;elements.sendInput.value=${JSON.stringify(payload.map(b=>b.toString(16).padStart(2,'0')).join(' '))};sendData()`);
    await wait(local,'__device.writes.length===1');assert.deepEqual(await ev(local,'__device.writes[0]'),payload);
    report.remoteToLocal={bytes:payload.length,milliseconds:Math.round(performance.now()-started)};
    const rxStart=performance.now();
    for(let i=0;i<8;i++)await ev(local,`__device.inject(${JSON.stringify(payload)})`);
    await wait(remote,'lastRxSeq===8');
    assert.equal(await ev(remote,"records.filter(r=>r.direction==='RX').reduce((n,r)=>n+r.bytes.length,0)"),8*payload.length);
    assert.equal(await ev(remote,"records.filter(r=>r.direction==='RX').every(r=>r.bytes.every((b,i)=>b===((i*31+(i>>>8))&255)))"),true);
    report.localToRemote={bytes:8*payload.length,milliseconds:Math.round(performance.now()-rxStart)};
    report.directPayloadBytesOnWSS=wire.slice(before).filter(x=>typeof x.message.data==='string').reduce((n,x)=>n+Buffer.from(x.message.data,'base64').length,0);
    assert.equal(report.directPayloadBytesOnWSS,0);report.hashPermits=wire.slice(before).filter(x=>x.message.type==='p2p_serial_tx').length;
    const reader=await connect('read');
    await ev(local,'__device.inject([0,255,192,219])');await wait(remote,'lastRxSeq===9');await wait(reader,'lastRxSeq===9');
    assert.equal(await ev(reader,'elements.sendBtn.disabled'),true);
    // A reader can inject native bytes, but cannot obtain a server TX permit.
    await ev(reader,'serialPeer.link.channel.send(SerialP2P.frame(1,1,Uint8Array.of(99)))');await delay(100);
    assert.equal(await ev(local,'__device.writes.length'),1);report.readerInjectionRejected=true;
    const readerID=await ev(reader,'serialPeer.remoteId');await ev(local,`revokeRemote(${JSON.stringify(readerID)})`);await wait(reader,'!isConnected');
    await ev(local,"document.getElementById('takeControlBtn').click()");await wait(remote,'remoteWritesPaused');
    await ev(local,'__device.inject([1,2,3])');await wait(remote,'lastRxSeq===10');
    assert.equal(await ev(remote,'elements.sendBtn.disabled'),true);report.pausePreservesRX=true;
    await ev(local,"document.getElementById('takeControlBtn').click()");await wait(remote,'!remoteWritesPaused');
    const legacy=await connect('read',true);await ev(local,'__device.inject([4,5,6,255])');await wait(remote,'lastRxSeq===11');await wait(legacy,'lastRxSeq===11');report.mixedDirectAndLegacy=true;
    await ev(legacy,'disconnectFromLocal()');await wait(local,'connectedRemotes.size===1');
    // Drop the final direct frame before native send; WSS head must recover it
    // from Local's cache even when no later serial bytes arrive.
    await ev(local,"[...serialPeers.values()][0].link.channel.send=()=>{throw Error('intentional direct loss')};__device.inject([7,8,0,255])");
    await wait(remote,'lastRxSeq===12');await wait(remote,'!serialPeer.direct');
    assert(await ev(remote,"!!p2pDiagnostic?.reason&&elements.wsStatus.title.includes('ICE=')"));report.fallbackReasonVisible=true;
    assert.deepEqual(await ev(remote,"[...records].reverse().find(r=>r.direction==='RX').bytes&&[...[...records].reverse().find(r=>r.direction==='RX').bytes]"),[7,8,0,255]);
    assert.equal(await ev(remote,"records.filter(r=>r.direction==='EVENT'&&r.text.startsWith('弱网缓存缺口')).length"),0);report.missingDirectTailRepaired=true;
    await ev(remote,"elements.sendInput.value='00 FF C0 DB';sendData()");await wait(local,'__device.writes.length===2');
    assert.deepEqual(await ev(local,'__device.writes[1]'),[0,255,192,219]);report.newTXUsesRelayAfterFallback=true;
    const remoteID=await ev(remote,'serialPeer.remoteId');await ev(local,`revokeRemote(${JSON.stringify(remoteID)})`);await wait(remote,'!isConnected');report.revokeClearsPeer=true;
    const fresh=await connect();await ev(local,'ws.close()');await wait(fresh,'!isConnected');report.signalingLossClearsPeer=true;
    report.uncaughtExceptions=browser.errors;assert.equal(browser.errors.length,0);
    fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
