const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Peer,Receiver,frame,unframe,digest,configuration,describe}=require('../static/js/serial-p2p.js');
const SerialData=require('../static/js/serial-data.js');
const {setImmediate:turn,setTimeout:delay}=require('node:timers/promises');
class Channel {
    label='shareserial-serial-v1';ordered=true;maxRetransmits=null;maxPacketLifeTime=null;
    readyState='open';bufferedAmount=0;sent=[];
    send(bytes){this.sent.push(Uint8Array.from(bytes))}
    close(){this.readyState='closed';this.onclose?.()}
}
class RTC {
    connectionState='new';
    createDataChannel(){return this.channel=new Channel()}
    async createOffer(){return {type:'offer',sdp:'offer'}}
    async createAnswer(){return {type:'answer',sdp:'answer'}}
    async setLocalDescription(){}
    async setRemoteDescription(){}
    async addIceCandidate(){}
    close(){this.connectionState='closed';this.onconnectionstatechange?.()}
}
function setup(role='local',options={}){
    let valid=true,writable=true;const sent=[],writes=[],received=[],errors=[],states=[];
    const peer=new Peer({role,localId:'ABC23',remoteId:'DEF45',portId:'usb',grantId:'grant',RTC,
        sendWS:value=>sent.push(value),valid:()=>valid,canTX:epoch=>writable&&epoch===2,
        deliverTX:value=>writes.push(value),deliverRX:(seq,bytes)=>received.push({seq,bytes:[...bytes]}),
        onError:value=>errors.push(value),onState:value=>states.push(value),txRelayProtocol:1,...options});
    if(role==='local')peer.link.attach(new Channel());
    if(options.autoOpen!==false){
        peer.link.channel.onopen();
        peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true});
    }
    return {peer,sent,writes,received,errors,states,revoke(){valid=false},pause(){writable=false}};
}
const permit=async bytes=>({type:'p2p_serial_permit',portId:'usb',grantId:'grant',writeEpoch:2,txSeq:1,byteLength:bytes.length,sha256:await digest(bytes)});
async function waitForIntent(endpoint,count=1){
    for(let i=0;i<50&&endpoint.sent.filter(m=>m.type==='p2p_serial_tx').length<count;i++)await delay(1);
    assert(endpoint.sent.filter(m=>m.type==='p2p_serial_tx').length>=count,'Web Crypto completed and a server permit was requested');
}

const retryState=attempt=>({type:'p2p_serial_state',portId:'usb',grantId:'grant',probeKind:'retry',p2pAttempt:attempt,serialP2PRetryProtocol:1,direct:false});
const failedState=(attempt=0,reason='connection_failed',details)=>({type:'p2p_serial_state',portId:'usb',grantId:'grant',probeKind:'fallback',p2pAttempt:attempt,direct:false,p2pReason:reason,p2pDetails:details});

test('Serial retries can connect after a minute, preserve relay operation and ignore old-round signals',async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    const endpoint=setup('remote',{autoOpen:false,retryProtocol:1});
    try{
        await endpoint.peer.link.chain;
        const first=endpoint.peer.link;
        t.mock.timers.tick(45000);endpoint.peer.handle(failedState(0,'negotiation_timeout'));
        assert.equal(endpoint.peer.direct,false);assert.equal(endpoint.peer.pending.size,0);
        t.mock.timers.tick(4999);assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,0);
        t.mock.timers.tick(1);assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,1);
        endpoint.peer.handle(retryState(1));await endpoint.peer.link.chain;
        assert.notEqual(endpoint.peer.link,first);assert.equal(first.closed,true);
        const second=endpoint.peer.link;
        for(const message of [failedState(),{...retryState(1),p2pAttempt:3},{...retryState(1),grantId:'old'},
            {type:'p2p_serial_signal',portId:'usb',grantId:'grant',probeKind:'answer',probePayload:'old'},
            {type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true}]) endpoint.peer.handle(message);
        assert.equal(endpoint.peer.link,second);assert.equal(second.mode,'connecting');assert.equal(endpoint.peer.direct,false);
        t.mock.timers.tick(15000);
        second.pc.connectionState='failed';second.pc.onconnectionstatechange();endpoint.peer.handle(failedState(1));
        t.mock.timers.tick(10000);assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,2);
        endpoint.peer.handle(retryState(2));await endpoint.peer.link.chain;
        endpoint.peer.link.channel.onopen();
        endpoint.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',p2pAttempt:2,direct:true});
        assert.equal(endpoint.peer.direct,true,'a fresh native negotiation can succeed after the first minute');
        assert.equal(endpoint.sent.filter(m=>m.type==='send'||m.type==='p2p_serial_tx').length,0,'connection retries never submit serial commands');
        first.pc.onicecandidate?.({candidate:{candidate:'candidate:old typ host'}});
        assert.equal(endpoint.sent.filter(m=>m.probeKind==='candidate').length,0);
        t.mock.timers.tick(180000);assert.equal(endpoint.peer.direct,true,'the retry budget must not close a healthy direct link');
        assert.match(describe(endpoint.peer.diagnostic),/直连尝试 3\/4/);
    }finally{endpoint.peer.close()}
});

test('Serial retry attempts and total elapsed time remain bounded',async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    const endpoint=setup('remote',{autoOpen:false,retryProtocol:1});
    try{
        for(let attempt=0;attempt<4;attempt++){
            await endpoint.peer.link.chain;
            t.mock.timers.tick(attempt===3?9999:45000);
            if(attempt===3){
                assert.equal(endpoint.peer.link.mode,'connecting');t.mock.timers.tick(1);
                assert.equal(endpoint.peer.link.mode,'websocket','the last round is truncated at the three-minute total deadline');
            }
            endpoint.peer.handle(failedState(attempt,'negotiation_timeout'));
            t.mock.timers.tick(5000*2**attempt);
            if(attempt<3)endpoint.peer.handle(retryState(attempt+1));
        }
        assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,3);
        assert.equal(endpoint.peer.attempt,3);
        endpoint.peer.handle(retryState(4));assert.equal(endpoint.peer.attempt,3);
        t.mock.timers.tick(1000000);assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,3);
    }finally{endpoint.peer.close()}
});

test('Serial retry cancellation, old peers and non-network failures never cause a new attempt',async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    for(const options of [{role:'local'},{retryProtocol:0},{reason:'application'},{reason:'candidate_error'},
        {details:{dtls:'failed'}},{revoke:true},{close:true},{expire:true}]){
        const endpoint=setup(options.role||'remote',{autoOpen:false,retryProtocol:options.retryProtocol??1});
        try{
            await endpoint.peer.link.chain;
            if(options.expire)t.mock.timers.tick(180000);
            endpoint.peer.handle(failedState(0,options.reason||'connection_failed',options.details));
            if(options.revoke)endpoint.revoke();if(options.close)endpoint.peer.close();
            t.mock.timers.tick(20000);
            assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,0,JSON.stringify(options));
        }finally{endpoint.peer.close()}
    }
});

test('An old direct write or RX failure cannot cancel a new negotiation or replay a command',async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    const remote=setup('remote',{retryProtocol:1}),local=setup('local',{retryProtocol:1});
    try{
        let rejectTX,rejectRX;
        remote.peer.link.send=()=>new Promise((resolve,reject)=>{rejectTX=reject});
        const bytes=Uint8Array.of(1),pending=remote.peer.sendTX(bytes,2);const rejected=assert.rejects(pending,/中断|协商/);
        await waitForIntent(remote);remote.peer.handle(await permit(bytes));await turn();assert(rejectTX);
        local.peer.link.send=()=>new Promise((resolve,reject)=>{rejectRX=reject});
        local.peer.sendRX(1,bytes);await turn();assert(rejectRX);
        remote.peer.handle(failedState());local.peer.handle(failedState());
        await rejected;t.mock.timers.tick(5000);
        remote.peer.handle(retryState(1));local.peer.handle(retryState(1));
        const currentRemote=remote.peer.link,currentLocal=local.peer.link;
        rejectTX(Error('old TX'));rejectRX(Error('old RX'));await turn();
        assert.equal(currentRemote.mode,'connecting');assert.equal(currentLocal.mode,'connecting');
        remote.peer.handle(await permit(bytes));assert.equal(remote.peer.pending.size,0);
        assert.equal(remote.sent.filter(m=>m.type==='p2p_serial_tx').length,1);
        assert.equal(remote.sent.filter(m=>m.type==='send').length,0);
    }finally{remote.peer.close();local.peer.close()}
});

test('Four early native failures cannot request a fifth attempt within the time budget',async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    const endpoint=setup('remote',{autoOpen:false,retryProtocol:1});
    try{
        for(let attempt=0;attempt<4;attempt++){
            await endpoint.peer.link.chain;endpoint.peer.handle(failedState(attempt));
            t.mock.timers.tick(5000*2**attempt);
            if(attempt<3)endpoint.peer.handle(retryState(attempt+1));
        }
        assert.equal(endpoint.sent.filter(m=>m.probeKind==='retry').length,3);
    }finally{endpoint.peer.close()}
});

test('Serial ICE may finish after the old 12 second cutoff and remains bounded when no path connects',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const waiting=setup('local',{autoOpen:false});
    try{
        await waiting.peer.link.chain;
        t.mock.timers.tick(13000);assert.equal(waiting.peer.link.mode,'connecting');
        assert.equal(waiting.peer.direct,false,'WSS remains the application data path while ICE is pending');
        waiting.peer.link.channel.onopen();waiting.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true});
        t.mock.timers.tick(45000);assert.equal(waiting.peer.link.mode,'p2p','a completed channel must cancel the deadline');
    }finally{waiting.peer.close()}
    const blocked=setup('local',{autoOpen:false});
    try{
        t.mock.timers.tick(44999);assert.equal(blocked.peer.link.mode,'connecting');
        t.mock.timers.tick(1);assert.equal(blocked.peer.link.mode,'websocket');assert.equal(blocked.peer.diagnostic.reason,'negotiation_timeout');
        blocked.peer.link.channel.onopen();assert.equal(blocked.peer.direct,false,'late channel events cannot revive fallback');
    }finally{blocked.peer.close()}
});

test('Serial P2P uses only bounded operator STUN configuration and explains host-only fallback',()=>{
    const original=globalThis.ShareSerialICE;
    try{
        delete globalThis.ShareSerialICE;assert.equal(configuration().configuration,'missing');assert.deepEqual(configuration().iceServers,[]);
        globalThis.ShareSerialICE={schemaVersion:1,iceServers:[{urls:['stun:192.0.2.3:18444']}]};
        const configured=configuration();assert.equal(configured.configuration,'server');assert.equal(configured.iceServers[0].urls[0],'stun:192.0.2.3:18444');
        let captured;
        class ConfiguredRTC extends RTC{constructor(value){super();captured=value}}
        const endpoint=setup('local',{RTC:ConfiguredRTC});try{assert.deepEqual(captured.iceServers,[{urls:['stun:192.0.2.3:18444']}])}finally{endpoint.peer.close()}
        configured.iceServers[0].urls[0]='stun:changed';assert.equal(configuration().iceServers[0].urls[0],'stun:192.0.2.3:18444');
        globalThis.ShareSerialICE={schemaVersion:1,iceServers:[{urls:['turn:user:secret@host']}]};assert.equal(configuration().configuration,'invalid');
        const explanation=describe({reason:'negotiation_timeout',stunConfigured:false,iceConnectionState:'checking',localCandidates:{host:2},remoteCandidates:{host:1},stunError:701});
        assert.match(explanation,/协商超时/);assert.match(explanation,/未配置 STUN/);assert.match(explanation,/host=2/);assert.match(explanation,/701/);
    }finally{if(original===undefined)delete globalThis.ShareSerialICE;else globalThis.ShareSerialICE=original}
});

test('A server-reported fallback reason is visible and cannot revive direct transport',async()=>{
    const t=setup();try{
        t.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',probeKind:'fallback',direct:false,p2pReason:'negotiation_timeout'});
        assert.equal(t.peer.direct,false);assert.equal(t.peer.diagnostic.reason,'negotiation_timeout');
        t.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true});assert.equal(t.peer.direct,false);
        assert.equal(t.peer.diagnostic.reason,'negotiation_timeout');
    }finally{t.peer.close()}
});

test('Physical serial direct frames preserve all bytes and reject invalid boundaries',()=>{
    const bytes=Uint8Array.from({length:16384},(_,i)=>i&255),result=unframe(frame(2,9007199254740991,bytes));
    assert.equal(result.sequence,9007199254740991);assert.deepEqual(result.bytes,bytes);
    assert.throws(()=>frame(1,0,bytes));assert.throws(()=>frame(1,1,new Uint8Array(16385)));
    assert.throws(()=>unframe(new Uint8Array(16)));const bad=frame(1,1,Uint8Array.of(1));bad[5]=1;assert.throws(()=>unframe(bad));
});
test('Remote direct TX obtains one hash-bound server permit before sending bytes',async()=>{
    const t=setup('remote');try{
        const bytes=Uint8Array.of(0,192,219,255),sending=t.peer.sendTX(bytes,2);await waitForIntent(t);
        assert.equal(t.peer.link.channel.sent.length,0);
        const intent=t.sent.find(m=>m.type==='p2p_serial_tx');assert.equal(intent.sha256,await digest(bytes));assert.equal(intent.byteLength,4);assert.equal(intent.data,undefined);
        t.peer.handle({...await permit(bytes),sha256:'b'.repeat(64)});assert.equal(t.peer.link.channel.sent.length,0);
        t.peer.handle(await permit(bytes));await sending;
        assert.deepEqual(unframe(t.peer.link.channel.sent[0]).bytes,bytes);assert.equal(t.peer.pending.size,0);
    }finally{t.peer.close()}
});
test('Local joins permits and direct bytes in either arrival order and never executes a duplicate',async()=>{
    for(const first of ['permit','frame']){
        const t=setup();try{
            const bytes=Uint8Array.of(0,192,255),authorization=await permit(bytes),packet=frame(1,1,bytes);
            if(first==='permit'){t.peer.handle(authorization);await turn();assert.equal(t.writes.length,0);t.peer.receive(packet)}
            else{t.peer.receive(packet);assert.equal(t.writes.length,0);t.peer.handle(authorization)}
            await t.peer.incomingChain;
            assert.equal(t.writes.length,1);assert.deepEqual(SerialData.fromBase64(t.writes[0].data),bytes);
            t.peer.handle(authorization);t.peer.receive(packet);await t.peer.incomingChain;
            assert.equal(t.writes.length,1);assert.equal(t.peer.incoming.size,0);
        }finally{t.peer.close()}
    }
});
test('Local rejects altered direct bytes, stale grants, read-only writes and permission loss during digest',async()=>{
    const bytes=Uint8Array.of(1,2,3);
    const t=setup();try{
        t.peer.handle(await permit(bytes));t.peer.receive(frame(1,1,Uint8Array.of(1,2,4)));await t.peer.incomingChain;
        assert.equal(t.writes.length,0);assert.equal(t.peer.direct,false);assert(t.errors.length);
    }finally{t.peer.close()}
    const stale=setup();try{stale.peer.handle({...await permit(bytes),grantId:'old'});stale.peer.receive(frame(1,1,bytes));await turn();assert.equal(stale.writes.length,0)}finally{stale.peer.close()}
    const reader=setup();try{reader.pause();reader.peer.handle(await permit(bytes));reader.peer.receive(frame(1,1,bytes));await turn();assert.equal(reader.writes.length,0)}finally{reader.peer.close()}
    const revoked=setup();const original=crypto.subtle.digest.bind(crypto.subtle);let release;
    const authorization=await permit(bytes);
    try{
        crypto.subtle.digest=()=>new Promise(resolve=>release=resolve);
        revoked.peer.handle(authorization);revoked.peer.receive(frame(1,1,bytes));await turn();assert(release);
        revoked.revoke();release(await original('SHA-256',bytes));await revoked.peer.incomingChain;assert.equal(revoked.writes.length,0);
    }finally{crypto.subtle.digest=original;revoked.peer.close()}
});
test('Fallback cancels pending TX and backlogged RX without replaying old commands on WSS',async()=>{
    const t=setup('remote');try{
        const sending=t.peer.sendTX(Uint8Array.of(1),2);const rejected=assert.rejects(sending,/中断|变化/);
        await turn();t.peer.fallback();await rejected;
        t.peer.handle(await permit(Uint8Array.of(1)));await turn();assert.equal(t.peer.link.channel.sent.length,0);
        assert.equal(t.sent.filter(m=>m.type==='send').length,0);
    }finally{t.peer.close()}
    const local=setup();try{local.peer.link.channel.bufferedAmount=65536;local.peer.sendRX(1,Uint8Array.of(1));await turn();local.peer.close();await local.peer.rxChain;assert.equal(local.peer.link.channel.sent.length,0)}finally{local.peer.close()}
});
test('Direct queues are bounded and late native frames cannot revive a closed grant',async()=>{
    const t=setup();try{
        for(let i=1;i<=17;i++)t.peer.receive(frame(1,i,Uint8Array.of(i)));
        assert.equal(t.peer.direct,true);assert.equal(t.peer.txViaRelay,true);assert.equal(t.peer.incoming.size,0);
        assert.equal(t.peer.link.mode,'p2p');
        t.peer.receive(frame(1,18,Uint8Array.of(18)));assert.equal(t.peer.incoming.size,0,'late TX is discarded after switching to relay');
        t.peer.close();t.peer.receive(frame(2,1,Uint8Array.of(1)));assert.equal(t.received.length,0);
    }finally{t.peer.close()}
});
test('RX reorders mixed transports and repairs a missing tail with the current cursor',async()=>{
    let cursor=0,replaying=false;const received=[],resumes=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{received.push(m.rxSeq);cursor=Math.max(cursor,m.rxSeq)},resume:s=>resumes.push(s),replaying:s=>{replaying=s},onError:()=>{}});
    const data=seq=>({type:'data',rxSeq:seq,data:'AA=='});
    try{
        rx.receive(data(2),true);rx.receive(data(1));assert.deepEqual(received,[1,2]);assert.deepEqual(resumes,[]);
        rx.observe(3);await delay(180);assert.deepEqual(resumes,[2]);assert(replaying);
        rx.receive(data(4),true);assert.equal(cursor,2,'live direct bytes must wait for ordered cache repair');
        rx.begin();rx.receive(data(3));rx.complete();assert.equal(cursor,3);assert(!replaying);
        rx.receive(data(3),true);assert.deepEqual(received,[1,2,3]);
    }finally{rx.close()}
});

test('RX repair freezes late live WSS frames until the server confirms the replay boundary',()=>{
    let cursor=0;const received=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{received.push(m.rxSeq);cursor=m.rxSeq},resume:()=>{},replaying:()=>{},onError:()=>{}});
    const data=rxSeq=>({type:'data',rxSeq,data:'AA=='});
    try{
        rx.observe(3);rx.repair();
        rx.receive(data(3));assert.equal(cursor,0,'late live WSS must not skip the missing bytes');
        rx.begin();for(let i=1;i<=3;i++)rx.receive(data(i));rx.complete();
        assert.deepEqual(received,[1,2,3]);assert.equal(cursor,3);
    }finally{rx.close()}
});

test('Late TX failure cannot overwrite the notice of a newer Remote authorization',async()=>{
    const {browser}=require('./browser-harness.cjs'),page=browser('remote.js');
    let reject;page.sandbox.txResult=new Promise((yes,no)=>{reject=no});
    page.run("isConnected=true; ws=new WebSocket('wss://localhost/ws/remote'); access='control'; grantId='old'; writeEpoch=1; connectedPortId='usb'; serialPeer={direct:true,sendTX:()=>txResult}; elements.sendInput.value='test'; sendData(); grantId='new'; elements.errorMessage.textContent='new grant notice'");
    reject(Error('late old TX failure'));await turn();
    assert.equal(page.elements.get('errorMessage').textContent,'new grant notice');
});

test('RX merges a bounded direct live tail after WSS backfill without acknowledging unsent history',()=>{
    let cursor=0,replaying=false;const delivered=[],acks=[],resumes=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{if(m.rxSeq>cursor){delivered.push(m.rxSeq);cursor=m.rxSeq}if(replaying)acks.push(m.rxSeq)},
        resume:n=>resumes.push(n),replaying:value=>{replaying=value},onError:()=>{}});
    const data=rxSeq=>({type:'data',rxSeq,data:'AA=='});
    try{
        rx.observe(3);rx.repair();rx.receive(data(4),true);
        assert.equal(cursor,0);assert.deepEqual(acks,[]);
        rx.begin(3);rx.receive(data(5),true);
        for(let sequence=1;sequence<=3;sequence++)rx.receive(data(sequence));
        assert.equal(cursor,3);assert.deepEqual(acks,[1,2,3]);
        rx.complete();assert.equal(cursor,5);assert.deepEqual(delivered,[1,2,3,4,5]);
        assert.deepEqual(acks,[1,2,3],'direct live frames must not ACK a server range that was never sent');
        rx.receive(data(4),true);assert.deepEqual(delivered,[1,2,3,4,5]);assert.deepEqual(resumes,[0]);
    }finally{rx.close()}
});

test('RX live-tail overflow retains the connection and requests another cache window',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let cursor=0;const resumes=[],errors=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{cursor=m.rxSeq},resume:n=>resumes.push(n),replaying:()=>{},onError:n=>errors.push(n)});
    const data=rxSeq=>({type:'data',rxSeq,data:'AA=='});
    try{
        rx.observe(1);rx.repair();rx.begin(1);
        for(let sequence=2;sequence<=302;sequence++)rx.receive(data(sequence),true);
        assert(rx.frames.size<=256);assert(rx.bytes<=192*1024);assert.equal(cursor,0);
        rx.receive(data(1));rx.complete();assert.equal(cursor,1);
        t.mock.timers.tick(150);assert.deepEqual(resumes,[0,1]);assert.deepEqual(errors,[]);
        rx.close();rx.receive(data(303),true);t.mock.timers.tick(30000);assert.deepEqual(resumes,[0,1]);
    }finally{rx.close()}
});

test('Stopping after a TX intent finishes that one submission without blocking the next command',async()=>{
    const endpoint=setup('remote'),local=setup('local');let current=true;
    try{
        const bytes=Uint8Array.of(1),pending=endpoint.peer.sendTX(bytes,2,()=>current);
        await waitForIntent(endpoint);current=false;
        const authorization=await permit(bytes);local.peer.handle(authorization);endpoint.peer.handle(authorization);
        await pending;local.peer.receive(endpoint.peer.link.channel.sent[0]);await local.peer.incomingChain;
        assert.equal(endpoint.peer.pending.size,0);assert.equal(local.writes.length,1);
        const nextBytes=Uint8Array.of(2),next=endpoint.peer.sendTX(nextBytes,2);await waitForIntent(endpoint,2);
        const nextPermit={...await permit(nextBytes),txSeq:2};local.peer.handle(nextPermit);endpoint.peer.handle(nextPermit);
        await next;local.peer.receive(endpoint.peer.link.channel.sent[1]);await local.peer.incomingChain;
        assert.deepEqual(local.writes.map(m=>[...SerialData.fromBase64(m.data)]),[[1],[2]]);
        assert.equal(local.peer.permits.length,0);assert.equal(local.peer.incoming.size,0);
        assert.equal(endpoint.sent.filter(m=>m.type==='send').length,0);
    }finally{endpoint.peer.close();local.peer.close()}
});

test('Cancelling a periodic TX during hashing cannot create a late server intent',async()=>{
    const endpoint=setup('remote');let current=true,release;
    const nativeDigest=crypto.subtle.digest.bind(crypto.subtle),bytes=Uint8Array.of(1);
    try{
        crypto.subtle.digest=()=>new Promise(resolve=>{release=resolve});
        const pending=endpoint.peer.sendTX(bytes,2,()=>current),rejected=assert.rejects(pending,/变化/);rejected.catch(()=>{});
        await turn();assert(release);current=false;release(await nativeDigest('SHA-256',bytes));await turn();
        assert.equal(endpoint.sent.filter(m=>m.type==='p2p_serial_tx').length,0);assert.equal(endpoint.peer.pending.size,0);
        await rejected;
    }finally{crypto.subtle.digest=nativeDigest;endpoint.peer.close()}
});

test('Write-state cancellation clears stale permits, fences late data and preserves direct RX',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});let allowed=true,epoch=2;
    const endpoint=setup('local',{canTX:value=>allowed&&value===epoch}),bytes=Uint8Array.of(1);
    try{
        endpoint.peer.handle(await permit(bytes));assert.equal(endpoint.peer.permits.length,1);
        allowed=false;epoch=3;endpoint.peer.cancelWrites();
        endpoint.peer.handle({...await permit(bytes),txSeq:2});
        assert.equal(endpoint.peer.incoming.size,0);assert.equal(endpoint.peer.lastPermit,2);
        allowed=true;endpoint.peer.receive(frame(1,2,bytes));assert.equal(endpoint.peer.incoming.size,0);
        endpoint.peer.handle({...await permit(bytes),txSeq:3,writeEpoch:3});endpoint.peer.receive(frame(1,3,bytes));await endpoint.peer.incomingChain;
        assert.equal(endpoint.writes.length,1);assert.equal(endpoint.peer.incoming.size,0);
        t.mock.timers.tick(10000);assert.equal(endpoint.peer.direct,true);
        assert.equal(endpoint.peer.sendRX(1,bytes),true);await endpoint.peer.rxChain;
    }finally{endpoint.peer.close()}
});

test('Write cancellation during digest cannot execute old bytes even if the same epoch becomes writable again',async()=>{
    const endpoint=setup('local'),bytes=Uint8Array.of(1);const authorization=await permit(bytes);
    const nativeDigest=crypto.subtle.digest.bind(crypto.subtle);let release;
    try{
        crypto.subtle.digest=()=>new Promise(resolve=>{release=resolve});
        endpoint.peer.handle(authorization);endpoint.peer.receive(frame(1,1,bytes));await turn();assert(release);
        endpoint.peer.cancelWrites();release(await nativeDigest('SHA-256',bytes));await endpoint.peer.incomingChain;
        assert.equal(endpoint.writes.length,0);assert.equal(endpoint.peer.direct,true);
    }finally{crypto.subtle.digest=nativeDigest;endpoint.peer.close()}
});

test('Slow backfill that keeps advancing does not warn on a fixed total duration',t=>{
    t.mock.timers.enable({apis:['setTimeout']});let cursor=0;const errors=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{cursor=m.rxSeq},resume:()=>{},replaying:()=>{},onError:e=>errors.push(e)});
    try{
        rx.observe(3);rx.repair();rx.begin(3);
        for(let sequence=1;sequence<=3;sequence++){t.mock.timers.tick(29000);rx.receive({type:'data',rxSeq:sequence,data:'AA=='});assert.deepEqual(errors,[])}
        rx.complete();t.mock.timers.tick(30000);assert.equal(cursor,3);assert.deepEqual(errors,[]);
    }finally{rx.close()}
});

test('Only verified RX cursor progress renews the backfill idle deadline',t=>{
    t.mock.timers.enable({apis:['setTimeout']});let cursor=0;const errors=[];
    const rx=new Receiver({cursor:()=>cursor,deliver:m=>{cursor=m.rxSeq},resume:()=>{},replaying:()=>{},onError:e=>errors.push(e)});
    try{
        rx.observe(1);rx.repair();rx.begin(1);t.mock.timers.tick(29000);
        rx.noteProgress();t.mock.timers.tick(1000);assert.equal(errors.length,1);assert.match(errors[0],/30 秒无进展/);
        rx.receive({type:'data',rxSeq:1,data:'AA=='});rx.complete();t.mock.timers.tick(30000);assert.equal(errors.length,1);
    }finally{rx.close()}
});

test('RX send failures preserve the assessment context before closing its stream',async()=>{
    const endpoint=setup('local');try{
        endpoint.peer.network.close();endpoint.peer.network={session:{closed:false,channel:{bufferedAmount:4096}},close(){this.session=null}};
        endpoint.peer.link.channel.bufferedAmount=77;endpoint.peer.link.send=async()=>{throw Error('secret 192.0.2.99')};
        endpoint.peer.sendRX(1,Uint8Array.of(1));await endpoint.peer.rxChain;await endpoint.peer.link.fallbackCapture;
        const report=endpoint.sent.find(message=>message.probeKind==='fallback');assert(report);
        assert.equal(report.p2pReason,'application');assert.equal(report.p2pDetails.applicationCause,'rx_send');assert.equal(report.p2pDetails.assessmentActive,true);
        assert.equal(report.p2pDetails.assessmentBufferedAmount,4096);assert.equal(report.p2pDetails.serialBufferedAmount,77);assert.equal(endpoint.peer.direct,false);
        assert(!/secret|192\.0\.2\.99/.test(JSON.stringify(report)));
    }finally{endpoint.peer.close()}
});

test('TX queue protection keeps the current P2P RX channel open and routes later TX to relay',async()=>{
    const local=setup('local');try{
        for(let sequence=1;sequence<=16;sequence++){
            local.peer.incoming.set(sequence,{bytes:Uint8Array.of(sequence),permit:{txSeq:sequence,writeEpoch:2},timer:setTimeout(()=>{},30000)});
            local.peer.permits.push(sequence);
        }
        assert.equal(local.peer.switchTXToRelay(),true);
        assert.equal(local.peer.switchTXToRelay(),false);
        assert.equal(local.peer.direct,true);assert.equal(local.peer.txViaRelay,true);
        assert.equal(local.peer.link.mode,'p2p');assert.equal(local.peer.link.channel.readyState,'open');
        assert.equal(local.peer.incoming.size,0);assert.equal(local.peer.permits.length,0);
        assert.equal(local.sent.filter(message=>message.probeKind==='tx_relay').length,1);
        local.peer.receive(frame(1,17,Uint8Array.of(17)));
        assert.equal(local.writes.length,0,'late direct TX is discarded without replay');
        assert.equal(local.peer.sendRX(1,Uint8Array.of(4,5)),true);await local.peer.rxChain;
        assert.equal(local.peer.direct,true);assert.equal(local.peer.link.mode,'p2p');
        assert.equal(unframe(local.peer.link.channel.sent.at(-1)).kind,2);
    }finally{local.peer.close()}

    const remote=setup('remote');try{
        const pending=remote.peer.sendTX(Uint8Array.of(9),2).then(()=>null,error=>error);
        await waitForIntent(remote);assert(remote.sent.some(message=>message.type==='p2p_serial_tx'));
        remote.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true,serialTXRelay:true,probeKind:'tx_relay'});
        assert.equal(remote.peer.direct,true);assert.equal(remote.peer.txViaRelay,true);
        assert.equal(remote.peer.link.mode,'p2p');
        const abandoned=await pending;
        assert.equal(abandoned?.code,'P2P_TX_RELAY','an incomplete command is cancelled with an explicit unknown-result status');
        remote.peer.receive(frame(2,1,Uint8Array.of(8)));
        assert.deepEqual(remote.received,[{seq:1,bytes:[8]}]);
        const intents=remote.sent.filter(message=>message.type==='p2p_serial_tx').length;
        await assert.rejects(remote.peer.sendTX(Uint8Array.of(9),2),/发送授权或传输状态/);
        assert.equal(remote.sent.filter(message=>message.type==='p2p_serial_tx').length,intents);
        remote.peer.fallback('channel_error',false);
        assert.equal(remote.peer.txViaRelay,false,'full fallback clears the split-route indicator');
    }finally{remote.peer.close()}

    const legacy=setup('local',{txRelayProtocol:0});try{
        for(let sequence=1;sequence<=16;sequence++)legacy.peer.incoming.set(sequence,{timer:setTimeout(()=>{},30000)});
        assert.equal(legacy.peer.switchTXToRelay(),false);
        assert.equal(legacy.peer.direct,false);assert.equal(legacy.peer.link.mode,'websocket');
        assert(legacy.sent.some(message=>message.probeKind==='fallback'),'an older peer keeps its existing all-relay fallback');
    }finally{legacy.peer.close()}
});

test('A peer fallback reports this side once and drops reports from a retired round',async()=>{
    const state={type:'p2p_serial_state',portId:'usb',grantId:'grant',probeKind:'fallback',direct:false,p2pReason:'channel_error',p2pReporter:'local'};
    const endpoint=setup('remote');try{
        endpoint.peer.handle(state);endpoint.peer.handle(state);await endpoint.peer.link.fallbackCapture;await turn();
        assert.equal(endpoint.sent.filter(m=>m.probeKind==='fallback').length,1);assert.equal(endpoint.peer.direct,false);
    }finally{endpoint.peer.close()}
    const own=setup('remote');try{
        own.peer.link.channel.onerror({error:{errorDetail:'sctp-failure',sctpCauseCode:12}});await own.peer.link.fallbackCapture;
        own.peer.handle(state);await turn();assert.equal(own.sent.filter(m=>m.probeKind==='fallback').length,1);
    }finally{own.peer.close()}
    const retired=setup('remote',{retryProtocol:1});let release;try{
        retired.peer.link.pc.getStats=()=>new Promise(resolve=>{release=resolve});retired.peer.handle(state);const old=retired.peer.link;
        retired.peer.handle(retryState(1));release(new Map());await old.fallbackCapture;await turn();
        assert.equal(retired.sent.filter(m=>m.probeKind==='fallback').length,0);
    }finally{retired.peer.close()}
});

test('The diagnostic stream tolerates delayed receiver readiness, stays isolated and rejects a retired grant',()=>{
    const endpoint=setup('local',{autoOpen:false});try{
        endpoint.peer.link.channel.onopen();assert.equal(endpoint.peer.direct,false);
        const main=endpoint.peer.link.channel,diagnostic=new Channel();diagnostic.label='shareserial-network-v1';
        endpoint.peer.link.pc.ondatachannel({channel:diagnostic});
        assert.equal(endpoint.peer.link.channel,main);assert(endpoint.peer.network.session);assert.equal(endpoint.writes.length,0);
        endpoint.peer.handle({type:'p2p_serial_state',portId:'usb',grantId:'grant',direct:true});
        diagnostic.close();assert.equal(endpoint.peer.direct,true);assert.equal(main.readyState,'open');
        endpoint.revoke();const stale=new Channel();stale.label='shareserial-network-v1';endpoint.peer.link.pc.ondatachannel({channel:stale});
        assert.equal(stale.readyState,'closed');assert.equal(endpoint.peer.network.session,null);
    }finally{endpoint.peer.close()}
});
