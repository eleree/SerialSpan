const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { estimate, percentile, sample, assess, assessCurrent } = require('../static/js/network-reference.js');

test('Network reference accounts for UART, Base64/framing and 50 percent headroom', () => {
    // 64-byte data -> 88 Base64 + 64 JSON + 4 WS + 22 TLS bytes.
    // 115200 / 10 raw B/s requires 64080 measured B/s at 50% utilization.
    assert.equal(estimate({ bytesPerSecond: 64080 }).baud, 115200);
    assert.equal(estimate({ bytesPerSecond: 64079 }).baud, 57600);
    assert.equal(estimate({ bytesPerSecond: 100000 }).baud, 115200);
    assert.equal(estimate({ bytesPerSecond: 5000 }).baud, 0);
    assert.equal(estimate({ bytesPerSecond: 10000000 }).baud, 921600);
});

test('Unstable or missing samples do not produce a reassuring baud reference', () => {
    for (const rate of [null, NaN, Infinity, -1, 0]) assert.equal(estimate({ bytesPerSecond: rate }).baud, null);
    assert.equal(estimate({ bytesPerSecond: 1000000, failed: 3 }).baud, null);
    assert.equal(estimate({ bytesPerSecond: 1000000, failed: 6 }).baud, null);
    assert.match(estimate({ bytesPerSecond: 100000, failed: 1 }).reason, /部分探测失败/);
    assert.equal(percentile([], .95), null);
    assert.equal(percentile([20, 1, 10], .5), 10);
});

function response(bytes, encoding = 'identity') {
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Encoding': encoding, 'X-Network-Sample-Bytes': String(bytes) } });
}

test('Bandwidth samples reject compressed and mismatched bodies', async () => {
    const signal = new AbortController().signal;
    let clock = 0;
    const compressed = await sample(async () => response(65536, 'gzip'), 65536, 1000, signal, () => ++clock);
    const mismatch = await sample(async () => response(64), 65536, 1000, signal, () => ++clock);
    assert.equal(compressed.ok, false); assert.equal(compressed.received, 0);
    assert.equal(mismatch.ok, false); assert.equal(mismatch.received, 0);
});

test('Failed samples distinguish HTTP errors from failures without an HTTP response', async () => {
    const signal = new AbortController().signal;
    const unauthorized = await sample(async () => new Response(null, { status: 401 }), 0, 5000, signal, () => 0);
    const unavailable = await sample(async () => new Response(null, { status: 503 }), 0, 5000, signal, () => 0);
    const disconnected = await sample(async () => { throw new TypeError('private browser error'); }, 0, 5000, signal, () => 0);
    assert.deepEqual(unauthorized.failure, { kind: 'http', status: 401 });
    assert.deepEqual(unavailable.failure, { kind: 'http', status: 503 });
    assert.deepEqual(disconnected.failure, { kind: 'network' });
    assert.equal(disconnected.timedOut, false);
    assert.equal(disconnected.received, 0);
});

test('A stalled request reports its actual timeout budget', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 0;
    const pending = sample((url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }), 0, 5000, new AbortController().signal, () => clock);
    clock = 5000;
    t.mock.timers.tick(5000);
    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.elapsedMs, 5000);
    assert.deepEqual(result.failure, { kind: 'timeout', timeoutMs: 5000 });
});

test('High-latency probes and slow downloads have time to finish within their bounds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 0;
    const fetcher = (url, { signal }) => new Promise((resolve, reject) => {
        const bytes = Number(new URL(url, 'https://test').searchParams.get('bytes'));
        const timer = setTimeout(() => resolve(bytes ? response(bytes) : new Response(null, { status: 204 })), bytes ? 6000 : 2000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    const pending = assess({ fetcher, signal: new AbortController().signal, now: () => clock });
    for (let i = 0; i < 8; i++) {
        const elapsed = i < 6 ? 2000 : 6000;
        clock += elapsed;
        t.mock.timers.tick(elapsed);
        await new Promise(setImmediate);
    }
    const report = await pending;
    assert.equal(report.failed, 0);
    assert.equal(report.medianRttMs, 2000);
    assert.equal(report.sampleBytes, 320 * 1024);
    assert.equal(report.baud, 19200);
});

test('Five timeouts and one network failure remain distinguishable and never yield a baud', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 0, calls = 0;
    const fetcher = async (url, { signal }) => {
        if (++calls === 1) throw new TypeError('private browser error');
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
    };
    const pending = assess({ fetcher, signal: new AbortController().signal, now: () => clock });
    await new Promise(setImmediate);
    for (const elapsed of [5000, 5000, 5000, 5000, 5000, 10000, 10000]) {
        clock += elapsed;
        t.mock.timers.tick(elapsed);
        await new Promise(setImmediate);
    }
    const report = await pending;
    assert.equal(calls, 8);
    assert.equal(report.failed, 6);
    assert.equal(report.timeouts, 5);
    assert.equal(report.medianRttMs, null);
    assert.equal(report.bytesPerSecond, null);
    assert.equal(report.baud, null);
    assert.match(report.failureDetails, /网络连接失败.*×1/);
    assert.match(report.failureDetails, /5 秒上限.*×5/);
    assert.match(report.failureDetails, /下载样本.*10 秒上限.*×2/);
    assert.doesNotMatch(report.failureDetails, /private browser error/);
});

test('Assessment reports authentication and response problems without presenting them as packet loss', async () => {
    const report = await assess({
        fetcher: async () => new Response(null, { status: 401 }),
        signal: new AbortController().signal
    });
    assert.equal(report.baud, null);
    assert.equal(report.failed, 6);
    assert.equal(report.timeouts, 0);
    assert.match(report.failureDetails, /往返探测.*HTTP 401/);
    assert.match(report.failureDetails, /下载样本.*HTTP 401/);
    assert.match(report.failureDetails, /重新登录/);
    assert.doesNotMatch(report.failureDetails, /丢包/);
});

test('Rejected download contents have a response error and contribute no measured bytes', async () => {
    const signal = new AbortController().signal;
    const compressed = await sample(async () => response(65536, 'gzip'), 65536, 1000, signal, () => 1);
    const truncated = await sample(async () => new Response(new Uint8Array(32), {
        headers: { 'X-Network-Sample-Bytes': '65536' }
    }), 65536, 1000, signal, () => 1);
    for (const result of [compressed, truncated]) {
        assert.equal(result.ok, false);
        assert.equal(result.failure.kind, 'response');
        assert.equal(result.received, 0);
    }
});

test('Assessment uses bounded samples and the slower measurement', async () => {
    let clock = 0;
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push(url); assert.equal(options.cache, 'no-store');
        const bytes = Number(new URL(url, 'https://test').searchParams.get('bytes'));
        clock += bytes === 0 ? 50 : bytes === 65536 ? 1000 : 2000;
        return bytes ? response(bytes) : new Response(null, { status: 204 });
    };
    const report = await assess({ fetcher, signal: new AbortController().signal, now: () => clock });
    assert.equal(calls.length, 8);
    assert.equal(report.sampleBytes, 320 * 1024);
    assert.equal(report.bytesPerSecond, 65536);
    assert.equal(report.baud, 115200);
    assert.equal(report.medianRttMs, 50);
    assert.equal(report.timeouts, 0);
});

test('Cancellation does not continue network requests', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await assert.rejects(assess({ fetcher: async () => { calls++; }, signal: controller.signal }), /cancelled/);
    assert.equal(calls, 0);
});

test('Opening a page never starts evaluation and does not modify the configured baud rate', async () => {
    let handler, calls = 0;
    const initializers = [];
    const fields = new Map();
    const button = { addEventListener(type, callback) { handler = callback; }, click() { return handler(); } };
    fields.set('networkEvaluateBtn', button);
    fields.set('baudRate', { value: '115200' });
    const sandbox = {
        document: { getElementById(id) { if (['networkTarget','networkTargetLabel'].includes(id)) return null; if (!fields.has(id)) fields.set(id, { textContent: '' }); return fields.get(id); } },
        addEventListener(type, callback) { initializers.push(callback); },
        fetch: async url => { calls++; const n=Number(new URL(url,'https://test').searchParams.get('bytes'));return n?response(n):new Response(null,{status:204}); },
        AbortController, setTimeout, clearTimeout, performance, console
    };
    vm.runInNewContext(fs.readFileSync('static/js/network-reference.js','utf8'), sandbox);
    initializers.forEach(callback => callback());
    assert.equal(calls, 0);
    assert.equal(typeof handler, 'function');
    assert.equal(fields.get('baudRate').value, '115200');
    await button.click();
    assert.equal(calls, 8);
    assert.equal(fields.get('baudRate').value, '115200');
    assert.match(fields.get('networkSummary').textContent, /共享网络参考/);
});

test('Current-route assessment uses P2P exclusively and models binary serial framing',async()=>{
    let http=0,direct=0;const controller=new AbortController();
    const target={mode:'p2p',label:'Local ABC23',valid:()=>true,assess:async()=>{direct++;return {uploadBytesPerSecond:200000,downloadBytesPerSecond:100000,probes:6,failed:0,timeouts:0,rtts:[10,12,11,9,13,10],sampleBytes:131072}}};
    const report=await assessCurrent({target,signal:controller.signal,fetcher:async()=>{http++;throw Error('HTTP must not run')}});
    assert.equal(direct,1);assert.equal(http,0);assert.equal(report.source,'p2p');assert.equal(report.bytesPerSecond,100000);assert.equal(report.medianRttMs,10);
    assert.equal(report.baud,230400);assert.match(report.reason,/P2P/);
    assert(estimate({bytesPerSecond:100000,transport:'p2p'}).capacityBaud>estimate({bytesPerSecond:100000}).capacityBaud);
});

test('A relay route uses HTTP only and a changed direct scope cannot publish results',async()=>{
    let direct=0,valid=true;
    const report=await assessCurrent({target:{mode:'server',label:'Local ABC23',valid:()=>true,assess:()=>{direct++}},
        signal:new AbortController().signal,fetcher:async url=>{const n=Number(new URL(url,'https://test').searchParams.get('bytes'));return n?response(n):new Response(null,{status:204})}});
    assert.equal(report.source,'server');assert.equal(direct,0);
    const target={mode:'p2p',valid:()=>valid,assess:async()=>{valid=false;return {}}};
    await assert.rejects(assessCurrent({target,signal:new AbortController().signal}),/路径/);
});

test('The network widget aborts on path change and invalidates old path results',async()=>{
    const {Element}=require('./browser-harness.cjs');const fields=new Map(),callbacks=[];let direct=true,release,fetches=0;
    const button=new Element();fields.set('networkEvaluateBtn',button);
    const report={uploadBytesPerSecond:100000,downloadBytesPerSecond:100000,probes:6,failed:0,timeouts:0,rtts:[5,6],sampleBytes:131072};
    const sandbox={document:{getElementById(id){if(['networkTarget','networkTargetLabel'].includes(id))return null;if(!fields.has(id))fields.set(id,new Element());return fields.get(id)}},
        addEventListener(type,fn){callbacks.push(fn)},getNetworkAssessmentTargets(){const mode=direct;return [{id:'one',label:'Local ABC23',mode:mode?'p2p':'server',valid:()=>direct===mode,
            assess:({signal})=>new Promise((resolve,reject)=>{release=()=>resolve(report);signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})})}]},
        fetch:()=>{fetches++;throw Error('unexpected HTTP')},AbortController,setTimeout,clearTimeout,performance,console};
    vm.runInNewContext(fs.readFileSync('static/js/network-reference.js','utf8'),sandbox);callbacks.forEach(fn=>fn());
    const first=button.listeners.click();direct=false;sandbox.NetworkReference.notifyTargets();await first;
    assert.match(fields.get('networkSummary').textContent,/路径已变化/);assert.equal(fetches,0);
    direct=true;sandbox.NetworkReference.notifyTargets();const second=button.listeners.click();release();await second;
    assert.match(fields.get('networkSummary').textContent,/P2P/);
    direct=false;sandbox.NetworkReference.notifyTargets();assert.match(fields.get('networkSummary').textContent,/重新评估/);assert.equal(fields.get('networkMetrics').textContent,'');
});

test('Selecting a different approved peer immediately clears the previous reference',async()=>{
    const {Element}=require('./browser-harness.cjs'),fields=new Map(),callbacks=[];
    const field=id=>{if(!fields.has(id))fields.set(id,new Element());return fields.get(id)};
    const report={uploadBytesPerSecond:100000,downloadBytesPerSecond:100000,probes:6,failed:0,timeouts:0,rtts:[5],sampleBytes:131072};
    const sandbox={document:{getElementById:field,createElement:()=>new Element()},addEventListener(type,fn){callbacks.push(fn)},
        getNetworkAssessmentTargets:()=>['first','second'].map(id=>({id,label:id,mode:'p2p',valid:()=>true,assess:async()=>report})),
        AbortController,setTimeout,clearTimeout,performance,console};
    vm.runInNewContext(fs.readFileSync('static/js/network-reference.js','utf8'),sandbox);callbacks.forEach(fn=>fn());
    await field('networkEvaluateBtn').listeners.click();assert.match(field('networkSummary').textContent,/first/);
    field('networkTarget').value='second';field('networkTarget').listeners.change();
    assert.match(field('networkSummary').textContent,/重新评估/);assert.equal(field('networkMetrics').textContent,'');
    assert.equal(field('networkTarget').value,'second');
});
