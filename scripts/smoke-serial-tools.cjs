// Native Chromium with simulated serial streams: this does not verify Web Serial permissions or hardware.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12565',output=process.argv[3]||'.local/serial-tools-browser.json';
const mock=`window.__device={writes:[],controller:null,inject(bytes){this.controller.enqueue(Uint8Array.from(bytes))}};
const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.controller=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){this.readable=null;this.writable=null},async setSignals(){}};
Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
let browser,local,remote;
(async()=>{
    browser=await launch();const {page,evaluate:ev,wait,delay,wire}=browser;
    const report={origin,browser:browser.version,realWebRTC:true,simulatedSerial:true,hardwareTested:false};
    async function catchUp(sequence){
        const deadline=performance.now()+90000;let previous=-1,lastProgress=performance.now();
        while(performance.now()<deadline){
            const state=await ev(remote,'({cursor:lastRxSeq,repairing:serialReceiver?.repairing,connected:isConnected})');
            assert(state.connected,'RX backfill ended the approved connection');
            if(state.cursor>previous){previous=state.cursor;lastProgress=performance.now()}
            if(state.cursor===sequence&&!state.repairing)return;
            assert(performance.now()-lastProgress<30000,'RX backfill stopped making progress: '+JSON.stringify(state));
            await delay(100);
        }
        throw Error('RX backfill exceeded the bounded 90-second acceptance window');
    }
    local=await page(origin+'/local',mock);remote=await page(origin+'/remote');
    await ev(local,"elements.refreshBtn.click()");await wait(local,'!!port');
    await ev(local,"elements.openPortBtn.click()");await wait(local,'isOpen');
    await ev(local,"elements.shareBtn.click()");await wait(local,'registered');
    await ev(local,"const nativeLocalMessage=handleServerMessage;handleServerMessage=message=>{if(message.type==='write_state')setTimeout(()=>nativeLocalMessage(message),250);else nativeLocalMessage(message)}");
    const code=await ev(local,'localId');
    async function connect(){
        await ev(remote,`elements.localIdInput.value=${JSON.stringify(code)};elements.accessSelect.value='control';elements.connectBtn.click()`);
        await wait(local,'pendingRequests.size===1');
        await ev(local,"[...document.querySelectorAll('#pendingList button')].find(button=>button.textContent==='允许控制').click()");
        await wait(remote,'isConnected');
    }
    await connect();await wait(remote,'serialPeer?.direct');
    await ev(remote,"const nativePeerHandle=serialPeer.handle.bind(serialPeer);serialPeer.handle=message=>{if(message.type==='p2p_serial_permit')setTimeout(()=>nativePeerHandle(message),150);else nativePeerHandle(message)}");
    await ev(remote,"elements.hexSend.checked=true;elements.sendCR.checked=false;elements.sendInput.value='00 FF';elements.periodicInterval.value='50';elements.periodicSendBtn.click()");
    await wait(local,'__device.writes.length>=3');
    await wait(remote,"periodicSender.busy&&[...serialPeer.pending.values()].some(item=>item.requested)");
    await ev(remote,'elements.periodicSendBtn.click()');await wait(remote,'!periodicSender.busy');await delay(150);
    const submittedBytes=await ev(remote,'txBytes');await wait(local,`__device.writes.length*2===${submittedBytes}`);
    const remoteCycles=await ev(local,'__device.writes.length');
    assert(await ev(local,'__device.writes.every(bytes=>bytes.length===2&&bytes[0]===0&&bytes[1]===255)'));
    assert.equal(await ev(remote,'txBytes'),remoteCycles*2);assert.equal(await ev(local,'txBytes'),remoteCycles*2);
    await delay(150);assert.equal(await ev(local,'__device.writes.length'),remoteCycles);
    const records=await ev(remote,'records.length');
    await ev(remote,'elements.clearCountsBtn.click()');assert.equal(await ev(remote,'rxBytes+txBytes'),0);assert.equal(await ev(remote,'records.length'),records);
    await ev(local,'elements.clearCountsBtn.click()');
    await ev(local,"elements.hexSend.checked=false;elements.sendInput.value='中';elements.lineEnding.value='crlf';elements.periodicInterval.value='50';elements.periodicSendBtn.click()");
    await wait(local,`__device.writes.length>=${remoteCycles+3}`);
    await ev(local,'elements.periodicSendBtn.click()');await wait(local,'!periodicSender.busy');
    const allWrites=await ev(local,'__device.writes'),localCycles=allWrites.length-remoteCycles;
    for(const bytes of allWrites.slice(remoteCycles))assert.deepEqual(bytes,[228,184,173,13,10]);
    assert.equal(await ev(local,'txBytes'),localCycles*5);
    report.periodic={remoteCycles,remoteTXBytes:remoteCycles*2,localCycles,localTXBytes:localCycles*5,stoppedWithoutCatchup:true,inFlightStopCompletedOnce:true,counterClearPreservesHistory:true};
    await ev(remote,"elements.sendInput.value='AA';elements.periodicSendBtn.click()");await wait(local,`__device.writes.length>${allWrites.length}`);
    await ev(local,'elements.takeControlBtn.click()');await wait(remote,'remoteWritesPaused');await wait(remote,'!periodicSender.running&&!periodicSender.busy');
    const pausedWrites=await ev(local,'__device.writes.length');
    await wait(local,'!writeStatePending&&!elements.takeControlBtn.disabled');
    await ev(local,'elements.takeControlBtn.click()');await wait(remote,'!remoteWritesPaused');await delay(10500);
    assert.equal(await ev(local,'__device.writes.length'),pausedWrites);report.pauseStopsPeriodicWithoutResume=true;
    assert(await ev(remote,'serialPeer.direct'),'pausing writes must not leave old permits that time out the receive channel');report.pausePreservesDirectRX=true;
    await ev(local,`window.__holdRepair=true;window.__heldTransfer=null;const nativeReplay=sendRXReplayWindow;sendRXReplayWindow=transfer=>{if(__holdRepair){__heldTransfer=transfer;return}return nativeReplay(transfer)};
        const channel=[...serialPeers.values()][0].link.channel;const nativeSend=channel.send.bind(channel);let drop=true;channel.send=packet=>{if(drop&&SerialP2P.unframe(packet).kind===2){drop=false;return}return nativeSend(packet)};__device.inject([128]);`);
    await wait(local,'!!__heldTransfer');await wait(remote,'serialReceiver.repairing');
    const wireStart=wire.length;
    for(let sequence=2;sequence<=25;sequence++)await ev(local,`__device.inject([${sequence}])`);
    await wait(remote,'serialReceiver.frames.size===24');assert.equal(await ev(remote,'lastRxSeq'),0);
    assert(await ev(remote,'isConnected&&serialPeer.direct'));
    await ev(local,'__holdRepair=false;sendRXReplayWindow(__heldTransfer)');await wait(remote,'lastRxSeq===25&&!serialReceiver.repairing');
    assert.equal(wire.slice(wireStart).filter(item=>item.message.type==='replay_data').length,1,'live direct tail must merge without being resent through relay');
    assert.deepEqual(await ev(remote,"records.filter(row=>row.direction==='RX').flatMap(row=>[...row.bytes])"),[128,...Array.from({length:24},(_,i)=>i+2)]);
    report.hybridTail={frames:25,relayBackfillFrames:1,directTailFrames:24,orderedExactBytes:true};
    await ev(remote,'disconnectFromLocal()');await wait(local,'connectedRemotes.size===0');
    await ev(remote,`lastRxSeq=0;clearRx();clearCounts();const PendingNativeRTC=window.RTCPeerConnection;window.RTCPeerConnection=class extends PendingNativeRTC{async setRemoteDescription(...args){await new Promise(resolve=>setTimeout(resolve,10000));return super.setRemoteDescription(...args)}};`);
    await ev(local,'__holdRepair=true;__heldTransfer=null');await connect();await wait(local,'!!__heldTransfer');
    for(let sequence=26;sequence<=325;sequence++)await ev(local,`__device.inject([${sequence&255}])`);
    await wait(remote,'serialReceiver.head===325');
    assert(await ev(remote,'isConnected'));assert.equal(await ev(remote,'lastRxSeq'),0);
    await ev(local,'__holdRepair=false;sendRXReplayWindow(__heldTransfer)');await catchUp(325);
    assert(await ev(remote,'isConnected'));assert.equal(await ev(remote,'rxBytes'),325);
    assert(await ev(remote,"elements.errorMessage.classList.contains('hidden')||!elements.errorMessage.textContent.startsWith('接收补传')"),'completed slow backfill must not retain a timeout notice');
    assert.equal(await ev(local,'__device.writes.length'),pausedWrites,'RX repair must not submit a serial command');
    report.negotiatingBackfill={liveFramesDuringHeldReplay:300,connectionPreserved:true,finalRXSequence:325,noTXReplay:true};
    assert(await ev(local,"elements.errorMessage.classList.contains('hidden')||!elements.errorMessage.textContent"),'a retired peer must not leave an authorization error on Local');
    if(process.argv.includes('--screenshots')){
        const prefix=path.resolve(output).replace(/\.json$/,'');fs.mkdirSync(path.dirname(prefix),{recursive:true});
        for(const [name,session,width,height] of [['local',local,1440,1000],['remote',remote,1440,1000],['remote-narrow',remote,390,844]]){
            await browser.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},session);
            const screenshot=await browser.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session);
            fs.writeFileSync(prefix+'-'+name+'.png',Buffer.from(screenshot.data,'base64'));
            await browser.command('Emulation.clearDeviceMetricsOverride',{},session);
        }
    }
    const beforeStandalone=await ev(local,'__device.writes.length');
    await ev(local,'elements.periodicSendBtn.click()');await ev(local,'stopSharing()');
    await wait(local,`__device.writes.length>=${beforeStandalone+2}`);assert(await ev(local,'periodicSender.running&&isOpen&&!shareEnabled'));
    await ev(local,'elements.periodicSendBtn.click()');await wait(local,'!periodicSender.busy');
    report.localPeriodicWorksWithoutSharing=true;report.uncaughtExceptions=browser.errors;assert.deepEqual(browser.errors,[]);
    fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(async error=>{
    console.error(error);
    if(browser&&remote){
        try{console.error('Remote state:',await browser.evaluate(remote,"({running:periodicSender.running,busy:periodicSender.busy,buttonDisabled:elements.periodicSendBtn.disabled,allowed:canRemoteSend(),connected:isConnected,access,paused:remoteWritesPaused,cursor:lastRxSeq,head:serialReceiver?.head,repairing:serialReceiver?.repairing,replayStarted:serialReceiver?.replayStarted,through:serialReceiver?.replayThrough,error:elements.errorMessage.textContent})"))}catch{}
    }
    if(browser&&local){try{console.error('Local replay state:',await browser.evaluate(local,"[...rxReplayTransfers.values()].map(t=>({through:t.throughSeq,next:t.nextIndex,frames:t.frames.length,inFlight:[...t.inFlight],complete:t.completeSent}))"))}catch{}}
    process.exitCode=1;
}).finally(async()=>{if(browser)await browser.close()});
