// Network-only diagnostics on a separate SCTP stream. Never deliver probe data to serial handlers.
(function(root,factory){
    if(typeof module==='object'&&module.exports)module.exports=factory();else root.P2PNetwork=factory();
})(globalThis,function(){
    'use strict';
    const LABEL='shareserial-network-v1',SIZE=32768,CHUNK=4096,BACKLOG=8192,DEADLINE=20000;
    const PLAN=[{id:0,dir:'up'},{id:1,dir:'up'},{id:2,dir:'down'},{id:3,dir:'down'}];
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    function gate(now=()=>performance.now()){
        return {active:null,last:-Infinity,claim(owner){if(this.active||now()-this.last<30000)return false;this.active=owner;this.last=now();return true},release(owner){if(this.active===owner)this.active=null}};
    }
    const pageGate=gate();
    function packet(id,offset){
        const count=Math.min(CHUNK,SIZE-offset),bytes=new Uint8Array(12+count),view=new DataView(bytes.buffer);
        bytes.set([83,83,78,1]);view.setUint32(4,id);view.setUint32(8,offset);
        for(let i=0;i<count;i++)bytes[12+i]=(offset+i)%251;
        return bytes;
    }
    class Session{
        constructor(endpoint,channel,initiator,{signal,progress=()=>{}}={}){
            Object.assign(this,{endpoint,channel,initiator,progress,signal});
            this.closed=false;this.messages=0;this.traffic=0;this.ping=0;this.plan=0;this.results=[];
            channel.binaryType='arraybuffer';
            this.result=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject});this.result.catch(()=>{});
            this.abort=()=>this.fail('评估已取消');signal?.addEventListener('abort',this.abort,{once:true});
            this.timer=setTimeout(()=>this.fail('直连评估超时，样本不足'),DEADLINE);
            channel.onmessage=event=>{try{this.receive(event.data)}catch(error){this.fail(error.message)}};
            channel.onclose=()=>this.fail('直连评估通道已关闭，请刷新两端后重试');
            channel.onerror=()=>this.fail('直连评估通道不可用');
            channel.onopen=()=>{if(initiator)this.start().catch(error=>this.fail(error.message))};
            if(signal?.aborted)this.abort();else if(channel.readyState==='open'&&initiator)queueMicrotask(()=>this.start().catch(error=>this.fail(error.message)));
        }
        valid(){return !this.closed&&this.endpoint.valid()&&this.endpoint.available()}
        check(){if(!this.valid())throw Error('连接路径或串口事务状态已变化，请重新评估')}
        account(length){this.traffic+=length;if(this.traffic>144*1024)throw Error('直连评估流量超过上限')}
        control(message){this.check();const data=JSON.stringify(message),length=new TextEncoder().encode(data).byteLength;if(length>256||this.channel.bufferedAmount+length>BACKLOG)throw Error('直连评估发送积压');this.account(length);this.channel.send(data)}
        waiting(kind,id,timeout=5000){
            if(this.pending)throw Error('直连评估操作重叠');
            const result=new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>{if(this.pending?.resolve===resolve){this.pending=null;reject(Error('直连探测未及时响应'))}},timeout);
                this.pending={kind,id,resolve,reject,timer};
            });result.catch(()=>{});return result;
        }
        accept(kind,id,value){
            const pending=this.pending;
            if(pending?.kind!==kind||pending.id!==id)return false;
            clearTimeout(pending.timer);this.pending=null;pending.resolve(value);return true;
        }
        async start(){
            if(this.started||this.closed)return;this.started=true;this.check();
            const ready=this.waiting('hello',0);this.control({t:'hello',v:1});await ready;
            const probes=[];
            for(let id=0;id<6;id++){
                this.progress('直连往返探测 '+(id+1)+'/6');const started=this.endpoint.now(),reply=this.waiting('pong',id,1500);
                this.control({t:'ping',id});try{await reply;probes.push({ok:true,elapsedMs:Math.max(1,this.endpoint.now()-started)})}catch{this.check();probes.push({ok:false})}
            }
            for(const item of PLAN){
                this.check();this.progress(item.dir==='up'?'正在评估直连发送速率':'正在评估直连接收速率');
                if(item.dir==='up'){
                    const ready=this.waiting('up_ready',item.id);this.control({t:'sample',id:item.id,dir:item.dir});await ready;
                    const done=this.waiting('up_done',item.id),started=this.endpoint.now();await this.send(item.id);await done;
                    this.results.push({dir:item.dir,bytes:SIZE,elapsedMs:Math.max(1,this.endpoint.now()-started)});
                }else{
                    this.incoming={id:item.id,received:0};const done=this.waiting('binary',item.id),started=this.endpoint.now();
                    this.control({t:'sample',id:item.id,dir:item.dir});await done;
                    this.results.push({dir:item.dir,bytes:SIZE,elapsedMs:Math.max(1,this.endpoint.now()-started)});
                    const next=this.waiting('next',item.id);this.control({t:'down_ack',id:item.id});await next;
                }
            }
            const rates=dir=>Math.min(...this.results.filter(item=>item.dir===dir).map(item=>item.bytes*1000/item.elapsedMs));
            const report={source:'p2p',uploadBytesPerSecond:rates('up'),downloadBytesPerSecond:rates('down'),
                probes:6,failed:probes.filter(item=>!item.ok).length,timeouts:probes.filter(item=>!item.ok).length,
                rtts:probes.filter(item=>item.ok).map(item=>item.elapsedMs),sampleBytes:SIZE*4};
            this.finish(report);
        }
        async send(id){
            for(let offset=0;offset<SIZE;offset+=CHUNK){
                const bytes=packet(id,offset);
                while(this.channel.bufferedAmount+bytes.length>BACKLOG){this.check();await delay(10)}
                this.check();this.account(bytes.length);this.sent=offset+bytes.length-12;this.channel.send(bytes);
            }
        }
        receive(data){
            this.check();if(++this.messages>96)throw Error('直连评估消息超过上限');
            if(typeof data==='string'){
                if(data.length>256)throw Error('直连评估消息过大');
                const length=new TextEncoder().encode(data).byteLength;if(length>256)throw Error('直连评估消息过大');this.account(length);
                const message=JSON.parse(data);
                if(this.initiator){
                    if(message.t==='hello_ready'&&message.v===1){this.accept('hello',0);return}
                    if(['pong','up_ready','up_done','next'].includes(message.t)&&Number.isInteger(message.id)){this.accept(message.t,message.id);return}
                    throw Error('直连评估应答无效');
                }
                if(message.t==='hello'&&message.v===1&&!this.started){
                    if(!this.endpoint.limiter.claim(this))throw Error('对端评估忙或刚完成评估，请稍后重试');
                    this.claimed=true;this.started=true;this.control({t:'hello_ready',v:1});return;
                }
                if(!this.started)throw Error('直连评估尚未确认');
                if(message.t==='ping'&&message.id===this.ping&&this.ping<6){this.ping++;this.control({t:'pong',id:message.id});return}
                const plan=PLAN[this.plan];
                if(message.t==='sample'&&this.ping===6&&!this.phase&&plan?.id===message.id&&plan.dir===message.dir){
                    this.phase=plan;this.sent=0;
                    if(plan.dir==='up'){this.incoming={id:plan.id,received:0};this.control({t:'up_ready',id:plan.id})}
                    else this.send(plan.id).catch(error=>this.fail(error.message));
                    return;
                }
                if(message.t==='down_ack'&&this.phase?.dir==='down'&&message.id===this.phase.id&&this.sent===SIZE){
                    this.phase=null;this.plan++;this.control({t:'next',id:message.id});return;
                }
                throw Error('直连评估请求无效');
            }
            if(!(data instanceof ArrayBuffer)||data.byteLength<13||data.byteLength>CHUNK+12)throw Error('直连评估帧无效');
            this.account(data.byteLength);const bytes=new Uint8Array(data),view=new DataView(data),incoming=this.incoming;
            if(!incoming||bytes[0]!==83||bytes[1]!==83||bytes[2]!==78||bytes[3]!==1||view.getUint32(4)!==incoming.id||view.getUint32(8)!==incoming.received||incoming.received+bytes.length-12>SIZE)throw Error('直连评估数据不匹配');
            for(let i=12;i<bytes.length;i++)if(bytes[i]!==((incoming.received+i-12)%251))throw Error('直连评估数据校验失败');
            incoming.received+=bytes.length-12;
            if(incoming.received===SIZE){
                this.incoming=null;
                if(this.initiator)this.accept('binary',incoming.id);
                else{this.phase=null;this.plan++;this.control({t:'up_done',id:incoming.id})}
            }
        }
        finish(report){if(this.closed)return;this.cleanup();this.resolve(report)}
        fail(reason){if(this.closed)return;this.cleanup();this.reject(Error(reason))}
        cleanup(){
            this.closed=true;clearTimeout(this.timer);this.signal?.removeEventListener('abort',this.abort);
            if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('直连评估已结束'));this.pending=null}
            this.endpoint.limiter.release(this);if(this.endpoint.session===this)this.endpoint.session=null;
            this.channel.onmessage=this.channel.onclose=this.channel.onerror=this.channel.onopen=null;this.channel.close();
        }
    }
    class Endpoint{
        constructor({valid,available=()=>true,create,now=()=>performance.now(),limiter=pageGate}){Object.assign(this,{valid,available,create,now,limiter});this.closed=false}
        accept(channel){
            if(channel.label!==LABEL)return false;
            if(this.closed||this.session||!this.valid()||!this.available()||!channel.ordered||channel.maxRetransmits!==null||channel.maxPacketLifeTime!==null){channel.close();return true}
            this.session=new Session(this,channel,false);return true;
        }
        assess(options={}){
            if(options.signal?.aborted)return Promise.reject(Error('评估已取消'));
            if(this.closed||!this.valid())return Promise.reject(Error('当前没有可用直连，请重新评估'));
            if(!this.available())return Promise.reject(Error('串口事务、补传或定时发送正在进行，请空闲后评估'));
            if(this.session||!this.limiter.claim(this))return Promise.reject(Error('评估忙或刚完成评估，请 30 秒后重试'));
            let channel;
            try{channel=this.create();this.limiter.release(this);const session=new Session(this,channel,true,options);this.session=session;this.limiter.active=session;return session.result}
            catch(error){this.limiter.release(this);channel?.close();return Promise.reject(error)}
        }
        close(){this.closed=true;this.session?.fail('连接路径已变化，请重新评估')}
    }
    return {Endpoint,LABEL,SIZE,CHUNK,DEADLINE,gate,packet};
});
