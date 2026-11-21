(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./p2p-probe-link.js') : root.ProbeLink,
        typeof module === 'object' && module.exports ? require('./serial-data.js') : root.SerialData,
        typeof module === 'object' && module.exports ? require('./p2p-network.js') : root.P2PNetwork);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SerialP2P = api;
})(globalThis, function (ProbeLink, SerialData, P2PNetwork) {
    'use strict';
    const MAX_PENDING = 16, MAX_BYTES = 192 * 1024, HEADER = 16, TIMEOUT = 10000;
    const RETRY_WINDOW = 180000, MAX_ATTEMPT = 3;
    const RX_STALL_MESSAGE = '接收补传连续 30 秒无进展，请检查网络；未补回的数据不能视为完整';
    const retryable = (reason, details) => details?.dtls !== 'failed' &&
        ['negotiation_timeout','connection_failed','connection_disconnected','channel_closed','channel_error'].includes(reason);
    const supported = () => typeof globalThis.RTCPeerConnection === 'function' && !!globalThis.crypto?.subtle;
    function configuration() {
        const input = globalThis.ShareSerialICE;
        if (!input) return {iceServers:[], configuration:'missing'};
        if (input.schemaVersion !== 1 || !Array.isArray(input.iceServers) || input.iceServers.length > 4) return {iceServers:[], configuration:'invalid'};
        const urls = input.iceServers.flatMap(server => Array.isArray(server?.urls) ? server.urls : [server?.urls]);
        if (urls.length > 4 || urls.some(url => typeof url !== 'string' || url.length > 256 || !/^stun:[^\s/\\?#@<>]+$/.test(url))) return {iceServers:[], configuration:'invalid'};
        return {iceServers:urls.length ? [{urls:[...urls]}] : [], configuration:'server'};
    }
    function describe(value) {
        if (!value) return '尚无 P2P 协商记录';
        const reasons = {webrtc_unavailable:'浏览器不支持 WebRTC',crypto_unavailable:'浏览器安全上下文或 Web Crypto 不可用',peer_unsupported:'双方未协商 P2P，请刷新两侧页面并检查浏览器支持',
            webrtc_disabled:'浏览器未能创建 WebRTC 连接',negotiation_timeout:'直连协商超时',connection_failed:'ICE/连接未能建立可用路径',connection_disconnected:'直连网络已断开',connection_closed:'直连已关闭',
            channel_closed:'数据通道已关闭',channel_error:'数据通道错误',sdp_error:'连接描述协商失败',candidate_error:'ICE 候选处理失败',signal_limit:'协商信令超出有界队列',
            invalid_frame:'收到无效直连帧',application:'直连已由应用回退',backpressure:'直连发送积压',peer_fallback:'对端已回退中转'};
        const phases = {connecting:'正在协商直连',channel_ready:'直连通道已建立，等待双方确认',local_offer:'已发送连接提议',remote_offer:'已收到连接提议',local_answer:'已发送连接应答',remote_answer:'已收到连接应答',
            ice_complete:'ICE 候选收集完成',ice_error:'STUN 探测出现错误',direct:'已建立直连',fallback:'已回退中转',tx_relay:'Remote TX 已切中转；RX 保持直连',retry_wait:'中转收发保持可用，稍后重试直连'};
        const counts = candidates => ['host','srflx','relay'].map(type => type+'='+Number(candidates?.[type]||0)).join(' ');
        return (phases[value.phase] && value.phase === 'retry_wait' ? phases[value.phase] : reasons[value.reason] || phases[value.phase] || '正在检查连接') +
            (value.retryProtocol === 1 ? '；直连尝试 '+(value.attempt+1)+'/4'+(value.retryInMs ? '；'+Math.ceil(value.retryInMs/1000)+' 秒后重试' : '') : '') +
            (value.configuration === 'missing' ? '；未加载部署配置' : value.configuration === 'invalid' ? '；部署配置无效' : '') +
            '；' + (value.stunConfigured ? '已配置 STUN' : '未配置 STUN，仅尝试本地候选') +
            '；ICE='+(value.iceConnectionState||'new')+'；本端 '+counts(value.localCandidates)+'；对端 '+counts(value.remoteCandidates)+
            (value.failureDetails ? '；DTLS='+value.failureDetails.dtls+'；SCTP='+value.failureDetails.sctp+
                (value.failureDetails.applicationCause ? '；回退入口='+value.failureDetails.applicationCause : '')+
                (value.failureDetails.channelError && value.failureDetails.channelError!=='unavailable' ? '；通道错误='+value.failureDetails.channelError+(value.failureDetails.sctpCauseCode!==null&&value.failureDetails.sctpCauseCode!==undefined?'（'+value.failureDetails.sctpCauseCode+'）':'') : '')+
                (value.failureDetails.statsAvailable ? '；探测请求='+value.failureDetails.checksSent+' 响应='+value.failureDetails.responsesReceived+' 成功候选对='+value.failureDetails.validPairs : '；探测统计未取得') : '')+
            (value.peerFailureDetails ? '；对端报告 ICE='+value.peerFailureDetails.ice+' DTLS='+value.peerFailureDetails.dtls+(value.peerFailureDetails.statsAvailable ? ' 探测请求='+value.peerFailureDetails.checksSent+' 响应='+value.peerFailureDetails.responsesReceived+' 成功候选对='+value.peerFailureDetails.validPairs : '') : '')+
            (value.stunError ? '；STUN 错误 '+value.stunError : '')+(value.errorName ? '；'+value.errorName : '');
    }
    const diagnosticEvent = value => ['connecting','channel_ready','local_offer','remote_offer','local_answer','remote_answer','ice_complete','ice_error','direct','fallback','fallback_details','tx_relay','retry_wait'].includes(value?.phase);
    async function digest(bytes) {
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function frame(kind, sequence, bytes) {
        if (![1, 2].includes(kind) || !Number.isSafeInteger(sequence) || sequence < 1 || !bytes.length || bytes.length > 16384) throw Error('Invalid serial frame');
        const result = new Uint8Array(HEADER + bytes.length);
        result.set([83, 83, 80, 1, kind]);
        new DataView(result.buffer).setBigUint64(8, BigInt(sequence), true);
        result.set(bytes, HEADER);
        return result;
    }
    function unframe(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length <= HEADER || bytes.length > HEADER + 16384 ||
            bytes[0] !== 83 || bytes[1] !== 83 || bytes[2] !== 80 || bytes[3] !== 1 || ![1, 2].includes(bytes[4]) ||
            bytes[5] || bytes[6] || bytes[7]) throw Error('Invalid direct serial frame');
        const sequence = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8, true));
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw Error('Invalid serial sequence');
        return { kind: bytes[4], sequence, bytes: bytes.slice(HEADER) };
    }

    class Peer {
        constructor({ role, localId, remoteId, portId, grantId, sendWS, valid, canTX, deliverTX, deliverRX, onState, onError, onDiagnostic = () => {},
            RTC = globalThis.RTCPeerConnection, retryProtocol = 0, txRelayProtocol = 0, canAssess = () => true }) {
            Object.assign(this, { role, localId, remoteId, portId, grantId, sendWS, valid, canTX, deliverTX, deliverRX, onState, onError });
            this.direct = false; this.txViaRelay = false; this.closed = false; this.generation = 0; this.writeGeneration = 0; this.txSequence = 0; this.lastPermit = 0;
            this.pending = new Map(); this.incoming = new Map(); this.permits = [];
            this.txChain = Promise.resolve(); this.incomingChain = Promise.resolve(); this.rxChain = Promise.resolve();
            this.pendingBytes = 0; this.rxBytes = 0; this.rxCount = 0;
            this.RTC = RTC; this.onDiagnostic = onDiagnostic; this.canAssess = canAssess; this.retryProtocol = retryProtocol === 1 ? 1 : 0;
            this.txRelayProtocol = txRelayProtocol === 1 && !!P2PNetwork ? 1 : 0;
            this.attempt = 0; this.retryUntil = Date.now() + RETRY_WINDOW;
            this.startLink();
        }
        startLink() {
            this.network?.close();
            this.txViaRelay = false;
            const config = configuration();
            this.configurationStatus = config.configuration;
            const attempt = this.attempt;
            this.link = new ProbeLink.Link({ initiator: this.role === 'remote', RTC: this.RTC,
                captureFailureStats: true,
                getFailureContext: () => this.failureContext(),
                timeoutMs: this.retryProtocol === 1 ? Math.max(1, Math.min(45000, this.retryUntil-Date.now())) : 45000,
                iceServers: config.iceServers,
                onDiagnostic: value => this.diagnose({...value,phase:value.phase==='direct'?'channel_ready':value.phase}),
                label: 'shareserial-serial-v1', maxFrame: HEADER + 16384, valid: () => this.active() && this.attempt === attempt,
                sendSignal: (probeKind, probePayload) => this.send({ type: 'p2p_serial_signal', probeKind, probePayload,
                    ...(probeKind === 'fallback' ? {p2pReason:this.diagnostic?.reason || 'application',p2pDetails:this.diagnostic?.failureDetails} : {}) }),
                relay: () => { throw Error('Serial direct operation interrupted'); },
                onFrame: bytes => this.receive(bytes), onState: mode => {
                    if (!this.active()) return;
                    if (mode === 'p2p') this.send({ type: 'p2p_serial_signal', probeKind: 'ready' });
                    else if (mode === 'websocket') this.cancelDirect('直连已中断，未完成的发送不会自动重试');
                } });
            const link = this.link;
            if (link.pc && P2PNetwork) {
                const endpoint = this.network = new P2PNetwork.Endpoint({
                    // The initiator needs server-confirmed direct state; the receiver's notification may arrive later.
                    valid: () => this.active() && this.link === link && link.mode === 'p2p',
                    available: () => this.canAssess(),
                    create: () => link.pc.createDataChannel(P2PNetwork.LABEL,{ordered:true})
                });
                const serialChannel = link.pc.ondatachannel;
                link.pc.ondatachannel = event => { if (!endpoint.accept(event.channel)) serialChannel(event); };
            }
        }
        assessNetwork(options) {
            if (!this.network || !this.direct) return Promise.reject(Error('当前直连不支持评估，请刷新两端后重试'));
            return this.network.assess(options);
        }
        active() { return !this.closed && this.valid(); }
        failureContext(applicationCause='') {
            const session=this.network?.session;
            return {applicationCause,assessmentActive:!!session&&!session.closed,assessmentBufferedAmount:session?.channel?.bufferedAmount||0};
        }
        diagnose(value) {
            this.diagnostic = {...value,configuration:this.configurationStatus,retryProtocol:this.retryProtocol,attempt:this.attempt,...(this.direct && !value.reason ? {phase:'direct'} : {}),
                ...(this.peerFailureDetails ? {peerFailureDetails:{...this.peerFailureDetails}} : {})};
            if (this.active()) { try { this.onDiagnostic(this.diagnostic); } catch {} }
        }
        send(message) {
            if (this.active()) this.sendWS({ ...message, localId: this.localId, remoteId: this.remoteId, portId: this.portId, grantId: this.grantId, p2pAttempt:this.attempt });
        }
        handle(message) {
            if (!this.active() || message.portId !== this.portId || message.grantId !== this.grantId ||
                (message.remoteId && message.remoteId !== this.remoteId)) return;
            if (message.type === 'p2p_serial_state' && message.probeKind === 'retry') {
                if (this.retryProtocol !== 1 || message.serialP2PRetryProtocol !== 1 ||
                    message.p2pAttempt !== this.attempt+1 || message.p2pAttempt > MAX_ATTEMPT) return;
                clearTimeout(this.retryTimer); this.retryTimer = null;
                this.cancelDirect('直连重新协商，未完成的发送不会自动重试');
                this.link.close(); this.attempt = message.p2pAttempt; this.peerFailureDetails = null;
                this.txChain = Promise.resolve(); this.incomingChain = Promise.resolve(); this.rxChain = Promise.resolve();
                this.startLink(); return;
            }
            if ((message.p2pAttempt ?? 0) !== this.attempt) return;
            if (message.type === 'p2p_serial_signal') this.link.signal(message.probeKind, message.probePayload || '');
            if (message.type === 'p2p_serial_state') {
                if (message.probeKind === 'fallback' && message.p2pDetails && message.p2pReporter && message.p2pReporter !== this.role) this.peerFailureDetails = {...message.p2pDetails};
                if (message.direct === true && this.link.mode === 'p2p') { this.direct = true; this.onState(true); this.diagnose({...this.diagnostic,phase:'direct'}); }
                if (message.direct === true && message.serialTXRelay === true && this.direct && this.txRelayProtocol === 1) this.switchTXToRelay(false);
                else if (!message.direct) {
                    // A partial ready notification must not cancel negotiation.
                    if (message.probeKind === 'fallback' || this.direct || this.link.mode === 'websocket') this.fallback(message.p2pReason || 'peer_fallback', false);
                }
                if (message.probeKind === 'fallback') {
                    if (message.p2pReporter && message.p2pReporter !== this.role) this.reportPeerFailure();
                    this.scheduleRetry(message);
                }
            }
            if (message.type === 'p2p_serial_permit') this.permit(message);
        }
        reportPeerFailure() {
            const link=this.link,attempt=this.attempt;
            if(link.peerFailureReported)return;
            link.peerFailureReported=true;
            Promise.resolve(link.fallbackCapture).then(()=>{
                if(!this.active()||this.link!==link||this.attempt!==attempt||link.failureReported||!link.diagnostic.failureDetails)return;
                link.failureReported=true;
                this.send({type:'p2p_serial_signal',probeKind:'fallback',p2pReason:link.diagnostic.reason||'peer_fallback',p2pDetails:{...link.diagnostic.failureDetails}});
            }).catch(()=>{});
        }
        scheduleRetry(message) {
            const wait = 5000 * 2**this.attempt;
            if (this.role !== 'remote' || this.retryProtocol !== 1 || this.retryTimer || this.attempt >= MAX_ATTEMPT ||
                !retryable(message.p2pReason, message.p2pDetails) || Date.now()+wait >= this.retryUntil) return;
            const attempt = this.attempt;
            this.diagnose({...this.diagnostic,phase:'retry_wait',retryInMs:wait});
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                if (!this.active() || this.attempt !== attempt || this.link.mode !== 'websocket' || Date.now() >= this.retryUntil) return;
                this.send({type:'p2p_serial_signal',probeKind:'retry'});
            }, wait);
        }
        sendTX(bytes, epoch, stillValid = () => true) {
            if (!this.active() || !this.direct || this.txViaRelay || !this.canTX(epoch)) return Promise.reject(Error('发送授权或传输状态已变化'));
            if (this.pending.size >= MAX_PENDING || this.pendingBytes + bytes.length > MAX_BYTES) return Promise.reject(Error('直连发送队列已满'));
            bytes = Uint8Array.from(bytes);
            const sequence = ++this.txSequence, generation = this.generation;
            let resolve, reject;
            const result = new Promise((yes, no) => { resolve = yes; reject = no; });
            const item = { bytes, epoch, generation, writeGeneration:this.writeGeneration, resolve, reject, valid:stillValid, timer: setTimeout(() => this.failTX(sequence, '直连发送确认超时，未自动重试'), TIMEOUT) };
            this.pending.set(sequence, item); this.pendingBytes += bytes.length;
            this.txChain = this.txChain.then(async () => {
                if (!this.currentTX(sequence, item)) return;
                item.sha = await digest(bytes);
                if (!this.currentTX(sequence, item)) { this.failTX(sequence, '发送授权已变化'); return; }
                this.send({ type: 'p2p_serial_tx', txSeq: sequence, writeEpoch: epoch, byteLength: bytes.length, sha256: item.sha });
                item.requested = true;
                await result.catch(() => {});
            }).catch(error => this.failTX(sequence, error.message));
            return result;
        }
        currentTX(sequence, item) {
            if (item.writeGeneration !== this.writeGeneration) return false;
            // Once submitted, finish this one authorized command. Abandoning
            // its permit would leave a hole in Local's ordered write queue.
            if (!item.requested && !item.valid()) return false;
            return this.active() && this.direct && item.generation === this.generation && this.pending.get(sequence) === item && this.canTX(item.epoch);
        }
        failTX(sequence, reason) {
            const item = this.pending.get(sequence);
            if (!item) return;
            this.pending.delete(sequence); this.pendingBytes -= item.bytes.length; clearTimeout(item.timer);
            const error=Error(reason);if(reason==='P2P_TX_RELAY')error.code=reason;item.reject(error);
        }
        switchTXToRelay(notify=true) {
            if (!this.active() || !this.direct || this.txViaRelay) return false;
            if(this.txRelayProtocol!==1){this.fallback('application',true,'tx_queue');return false}
            this.txViaRelay=true;
            this.cancelWrites('直连 TX 已切到中转；未完成命令结果未知，不自动重放','P2P_TX_RELAY');
            if(notify)this.send({type:'p2p_serial_signal',probeKind:'tx_relay',probePayload:'',p2pReason:'tx_queue'});
            this.onError(this.role==='local'
                ? 'Remote TX 队列已满，后续写入切到中转；未完成命令结果未知，不自动重放；RX 保持直连'
                : 'Local 已将 TX 切到中转；未完成命令结果未知，不自动重放；RX 保持直连');
            this.onState(true);
            this.diagnose({...this.diagnostic,phase:'tx_relay',reason:'tx_queue',txViaRelay:true});
            return true;
        }
        permit(message) {
            if (!Number.isSafeInteger(message.txSeq) || message.txSeq < 1 || !Number.isSafeInteger(message.byteLength) ||
                message.byteLength < 1 || message.byteLength > 16384 || !/^[a-f0-9]{64}$/.test(message.sha256 || '')) return;
            if (this.role === 'remote') {
                const item = this.pending.get(message.txSeq);
                if (!item || !this.currentTX(message.txSeq, item) || message.writeEpoch !== item.epoch ||
                    message.sha256 !== item.sha || message.byteLength !== item.bytes.length) return;
                this.link.send(frame(1, message.txSeq, item.bytes)).then(() => {
                    if (!this.currentTX(message.txSeq, item)) { this.failTX(message.txSeq, '发送途中授权或通道已变化，执行结果未知'); return; }
                    this.pending.delete(message.txSeq); this.pendingBytes -= item.bytes.length; clearTimeout(item.timer); item.resolve();
                }).catch(error => { this.failTX(message.txSeq, error.message); if (item.generation === this.generation) this.fallback('application',true,'tx_send'); });
                return;
            }
            if(this.txViaRelay){this.lastPermit=Math.max(this.lastPermit,message.txSeq);return;}
            if (message.txSeq <= this.lastPermit || !this.direct) return;
            this.lastPermit = message.txSeq;
            if (!this.canTX(message.writeEpoch)) {
                const stale = this.incoming.get(message.txSeq);
                if (stale) clearTimeout(stale.timer);
                this.incoming.delete(message.txSeq);
                this.permits = this.permits.filter(sequence => sequence !== message.txSeq);
                return;
            }
            const item = this.incomingItem(message.txSeq);
            if (!item) return;
            item.permit = message;
            this.permits.push(message.txSeq); this.drain();
        }
        incomingItem(sequence) {
            let item = this.incoming.get(sequence);
            if (item) return item;
            if (this.incoming.size >= MAX_PENDING) { this.switchTXToRelay(); return null; }
            item = { timer: setTimeout(() => {
                if (!this.active()) return;
                this.onError('直连发送缺少数据或授权，已中止；未自动重试'); this.fallback('application',true,'tx_wait');
            }, TIMEOUT) };
            this.incoming.set(sequence, item); return item;
        }
        receive(raw) {
            if (!this.active() || this.link.mode !== 'p2p') return;
            try {
                const packet = unframe(raw);
                if (this.role === 'remote') {
                    if (packet.kind !== 2) throw Error('Unexpected TX frame');
                    this.deliverRX(packet.sequence, packet.bytes);
                } else {
                    if (packet.kind !== 1) throw Error('Unexpected RX frame');
                    if(this.txViaRelay)return;
                    if (packet.sequence <= this.lastPermit && !this.incoming.has(packet.sequence)) return;
                    const item = this.incomingItem(packet.sequence);
                    if (!item || item.bytes) return;
                    item.bytes = packet.bytes; this.drain();
                }
            } catch (error) { this.onError(error.message); this.fallback('application',true,'serial_frame'); }
        }
        drain() {
            const chainGeneration = this.generation;
            this.incomingChain = this.incomingChain.then(async () => {
                while (this.permits.length) {
                    if (chainGeneration !== this.generation) return;
                    const sequence = this.permits[0], item = this.incoming.get(sequence);
                    if (!item?.bytes) return;
                    this.permits.shift(); this.incoming.delete(sequence); clearTimeout(item.timer);
                    const message = item.permit, generation = this.generation, writeGeneration = this.writeGeneration;
                    if (!this.active() || !this.direct || !this.canTX(message.writeEpoch)) continue;
                    if (item.bytes.length !== message.byteLength || await digest(item.bytes) !== message.sha256) {
                        if (!this.active() || generation !== this.generation || writeGeneration !== this.writeGeneration) continue;
                        this.onError('直连字节与服务器发送授权不匹配，已拒绝'); this.fallback('application',true,'tx_integrity'); return;
                    }
                    if (!this.active() || !this.direct || generation !== this.generation || writeGeneration !== this.writeGeneration || !this.canTX(message.writeEpoch)) continue;
                    this.deliverTX({ type: 'send', remoteId: this.remoteId, portId: this.portId,
                        grantId: this.grantId, writeEpoch: message.writeEpoch, data: SerialData.toBase64(item.bytes) });
                }
            }).catch(error => { if (chainGeneration === this.generation) { this.onError(error.message); this.fallback('application',true,'tx_dispatch'); } });
        }
        sendRX(sequence, bytes) {
            if (!this.active() || !this.direct) return false;
            if (this.rxCount >= MAX_PENDING || this.rxBytes + bytes.length > MAX_BYTES) { this.fallback('backpressure',true,'rx_queue'); return false; }
            const generation = this.generation, packet = frame(2, sequence, bytes);
            this.rxBytes += bytes.length; this.rxCount++;
            this.rxChain = this.rxChain.then(async () => {
                if (!this.active() || !this.direct || generation !== this.generation) return;
                await this.link.send(packet);
            }).catch(() => { if (generation === this.generation) this.fallback('application',true,'rx_send'); }).finally(() => { this.rxCount--; this.rxBytes -= bytes.length; });
            return true;
        }
        cancelWrites(reason = '发送权限或串口状态已变化', code = '') {
            this.writeGeneration++;
            for (const sequence of this.pending.keys()) this.failTX(sequence, code||reason);
            for (const item of this.incoming.values()) clearTimeout(item.timer);
            this.incoming.clear(); this.permits.length = 0;
        }
        cancelDirect(reason) {
            this.network?.close();
            const wasDirect = this.direct;
            this.direct = false; this.txViaRelay=false; this.generation++;
            this.cancelWrites(reason);
            if (wasDirect) this.onState(false);
        }
        fallback(reason = 'application', notify = true, applicationCause = '') {
            if (this.link && this.link.mode !== 'websocket') this.link.failureContextSnapshot = this.failureContext(applicationCause);
            this.cancelDirect('直连发送中断，执行结果未知；未自动重试');
            this.link?.fallback(notify, reason); this.onState(false);
        }
        close() {
            clearTimeout(this.retryTimer); this.retryTimer = null;
            this.cancelDirect('连接授权已结束'); this.closed = true; this.link.close();
        }
    }

    // Both transports share one RX cursor. Direct heads detect a missing tail;
    // repair uses the existing bounded Local cache and authenticated WSS replay.
    class Receiver {
        constructor({ cursor, deliver, resume, replaying, onError }) {
            Object.assign(this, { cursor, deliver, resume, replaying, onError });
            this.frames = new Map(); this.bytes = 0; this.head = cursor(); this.closed = false; this.repairing = false; this.replayStarted = false;
        }
        receive(message, direct = false) {
            if (this.closed) return;
            const sequence = message.rxSeq;
            if (!Number.isSafeInteger(sequence) || sequence < 1) return;
            this.head = Math.max(this.head, sequence);
            if (sequence <= this.cursor()) { if (!direct) this.deliver(message); return; }
            if (this.repairing) {
                if (this.replayStarted && !direct && sequence <= this.replayThrough) { this.deliver(message); this.noteProgress(); return; }
                // Keep a bounded live tail while WSS repairs the missing prefix.
                // Direct bytes cannot generate an ACK for unsent relay history.
                if (!this.replayStarted || sequence > this.replayThrough) this.buffer(message);
                return;
            }
            this.buffer(message);
            this.flush(); this.schedule();
        }
        buffer(message) {
            const sequence = message.rxSeq;
            if (!this.frames.has(sequence)) { this.frames.set(sequence, message); this.bytes += message.data.length; }
            if (this.frames.size > 256 || this.bytes > MAX_BYTES) {
                this.frames.clear(); this.bytes = 0; this.repair(); return;
            }
        }
        flush() {
            while (this.frames.has(this.cursor() + 1)) {
                const sequence = this.cursor() + 1, message = this.frames.get(sequence);
                this.frames.delete(sequence); this.bytes -= message.data.length; this.deliver(message);
                if (this.cursor() < sequence) break;
            }
        }
        observe(sequence) {
            if (Number.isSafeInteger(sequence) && sequence >= 0) { this.head = Math.max(this.head, sequence); this.schedule(); }
        }
        schedule() {
            if (this.closed || this.repairing || this.timer || this.head <= this.cursor()) return;
            this.timer = setTimeout(() => { this.timer = null; if (this.head > this.cursor()) this.repair(); }, 150);
        }
        repair() {
            if (this.closed || this.repairing) return;
            this.repairing = true; this.replayStarted = false; this.frames.clear(); this.bytes = 0; this.replaying(true); this.resume(this.cursor());
            this.progressCursor = this.cursor(); this.armRepairDeadline();
        }
        armRepairDeadline() {
            clearTimeout(this.deadline);
            const token = this.deadlineToken = (this.deadlineToken || 0) + 1;
            this.deadline = setTimeout(() => {
                if (this.closed || !this.repairing || token !== this.deadlineToken) return;
                this.onError(RX_STALL_MESSAGE);
            }, 30000);
        }
        noteProgress() {
            const position = this.cursor();
            if (this.closed || !this.repairing || !Number.isSafeInteger(position) || position <= this.progressCursor) return;
            this.progressCursor = position; this.armRepairDeadline();
        }
        begin(through = this.head) {
            this.repairing = true; this.replayStarted = true;
            this.replayThrough = Number.isSafeInteger(through) && through >= this.cursor() ? through : this.cursor();
            this.head = Math.max(this.head,this.replayThrough);
            this.progressCursor = this.cursor(); this.armRepairDeadline();
            for (const [sequence,message] of this.frames) {
                if (sequence <= this.replayThrough) { this.frames.delete(sequence); this.bytes -= message.data.length; }
            }
            this.replaying(true);
        }
        complete() {
            clearTimeout(this.deadline); this.deadlineToken = (this.deadlineToken || 0) + 1;
            this.repairing = false; this.replayStarted = false; this.replaying(false); this.flush(); this.schedule();
        }
        close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.deadline); this.frames.clear(); }
    }
    return { supported, configuration, describe, diagnosticEvent, Peer, Receiver, frame, unframe, digest, RX_STALL_MESSAGE };
});
