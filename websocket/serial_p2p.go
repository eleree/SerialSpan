package websocket

import (
	"encoding/json"
	"strings"
	"time"
)

const (
	MsgTypeSerialSignal MessageType = "p2p_serial_signal"
	MsgTypeSerialState  MessageType = "p2p_serial_state"
	MsgTypeSerialTX     MessageType = "p2p_serial_tx"
	MsgTypeSerialPermit MessageType = "p2p_serial_permit"
	MsgTypeSerialHead   MessageType = "p2p_serial_head"
	MsgTypeSerialResume MessageType = "p2p_serial_resume"
	MsgTypeSerialReplay MessageType = "p2p_serial_replay"
)

type P2PFailureDetails struct {
	ICE                      string `json:"ice"`
	DTLS                     string `json:"dtls"`
	SCTP                     string `json:"sctp"`
	ChecksSent               int    `json:"checksSent"`
	ResponsesReceived        int    `json:"responsesReceived"`
	RequestsReceived         int    `json:"requestsReceived"`
	ValidPairs               int    `json:"validPairs"`
	StatsAvailable           bool   `json:"statsAvailable"`
	ApplicationCause         string `json:"applicationCause,omitempty"`
	ChannelError             string `json:"channelError,omitempty"`
	SCTPCauseCode            *int   `json:"sctpCauseCode,omitempty"`
	ChannelState             string `json:"channelState,omitempty"`
	SerialBufferedAmount     int    `json:"serialBufferedAmount,omitempty"`
	AssessmentActive         bool   `json:"assessmentActive,omitempty"`
	AssessmentBufferedAmount int    `json:"assessmentBufferedAmount,omitempty"`
}

func validP2PDetails(d *P2PFailureDetails) bool {
	if d == nil {
		return true
	}
	allowed := func(value string, choices ...string) bool {
		for _, choice := range choices {
			if value == choice {
				return true
			}
		}
		return false
	}
	if !allowed(d.ICE, "unavailable", "new", "checking", "connected", "completed", "failed", "disconnected", "closed") ||
		!allowed(d.DTLS, "unavailable", "new", "connecting", "connected", "failed", "closed") ||
		!allowed(d.SCTP, "unavailable", "connecting", "connected", "closed") {
		return false
	}
	if d.ChecksSent < 0 || d.ChecksSent > 1000000 || d.ResponsesReceived < 0 || d.ResponsesReceived > 1000000 ||
		d.RequestsReceived < 0 || d.RequestsReceived > 1000000 || d.ValidPairs < 0 || d.ValidPairs > 64 {
		return false
	}
	if !allowed(d.ApplicationCause, "", "rx_send", "rx_queue", "tx_send", "tx_queue", "tx_wait", "serial_frame", "tx_integrity", "tx_dispatch") ||
		!allowed(d.ChannelError, "", "unavailable", "sctp-failure", "data-channel-failure", "dtls-failure") ||
		!allowed(d.ChannelState, "", "unavailable", "connecting", "open", "closing", "closed") ||
		d.SerialBufferedAmount < 0 || d.SerialBufferedAmount > 1048576 || d.AssessmentBufferedAmount < 0 || d.AssessmentBufferedAmount > 1048576 ||
		d.SCTPCauseCode != nil && (d.ChannelError != "sctp-failure" || *d.SCTPCauseCode < 0 || *d.SCTPCauseCode > 65535) {
		return false
	}
	return d.StatsAvailable || d.ChecksSent == 0 && d.ResponsesReceived == 0 && d.RequestsReceived == 0 && d.ValidPairs == 0
}

func negotiatedSerialP2P(local, remote *Client) int {
	if local.serialP2PProtocol == 1 && remote.serialP2PProtocol == 1 {
		return 1
	}
	return 0
}

func negotiatedSerialP2PRetry(local, remote *Client) int {
	if negotiatedSerialP2P(local, remote) == 1 && local.serialP2PRetryProtocol == 1 && remote.serialP2PRetryProtocol == 1 {
		return 1
	}
	return 0
}

func negotiatedSerialP2PTXRelay(local, remote *Client) int {
	if negotiatedSerialP2P(local, remote) == 1 && local.serialP2PTXRelayProtocol == 1 && remote.serialP2PTXRelayProtocol == 1 {
		return 1
	}
	return 0
}

func retryableSerialP2P(reason string, details *P2PFailureDetails) bool {
	if details != nil && details.DTLS == "failed" {
		return false
	}
	switch reason {
	case "negotiation_timeout", "connection_failed", "connection_disconnected", "channel_closed", "channel_error":
		return true
	}
	return false
}

// All negotiation and write permits are scoped to the actual live sockets.
func (h *Hub) serialPeer(sender *Client, message Message) (*Client, *Client, subscription, bool) {
	remote := sender
	if sender.role == RoleLocal {
		remote = h.remotes[message.RemoteID]
	}
	target, ok := h.subscriptions[remote]
	local := h.locals[target.localID]
	if !ok || local == nil || (sender != local && sender != remote) ||
		message.PortID != target.portID || message.GrantID != target.grantID ||
		negotiatedSerialP2P(local, remote) != 1 {
		remoteID := sender.remoteID
		if sender.role == RoleLocal {
			remoteID = message.RemoteID
		}
		h.send(sender, Message{Type: MsgTypeError, Code: "p2p_not_authorized", Error: "A current approved serial P2P pair is required",
			PortID: message.PortID, GrantID: message.GrantID, RemoteID: remoteID})
		return nil, nil, subscription{}, false
	}
	if (message.Type == MsgTypeSerialSignal || message.Type == MsgTypeSerialTX) && message.P2PAttempt != remote.serialAttempt {
		// Delayed messages from an older round are expected and never revive it.
		if message.P2PAttempt > remote.serialAttempt || message.P2PAttempt < 0 {
			h.fail(sender, "p2p_attempt_expired", "Serial negotiation round is invalid")
		}
		return nil, nil, subscription{}, false
	}
	return local, remote, target, true
}

func (h *Hub) serialState(local, remote *Client, target subscription) {
	state := Message{Type: MsgTypeSerialState, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, SerialP2PProtocol: 1, Direct: remote.serialDirect,
		SerialTXRelay: remote.serialTXRelay, SerialP2PTXRelayProtocol: negotiatedSerialP2PTXRelay(local, remote),
		P2PAttempt: remote.serialAttempt, SerialP2PRetryProtocol: negotiatedSerialP2PRetry(local, remote)}
	if remote.serialFallback {
		state.ProbeKind = "fallback"
		state.P2PReason = remote.serialFallbackReason
		state.P2PDetails = remote.serialFallbackDetails
		state.P2PReporter = remote.serialFallbackReporter
	} else if remote.serialTXRelay {
		state.ProbeKind = "tx_relay"
		state.P2PReason = "tx_queue"
	}
	h.relay(local, []*Client{local, remote}, state)
}

func (h *Hub) serialSignal(sender *Client, message Message) {
	local, remote, target, ok := h.serialPeer(sender, message)
	if !ok {
		return
	}
	if message.ProbeKind == "retry" {
		h.retrySerialP2P(sender, local, remote, target, message)
		return
	}
	if message.ProbeKind == "tx_relay" {
		if sender != local || negotiatedSerialP2PTXRelay(local, remote) != 1 || !remote.serialDirect || remote.serialFallback || remote.serialTXRelay ||
			message.ProbePayload != "" || message.P2PReason != "tx_queue" || message.P2PDetails != nil || message.P2PReporter != "" {
			h.fail(sender, "invalid_p2p_signal", "Only a negotiated Local may relay TX while preserving P2P RX")
			return
		}
		remote.serialTXRelay = true
		h.logEvent(sender, "serial_p2p_tx_relay", "local_id=%q remote_id=%q reason=tx_queue direct_rx=true", target.localID, remote.remoteID)
		h.serialState(local, remote, target)
		return
	}
	if message.ProbeKind == "ready" || message.ProbeKind == "fallback" {
		if message.ProbePayload != "" || message.ProbeKind == "ready" && (message.P2PReason != "" || message.P2PDetails != nil) ||
			!validP2PReason(message.P2PReason) || !validP2PDetails(message.P2PDetails) {
			h.fail(sender, "invalid_p2p_signal", "Transport state must not contain data")
			return
		}
		beforeLocal, beforeRemote, beforeFallback := remote.serialLocalReady, remote.serialRemoteReady, remote.serialFallback
		if message.ProbeKind == "fallback" {
			if !remote.serialFallback {
				remote.serialFallbackReporter = sender.role
				remote.serialRetryAfter = h.now().Add((5 * time.Second) << remote.serialAttempt)
				if message.P2PDetails != nil {
					copy := *message.P2PDetails
					if copy.SCTPCauseCode != nil {
						code := *copy.SCTPCauseCode
						copy.SCTPCauseCode = &code
					}
					remote.serialFallbackDetails = &copy
				}
				remote.serialFallbackReason = message.P2PReason
				if remote.serialFallbackReason == "" {
					remote.serialFallbackReason = "peer_fallback"
				}
			}
			remote.serialFallback = true
			remote.serialDirect = false
		} else if !remote.serialFallback {
			if sender == local {
				remote.serialLocalReady = true
			} else {
				remote.serialRemoteReady = true
			}
			remote.serialDirect = remote.serialLocalReady && remote.serialRemoteReady
		}
		if beforeLocal != remote.serialLocalReady || beforeRemote != remote.serialRemoteReady || beforeFallback != remote.serialFallback {
			h.logEvent(sender, "serial_p2p_state", "local_id=%q remote_id=%q local_ready=%t remote_ready=%t direct=%t reported_reason=%q",
				target.localID, remote.remoteID, remote.serialLocalReady, remote.serialRemoteReady, remote.serialDirect, remote.serialFallbackReason)
		}
		if d := message.P2PDetails; message.ProbeKind == "fallback" && d != nil {
			reporter := uint8(1)
			if sender == remote {
				reporter = 2
			}
			if remote.serialFailureLogged&reporter == 0 {
				remote.serialFailureLogged |= reporter
				code := -1
				if d.SCTPCauseCode != nil {
					code = *d.SCTPCauseCode
				}
				h.logEvent(sender, "serial_p2p_failure_details", "local_id=%q remote_id=%q primary=%t reported_reason=%q reported_ice=%q reported_dtls=%q reported_sctp=%q stats_available=%t checks_sent=%d responses_received=%d requests_received=%d valid_pairs=%d application_cause=%q channel_error=%q sctp_cause=%d channel_state=%q serial_buffered=%d assessment_active=%t assessment_buffered=%d",
					target.localID, remote.remoteID, sender.role == remote.serialFallbackReporter, message.P2PReason, d.ICE, d.DTLS, d.SCTP, d.StatsAvailable, d.ChecksSent, d.ResponsesReceived, d.RequestsReceived, d.ValidPairs, d.ApplicationCause, d.ChannelError, code, d.ChannelState, d.SerialBufferedAmount, d.AssessmentActive, d.AssessmentBufferedAmount)
			}
		}
		h.serialState(local, remote, target)
		return
	}
	valid := false
	switch message.ProbeKind {
	case "offer":
		valid = sender == remote && len(message.ProbePayload) > 0 && len(message.ProbePayload) <= 16384
	case "answer":
		valid = sender == local && len(message.ProbePayload) > 0 && len(message.ProbePayload) <= 16384
	case "candidate":
		var candidate struct {
			Candidate string `json:"candidate"`
		}
		valid = len(message.ProbePayload) <= 2048 && json.Unmarshal([]byte(message.ProbePayload), &candidate) == nil &&
			len(candidate.Candidate) > 0 && len(candidate.Candidate) <= 1024
	}
	if !valid || remote.serialFallback {
		h.fail(sender, "invalid_p2p_signal", "Invalid or expired serial negotiation")
		return
	}
	peer := local
	if sender == local {
		peer = remote
	}
	h.relay(sender, []*Client{peer}, Message{Type: MsgTypeSerialSignal, LocalID: target.localID,
		RemoteID: remote.remoteID, PortID: target.portID, GrantID: target.grantID,
		ProbeKind: message.ProbeKind, ProbePayload: message.ProbePayload, P2PAttempt: remote.serialAttempt})
}

func (h *Hub) retrySerialP2P(sender, local, remote *Client, target subscription, message Message) {
	if sender != remote || negotiatedSerialP2PRetry(local, remote) != 1 || !remote.serialFallback ||
		message.ProbePayload != "" || message.P2PReason != "" || message.P2PDetails != nil ||
		remote.serialAttempt >= 3 || remote.serialRetryStarted.IsZero() ||
		!h.now().Before(remote.serialRetryStarted.Add(180*time.Second)) || h.now().Before(remote.serialRetryAfter) ||
		!retryableSerialP2P(remote.serialFallbackReason, remote.serialFallbackDetails) {
		h.fail(sender, "p2p_retry_unavailable", "Serial P2P retry is unavailable for this round")
		return
	}
	remote.serialAttempt++
	remote.serialDirect, remote.serialLocalReady, remote.serialRemoteReady, remote.serialFallback = false, false, false, false
	remote.serialTXRelay = false
	remote.serialFallbackReason, remote.serialFallbackReporter = "", ""
	remote.serialFallbackDetails = nil
	remote.serialFailureLogged = 0
	h.logEvent(sender, "serial_p2p_retry", "local_id=%q remote_id=%q attempt=%d", target.localID, remote.remoteID, remote.serialAttempt+1)
	h.relay(remote, []*Client{local, remote}, Message{Type: MsgTypeSerialState, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, SerialP2PProtocol: 1, SerialP2PRetryProtocol: 1,
		ProbeKind: "retry", P2PAttempt: remote.serialAttempt})
}

func validP2PReason(reason string) bool {
	switch reason {
	case "", "webrtc_unavailable", "webrtc_disabled", "negotiation_timeout", "connection_failed", "connection_disconnected", "connection_closed",
		"channel_closed", "channel_error", "sdp_error", "candidate_error", "signal_limit", "invalid_frame", "application", "backpressure", "peer_fallback":
		return true
	default:
		return false
	}
}

// A permit binds one command's digest and length to the current write state.
// Physical TX still requires a fresh server check, even though its bytes use RTC.
func (h *Hub) serialTX(remote *Client, message Message) {
	local, owner, target, ok := h.serialPeer(remote, message)
	if !ok {
		return
	}
	if owner != remote || remote.role != RoleRemote || target.access != AccessControl {
		h.fail(remote, "read_only", "A fully controlled Remote is required")
		return
	}
	code := ""
	switch {
	case local.writesPaused:
		code = "writes_paused"
	case message.WriteEpoch != local.writeEpoch:
		code = "stale_write_state"
	case local.configuration != nil:
		code = "configuration_busy"
	case h.flashSessions[local] != nil:
		code = "flash_busy"
	case remote.serialTXRelay:
		code = "p2p_tx_relay"
	case !remote.serialDirect:
		code = "p2p_not_ready"
	case message.TXSeq == 0 || message.TXSeq > 9007199254740991 || message.TXSeq <= remote.serialTXSequence ||
		message.ByteLength < 1 || message.ByteLength > MaxDataSize || len(message.SHA256) != 64 ||
		strings.Trim(message.SHA256, "0123456789abcdef") != "":
		code = "invalid_p2p_tx"
	}
	if code != "" {
		description := "Direct serial command was not authorized"
		if code == "p2p_tx_relay" {
			description = "Remote TX is routed over the server after the direct TX queue filled; incomplete direct commands are not replayed"
		}
		h.send(remote, Message{Type: MsgTypeError, Code: code, Error: description, TXSeq: message.TXSeq})
		return
	}
	remote.serialTXSequence = message.TXSeq
	permit := Message{Type: MsgTypeSerialPermit, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, WriteEpoch: local.writeEpoch,
		TXSeq: message.TXSeq, ByteLength: message.ByteLength, SHA256: message.SHA256, P2PAttempt: remote.serialAttempt}
	h.relay(remote, []*Client{local, remote}, permit)
}

// RX keeps the existing global sequence and cache. Only relay recipients need
// the payload on WSS; lightweight heads allow a lost direct tail to be repaired.
func (h *Hub) serialRX(local *Client, message Message) {
	if local.serialP2PProtocol != 1 || local.localID == "" || h.locals[local.localID] != local ||
		h.ports[local.localID].PortID != message.PortID || message.RXStreamID != local.rxStreamID ||
		message.RXSeq != local.rxSequence+1 || len(message.DirectRemotes) > MaxRemotesPerLocal ||
		(message.Data != "" && !validData(message.Data)) {
		h.fail(local, "invalid_rx_sequence", "Invalid direct receive frame")
		return
	}
	direct := make(map[string]bool, len(message.DirectRemotes))
	for _, id := range message.DirectRemotes {
		direct[id] = true
	}
	for remote, target := range h.subscriptions {
		if target.localID == local.localID && target.portID == message.PortID && message.Data == "" &&
			negotiatedSerialP2P(local, remote) == 0 {
			h.fail(local, "invalid_data", "A legacy recipient requires the relay payload")
			return
		}
	}
	local.rxSequence = message.RXSeq
	data := Message{Type: MsgTypeData, LocalID: local.localID, PortID: message.PortID,
		Data: message.Data, RXStreamID: local.rxStreamID, RXSeq: message.RXSeq}
	encoded, _ := json.Marshal(data)
	for remote, target := range h.subscriptions {
		if target.localID != local.localID || target.portID != message.PortID {
			continue
		}
		if message.Data != "" && !(direct[remote.remoteID] && remote.serialDirect) {
			if remote.replay != nil {
				if message.RXSeq > remote.replay.through && negotiatedSerialP2P(local, remote) == 0 {
					if code := local.lease.Outbound(len(encoded)); code != "" {
						h.stopLimited(local, code)
						return
					}
					h.queueRXDuringReplay(remote, data, len(encoded))
				}
			} else {
				h.relay(local, []*Client{remote}, data)
			}
		}
		if negotiatedSerialP2P(local, remote) == 1 {
			h.relay(local, []*Client{remote}, Message{Type: MsgTypeSerialHead, LocalID: local.localID,
				PortID: target.portID, GrantID: target.grantID, RXStreamID: local.rxStreamID, RXSeq: message.RXSeq})
		}
	}
}

func (h *Hub) serialResume(remote *Client, message Message) {
	local, owner, target, ok := h.serialPeer(remote, message)
	if !ok {
		return
	}
	if remote != owner || remote.role != RoleRemote || message.RXStreamID != local.rxStreamID || message.ResumeSeq > local.rxSequence {
		h.fail(remote, "invalid_rx_resume", "Invalid live receive cursor")
		return
	}
	if remote.replay != nil {
		return
	}
	through := local.rxSequence
	if message.ResumeSeq == through {
		h.send(remote, Message{Type: MsgTypeReplayComplete, LocalID: target.localID, PortID: target.portID,
			RXStreamID: local.rxStreamID, ThroughSeq: through})
		return
	}
	remote.replay = &receiveReplay{streamID: local.rxStreamID, through: through, nextSeq: message.ResumeSeq + 1, ackedSeq: message.ResumeSeq}
	h.send(remote, Message{Type: MsgTypeSerialReplay, LocalID: target.localID, PortID: target.portID,
		GrantID: target.grantID, RXStreamID: local.rxStreamID, ThroughSeq: through})
	h.send(local, Message{Type: MsgTypeResumeRX, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, RXStreamID: local.rxStreamID, ResumeSeq: message.ResumeSeq, ThroughSeq: through})
}
