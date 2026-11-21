// Native WebRTC regression: direct TX backlog must route only TX through WSS.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./browser-test-client.cjs');
const origin=process.argv[2]||'https://127.0.0.1:12567',output=process.argv[3]||'.local/p2p-tx-relay-native.json';let browser;
const mock=`window.__device={writes:[]};const device={getInfo(){return {usbVendorId:1234,usbProductId:5678}},async open(){this.readable=new ReadableStream({start(c){__device.reader=c}});this.writable=new WritableStream({write(bytes){__device.writes.push([...bytes])}})},async close(){},async setSignals(){}};Object.defineProperty(navigator,'serial',{value:{async requestPort(){return device}}});`;
(async()=>{
 browser=await launch();const {page,evaluate:ev,wait,wire,delay}=browser;
 const report={origin,browser:browser.version,realWebRTC:true,simulatedSerial:true,hardwareTested:false};
 const local=await page(origin+'/local',mock);
 await ev(local,'elements.refreshBtn.click()');await wait(local,'!!port');
 await ev(local,'elements.openPortBtn.click()');await wait(local,'isOpen');await ev(local,'elements.shareBtn.click()');await wait(local,'registered');
 const code=await ev(local,'localId'),remote=await page(origin+'/remote');
 await ev(remote,`elements.localIdInput.value=${JSON.stringify(code)};elements.accessSelect.value='control';elements.connectBtn.click()`);
 try{await wait(local,'pendingRequests.size===1')}catch(error){
  throw Error(JSON.stringify({wait:error.message,
   remote:await ev(remote,'({isConnected,isPending,access,error:elements.errorMessage.textContent,status:elements.wsStatus.textContent})'),
   local:await ev(local,'({registered,shareEnabled,connected:connectedRemotes.size,pending:pendingRequests.size,error:elements.errorMessage.textContent})'),
   ws:wire.slice(-12).map(item=>({sent:item.sent,type:item.message.type,code:item.message.code,error:item.message.error,probeKind:item.message.probeKind}))}));
 }
 await ev(local,"[...document.querySelectorAll('#pendingList button')].find(button=>button.textContent==='允许控制').click()");
 await wait(remote,'isConnected');await wait(remote,'serialPeer?.direct');await wait(local,'[...serialPeers.values()][0]?.direct');
 assert.equal(await ev(local,'[...serialPeers.values()][0]?.txRelayProtocol'),1,'Local/Remote both negotiated TX-only fallback');
 const remoteCaps=await ev(remote,'({txRelay:serialPeer.txRelayProtocol,module:!!globalThis.P2PNetwork})');
 assert.equal(remoteCaps.txRelay,1,JSON.stringify({remoteCaps,received:wire.filter(item=>!item.sent&&item.message.type==='connect').map(item=>item.message.serialP2PTXRelayProtocol)}));
 const remoteID=await ev(remote,'serialPeer.remoteId');
 await ev(local,`(()=>{const peer=serialPeers.get(${JSON.stringify(remoteID)}),original=peer.receive.bind(peer);window.__droppedTXFrames=0;peer.receive=raw=>{const packet=SerialP2P.unframe(raw);if(packet.kind===1){window.__droppedTXFrames++;return}return original(raw)}})()`);
  let submittedBeforeRelay=0,unknownBeforeRelay=0,attemptedBeforeRelay=0;
  for(let i=0;i<17;i++){
   const sent=await ev(remote,`(async()=>{if(serialPeer?.txViaRelay)return null;return await submitRemoteBytes(Uint8Array.of(${i+1}))})()`);
   if(sent===null)break;
   attemptedBeforeRelay++;
   if(sent)submittedBeforeRelay++;
   else{
    unknownBeforeRelay++;
    try{await wait(remote,'serialPeer?.txViaRelay',10000)}catch(error){throw Error(JSON.stringify({wait:error.message,remote:await ev(remote,'({direct:serialPeer?.direct,txViaRelay:serialPeer?.txViaRelay,error:elements.errorMessage.textContent,diag:p2pDiagnostic,events:records.filter(r=>r.direction==="EVENT").slice(-8).map(r=>r.text)})')}))}
    break;
   }
  }
  assert(unknownBeforeRelay<=1,'sequential stress may have at most one in-flight TX with an unknown result');
 try{await wait(local,"serialPeers.get("+JSON.stringify(remoteID)+").txViaRelay",10000)}catch(error){
  throw Error(JSON.stringify({wait:error.message,local:await ev(local,'(()=>{const p=serialPeers.values().next().value;return {direct:p?.direct,txViaRelay:p?.txViaRelay,txRelayProtocol:p?.txRelayProtocol,incoming:p?.incoming.size,permits:p?.permits.length,dropped:__droppedTXFrames,writes:__device.writes.length,mode:p?.link.mode,diag:connectedRemotes.values().next().value?.p2pDiagnostic,events:eventRecords.slice(-12).map(e=>e.text)}})()'),
   remote:await ev(remote,'({direct:serialPeer?.direct,txViaRelay:serialPeer?.txViaRelay,txRelayProtocol:serialPeer?.txRelayProtocol,pending:serialPeer?.pending.size,mode:serialPeer?.link.mode,diag:p2pDiagnostic,txBytes,events:records.filter(r=>r.direction==="EVENT").slice(-8).map(r=>r.text)})'),
   intents:wire.filter(item=>item.sent&&item.message.type==='p2p_serial_tx').length,
   signals:wire.filter(item=>item.sent&&item.message.type==='p2p_serial_signal').map(item=>({probeKind:item.message.probeKind,reason:item.message.p2pReason}))}));
 }
 await wait(remote,'serialPeer.txViaRelay');await delay(1300);
 const localState=await ev(local,`({direct:serialPeers.get(${JSON.stringify(remoteID)}).direct,txViaRelay:serialPeers.get(${JSON.stringify(remoteID)}).txViaRelay,link:serialPeers.get(${JSON.stringify(remoteID)}).link.mode,dropped:__droppedTXFrames,writes:__device.writes.length})`);
 const remoteState=await ev(remote,'({direct:serialPeer.direct,txViaRelay:serialPeer.txViaRelay,link:serialPeer.link.mode,txBytes})');
 assert.equal(localState.direct,true);assert.equal(remoteState.direct,true);assert.equal(localState.txViaRelay,true);assert.equal(remoteState.txViaRelay,true);
 assert.equal(localState.link,'p2p');assert.equal(remoteState.link,'p2p');assert.equal(localState.writes,0);assert(localState.dropped>=16);
  report.queueStress={attempted:attemptedBeforeRelay,submittedBeforeRelay,unknownBeforeRelay};
  report.afterQueueRelay={local:localState,remote:remoteState,noOldDirectTXReplay:true};
 await ev(remote,"elements.sendInput.value='00 FF';elements.hexSend.checked=true;elements.sendCR.checked=false;sendData()");
 await wait(local,'__device.writes.length===1');assert.deepEqual(await ev(local,'__device.writes[0]'),[0,255]);
 await ev(local,'__device.reader.enqueue(Uint8Array.of(7,8,0,255))');await wait(remote,'lastRxSeq===1');
 assert.deepEqual(await ev(remote,"[...records.find(record=>record.direction==='RX').bytes]"),[7,8,0,255]);
 assert.equal(await ev(local,'__device.writes.length'),1);
 const wssWrites=wire.filter(item=>item.sent&&item.message.type==='send');
 assert.equal(wssWrites.length,1,'new Remote TX uses the existing authorized WSS write queue');
 report.relayTXBytes=wssWrites.length;report.directRXStillWorks=true;report.existingGrantAndFifoUsed=true;
 report.uncaughtExceptions=browser.errors;assert.deepEqual(browser.errors,[]);
 fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
