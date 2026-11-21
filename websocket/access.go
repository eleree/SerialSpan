package websocket

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

type Access string

const (
	AccessRead         Access = "read"
	AccessControl      Access = "control"
	ApprovalTTL               = 60 * time.Second
	MaxPendingPerLocal        = 8
	MaxRemotesPerLocal        = 16
)

type connectionRequest struct {
	id             string
	local          *Client
	remote         *Client
	target         subscription
	resumeStreamID string
	resumeSeq      uint64
	expiresAt      time.Time
}

// Request IDs correlate one decision with one live socket; they are not bearer
// credentials. Only the owning Local socket can approve, deny or revoke access.
func (h *Hub) requestConnection(remote, local *Client, target subscription, resumeStreamID string, resumeSeq uint64) {
	if previous := h.pending[remote]; previous != nil && previous.target == target && h.now().Before(previous.expiresAt) {
		h.sendPending(previous)
		return
	}
	count := 0
	for other, request := range h.pending {
		if other != remote && request.local == local {
			count++
		}
	}
	if count >= MaxPendingPerLocal {
		h.fail(remote, "too_many_requests", "Local has too many pending requests")
		return
	}
	var id string
	for attempt := 0; attempt < 16; attempt++ {
		bytes := make([]byte, 16)
		if _, err := rand.Read(bytes); err != nil {
			h.fail(remote, "request_failed", "Unable to create an approval request")
			return
		}
		id = base64.RawURLEncoding.EncodeToString(bytes)
		if h.requests[id] == nil {
			break
		}
		id = ""
	}
	if id == "" {
		h.fail(remote, "request_failed", "Unable to create a unique approval request")
		return
	}
	h.cancelRequest(remote, "request_replaced", false)
	if !h.clients[remote] || h.locals[target.localID] != local {
		h.fail(remote, "local_disconnected", "Local disconnected while replacing the request")
		return
	}
	request := &connectionRequest{id: id, local: local, remote: remote, target: target,
		resumeStreamID: resumeStreamID, resumeSeq: resumeSeq, expiresAt: h.now().Add(ApprovalTTL)}
	h.pending[remote] = request
	h.requests[id] = request
	if !h.send(local, Message{Type: MsgTypeConnectionRequest, RequestID: id, LocalID: target.localID,
		RemoteID: remote.remoteID, PortID: target.portID, Access: target.access, ExpiresIn: int(ApprovalTTL / time.Second), Version: ProtocolVersion}) {
		return
	}
	h.sendPending(request)
}

func (h *Hub) sendPending(request *connectionRequest) {
	remaining := request.expiresAt.Sub(h.now())
	h.send(request.remote, Message{Type: MsgTypeConnectPending, RequestID: request.id,
		LocalID: request.target.localID, RemoteID: request.remote.remoteID,
		Access: request.target.access, ExpiresIn: int((remaining + time.Second - 1) / time.Second), Version: ProtocolVersion})
}

func (h *Hub) forgetRequest(request *connectionRequest) {
	delete(h.requests, request.id)
	delete(h.pending, request.remote)
}

func (h *Hub) cancelRequest(remote *Client, reason string, notifyRemote bool) {
	request := h.pending[remote]
	if request == nil {
		return
	}
	h.forgetRequest(request)
	h.send(request.local, Message{Type: MsgTypeRequestCancelled, RequestID: request.id, RemoteID: remote.remoteID, Code: reason})
	if notifyRemote {
		detail := "Connection request was cancelled"
		switch reason {
		case "connection_denied":
			detail = "Local declined the connection request"
		case "approval_timeout":
			detail = "Local did not approve the request within 60 seconds"
		case "local_disconnected":
			detail = "Local stopped sharing the serial port"
		}
		h.fail(remote, reason, detail)
	}
}

func (h *Hub) expireRequests() {
	for remote, request := range h.pending {
		if !h.now().Before(request.expiresAt) {
			h.cancelRequest(remote, "approval_timeout", true)
		}
	}
}

func (h *Hub) ownedRequest(local *Client, id string) *connectionRequest {
	request := h.requests[id]
	if request == nil {
		h.fail(local, "request_not_found", "Connection request no longer exists")
		return nil
	}
	if request.local != local || h.locals[request.target.localID] != local {
		h.fail(local, "permission_denied", "Only the sharing Local can decide this request")
		return nil
	}
	if !h.now().Before(request.expiresAt) {
		h.cancelRequest(request.remote, "approval_timeout", true)
		h.fail(local, "request_expired", "Connection request has expired")
		return nil
	}
	return request
}

func (h *Hub) approve(local *Client, message Message) {
	request := h.ownedRequest(local, message.RequestID)
	if request == nil {
		return
	}
	if message.Access != AccessRead && message.Access != AccessControl {
		h.failDecision(local, request, "invalid_access", "Choose read or control access")
		return
	}
	if message.Access == AccessControl && request.target.access != AccessControl {
		h.failDecision(local, request, "permission_denied", "Cannot grant more access than Remote requested")
		return
	}
	count := 0
	for remote, target := range h.subscriptions {
		if remote == request.remote || target.localID != request.target.localID {
			continue
		}
		count++
	}
	if count >= MaxRemotesPerLocal {
		h.failDecision(local, request, "too_many_remotes", "Local has reached its approved connection limit")
		return
	}
	remote := request.remote
	target := request.target
	resumeStreamID, resumeSeq := request.resumeStreamID, request.resumeSeq
	target.access = message.Access
	target.grantID = request.id
	h.forgetRequest(request)
	h.detach(remote)
	if !h.clients[remote] || h.locals[target.localID] != local {
		h.fail(remote, "local_disconnected", "Local disconnected while approving the request")
		return
	}
	h.subscriptions[remote] = target
	remote.serialRetryStarted = h.now()
	h.logEvent(local, "serial_p2p_capability", "local_id=%q remote_id=%q enabled=%t", target.localID, remote.remoteID, negotiatedSerialP2P(local, remote) == 1)
	if !h.send(local, Message{Type: MsgTypeRemoteConnected, RequestID: request.id, RemoteID: remote.remoteID,
		PortID: target.portID, Access: target.access, GrantID: target.grantID, ProbeProtocol: negotiatedProbe(local, remote), SerialP2PProtocol: negotiatedSerialP2P(local, remote), SerialP2PRetryProtocol: negotiatedSerialP2PRetry(local, remote), SerialP2PTXRelayProtocol: negotiatedSerialP2PTXRelay(local, remote)}) {
		return
	}
	if local.rxReplayProtocol == RXReplayProtocolVersion && remote.rxReplayProtocol == RXReplayProtocolVersion &&
		resumeStreamID != "" && resumeStreamID == local.rxStreamID && resumeSeq < local.rxSequence {
		remote.replay = &receiveReplay{streamID: local.rxStreamID, through: local.rxSequence, nextSeq: resumeSeq + 1}
		if !h.send(local, Message{Type: MsgTypeResumeRX, LocalID: target.localID, RemoteID: remote.remoteID,
			PortID: target.portID, GrantID: target.grantID, RXStreamID: local.rxStreamID,
			ResumeSeq: resumeSeq, ThroughSeq: local.rxSequence}) {
			return
		}
	}
	connected := h.withRXReplayState(local, remote, Message{Type: MsgTypeConnect, RequestID: request.id, LocalID: target.localID,
		RemoteID: remote.remoteID, PortID: target.portID, Access: target.access, Version: ProtocolVersion,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused)})
	connected.ProbeProtocol = negotiatedProbe(local, remote)
	connected.SerialP2PProtocol = negotiatedSerialP2P(local, remote)
	connected.SerialP2PRetryProtocol = negotiatedSerialP2PRetry(local, remote)
	connected.SerialP2PTXRelayProtocol = negotiatedSerialP2PTXRelay(local, remote)
	h.send(remote, h.withFlashState(local, remote, h.withSerialState(local, connected)))
}

func boolPointer(value bool) *bool { return &value }

func (h *Hub) setWriteState(local *Client, message Message) {
	if local.localID == "" || h.locals[local.localID] != local {
		h.fail(local, "not_sharing", "Local must be sharing a port")
		return
	}
	if message.Version != ProtocolVersion || message.Paused == nil || message.RequestID == "" || len(message.RequestID) > 128 {
		h.fail(local, "invalid_write_state", "Specify a pause state and request ID using protocol v3")
		return
	}
	if local.configuration != nil && !*message.Paused {
		h.send(local, Message{Type: MsgTypeError, RequestID: message.RequestID, Code: "configuration_busy", Error: "Wait for serial configuration to settle before resuming"})
		return
	}
	if *message.Paused {
		h.cancelConfiguration(local, nil, "writes_paused")
		if h.flashSessions[local] != nil {
			h.releaseFlashSession(local, "writes_paused", true)
		}
	}
	local.writesPaused = *message.Paused
	local.writeEpoch++
	h.logEvent(local, "remote_write_state", "paused=%t write_epoch=%d", local.writesPaused, local.writeEpoch)
	state := Message{Type: MsgTypeWriteState, LocalID: local.localID, Paused: boolPointer(local.writesPaused), WriteEpoch: local.writeEpoch, Version: ProtocolVersion, RequestID: message.RequestID}
	if !h.send(local, state) {
		return
	}
	state.RequestID = ""
	for remote, target := range h.subscriptions {
		if target.localID == local.localID {
			h.send(remote, state)
		}
	}
}

func (h *Hub) failDecision(local *Client, request *connectionRequest, code, message string) {
	h.send(local, Message{Type: MsgTypeError, RequestID: request.id, Code: code, Error: message})
}

func (h *Hub) reject(local *Client, message Message) {
	request := h.ownedRequest(local, message.RequestID)
	if request != nil {
		h.cancelRequest(request.remote, "connection_denied", true)
	}
}

func (h *Hub) revoke(local *Client, message Message) {
	remote := h.remotes[message.RemoteID]
	target, ok := h.subscriptions[remote]
	if !ok || h.locals[target.localID] != local {
		h.fail(local, "permission_denied", "Only the sharing Local can revoke this connection")
		return
	}
	h.detach(remote)
	h.send(remote, Message{Type: MsgTypePermissionRevoked, LocalID: target.localID, PortID: target.portID})
}
