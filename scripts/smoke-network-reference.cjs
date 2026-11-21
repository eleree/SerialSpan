// Current-route network assessment, native WebRTC and simulated serial only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12567',output=process.argv[3]||'.local/network-reference-browser.json';
const fetchCount=`window.__samples=0;const actualFetch=window.fetch.bind(window);window.fetch=(url,...args)=>{if(String(url).startsWith('/api/network-sample'))__samples++;return actualFetch(url,...args)};`;
const mock=`window.__device={writes:[]};const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.reader=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){this.readable=null;this.writable=null},async setSignals(){}};Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
let browser;
(async()=>{
    browser=await launch();const {page,evaluate:ev,wait,wire,delay}=browser;
    const report={origin,browser:browser.version,realWebRTC:true,simulatedSerial:true,hardwareTested:false};
    const click="document.getElementById('networkEvaluateBtn').click()";
    const finished="document.getElementById('networkEvaluateBtn').textContent==='评估网络'";
    async function share(){const local=await page(origin+'/local',fetchCount+mock,60000);await ev(local,'elements.refreshBtn.click()');await wait(local,'!!port');await ev(local,'elements.openPortBtn.click()');await wait(local,'isOpen');await ev(local,'elements.shareBtn.click()');await wait(local,'registered');return local}
    async function connect(local,access='read',legacy=false){
        const code=await ev(local,'localId'),remote=await page(origin+'/remote',fetchCount+(legacy?"Object.defineProperty(window,'RTCPeerConnection',{value:undefined});":''),60000);
        await ev(remote,`elements.localIdInput.value=${JSON.stringify(code)};elements.accessSelect.value=${JSON.stringify(access)};elements.connectBtn.click()`);
        await wait(local,'pendingRequests.size===1');await ev(local,`[...document.querySelectorAll('#pendingList button')].find(button=>button.textContent===${JSON.stringify(access==='control'?'允许控制':'允许只读')}).click()`);
        await wait(remote,'isConnected');if(!legacy)await wait(remote,'serialPeer.direct');return remote;
    }
    const localA=await share();assert.equal(await ev(localA,'__samples'),0);
    await ev(localA,click);await wait(localA,finished,60000);
    assert((await ev(localA,"document.getElementById('networkSummary').textContent")).includes('服务器'));
    assert.equal(await ev(localA,'__samples'),8);report.serverBeforePeer=true;
    const remoteA=await connect(localA,'control'),legacy=await connect(localA,'read',true);
    await wait(localA,"document.getElementById('networkTarget').options.length===2");
    const remoteID=await ev(remoteA,'serialPeer.remoteId');
    await ev(localA,`document.getElementById('networkTarget').value=[...connectedRemotes.keys()].find(id=>id!==${JSON.stringify(remoteID)});document.getElementById('networkTarget').dispatchEvent(new Event('change'));${click}`);
    await wait(localA,finished,60000);assert((await ev(localA,"document.getElementById('networkSummary').textContent")).includes('服务器'));
    assert.equal(await ev(localA,'__samples'),16);report.mixedRelayTargetUsesServer=true;
    await ev(localA,`document.getElementById('networkTarget').value=${JSON.stringify(remoteID)};document.getElementById('networkTarget').dispatchEvent(new Event('change'));${click}`);
    await wait(localA,finished);
    assert((await ev(localA,"document.getElementById('networkSummary').textContent")).includes('P2P 直连'));
    const localMetrics=await ev(localA,"document.getElementById('networkMetrics').textContent");assert(/有效接收/.test(localMetrics)&&/有效发送/.test(localMetrics));
    assert.equal(await ev(localA,'__samples'),16,'direct evaluation must not call the HTTP sample API');
    assert.equal(await ev(localA,'rxBytes+txBytes+__device.writes.length'),0);
    assert.equal(await ev(remoteA,'rxBytes+txBytes'),0);assert(await ev(remoteA,'serialPeer.direct'));
    report.localP2P={targetCount:2,metrics:localMetrics,serialCountersUnchanged:true,httpSamplesUnchanged:true};
    const localB=await share();
    await ev(localB,"(()=>{const actual=handleServerMessage,held=[];window.__releaseReady=()=>{for(const message of held.splice(0))actual(message)};handleServerMessage=message=>{if(message.type==='p2p_serial_state'&&message.direct===true)held.push(message);else actual(message)}})()");
    const remoteB=await connect(localB,'read');
    assert.equal(await ev(localB,'[...serialPeers.values()][0].direct'),false);
    await ev(remoteB,click);await wait(remoteB,finished);
    const readonlySummary=await ev(remoteB,"document.getElementById('networkSummary').textContent");
    assert(readonlySummary.includes('P2P 直连'),JSON.stringify({summary:readonlySummary,
        remote:await ev(remoteB,'({direct:serialPeer.direct,diagnosticLoaded:!!globalThis.P2PNetwork})'),
        local:await ev(localB,'({direct:[...serialPeers.values()][0]?.direct,diagnosticLoaded:!!globalThis.P2PNetwork})')}));
    assert.equal(await ev(remoteB,'__samples'),0);assert.equal(await ev(remoteB,'rxBytes+txBytes'),0);
    assert.equal(await ev(localB,'rxBytes+txBytes+__device.writes.length'),0);
    assert.equal(await ev(remoteB,'access'),'read');assert(await ev(remoteB,'serialPeer.direct'));
    assert.equal(wire.filter(item=>['send','data','replay_data','p2p_serial_tx'].includes(item.message.type)).length,0);
    report.readonlyRemoteP2P={metrics:await ev(remoteB,"document.getElementById('networkMetrics').textContent"),noSerialCommands:true};
    assert.equal(await ev(localB,'[...serialPeers.values()][0].direct'),false);
    await ev(localB,'__releaseReady()');await wait(localB,'[...serialPeers.values()][0].direct');report.delayedReceiverReadyAccepted=true;
    await ev(remoteA,"elements.sendInput.value='00 FF';elements.hexSend.checked=true;elements.sendCR.checked=false;sendData()");
    await wait(localA,'__device.writes.length===1');assert.deepEqual(await ev(localA,'__device.writes[0]'),[0,255]);
    await ev(localA,'__device.reader.enqueue(Uint8Array.of(0,255))');await wait(remoteA,'lastRxSeq===1');
    assert.equal(await ev(remoteA,'rxBytes'),2);assert(await ev(remoteA,'serialPeer.direct'));report.serialStillWorksAfterAssessment=true;
    await ev(remoteB,"serialPeer.fallback('application')");await wait(remoteB,"document.getElementById('networkSummary').textContent.includes('重新评估')");
    await ev(remoteB,click);await wait(remoteB,finished,60000);
    assert((await ev(remoteB,"document.getElementById('networkSummary').textContent")).includes('服务器'));
    assert.equal(await ev(remoteB,'__samples'),8);report.serverAfterFallback=true;
    await ev(remoteB,click+';'+click);await wait(remoteB,finished);await delay(100);
    assert((await ev(remoteB,"document.getElementById('networkSummary').textContent")).includes('取消'));
    assert.equal(await ev(remoteB,'__samples'),9);report.cancelStopsMoreRequests=true;
    for(const session of [localA,remoteA,localB,remoteB])assert.equal(await ev(session,"elements.baudRate.value"),'115200');
    report.baudUnchanged=true;
    if(process.argv.includes('--screenshots')){
        const prefix=path.resolve(output).replace(/\.json$/,'');fs.mkdirSync(path.dirname(prefix),{recursive:true});
        for(const [name,session] of [['local',localA],['remote',remoteA]]){
            await browser.command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},session);
            const shot=await browser.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session);fs.writeFileSync(prefix+'-'+name+'.png',Buffer.from(shot.data,'base64'));
        }
    }
    await ev(localA,`document.getElementById('networkTarget').value=[...connectedRemotes.keys()].find(id=>id!==${JSON.stringify(remoteID)});document.getElementById('networkTarget').dispatchEvent(new Event('change'))`);
    assert((await ev(localA,"document.getElementById('networkSummary').textContent")).includes('重新评估'));
    assert.equal(await ev(localA,"document.getElementById('networkMetrics').textContent"),'');
    assert.equal(await ev(localA,'__samples'),16);report.peerSelectionClearsOldResult=true;
    report.uncaughtExceptions=browser.errors;assert.deepEqual(browser.errors,[]);
    fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
