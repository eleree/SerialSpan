(function (root,factory) {
    if(typeof module==='object'&&module.exports)module.exports=factory();
    else root.SerialTools=factory();
})(globalThis,function(){
    'use strict';
    const MIN_INTERVAL=20,MAX_INTERVAL=86400000;
    class PeriodicSender {
        constructor({setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=timer=>clearTimeout(timer),onChange=()=>{}}={}) {
            // Browser timer functions require their Window receiver, unlike
            // Node's timers. Keep injected clocks callable in both runtimes.
            Object.assign(this,{setTimer:(fn,ms)=>setTimer.call(globalThis,fn,ms),clearTimer:timer=>clearTimer.call(globalThis,timer),onChange});
            this.running=false;this.busy=false;this.generation=0;
        }
        notify(reason){try{this.onChange(this.running,reason)}catch{}}
        allowed(){try{return !!this.valid()}catch{return false}}
        start(interval,send,valid){
            const value=typeof interval==='string'&&/^[1-9]\d*$/.test(interval)?Number(interval):interval;
            if(!Number.isSafeInteger(value)||value<MIN_INTERVAL||value>MAX_INTERVAL)throw Error('定时间隔须为 20–86400000 ms 的整数');
            if(this.running||this.busy)throw Error('上一次定时发送尚未结束');
            Object.assign(this,{interval:value,send,valid});
            if(!this.allowed())throw Error('当前不能发送，请检查串口或发送权限');
            this.running=true;const generation=++this.generation;this.notify('started');this.tick(generation);
        }
        async tick(generation){
            this.timer=null;
            if(!this.running||generation!==this.generation)return;
            if(!this.allowed()){this.stop('unavailable');return}
            this.busy=true;let sent=false;
            try{sent=await this.send(()=>this.running&&generation===this.generation&&this.allowed())===true}catch{}
            this.busy=false;
            if(!this.running||generation!==this.generation){this.notify('settled');return}
            if(!sent||!this.allowed()){this.stop(sent?'unavailable':'failed');return}
            this.timer=this.setTimer(()=>this.tick(generation),this.interval);
        }
        stop(reason='manual'){
            if(!this.running)return;
            this.running=false;this.generation++;this.clearTimer(this.timer);this.timer=null;this.notify(reason);
        }
    }
    return {PeriodicSender,MIN_INTERVAL,MAX_INTERVAL};
});
