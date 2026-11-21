const {test}=require('node:test'),assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {PeriodicSender}=require('../static/js/serial-tools.js');

test('Periodic sends reject invalid intervals and never overlap or catch up after a slow write',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const sender=new PeriodicSender();
    for(const interval of [null,true,'',0,19,86400001,1.5,'20ms'])assert.throws(()=>sender.start(interval,()=>true,()=>true));
    let release,calls=0;
    sender.start('100',()=>{calls++;return new Promise(resolve=>{release=resolve})},()=>true);
    assert.equal(calls,1);t.mock.timers.tick(10000);assert.equal(calls,1);
    release(true);await turn();t.mock.timers.tick(99);assert.equal(calls,1);
    t.mock.timers.tick(1);assert.equal(calls,2);
    sender.stop();release(true);await turn();t.mock.timers.tick(10000);assert.equal(calls,2);
});

test('Stopping invalidates a queued periodic write and permission loss never resumes by itself',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let valid=true,current,release,calls=0;
    const sender=new PeriodicSender();
    sender.start(20,isCurrent=>{calls++;current=isCurrent;return new Promise(resolve=>{release=resolve})},()=>valid);
    assert(current());sender.stop();assert.equal(current(),false);
    assert.throws(()=>sender.start(20,()=>true,()=>true));release(false);await turn();
    sender.start(20,()=>{calls++;return true},()=>valid);await turn();
    valid=false;t.mock.timers.tick(20);await turn();assert.equal(sender.running,false);
    valid=true;t.mock.timers.tick(10000);await turn();assert.equal(calls,2);
});

test('A failed periodic submission stops and a stale timer cannot start a newer session',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let calls=0,old;const callbacks=[];
    const sender=new PeriodicSender({setTimer:callback=>{callbacks.push(callback);return callback},clearTimer:()=>{}});
    sender.start(20,()=>{calls++;return true},()=>true);await turn();old=callbacks[0];sender.stop();
    sender.start(20,()=>{calls++;return false},()=>true);await turn();assert.equal(sender.running,false);
    old();await turn();assert.equal(calls,2);
    sender.start(20,()=>Promise.reject(Error('write failed')),()=>true);await turn();assert.equal(sender.running,false);
});

test('Injected browser timers receive the global receiver when scheduled and cancelled',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});let calls=0;
    const sender=new PeriodicSender({setTimer:function(callback,ms){assert.equal(this,globalThis);return setTimeout(callback,ms)},clearTimer:function(timer){assert.equal(this,globalThis);clearTimeout(timer)}});
    sender.start(20,()=>{calls++;return true},()=>true);await turn();
    t.mock.timers.tick(20);await turn();assert.equal(calls,2);sender.stop();t.mock.timers.tick(20);assert.equal(calls,2);
});
