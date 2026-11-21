const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Link,MAX_BACKLOG}=require('../static/js/p2p-probe-link.js');
const {setTimeout:delay}=require('node:timers/promises');

class Channel {
    label='shareserial-synthetic-probe';ordered=true;maxRetransmits=null;maxPacketLifeTime=null;
    readyState='open';bufferedAmount=0;sent=[];
    send(data){this.sent.push([...data])}
    close(){this.readyState='closed';this.onclose?.()}
}
class RTC {
    connectionState='new';added=[];
    createDataChannel(){return this.channel=new Channel()}
    async createOffer(){return {type:'offer',sdp:'offer'}}
    async createAnswer(){return {type:'answer',sdp:'answer'}}
    async setLocalDescription(){}
    async setRemoteDescription(){this.remote=true}
    async addIceCandidate(value){this.added.push(value)}
    async getStats(){return new Map()}
    close(){this.connectionState='closed';this.onconnectionstatechange?.()}
}
function setup(options={}){
    let valid=true;const signals=[],relayed=[],received=[],states=[];
    const link=new Link({initiator:true,RTC,sendSignal:(kind,payload)=>signals.push({kind,payload}),relay:async bytes=>relayed.push([...bytes]),
        valid:()=>valid,onFrame:bytes=>received.push([...bytes]),onState:mode=>states.push(mode),...options});
    return {link,signals,relayed,received,states,revoke(){valid=false}};
}

test('P2P probe sends reliable ordered binary data and never relays an established direct frame',async()=>{
    const t=setup();try{
        await t.link.chain;t.link.channel.onopen();
        await t.link.send(Uint8Array.from([0,192,219,255]));
        t.link.channel.onmessage({data:Uint8Array.from([255,0,13]).buffer});
        assert.deepEqual(t.link.channel.sent,[[0,192,219,255]]);assert.deepEqual(t.received,[[255,0,13]]);
        assert.equal(t.relayed.length,0);assert.equal(t.link.metrics.p2pSent,4);
    }finally{t.link.close()}
});

test('ICE diagnostics retain timeout stage and candidate types without addresses or raw browser errors',async()=>{
    const snapshots=[],t=setup({timeoutMs:25,iceServers:[{urls:['stun:192.0.2.99:18444']}],onDiagnostic:value=>snapshots.push(value)});
    try{
        await t.link.chain;
        t.link.pc.onicecandidate({candidate:{candidate:'candidate:1 1 udp 123 10.0.0.99 12345 typ host',address:'10.0.0.99'}});
        t.link.signal('candidate',JSON.stringify({candidate:'candidate:2 1 udp 123 203.0.113.99 30000 typ srflx raddr 10.0.0.99 rport 12345'}));await t.link.chain;
        t.link.pc.iceConnectionState='checking';t.link.pc.iceGatheringState='complete';
        t.link.pc.onicecandidateerror({errorCode:701,url:'stun:secret@192.0.2.99',errorText:'private 10.0.0.99'});
        await delay(40);
        const stats=await t.link.stats();assert.equal(stats.diagnostic.reason,'negotiation_timeout');
        assert.equal(stats.diagnostic.iceConnectionState,'checking');assert.equal(stats.diagnostic.localCandidates.host,1);assert.equal(stats.diagnostic.remoteCandidates.srflx,1);
        assert.equal(stats.diagnostic.stunError,701);assert(stats.diagnostic.stunConfigured);
        assert(!/10\.0\.0\.99|203\.0\.113\.99|192\.0\.2\.99|secret|stun:/.test(JSON.stringify(snapshots)));
        assert.equal(snapshots.at(-1).phase,'fallback','closing the native PC must not overwrite the failure snapshot');
    }finally{t.link.close()}
});

test('SDP failure exposes a typed cause and diagnostic observers cannot break transport',async()=>{
    class InvalidRTC extends RTC{async setRemoteDescription(){const e=Error('private sdp 192.0.2.99');e.name='OperationError';throw e}}
    const t=setup({RTC:InvalidRTC,initiator:false});try{
        t.link.signal('offer','private SDP');await t.link.chain;
        const diagnostic=(await t.link.stats()).diagnostic;assert.equal(diagnostic.reason,'sdp_error');assert.equal(diagnostic.errorName,'OperationError');
        assert(!/private|192\.0\.2\.99/.test(JSON.stringify(diagnostic)));
    }finally{t.link.close()}
    const observer=setup({onDiagnostic:()=>{throw Error('observer')}});try{
        await observer.link.chain;observer.link.channel.onopen();await observer.link.send(Uint8Array.of(9));assert.equal(observer.link.channel.sent.length,1);
        observer.revoke();const prior=JSON.stringify(observer.link.diagnostic);observer.link.pc.onicecandidateerror({errorCode:701});assert.equal(JSON.stringify(observer.link.diagnostic),prior);
    }finally{observer.link.close()}
});

test('Failure capture preserves DTLS state and redacted pair counters before native close',async()=>{
    const snapshots=[],t=setup({captureFailureStats:true,onDiagnostic:value=>snapshots.push(value)});
    try{
        await t.link.chain;t.link.pc.connectionState='failed';t.link.pc.iceConnectionState='disconnected';
        t.link.pc.sctp={state:'closed',transport:{state:'failed'}};
        t.link.pc.getStats=async()=>{
            assert.notEqual(t.link.pc.connectionState,'closed');
            t.link.pc.iceConnectionState='closed';
            return new Map([['private-id',{type:'candidate-pair',state:'succeeded',requestsSent:4,responsesReceived:3,requestsReceived:2,address:'10.0.0.99',localCandidateId:'secret'}],['transport',{type:'transport',dtlsState:'closed'}]]);
        };
        t.link.fallback(true,'connection_failed');assert.equal(t.link.mode,'websocket');
        await t.link.fallbackCapture;
        const diagnostic=(await t.link.stats()).diagnostic;
        assert.equal(diagnostic.iceConnectionState,'disconnected');assert.equal(diagnostic.failureDetails.dtls,'failed');
        assert.equal(diagnostic.failureDetails.validPairs,1);assert.equal(diagnostic.failureDetails.checksSent,4);assert.equal(diagnostic.failureDetails.responsesReceived,3);assert(diagnostic.failureDetails.statsAvailable);
        assert.equal(t.link.pc.connectionState,'closed');assert.equal(snapshots.at(-1).phase,'fallback_details');
        assert(!/10\.0\.0\.99|secret|private-id/.test(JSON.stringify(snapshots)));
        snapshots.at(-1).failureDetails.dtls='changed';assert.equal((await t.link.stats()).diagnostic.failureDetails.dtls,'failed');
    }finally{t.link.close()}
});

test('Failure stats cannot hold fallback beyond 200ms or publish after grant loss',async context=>{
    context.mock.timers.enable({apis:['setTimeout']});
    const slow=setup({captureFailureStats:true});try{
        slow.link.pc.getStats=()=>new Promise(()=>{});slow.link.fallback();
        assert.equal(slow.link.mode,'websocket');await slow.link.send(Uint8Array.of(9));assert.deepEqual(slow.relayed,[[9]]);
        context.mock.timers.tick(199);assert.notEqual(slow.link.pc.connectionState,'closed');
        context.mock.timers.tick(1);await Promise.resolve();await Promise.resolve();assert.equal(slow.link.pc.connectionState,'closed');await slow.link.fallbackCapture;assert.equal(slow.link.diagnostic.failureDetails.statsAvailable,false);
    }finally{slow.link.close()}
    let release;const snapshots=[],revoked=setup({captureFailureStats:true,onDiagnostic:value=>snapshots.push(value)});
    try{
        revoked.link.pc.getStats=()=>new Promise(resolve=>release=resolve);revoked.link.fallback();const count=snapshots.length;
        revoked.revoke();release(new Map());await revoked.link.fallbackCapture;
        assert.equal(snapshots.length,count);assert.equal(revoked.signals.filter(s=>s.kind==='fallback').length,0);assert.equal(revoked.link.pc.connectionState,'closed');
    }finally{revoked.link.close()}
});

test('A transport-only failure report does not imply zero peer responses were measured',async()=>{
    const t=setup({captureFailureStats:true});try{
        t.link.pc.getStats=async()=>new Map([['transport',{type:'transport',dtlsState:'failed'}]]);
        t.link.fallback();await t.link.fallbackCapture;
        assert.equal(t.link.diagnostic.failureDetails.statsAvailable,false);
    }finally{t.link.close()}
});

test('Native channel errors retain only typed SCTP context and bounded counters',async()=>{
    const t=setup({captureFailureStats:true,getFailureContext:()=>({applicationCause:'private-address',assessmentActive:true,assessmentBufferedAmount:9999999,secret:'10.0.0.99'})});
    try{
        await t.link.chain;t.link.channel.onopen();t.link.channel.bufferedAmount=37;
        t.link.channel.onerror({error:{errorDetail:'sctp-failure',sctpCauseCode:12,message:'secret 10.0.0.99'}});
        await t.link.fallbackCapture;const details=t.signals.find(value=>value.kind==='fallback');assert(details);
        const snapshot=t.link.diagnostic.failureDetails;assert.equal(snapshot.channelError,'sctp-failure');assert.equal(snapshot.sctpCauseCode,12);
        assert.equal(snapshot.channelState,'open');assert.equal(snapshot.serialBufferedAmount,37);assert.equal(snapshot.assessmentActive,true);assert.equal(snapshot.assessmentBufferedAmount,1048576);assert.equal(snapshot.applicationCause,'');
        assert(!/secret|10\.0\.0\.99|private-address/.test(JSON.stringify(t.link.diagnostic)));
    }finally{t.link.close()}
});

test('Fallback uses relay for new frames and ignores late direct data',async()=>{
    const t=setup();try{
        await t.link.chain;const old=t.link.channel;old.onopen();t.link.fallback();
        assert.equal(t.link.mode,'websocket');assert.equal(t.signals.at(-1).kind,'fallback');
        old.onmessage({data:Uint8Array.of(9).buffer});assert.equal(t.received.length,0);
        await t.link.send(Uint8Array.of(3,4));t.link.receiveRelay(Uint8Array.of(5,6));
        assert.deepEqual(t.relayed,[[3,4]]);assert.deepEqual(t.received,[[5,6]]);
        assert.equal(t.link.metrics.wsSent,2);
    }finally{t.link.close()}
});

test('Revoked grants fence late SDP completion and direct frames',async()=>{
    let release;
    class SlowRTC extends RTC{async setRemoteDescription(){await new Promise(resolve=>release=resolve)}}
    const t=setup({initiator:false,RTC:SlowRTC});try{
        t.link.signal('offer','old');await Promise.resolve();t.revoke();release();await t.link.chain;
        assert.equal(t.signals.length,0,'late answer cannot revive an invalid grant');
        await assert.rejects(t.link.send(Uint8Array.of(1)),/authorization/);
    }finally{t.link.close()}
});

test('P2P probe bounds pending ICE work, frame size and backpressure',async()=>{
    const t=setup();try{
        await t.link.chain;t.link.channel.onopen();
        await assert.rejects(t.link.send(new Uint8Array(16385)),/size/);
        t.link.channel.bufferedAmount=MAX_BACKLOG;
        const sending=t.link.send(Uint8Array.of(1));t.link.fallback();
        await assert.rejects(sending,/interrupted|changed/);
        assert.equal(t.relayed.length,0,'in-flight frame must not be resent through relay');
    }finally{t.link.close()}
    const flooded=setup({initiator:false});try{
        for(let i=0;i<74;i++)flooded.link.signal('candidate','{"candidate":"candidate"}');
        await flooded.link.chain;
        assert.equal(flooded.link.mode,'websocket');assert(flooded.link.candidates.length<=64);
    }finally{flooded.link.close()}
});

test('An unavailable WebRTC implementation negotiates relay without a public ICE service',()=>{
    const t=setup({RTC:null});try{assert.equal(t.link.mode,'websocket');assert.equal(t.signals[0].kind,'fallback')}finally{t.link.close()}
    let config;
    class CaptureRTC extends RTC{constructor(value){super();config=value}}
    const direct=setup({RTC:CaptureRTC});assert.deepEqual(config,{iceServers:[]});direct.link.close();
    class DisabledRTC{constructor(){throw Error('disabled by browser policy')}}
    const disabled=setup({RTC:DisabledRTC});assert.equal(disabled.link.mode,'websocket');disabled.link.close();
});
