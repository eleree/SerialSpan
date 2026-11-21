// Optional network-only estimate, shared by Local and Remote. No automatic
// sampling, device commands, persistent results, or baud-rate changes.
(function (root) {
    const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
    const PROBES = 6;
    const SAMPLE_SIZES = [64 * 1024, 256 * 1024];
    const PROBE_TIMEOUT_MS = 5000;
    const DOWNLOAD_TIMEOUT_MS = 10000;

    function estimate({ bytesPerSecond, failed = 0, probes = PROBES, transport = 'server' }) {
        if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || probes <= 0 || failed < 0 || failed >= probes / 2) {
            return { baud: null, capacityBaud: null, reason: '链路不稳定或有效样本不足' };
        }
        // Conservative 8N1 model: 10 serial bits/byte, 64-byte batches,
        // Base64 + actual v3 RX JSON envelope + WS/TLS record overhead, 50% margin.
        const chunkBytes = 64;
        const jsonOverhead = JSON.stringify({ type: 'data', localId: 'ABCDE', portId: '1234:5678', data: '' }).length;
        const frameBytes = transport === 'p2p' ? chunkBytes + 16 : 4 * Math.ceil(chunkBytes / 3) + jsonOverhead + 4 + 22;
        const capacityBaud = bytesPerSecond * chunkBytes / frameBytes * 10 * 0.5;
        const baud = BAUD_RATES.filter(value => value <= capacityBaud).at(-1) || 0;
        return { baud, capacityBaud, reason: failed ? '部分探测失败，结果仅供临时参考' : transport === 'p2p' ? '按 P2P 二进制、8N1、64 B 分块及 50% 余量估算；控制和补传链路另计' : '按 8N1、64 B 分块及 50% 余量估算' };
    }

    function percentile(values, fraction) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    }

    async function sample(fetcher, bytes, timeoutMs, signal, now) {
        const controller = new AbortController();
        let timedOut = false, received = 0, reader, failure = null;
        const invalidResponse = message => {
            failure = { kind: 'response', message };
            throw new Error(message);
        };
        const cancel = () => controller.abort();
        if (signal.aborted) throw new Error('cancelled');
        signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        const started = now();
        try {
            const response = await fetcher('/api/network-sample?bytes=' + bytes, {
                cache: 'no-store', credentials: 'same-origin', signal: controller.signal
            });
            if (!response.ok) {
                failure = { kind: 'http', status: response.status };
                throw new Error('HTTP ' + response.status);
            }
            const encoding = response.headers.get('Content-Encoding');
            if (bytes && encoding && encoding !== 'identity') invalidResponse('采样响应被压缩，无法可靠评估');
            if (bytes) {
                if (Number(response.headers.get('X-Network-Sample-Bytes')) !== bytes) invalidResponse('采样响应不匹配');
                if (!response.body) invalidResponse('采样响应缺少数据');
                reader = response.body.getReader();
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    received += value.length;
                    if (received > bytes) invalidResponse('采样响应超出上限');
                }
                if (received !== bytes) invalidResponse('采样响应不完整');
            }
            return { ok: true, received, elapsedMs: Math.max(1, now() - started), timedOut: false, failure: null };
        } catch (error) {
            if (signal.aborted) throw new Error('cancelled');
            // Keep a timed-out streaming sample only if measurable data arrived.
            return {
                ok: false, received: timedOut ? received : 0, elapsedMs: Math.max(1, now() - started), timedOut,
                failure: timedOut ? { kind: 'timeout', timeoutMs } : failure || { kind: 'network' }
            };
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            if (reader) { try { await reader.cancel(); } catch (_) { /* Aborted stream. */ } }
        }
    }

    function describeFailures(samples) {
        const counts = new Map();
        for (const { failure } of samples) {
            if (!failure) continue;
            let label;
            if (failure.kind === 'timeout') label = '等待响应超时（' + failure.timeoutMs / 1000 + ' 秒上限）';
            else if (failure.kind === 'http') {
                label = 'HTTP ' + failure.status;
                if (failure.status === 401) label += '，请刷新页面并重新登录';
                else if (failure.status === 403) label += '，请求被拒绝';
                else if (failure.status === 404) label += '，采样接口不存在，请检查服务版本';
                else if (failure.status === 429) label += '，公共服务额度或请求频率达到上限，请稍后重试';
            } else if (failure.kind === 'response') label = failure.message;
            else label = '网络连接失败（浏览器未提供 HTTP 状态）';
            counts.set(label, (counts.get(label) || 0) + 1);
        }
        return [...counts].map(([label, count]) => label + ' ×' + count).join('；');
    }

    async function assess({ fetcher = root.fetch.bind(root), signal, now = () => root.performance.now(), progress = () => {} }) {
        const probes = [];
        for (let i = 0; i < PROBES; i++) {
            progress('轻量探测 ' + (i + 1) + '/' + PROBES);
            probes.push(await sample(fetcher, 0, PROBE_TIMEOUT_MS, signal, now));
        }
        const downloads = [];
        for (const bytes of SAMPLE_SIZES) {
            progress('正在评估有效下载带宽');
            downloads.push(await sample(fetcher, bytes, DOWNLOAD_TIMEOUT_MS, signal, now));
        }
        const rates = downloads.filter(item => item.received >= 16384).map(item => item.received / (item.elapsedMs / 1000));
        const bytesPerSecond = rates.length ? Math.min(...rates) : null;
        const failed = probes.filter(item => !item.ok).length;
        return {
            ...estimate({ bytesPerSecond, failed }),
            bytesPerSecond, failed, probes: PROBES,
            timeouts: probes.filter(item => item.timedOut).length,
            medianRttMs: percentile(probes.filter(item => item.ok).map(item => item.elapsedMs), 0.5),
            p95RttMs: percentile(probes.filter(item => item.ok).map(item => item.elapsedMs), 0.95),
            sampleBytes: downloads.reduce((total, item) => total + item.received, 0),
            failureDetails: [
                probes.some(item => !item.ok) ? '往返探测：' + describeFailures(probes) : '',
                downloads.some(item => !item.ok) ? '下载样本：' + describeFailures(downloads) : ''
            ].filter(Boolean).join('；')
        };
    }

    async function assessCurrent({target,signal,progress=()=>{},fetcher,now}) {
        const valid=()=>!target?.valid||target.valid();
        if(!valid())throw Error('连接路径已变化，请重新评估');
        if(target?.mode==='p2p'){
            const direct=await target.assess({signal,progress});
            if(!valid()||signal.aborted)throw Error('连接路径已变化，请重新评估');
            const bytesPerSecond=Math.min(direct.uploadBytesPerSecond,direct.downloadBytesPerSecond);
            return {...direct,...estimate({bytesPerSecond,failed:direct.failed,probes:direct.probes,transport:'p2p'}),bytesPerSecond,
                medianRttMs:percentile(direct.rtts,0.5),p95RttMs:percentile(direct.rtts,0.95),source:'p2p',targetLabel:target.label};
        }
        const report=await assess({signal,progress,...(fetcher?{fetcher}:{}),...(now?{now}:{})});
        if(!valid()||signal.aborted)throw Error('连接路径已变化，请重新评估');
        return {...report,source:'server',targetLabel:target?.label||'本页'};
    }

    let targetsChanged=()=>{};
    function initialize() {
        const button = root.document.getElementById('networkEvaluateBtn');
        if (!button) return;
        const summary = root.document.getElementById('networkSummary');
        const metrics = root.document.getElementById('networkMetrics');
        const targetControl=root.document.getElementById('networkTarget');
        const targetLabel=root.document.getElementById('networkTargetLabel');
        let active = null,lastTarget=null,selected='',userSelected=false;
        const targets=()=>root.getNetworkAssessmentTargets?.()||[{id:'server',mode:'server',label:'本页',valid:()=>true}];
        const refreshTargets=()=>{
            const candidates=targets();
            if(active)selected=active.target?.id||selected;
            else if(!userSelected)selected=(candidates.find(item=>item.mode==='p2p')||candidates.find(item=>item.id===selected)||candidates[0])?.id||'';
            else if(!candidates.some(item=>item.id===selected)){userSelected=false;selected=candidates[0]?.id||''}
            if(targetControl&&targetLabel){
                targetLabel.classList.toggle('hidden',candidates.length<2);targetControl.replaceChildren();
                for(const item of candidates){const option=root.document.createElement('option');option.value=item.id;option.textContent=item.label+' · '+(item.mode==='p2p'?'直连':'服务器');targetControl.appendChild(option)}
                targetControl.value=selected;targetControl.disabled=!!active;
            }
            if(active?.target?.valid&&!active.target.valid())active.controller.abort('path_changed');
            if(lastTarget&&(lastTarget.id!==selected||lastTarget.valid&&!lastTarget.valid())){lastTarget=null;metrics.textContent='';summary.textContent='连接路径或对象已变化，请重新评估'}
            return candidates.find(item=>item.id===selected)||candidates[0];
        };
        targetsChanged=refreshTargets;refreshTargets();
        targetControl?.addEventListener('change',()=>{selected=targetControl.value;userSelected=true;if(active)active.controller.abort('path_changed');refreshTargets()});
        button.addEventListener('click', async () => {
            if (active) { active.controller.abort('cancelled'); return; }
            const target=refreshTargets();
            lastTarget=null;
            active = {controller:new AbortController(),target};
            if(targetControl)targetControl.disabled=true;
            button.textContent = '取消'; metrics.textContent = '';
            try {
                const report = await assessCurrent({target,signal:active.controller.signal,progress:text=>{summary.textContent=(target?.mode==='p2p'?'直连评估：':'服务器评估：')+text}});
                lastTarget=target;
                const source=report.source==='p2p'?'P2P 直连 · '+report.targetLabel:'服务器';
                summary.textContent = '共享网络参考（'+source+'）：'+(report.baud === null ? '暂无法给出参考波特率' : report.baud === 0 ? '低于 9600' : '≤ ' + report.baud);
                const bandwidth = report.bytesPerSecond ? (report.bytesPerSecond * 8 / 1e6).toFixed(2) + ' Mbps' : '无有效样本';
                const rtt = report.medianRttMs === null ? '无响应' : Math.round(report.medianRttMs) + ' ms';
                const speed=report.source==='p2p'?'有效接收 '+(report.downloadBytesPerSecond*8/1e6).toFixed(2)+' Mbps · 有效发送 '+(report.uploadBytesPerSecond*8/1e6).toFixed(2)+' Mbps':'有效下载 '+bandwidth;
                metrics.textContent = speed + ' · 往返中位 ' + rtt + ' · 探测超时率 ' + (report.timeouts / report.probes * 100).toFixed(0) + '%（' + report.timeouts + '/' + report.probes + '），失败共 ' + report.failed + '/' + report.probes + '。' + report.reason + (report.failureDetails ? '。失败详情：' + report.failureDetails : '') + '。更新于 ' + new Date().toLocaleTimeString();
            } catch (error) {
                summary.textContent = active.controller.signal.reason==='path_changed'||active.target?.valid&&!active.target.valid() ? '连接路径已变化，请重新评估' : active.controller.signal.aborted ? '评估已取消' : error.message||'评估失败，请稍后重试';
            } finally { active = null; button.textContent = '评估网络';refreshTargets(); }
        });
    }

    const api = { estimate, percentile, sample, assess, assessCurrent, initialize, notifyTargets:()=>targetsChanged() };
    root.NetworkReference=api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root.document) root.addEventListener('DOMContentLoaded', initialize);
})(globalThis);
