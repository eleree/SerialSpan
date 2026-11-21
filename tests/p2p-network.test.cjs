const {test}=require('node:test'),assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {Endpoint,LABEL,SIZE,gate}=require('../static/js/p2p-network.js');
class Channel{
    label=LABEL;ordered=true;maxRetransmits=null;maxPacketLifeTime=null;readyState='open';bufferedAmount=0;
    send(data){
        if(this.readyState!=='open')throw Error('closed');
        const message=typeof data==='string'?data:Uint8Array.from(data).buffer;
        queueMicrotask(()=>{if(this.peer.readyState==='open')this.peer.onmessage?.({data:message})});
    }
    close(){
        if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.();
        queueMicrotask(()=>{if(this.peer.readyState!=='closed'){this.peer.readyState='closed';this.peer.onclose?.()}});
    }
}
function pair({responderLimiter}={}){
    let valid=true,available=true,created=0,clock=100;const channels=[];
    const responder=new Endpoint({valid:()=>valid,available:()=>available,limiter:responderLimiter||gate(()=>clock),create:()=>{throw Error('not an initiator')}});
    const initiator=new Endpoint({valid:()=>valid,available:()=>available,limiter:gate(()=>clock),now:()=>++clock,create:()=>{
        created++;const first=new Channel(),second=new Channel();first.peer=second;second.peer=first;channels.push(first,second);responder.accept(second);return first;
    }});
    return {initiator,responder,channels,get created(){return created},invalidate(){valid=false;initiator.close();responder.close()},loseScope(){valid=false},busy(){available=false},advance(){clock+=30001}};
}

test('A P2P assessment measures both directions using bounded validated network-only bytes',async()=>{
    const fixture=pair(),progress=[];
    try{
        assert.equal(fixture.created,0,'opening an endpoint does not send network probes');
        const result=await fixture.initiator.assess({signal:new AbortController().signal,progress:value=>progress.push(value)});
        assert.equal(result.source,'p2p');assert.equal(result.sampleBytes,SIZE*4);assert.equal(result.probes,6);assert.equal(result.failed,0);
        assert(result.uploadBytesPerSecond>0&&result.downloadBytesPerSecond>0);assert.equal(result.rtts.length,6);
        assert(progress.some(value=>value.includes('接收'))&&progress.some(value=>value.includes('发送')));
        await turn();assert.equal(fixture.responder.session,null);assert.equal(fixture.initiator.session,null);
        await assert.rejects(fixture.initiator.assess(),/30 秒/);fixture.advance();
        assert((await fixture.initiator.assess()).downloadBytesPerSecond>0);
    }finally{fixture.invalidate()}
});

test('Busy, cancelled and invalid scopes cannot create a diagnostic channel',async()=>{
    const fixture=pair();try{
        const controller=new AbortController();controller.abort();await assert.rejects(fixture.initiator.assess({signal:controller.signal}),/取消/);
        assert.equal(fixture.created,0);fixture.busy();await assert.rejects(fixture.initiator.assess(),/空闲/);assert.equal(fixture.created,0);
        fixture.invalidate();await assert.rejects(fixture.initiator.assess(),/直连/);
    }finally{fixture.invalidate()}
});

test('Route loss and explicit cancellation close only the diagnostic session and release its gate',async()=>{
    for(const kind of ['route','cancel']){
        const fixture=pair(),controller=new AbortController();
        try{
            const result=fixture.initiator.assess({signal:controller.signal});const rejected=assert.rejects(result,/路径|取消/);
            if(kind==='route')fixture.invalidate();else controller.abort();await rejected;await turn();
            assert.equal(fixture.initiator.session,null);assert.equal(fixture.initiator.limiter.active,null);
            assert.equal(fixture.channels.every(channel=>channel.readyState==='closed'),true);
        }finally{fixture.invalidate()}
    }
});

test('Unexpected and oversized probe frames cannot reach a serial handler or grow a queue',async()=>{
    const fixture=pair();try{
        const result=fixture.initiator.assess();const rejected=assert.rejects(result,/无效|不匹配/);
        fixture.channels[0].onmessage({data:new ArrayBuffer(9000)});await rejected;await turn();
        assert.equal(fixture.initiator.session,null);assert.equal(fixture.initiator.limiter.active,null);
    }finally{fixture.invalidate()}
});

test('A receiving page permits only one active peer assessment',async()=>{
    const limiter=gate(),first=pair({responderLimiter:limiter}),second=pair({responderLimiter:limiter});
    try{
        const results=await Promise.allSettled([first.initiator.assess(),second.initiator.assess()]);
        assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
        assert.equal(results.filter(result=>result.status==='rejected').length,1);assert.equal(limiter.active,null);
    }finally{first.invalidate();second.invalidate()}
});

test('A full diagnostic buffer times out without an unbounded send queue',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const fixture=pair();let sent=0;
    const create=fixture.initiator.create;
    fixture.initiator.create=()=>{
        const channel=create(),send=channel.send.bind(channel);
        channel.send=data=>{send(data);if(typeof data!=='string'){sent++;channel.bufferedAmount=100000}};return channel;
    };
    try{
        const result=fixture.initiator.assess(),rejected=assert.rejects(result,/响应|超时|变化/);
        await turn();assert.equal(sent,1);t.mock.timers.tick(20000);assert.equal(fixture.initiator.session,null);await rejected;await turn();
        assert.equal(fixture.initiator.session,null);assert.equal(fixture.initiator.limiter.active,null);assert.equal(sent,1);
    }finally{fixture.invalidate()}
});

test('An older peer closing the unknown diagnostic stream leaves no live session',async()=>{
    const fixture=pair();fixture.responder.close();
    try{await assert.rejects(fixture.initiator.assess(),/通道/);assert.equal(fixture.initiator.session,null)}finally{fixture.invalidate()}
});

test('Approval loss and a new busy transaction stop an in-progress probe without external cleanup',async()=>{
    for(const kind of ['scope','busy']){
        const fixture=pair();try{
            await assert.rejects(fixture.initiator.assess({progress:()=>{if(kind==='scope')fixture.loseScope();else fixture.busy()}}),/状态|路径/);
            assert.equal(fixture.initiator.session,null);assert.equal(fixture.initiator.limiter.active,null);
        }finally{fixture.invalidate()}
    }
});

test('A diagnostic session rejects excessive traffic even with individually valid small controls',async()=>{
    const fixture=pair();try{
        const result=fixture.initiator.assess(),rejected=assert.rejects(result,/流量/);
        for(let i=0;i<65;i++)fixture.channels[0].onmessage({data:JSON.stringify({t:'pong',id:99,pad:'x'.repeat(215)})});
        await rejected;assert.equal(fixture.initiator.session,null);
    }finally{fixture.invalidate()}
});

test('A diagnostic session bounds the number of tiny controls',async()=>{
    const fixture=pair();try{
        const result=fixture.initiator.assess(),rejected=assert.rejects(result,/消息超过/);
        for(let i=0;i<97;i++)fixture.channels[0].onmessage?.({data:'{"t":"pong","id":99}'});
        await rejected;
    }finally{fixture.invalidate()}
});

test('Control limits count UTF-8 bytes rather than UTF-16 string length',async()=>{
    const fixture=pair();try{
        const result=fixture.initiator.assess(),rejected=assert.rejects(result,/消息过大/);
        const data=JSON.stringify({t:'pong',id:99,pad:'汉'.repeat(100)});
        assert(data.length<256);assert(Buffer.byteLength(data)>256);
        fixture.channels[0].onmessage({data});await rejected;assert.equal(fixture.initiator.session,null);
    }finally{fixture.invalidate()}
});

test('Oversized but otherwise correctly patterned binary data is rejected',async()=>{
    const fixture=pair(),create=fixture.initiator.create;let enlarged=false,skip=false;
    fixture.initiator.create=()=>{
        const channel=create(),peer=channel.peer,send=peer.send.bind(peer);
        peer.send=data=>{
            if(typeof data!=='string'){
                if(skip){skip=false;return}
                if(!enlarged){
                    enlarged=true;skip=true;const bytes=new Uint8Array(12+8192);bytes.set(data.subarray(0,12));
                    for(let i=0;i<8192;i++)bytes[12+i]=i%251;
                    send(bytes);return;
                }
            }
            send(data);
        };return channel;
    };
    try{await assert.rejects(fixture.initiator.assess(),/帧无效/);assert(enlarged)}finally{fixture.invalidate()}
});
