// Native browser check for persistent Local preferences and Remote monitor recovery.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12567',output=process.argv[3]||'.local/monitor-reconnect-native.json';let browser;
const fakeSerial=`window.__device={writes:[]};const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.reader=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){},async setSignals(){}};Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
(async()=>{
 browser=await launch();const {page,evaluate:ev,wait,command,wire,delay}=browser;
 const local=await page(origin+'/local',fakeSerial);
 await ev(local,'elements.refreshBtn.click()');await wait(local,'!!port');
 const selectedPortLabel=await ev(local,'elements.portSelect.options[0].textContent');
 assert.match(selectedPortLabel,/串口设备 \(4D2:162E\)/);
 await ev(local,'elements.openPortBtn.click()');await wait(local,'isOpen');await ev(local,'elements.shareBtn.click()');await wait(local,'registered');
 if(!await ev(local,'elements.autoAccept.checked'))await ev(local,'elements.autoAccept.click()');
 await wait(local,'autoAccept&&localStorage.getItem("shareserial.local.autoAccept.v1")==="true"');
 const localId=await ev(local,'localId');
 const remote=await page(origin+'/remote');
 await ev(remote,`elements.localIdInput.value=${JSON.stringify(localId)};elements.accessSelect.value='read';elements.connectBtn.click()`);
 await wait(remote,'isConnected');
 const navigationGrant=await ev(remote,'grantId');
 const connectRequestsBeforeNavigation=wire.filter(x=>x.sent&&x.message.type==='connect').length;
 await ev(remote,'window.__toolNavigationMarker={};window.__toolNavigationSocket=ws;elements.remoteFlashTab.click()');
 await wait(remote,"location.pathname==='/remote/esp32'&&!elements.esp32Panel.classList.contains('hidden')");
 assert.equal(await ev(remote,'grantId'),navigationGrant);
 assert.equal(await ev(remote,'ws===window.__toolNavigationSocket'),true);
 assert.equal(await ev(remote,'!!window.__toolNavigationMarker'),true);
 await ev(remote,'elements.remoteSerialTab.click()');
 await wait(remote,"location.pathname==='/remote'&&!elements.remoteSerialPanel.classList.contains('hidden')");
 assert.equal(await ev(remote,'grantId'),navigationGrant);
 assert.equal(await ev(remote,'ws===window.__toolNavigationSocket'),true);
 assert.equal(wire.filter(x=>x.sent&&x.message.type==='connect').length,connectRequestsBeforeNavigation,'switching tools does not request another Remote grant');
 const firstGrant=await ev(remote,'grantId');
 await ev(remote,'window.__grantBeforeDrop=grantId;ws.close()');
 await wait(remote,"elements.wsStatus.textContent.includes('3 秒后自动重连')");
 await wait(remote,'isConnected&&grantId&&grantId!==window.__grantBeforeDrop',30000);
 const secondGrant=await ev(remote,'grantId');
 await ev(remote,'window.__grantBeforeReload=grantId');
 await command('Page.navigate',{url:origin+'/remote'},remote);
 await wait(remote,"document.readyState==='complete'");
 await wait(remote,'isConnected&&grantId&&grantId!==window.__grantBeforeReload',30000);
 const thirdGrant=await ev(remote,'grantId');
 const stored=JSON.parse(await ev(remote,'localStorage.getItem("shareserial.remote.connection.v1")'));
 assert.equal(stored.localId,localId);assert.equal(stored.access,'read');assert.equal(stored.autoReconnect,true);
 assert.notEqual(firstGrant,secondGrant);assert.notEqual(secondGrant,thirdGrant);
 const cursor=await ev(remote,'lastRxSeq');
 await ev(local,'__device.reader.enqueue(Uint8Array.of(65,0,255))');await wait(remote,'lastRxSeq>'+cursor);
 const rx=await ev(remote,"Array.from(records.filter(r=>r.direction==='RX').at(-1).bytes)");
 assert.deepEqual(rx,[65,0,255]);
 const report={origin,browser:browser.version,remoteAutoReconnect:true,freshGrantAfterDrop:firstGrant!==secondGrant,
  savedTargetRestoredAfterReload:stored.localId===localId,reconnectedAfterReload:secondGrant!==thirdGrant,
  localAutoAcceptActive:await ev(local,'autoAccept')===true,
  toolNavigationPreservedConnection:true,
  localPortLabelRestored:true,
  rxContinued:true,websocketConnectRequests:wire.filter(x=>x.sent&&x.message.type==='connect').length,
  simulatedSerial:true,hardwareTested:false,uncaughtExceptions:browser.errors};
 assert.deepEqual(report.uncaughtExceptions,[]);
 fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 await ev(remote,'disconnectFromLocal()');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
