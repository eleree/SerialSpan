/* Synthetic P2P experiment. No Web Serial calls or physical-device operations. */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const PORT = 'p2p-probe', MAX_BYTES = 4 * 1024 * 1024;
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
    const state = { ws: null, role: 'local', localId: '', remoteId: '', epoch: 0, paused: false, registered: false,
        pending: new Map(), peers: new Map(), events: [], results: [], denied: 0, signalBytes: 0 };
    const randomID = () => crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    const sha = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    const current = peer => state.ws?.readyState === WebSocket.OPEN && state.peers.get(peer.id) === peer;
    function event(text) { state.events.push(new Date().toLocaleTimeString() + '  ' + text); state.events = state.events.slice(-200); $('log').textContent = state.events.join('\n'); }
    function socketSend(message) {
        if (state.ws?.readyState !== WebSocket.OPEN) throw Error('共享服务连接已结束');
        state.ws.send(JSON.stringify(message));
    }
    function signal(peer, kind, payload) {
        if (!current(peer)) throw Error('实验授权已结束');
        const message = { type: 'p2p_probe_signal', localId: state.localId, remoteId: peer.id, portId: PORT,
            grantId: peer.grant, probeKind: kind, probePayload: payload };
        state.signalBytes += encoder.encode(JSON.stringify(message)).length;
        socketSend(message);
    }
    function cancel(peer, reason) {
        if (peer.receiving) { clearTimeout(peer.receiving.timer); peer.receiving = null; }
        if (peer.sending) {
            const operation = peer.sending; peer.sending = null; clearTimeout(operation.timer); operation.reject(Error(reason));
        }
    }
    function remove(peer, reason) {
        state.peers.delete(peer.id); cancel(peer, reason); peer.link?.close(); render();
    }
    function clear(reason) {
        for (const peer of [...state.peers.values()]) remove(peer, reason);
        state.pending.clear(); state.registered = false; state.localId = ''; state.remoteId = ''; state.epoch = 0;
        render();
    }
    function disconnect() {
        const socket = state.ws; state.ws = null;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'disconnect' }));
        socket?.close(); clear('实验连接已结束'); $('status').textContent = '尚未连接';
    }
    function addPeer(id, grant, access, initiator) {
        const previous = state.peers.get(id); if (previous) remove(previous, '授权已替换');
        if (state.peers.size >= 16) throw Error('实验端数量上限');
        const peer = { id, grant, access, sending: null, receiving: null };
        state.peers.set(id, peer);
        peer.link = new ProbeLink.Link({ initiator,
            valid: () => current(peer),
            sendSignal: (kind, payload) => signal(peer, kind, payload),
            relay: async bytes => {
                const deadline = Date.now() + 10000;
                while (current(peer) && state.ws.bufferedAmount + bytes.length * 1.4 > 65536) {
                    if (Date.now() > deadline) throw Error('中继积压超时');
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                if (!current(peer)) throw Error('实验授权已结束');
                socketSend({ type: 'p2p_probe_frame', localId: state.localId, remoteId: peer.id, portId: PORT,
                    grantId: peer.grant, writeEpoch: state.epoch, data: SerialData.toBase64(bytes) });
            },
            onFrame: bytes => { try { receive(peer, bytes); } catch (error) { cancel(peer, error.message); event('拒绝实验帧：' + error.message); } },
            onState: mode => { if (!current(peer)) return; if (mode === 'websocket') cancel(peer, '直连已结束，当前测试中止；可手动开始新的中继测试'); event(peer.id + ' 传输：' + mode); render(); }
        });
        render(); return peer;
    }
    function connect() {
        if (state.ws) return;
        state.role = $('role').value;
        state.localId = state.role === 'local' ? Array.from(crypto.getRandomValues(new Uint8Array(5)), value => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[value & 31]).join('') : $('code').value.trim().toUpperCase();
        if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(state.localId)) throw Error('请输入有效共享码');
        const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/' + state.role);
        state.ws = socket;
        $('status').textContent = '正在连接'; render();
        socket.onopen = () => {
            if (state.ws !== socket) return;
            socketSend(state.role === 'local' ? { type: 'register', version: 3, localId: state.localId,
                p2pProbeProtocol: 1, ports: [{ portId: PORT, name: 'P2P 合成数据（无物理串口）' }] } :
                { type: 'connect', version: 3, localId: state.localId, access: $('access').value, p2pProbeProtocol: 1 });
        };
        socket.onmessage = message => {
            if (state.ws !== socket) return;
            try { handle(JSON.parse(message.data)); } catch (error) { event(error.message); }
        };
        socket.onclose = () => { if (state.ws !== socket) return; state.ws = null; clear('信令连接已断开'); $('status').textContent = '服务连接已断开，实验授权已清除'; };
        socket.onerror = () => { if (state.ws === socket) event('共享服务连接失败'); };
    }
    function handle(message) {
        switch (message.type) {
            case 'register': state.registered = true; state.epoch = message.writeEpoch; state.paused = message.paused; $('status').textContent = '实验共享已开启'; break;
            case 'connection_request': state.pending.set(message.requestId, message); event('待批准 ' + message.remoteId + '：' + message.access); break;
            case 'request_cancelled': state.pending.delete(message.requestId); break;
            case 'connect_pending': state.remoteId = message.remoteId; $('status').textContent = '等待 Local 批准：' + message.remoteId; break;
            case 'remote_connected':
                for (const [id, request] of state.pending) if (request.remoteId === message.remoteId) state.pending.delete(id);
                if (message.p2pProbeProtocol !== 1) throw Error('对端不是合成数据实验页');
                addPeer(message.remoteId, message.grantId, message.access, false); break;
            case 'connect':
                if (message.p2pProbeProtocol !== 1 || !message.grantId || message.localId !== state.localId) throw Error('无效实验授权');
                state.epoch = message.writeEpoch; state.paused = message.paused; state.remoteId = message.remoteId;
                addPeer(message.remoteId, message.grantId, message.access, true); $('status').textContent = '已批准，正在协商数据通道'; break;
            case 'p2p_probe_signal': {
                const peer = state.peers.get(message.remoteId);
                if (!peer || message.grantId !== peer.grant || message.localId !== state.localId || message.portId !== PORT) return;
                if (message.probeKind === 'receipt') receiveReceipt(peer, JSON.parse(message.probePayload));
                else peer.link.signal(message.probeKind, message.probePayload);
                break;
            }
            case 'p2p_probe_frame': {
                const peer = state.peers.get(message.remoteId);
                if (!peer || message.grantId !== peer.grant || message.localId !== state.localId || message.portId !== PORT) return;
                peer.link.receiveRelay(SerialData.fromBase64(message.data)); break;
            }
            case 'remote_disconnected': { const peer = state.peers.get(message.remoteId); if (peer) remove(peer, 'Local 撤销或 Remote 离线'); break; }
            case 'local_disconnected': case 'permission_revoked': case 'disconnect': disconnect(); event('授权已结束'); break;
            case 'write_state':
                if (message.localId !== state.localId || !Number.isSafeInteger(message.writeEpoch) || message.writeEpoch < state.epoch) return;
                state.epoch = message.writeEpoch; state.paused = message.paused;
                for (const peer of state.peers.values()) cancel(peer, '写入代次改变，当前测试中止');
                break;
            case 'error': event(message.code + '：' + message.error); $('status').textContent = message.code; break;
        }
        render();
    }
    function selected() { return state.peers.get($('target').value); }
    function render() {
        const connected = !!state.ws;
        $('connect').disabled = connected; $('disconnect').disabled = !connected; $('role').disabled = connected;
        $('code').disabled = connected; $('access').disabled = connected;
        $('idLabel').classList.toggle('hidden', $('role').value === 'local'); $('accessLabel').classList.toggle('hidden', $('role').value === 'local');
        $('shareCode').textContent = state.localId || '—';
        const pending = $('pending'); pending.replaceChildren();
        for (const [requestId, request] of state.pending) {
            const row = document.createElement('div'); row.className = 'peer'; row.textContent = request.remoteId + ' 申请 ' + (request.access === 'read' ? '只读' : '完全控制');
            for (const [text, type, access] of [['批准只读', 'approve', 'read'], ...(request.access === 'control' ? [['批准控制', 'approve', 'control']] : []), ['拒绝', 'reject', '']]) {
                const button = document.createElement('button'); button.textContent = text; button.dataset.access = access; button.dataset.request = requestId;
                button.onclick = () => socketSend({ type, requestId, access }); row.append(button);
            }
            pending.append(row);
        }
        const target = $('target'), previous = target.value; target.replaceChildren(); $('peers').replaceChildren();
        for (const peer of state.peers.values()) {
            const option = document.createElement('option'); option.value = peer.id; option.textContent = peer.id; target.append(option);
            const row = document.createElement('div'); row.className = 'peer'; row.textContent = peer.id + ' · ' + peer.access + ' · ' + (peer.link?.mode || 'connecting');
            if (state.role === 'local') { const revoke = document.createElement('button'); revoke.textContent = '撤销'; revoke.onclick = () => { remove(peer, 'Local 已撤销'); socketSend({ type: 'revoke', remoteId: peer.id }); }; row.append(revoke); }
            $('peers').append(row);
        }
        if (state.peers.has(previous)) target.value = previous;
        const peer = selected();
        $('send').disabled = !peer || peer.link?.mode === 'connecting' || !!peer.sending || state.role === 'remote' && (peer.access !== 'control' || state.paused);
        $('fallback').disabled = !peer || peer.link?.mode !== 'p2p';
        $('pause').disabled = state.role !== 'local' || !state.registered;
        $('pause').textContent = state.paused ? '恢复 Remote 合成发送' : '暂停 Remote 合成发送';
        $('results').textContent = state.results.length ? JSON.stringify(state.results, null, 2) : '尚未测试';
    }
    function controlFrame(message) { const text = encoder.encode(JSON.stringify(message)); const bytes = new Uint8Array(text.length + 1); bytes.set(text, 1); return bytes; }
    function receipt(peer, value) { signal(peer, 'receipt', JSON.stringify(value)); }
    function allowed(peer) { return state.role !== 'local' || peer.access === 'control' && !state.paused; }
    function reject(peer, id, code) { state.denied++; if (id) receipt(peer, { op: 'rejected', id, code }); }
    function receive(peer, frame) {
        if (!current(peer)) return;
        if (frame[0] === 0) {
            const message = JSON.parse(decoder.decode(frame.subarray(1)));
            if (message.op !== 'begin' || !Number.isInteger(message.id) || message.id < 1 || message.id > 0xffffffff || !Number.isInteger(message.bytes) || message.bytes < 1 || message.bytes > MAX_BYTES) throw Error('无效实验开始帧');
            if (!allowed(peer) || state.role === 'local' && message.epoch !== state.epoch) { reject(peer, message.id, 'permission_denied'); return; }
            if (peer.receiving) throw Error('已有接收测试未结束');
            const receiving = { id: message.id, data: new Uint8Array(message.bytes), offset: 0, epoch: state.epoch };
            receiving.timer = setTimeout(() => { if (peer.receiving === receiving) { peer.receiving = null; reject(peer, message.id, 'timeout'); } }, 30000);
            peer.receiving = receiving; return;
        }
        if (frame[0] !== 1 || frame.length < 17 || frame[1] !== 0x53 || frame[2] !== 0x53 || frame[3] !== 0x50) throw Error('实验帧头错误');
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength), id = view.getUint32(4, true), offset = view.getUint32(8, true), total = view.getUint32(12, true);
        const receiving = peer.receiving;
        if (!allowed(peer) || !receiving || receiving.id !== id || state.role === 'local' && receiving.epoch !== state.epoch) { reject(peer, id, 'permission_denied'); return; }
        if (total !== receiving.data.length || offset !== receiving.offset || offset + frame.length - 16 > total) throw Error('实验序号或长度不匹配');
        receiving.data.set(frame.subarray(16), offset); receiving.offset += frame.length - 16;
        if (receiving.offset === total) {
            clearTimeout(receiving.timer);
            sha(receiving.data).then(hash => {
                if (!current(peer) || peer.receiving !== receiving || !allowed(peer) || state.role === 'local' && receiving.epoch !== state.epoch) return;
                peer.receiving = null; receipt(peer, { op: 'complete', id, bytes: total, sha: hash });
            }).catch(error => event(error.message));
        }
    }
    function receiveReceipt(peer, message) {
        const operation = peer.sending;
        if (!operation || operation.id !== message.id) return;
        clearTimeout(operation.timer); peer.sending = null;
        if (message.op !== 'complete' || message.sha !== operation.hash || message.bytes !== operation.bytes) { operation.reject(Error(message.code || '合成数据 SHA-256 不匹配')); render(); return; }
        const ms = performance.now() - operation.started;
        const result = { peer: peer.id, mode: operation.mode, bytes: message.bytes, sha256: message.sha, milliseconds: Math.round(ms), kibPerSecond: Math.round(message.bytes / 1024 / (ms / 1000)) };
        state.results.unshift(result); state.results = state.results.slice(0, 20); operation.resolve(result); render();
    }
    async function start(bytes = Number($('size').value)) {
        const peer = selected();
        if (!peer || !current(peer) || peer.link.mode === 'connecting' || peer.sending) throw Error('需要已批准且空闲的实验通道');
        if (state.role === 'remote' && (peer.access !== 'control' || state.paused)) throw Error('只读或暂停状态不能发送');
        if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) throw Error('测试大小上限 4 MiB');
        const data = Uint8Array.from({ length: bytes }, (_, index) => (index * 31 + (index >>> 8)) & 255);
        const operation = { id: randomID(), bytes, mode: peer.link.mode, started: performance.now() };
        const done = new Promise((resolve, reject) => Object.assign(operation, { resolve, reject }));
        // Attach a handler before the asynchronous hash/send work can fail.
        done.catch(() => {}); peer.sending = operation; render();
        operation.timer = setTimeout(() => { if (peer.sending === operation) { peer.sending = null; operation.reject(Error('测试确认超时')); render(); } }, 30000);
        try {
            operation.hash = await sha(data);
            if (!current(peer) || peer.sending !== operation) throw Error('测试已取消');
            await peer.link.send(controlFrame({ op: 'begin', id: operation.id, bytes, epoch: state.epoch }));
            for (let offset = 0; offset < bytes; offset += 4096) {
                if (!current(peer) || peer.sending !== operation) throw Error('测试已取消，旧数据不重发');
                const chunk = data.subarray(offset, offset + 4096), frame = new Uint8Array(16 + chunk.length), view = new DataView(frame.buffer);
                frame.set([1, 0x53, 0x53, 0x50]); view.setUint32(4, operation.id, true); view.setUint32(8, offset, true); view.setUint32(12, bytes, true); frame.set(chunk, 16);
                await peer.link.send(frame);
            }
        } catch (error) { if (peer.sending === operation) { clearTimeout(operation.timer); peer.sending = null; operation.reject(error); render(); } }
        return done;
    }
    $('role').value = new URLSearchParams(location.search).get('role') === 'remote' ? 'remote' : 'local';
    $('role').onchange = render; $('target').onchange = render;
    $('connect').onclick = () => { try { connect(); } catch (error) { event(error.message); } };
    $('disconnect').onclick = disconnect;
    $('send').onclick = () => start().catch(error => event(error.message));
    $('fallback').onclick = () => selected()?.link.fallback();
    $('pause').onclick = () => {
        const paused=!state.paused;
        if(paused){state.paused=true;for(const peer of state.peers.values())cancel(peer,'Local 已暂停');render()}
        socketSend({ type: 'set_write_state', version: 3, requestId: crypto.randomUUID(), paused });
    };
    // Diagnostics use the same actions and live WebRTC statistics as the UI.
    window.ShareSerialP2PProbe = { start, disconnect,
        fallback: () => selected()?.link.fallback(),
        stats: async () => ({ role: state.role, localId: state.localId, pending: state.pending.size, paused: state.paused, denied: state.denied, signalBytes: state.signalBytes, results: state.results,
            peers: await Promise.all([...state.peers.values()].map(async peer => ({ id: peer.id, access: peer.access, ...await peer.link.stats() }))) }) };
    render();
})();
