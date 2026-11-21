(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ProbeLink = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const MAX_FRAME = 16384, MAX_BACKLOG = 65536, MAX_CANDIDATES = 64;

    class Link {
        constructor({ initiator, sendSignal, relay, valid, onFrame, onState, RTC = globalThis.RTCPeerConnection, timeoutMs = 12000,
            label = 'shareserial-synthetic-probe', maxFrame = MAX_FRAME, iceServers = [], onDiagnostic = () => {}, captureFailureStats = false, getFailureContext = () => ({}) }) {
            Object.assign(this, { sendSignal, relay, valid, onFrame, onState });
            this.captureFailureStats = captureFailureStats;
            this.getFailureContext = getFailureContext;
            this.onDiagnostic = onDiagnostic; this.startedAt = Date.now();
            this.diagnostic = { phase: 'connecting', reason: '', stunConfigured: iceServers.length > 0,
                localCandidates: {host:0,srflx:0,relay:0,prflx:0,unknown:0}, remoteCandidates: {host:0,srflx:0,relay:0,prflx:0,unknown:0},
                offerSent: false, offerReceived: false, answerSent: false, answerReceived: false, stunError: 0 };
            this.label = label; this.maxFrame = maxFrame;
            this.mode = 'connecting'; this.closed = false; this.candidates = []; this.remoteSet = false;
            this.metrics = { p2pSent: 0, p2pReceived: 0, wsSent: 0, wsReceived: 0 };
            this.chain = Promise.resolve(); this.candidateCount = 0;
            this.note('connecting');
            if (!RTC) { this.fallback(true, 'webrtc_unavailable'); return; }
            try{this.pc = new RTC({ iceServers })}catch(error){this.recordError(error);this.fallback(true,'webrtc_disabled');return}
            this.pc.onicecandidate = event => {
                if (event.candidate && !this.closed && this.mode !== 'websocket' && this.valid()) {
                    this.countCandidate('localCandidates', event.candidate); this.note('candidate');
                    this.sendSignal('candidate', JSON.stringify(event.candidate));
                }
            };
            this.pc.onconnectionstatechange = () => {
                this.note('connection_state');
                if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) this.fallback(true, 'connection_' + this.pc.connectionState);
            };
            this.pc.oniceconnectionstatechange = () => this.note('ice_state');
            this.pc.onicegatheringstatechange = () => this.note(this.pc.iceGatheringState === 'complete' ? 'ice_complete' : 'ice_gathering');
            this.pc.onicecandidateerror = event => {
                if (!this.active()) return;
                this.diagnostic.stunError = Number.isInteger(event.errorCode) && event.errorCode >= 0 && event.errorCode <= 999 ? event.errorCode : 0;
                this.note('ice_error');
            };
            this.pc.ondatachannel = event => this.attach(event.channel);
            this.timer = setTimeout(() => this.fallback(true, 'negotiation_timeout'), timeoutMs);
            if (initiator) {
                this.attach(this.pc.createDataChannel(this.label, { ordered: true }));
                this.chain = this.chain.then(async () => {
                    const offer = await this.pc.createOffer();
                    if (!this.active()) return;
                    await this.pc.setLocalDescription(offer);
                    if (this.active()) { this.diagnostic.offerSent = true; this.note('local_offer'); this.sendSignal('offer', offer.sdp); }
                }).catch(error => { this.recordError(error); this.fallback(true, 'sdp_error'); });
            }
        }
        active() { return !this.closed && this.mode !== 'websocket' && this.valid(); }
        recordError(error) {
            this.diagnostic.errorName = ['NotAllowedError','NotSupportedError','InvalidStateError','OperationError','TypeError','SyntaxError','RTCError'].includes(error?.name) ? error.name : 'Error';
        }
        countCandidate(side, candidate) {
            const type = candidate?.type || String(candidate?.candidate || '').match(/\btyp (host|srflx|relay|prflx)\b/)?.[1];
            const key = ['host','srflx','relay','prflx'].includes(type) ? type : 'unknown';
            this.diagnostic[side][key] = Math.min(MAX_CANDIDATES, this.diagnostic[side][key] + 1);
        }
        failureDetails() {
            const pick = (value, values) => values.includes(value) ? value : 'unavailable';
            const bytes = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value,1048576) : 0;
            let context={};try{context=this.failureContextSnapshot||this.getFailureContext()||{}}catch{}
            const causes=['rx_send','rx_queue','tx_send','tx_queue','tx_wait','serial_frame','tx_integrity','tx_dispatch'];
            let transport;
            try { transport = this.pc?.sctp?.transport; } catch {}
            return {ice:pick(this.pc?.iceConnectionState,['new','checking','connected','completed','failed','disconnected','closed']),
                dtls:pick(transport?.state,['new','connecting','connected','failed','closed']),
                sctp:pick(this.pc?.sctp?.state,['connecting','connected','closed']),
                applicationCause:causes.includes(context.applicationCause)?context.applicationCause:'',
                channelError:pick(this.channelError||'',['','sctp-failure','data-channel-failure','dtls-failure','unavailable']),
                sctpCauseCode:this.sctpCauseCode??null,
                channelState:pick(this.channel?.readyState,['connecting','open','closing','closed']),
                serialBufferedAmount:bytes(this.channel?.bufferedAmount),
                assessmentActive:context.assessmentActive===true,assessmentBufferedAmount:bytes(context.assessmentBufferedAmount),
                checksSent:0,responsesReceived:0,requestsReceived:0,validPairs:0,statsAvailable:false};
        }
        summarizeFailure(report, original) {
            const result = {...original};
            const count = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value,1000000) : 0;
            let pairs = 0;
            for (const item of report.values()) {
                if (item.type !== 'candidate-pair') continue;
                if (++pairs > 64) break;
                result.statsAvailable = true;
                result.checksSent = Math.min(1000000,result.checksSent+count(item.requestsSent));
                result.responsesReceived = Math.min(1000000,result.responsesReceived+count(item.responsesReceived));
                result.requestsReceived = Math.min(1000000,result.requestsReceived+count(item.requestsReceived));
                if (item.state === 'succeeded') result.validPairs++;
            }
            return result;
        }
        note(phase, reason = '') {
            if (this.closed || !this.valid() || this.mode === 'websocket' && !['fallback','fallback_details'].includes(phase)) return;
            this.diagnostic = {...this.diagnostic, phase, mode: this.mode, elapsedMs: Math.max(0, Date.now() - this.startedAt),
                ...(phase === 'fallback_details' ? {} : {connectionState: this.pc?.connectionState || 'new', iceConnectionState: this.pc?.iceConnectionState || 'new',
                iceGatheringState: this.pc?.iceGatheringState || 'new', signalingState: this.pc?.signalingState || 'stable'}),
                ...(reason ? {reason} : {}), localCandidates: {...this.diagnostic.localCandidates}, remoteCandidates: {...this.diagnostic.remoteCandidates}};
            // Observability must not change transport behavior or expose raw SDP,
            // candidate addresses, STUN URLs, or browser-provided error text.
            try { this.onDiagnostic(this.diagnosticSnapshot()); } catch {}
        }
        diagnosticSnapshot() {
            return {...this.diagnostic, localCandidates:{...this.diagnostic.localCandidates}, remoteCandidates:{...this.diagnostic.remoteCandidates},
                ...(this.diagnostic.failureDetails ? {failureDetails:{...this.diagnostic.failureDetails}} : {})};
        }
        attach(channel) {
            if (this.channel || !this.active() || channel.label !== this.label || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
                channel.close(); return;
            }
            this.channel = channel;
            channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = MAX_BACKLOG / 2;
            channel.onopen = () => {
                if (!this.active()) return;
                clearTimeout(this.timer); this.mode = 'p2p'; this.onState(this.mode);
                this.note('direct');
            };
            channel.onclose = () => this.fallback(true, 'channel_closed');
            channel.onerror = event => {
                const error=event?.error;
                this.channelError=['sctp-failure','data-channel-failure','dtls-failure'].includes(error?.errorDetail)?error.errorDetail:'unavailable';
                this.sctpCauseCode=this.channelError==='sctp-failure'&&Number.isInteger(error?.sctpCauseCode)&&error.sctpCauseCode>=0&&error.sctpCauseCode<=65535?error.sctpCauseCode:null;
                this.fallback(true, 'channel_error');
            };
            channel.onmessage = event => {
                if (!this.active() || this.mode !== 'p2p') return;
                if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0 || event.data.byteLength > this.maxFrame) { this.fallback(true,'invalid_frame'); return; }
                this.metrics.p2pReceived += event.data.byteLength;
                this.onFrame(new Uint8Array(event.data));
            };
        }
        signal(kind, payload) {
            if (this.closed || !this.valid()) return;
            if (kind === 'fallback') { this.fallback(false, 'peer_fallback'); return; }
            if (!this.active()) return;
            if (!['offer', 'answer', 'candidate'].includes(kind)) return;
            if(kind!=='candidate'){
                if(this.descriptionQueued){this.fallback(true,'sdp_error');return}
                this.descriptionQueued=true;
            }
            // Bound work queued behind native asynchronous SDP operations.
            if ((this.pendingSignals || 0) >= 72) { this.fallback(true,'signal_limit'); return; }
            this.pendingSignals = (this.pendingSignals || 0) + 1;
            this.chain = this.chain.then(async () => {
                if (!this.active()) return;
                if (kind === 'candidate') {
                    if (++this.candidateCount > MAX_CANDIDATES) throw Error('ICE candidate limit');
                    const candidate = JSON.parse(payload);
                    this.countCandidate('remoteCandidates', candidate); this.note('candidate');
                    if (this.remoteSet) await this.pc.addIceCandidate(candidate);
                    else this.candidates.push(candidate);
                    return;
                }
                await this.pc.setRemoteDescription({ type: kind, sdp: payload });
                if (!this.active()) return;
                this.remoteSet = true;
                this.diagnostic[kind === 'offer' ? 'offerReceived' : 'answerReceived'] = true;
                this.note(kind === 'offer' ? 'remote_offer' : 'remote_answer');
                for (const candidate of this.candidates.splice(0)) {
                    if (!this.active()) return;
                    await this.pc.addIceCandidate(candidate);
                }
                if (kind === 'offer') {
                    const answer = await this.pc.createAnswer();
                    if (!this.active()) return;
                    await this.pc.setLocalDescription(answer);
                    if (this.active()) { this.diagnostic.answerSent = true; this.note('local_answer'); this.sendSignal('answer', answer.sdp); }
                }
            }).catch(error => { this.recordError(error); this.fallback(true, kind === 'candidate' ? 'candidate_error' : 'sdp_error'); }).finally(() => { this.pendingSignals--; });
        }
        async send(frame) {
            if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > this.maxFrame) throw Error('Probe frame size');
            if (this.closed || !this.valid()) throw Error('Probe authorization ended');
            const mode = this.mode;
            if (mode === 'connecting') throw Error('Wait for transport negotiation');
            const deadline = Date.now() + 10000;
            while (mode === 'p2p' && this.channel.bufferedAmount + frame.length > MAX_BACKLOG) {
                if (Date.now() > deadline || this.mode !== mode || !this.active()) throw Error('Probe interrupted or backlogged');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (this.closed || !this.valid() || this.mode !== mode) throw Error('Probe transport changed; start a new test');
            if (mode === 'p2p') {
                if (this.channel.readyState !== 'open') throw Error('DataChannel closed');
                this.channel.send(frame); this.metrics.p2pSent += frame.length;
            } else { await this.relay(frame); this.metrics.wsSent += frame.length; }
        }
        receiveRelay(frame) {
            if (this.closed || !this.valid() || this.mode !== 'websocket' || !(frame instanceof Uint8Array) || frame.length === 0 || frame.length > MAX_FRAME) return;
            this.metrics.wsReceived += frame.length; this.onFrame(frame);
        }
        fallback(notify = true, reason = 'application') {
            if (this.closed || this.mode === 'websocket') return;
            const valid = this.valid();
            this.mode = 'websocket'; clearTimeout(this.timer); this.candidates = [];
            if (this.captureFailureStats) this.diagnostic.failureDetails = this.failureDetails();
            this.note('fallback', reason);
            this.onState(this.mode);
            let finished = false;
            const finish = () => {
                if (this.closed || finished) return;
                finished = true;
                try { if (notify && valid && this.valid()) { this.failureReported=true;this.sendSignal('fallback', ''); } } catch {}
                finally { this.channel?.close(); this.pc?.close(); }
            };
            if (!this.captureFailureStats || !this.pc || !valid) { finish(); return; }
            // The data path is already WSS. Capture only redacted diagnostics,
            // with one bounded pending operation; revocation still closes now.
            let timer, pending;
            try { pending = Promise.resolve(this.pc.getStats()); } catch { finish(); return; }
            this.fallbackCapture = Promise.race([pending,new Promise(resolve => { timer = setTimeout(() => resolve(null),200); })]).then(report => {
                if (this.closed || !this.valid()) { finish(); return; }
                if (report) this.diagnostic.failureDetails = this.summarizeFailure(report,this.diagnostic.failureDetails);
                this.note('fallback_details', reason);
                finish();
            }).catch(() => finish()).finally(() => clearTimeout(timer));
        }
        close() {
            if (this.closed) return;
            this.closed = true; clearTimeout(this.timer); this.candidates = [];
            this.channel?.close(); this.pc?.close();
        }
        async stats() {
            const result = { mode: this.mode, ...this.metrics, diagnostic: this.diagnosticSnapshot() };
            if (!this.pc || this.pc.connectionState === 'closed') return result;
            let stats;try{stats=await this.pc.getStats()}catch{return result}
            const transport = [...stats.values()].find(item => item.type === 'transport' && item.selectedCandidatePairId);
            const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(item => item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded');
            if (pair) result.candidate = { local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType, protocol: stats.get(pair.localCandidateId)?.protocol };
            return result;
        }
    }
    return { Link, MAX_FRAME, MAX_BACKLOG };
});
