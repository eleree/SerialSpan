// Native failure-diagnostic acceptance. UART and the failed send are simulated.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12567',output=process.argv[3]||'.local/p2p-failure-browser.json';let browser;
const mock=`window.__device={writes:[]};const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.reader=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){},async setSignals(){}};Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
(async()=>{
 browser=await launch();const {page,evaluate:ev,wait,wire,delay}=browser;
 const report={origin,browser:browser.version,realWebRTC:true,simulatedSerial:true,simulatedSendFailure:true,hardwareTested:false};
 const local=await page(origin+'/local',mock,60000);await ev(local,'elements.refreshBtn.click()');await wait(local,'!!port');await ev(local,'elements.openPortBtn.click()');await wait(local,'isOpen');await ev(local,'elements.shareBtn.click()');await wait(local,'registered');
 const code=await ev(local,'localId'),remote=await page(origin+'/remote','',60000);
 await ev(remote,`elements.localIdInput.value=${JSON.stringify(code)};elements.connectBtn.click()`);await wait(local,'pendingRequests.size===1');await ev(local,"[...document.querySelectorAll('#pendingList button')].find(b=>b.textContent==='允许只读').click()");
 await wait(remote,'isConnected');await wait(remote,'serialPeer?.direct');await wait(local,'[...serialPeers.values()][0]?.direct');assert.equal(await ev(remote,'access'),'read');
 report.localId=code;report.remoteId=await ev(remote,'serialPeer.remoteId');
 await ev(local,`(()=>{const peer=[...serialPeers.values()][0],receive=peer.link.pc.ondatachannel;peer.link.pc.ondatachannel=event=>{receive(event);if(event.channel.label!==P2PNetwork.LABEL)return;const message=event.channel.onmessage;event.channel.onmessage=value=>{message(value);if(typeof value.data==='string'&&JSON.parse(value.data).t==='ping'&&!window.__injected){window.__injected=true;peer.link.channel.send=()=>{throw Error('private diagnostic injection')};__device.reader.enqueue(Uint8Array.of(7,8,0,255))}}}})()`);
 await ev(remote,"document.getElementById('networkEvaluateBtn').click()");await wait(local,'!!window.__injected');await wait(remote,'!serialPeer.direct');await wait(remote,'lastRxSeq===1');
 await wait(remote,"document.getElementById('networkEvaluateBtn').textContent==='评估网络'");await delay(500);
 const snapshots=wire.filter(item=>item.sent&&item.message.type==='p2p_serial_signal'&&item.message.probeKind==='fallback');
 const own=snapshots.find(item=>item.session===local),peer=snapshots.find(item=>item.session===remote);assert(own&&peer,'both real endpoints reported a failure snapshot');
 assert.equal(snapshots.filter(item=>item.session===local).length,1);assert.equal(snapshots.filter(item=>item.session===remote).length,1);
 assert.equal(own.message.p2pDetails.applicationCause,'rx_send');assert.equal(own.message.p2pDetails.assessmentActive,true);assert.equal(own.message.p2pDetails.channelState,'open');
 assert(!JSON.stringify(snapshots.map(item=>item.message.p2pDetails)).includes('private diagnostic injection'));
 assert.equal(await ev(local,'__device.writes.length'),0);assert.equal(await ev(remote,'txBytes'),0);assert.equal(await ev(remote,'rxBytes'),4);
 assert.deepEqual(await ev(remote,"records.filter(record=>record.direction==='RX').flatMap(record=>[...record.bytes])"),[7,8,0,255]);
 report.bothSnapshotsOnce=true;report.assessmentCapturedBeforeClose=true;report.applicationCause='rx_send';report.rxRecoveredThroughRelay=true;report.noUARTWrites=true;
 report.localSnapshot=own.message.p2pDetails;report.remoteSnapshot=peer.message.p2pDetails;report.uncaughtExceptions=browser.errors;assert.deepEqual(browser.errors,[]);
 fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
