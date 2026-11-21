package websocket

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

const (
	FlashSessionTTL       = 90 * time.Second
	SerialSignalsTTL      = 10 * time.Second
	MaxPendingSignalCalls = 8
)

func flashToken() (string, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(token[:]), nil
}

func (h *Hub) withFlashState(local, remote *Client, message Message) Message {
	if local.flashProtocol == 1 && remote.flashProtocol == 1 {
		message.FlashProtocol = 1
	}
	message.SerialSignalsProtocol = local.serialSignalsProtocol
	session := h.flashSessions[local]
	active := session != nil
	starting := session != nil && session.starting
	ending := session != nil && session.ending
	message.FlashActive = boolPointer(active)
	message.FlashStarting = boolPointer(starting)
	message.FlashEnding = boolPointer(ending)
	message.FlashOwnerID = ""
	message.FlashSessionID = ""
	if session != nil {
		message.FlashOwnerID = session.remote.remoteID
		if remote == session.remote && !session.starting {
			message.FlashSessionID = session.id
		}
	}
	return message
}

func (h *Hub) broadcastFlashState(local *Client) {
	if local == nil || local.localID == "" || h.locals[local.localID] != local {
		return
	}
	session := h.flashSessions[local]
	for remote, target := range h.subscriptions {
		if target.localID != local.localID {
			continue
		}
		state := Message{Type: MsgTypeFlashState, LocalID: local.localID, PortID: target.portID,
			Version: ProtocolVersion, WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused)}
		h.send(remote, h.withFlashState(local, remote, state))
	}
	state := Message{Type: MsgTypeFlashState, LocalID: local.localID,
		PortID: h.ports[local.localID].PortID, Version: ProtocolVersion,
		WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused)}
	if session != nil {
		state.FlashSessionID = session.id
		state.FlashOwnerID = session.remote.remoteID
	}
	state.FlashActive = boolPointer(session != nil)
	state.FlashStarting = boolPointer(session != nil && session.starting)
	state.FlashEnding = boolPointer(session != nil && session.ending)
	state.SerialSignalsProtocol = local.serialSignalsProtocol
	state.FlashProtocol = local.flashProtocol
	h.send(local, state)
}

func (h *Hub) beginFlashSession(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok {
		h.fail(remote, "not_connected", "Connect to a Local before starting a flash session")
		return
	}
	if target.access != AccessControl {
		h.fail(remote, "read_only", "A fully controlled connection is required for remote flashing")
		return
	}
	local := h.locals[target.localID]
	if local == nil || message.PortID != target.portID {
		h.fail(remote, "port_not_available", "The approved Local and serial port must match")
		return
	}
	if remote.flashProtocol != 1 || local.flashProtocol != 1 || local.serialSignalsProtocol != 1 || local.serialConfig == nil {
		h.fail(remote, "flash_unsupported", "Update both pages to enable remote ESP32 flashing")
		return
	}
	if message.RequestID == "" || len(message.RequestID) > 128 || message.GrantID != target.grantID {
		h.fail(remote, "stale_grant", "Flash request is missing its current authorization")
		return
	}
	if local.writesPaused {
		h.fail(remote, "writes_paused", "Local paused remote operations")
		return
	}
	if message.WriteEpoch != local.writeEpoch {
		h.fail(remote, "stale_write_state", "Write state changed; reconnect before flashing")
		return
	}
	if local.configuration != nil {
		h.fail(remote, "configuration_busy", "Wait for serial configuration to finish before flashing")
		return
	}
	if h.flashSessions[local] != nil {
		h.fail(remote, "flash_busy", "Another remote flash session is active")
		return
	}
	id, err := flashToken()
	if err != nil {
		h.fail(remote, "request_failed", "Unable to create a flash session")
		return
	}
	session := &flashSession{id: id, requestID: message.RequestID, remote: remote, local: local,
		target: target, starting: true, expiresAt: h.now().Add(FlashSessionTTL)}
	h.flashSessions[local] = session
	local.writeEpoch++
	h.broadcastFlashState(local)
	if !h.send(local, Message{Type: MsgTypeBeginFlash, RequestID: message.RequestID,
		FlashSessionID: id, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, WriteEpoch: local.writeEpoch,
		Version: ProtocolVersion}) {
		h.releaseFlashSession(local, "local_disconnected", false)
		return
	}
	h.logEvent(local, "flash_session_starting", "remote_id=%q", remote.remoteID)
}

func (h *Hub) endFlashSession(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok {
		h.fail(remote, "not_connected", "No approved Local connection")
		return
	}
	local := h.locals[target.localID]
	session := h.flashSessions[local]
	if session == nil || session.remote != remote || session.id != message.FlashSessionID || target != session.target {
		h.fail(remote, "stale_flash_session", "Flash session is no longer active")
		return
	}
	if session.starting || session.ending || message.RequestID == "" || len(message.RequestID) > 128 {
		h.fail(remote, "flash_busy", "Flash session is still changing state")
		return
	}
	if local.configuration != nil {
		h.fail(remote, "configuration_busy", "Wait for serial configuration to finish before ending the flash session")
		return
	}
	for _, request := range h.signalRequests {
		if request.local == local && request.flashID == session.id {
			h.fail(remote, "serial_busy", "Wait for the serial control operation to finish")
			return
		}
	}
	if message.GrantID != target.grantID || message.WriteEpoch != local.writeEpoch {
		h.fail(remote, "stale_write_state", "Flash authorization changed")
		return
	}
	session.requestID = message.RequestID
	session.ending = true
	session.expiresAt = h.now().Add(FlashSessionTTL)
	h.broadcastFlashState(local)
	if !h.send(local, Message{Type: MsgTypeEndFlash, RequestID: message.RequestID,
		FlashSessionID: session.id, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, WriteEpoch: local.writeEpoch,
		Version: ProtocolVersion}) {
		h.releaseFlashSession(local, "local_disconnected", false)
	}
}

func (h *Hub) keepFlashSession(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok {
		return
	}
	local := h.locals[target.localID]
	session := h.flashSessions[local]
	if session != nil && session.remote == remote && session.id == message.FlashSessionID &&
		!session.starting && !session.ending && message.GrantID == target.grantID &&
		message.WriteEpoch == local.writeEpoch && !local.writesPaused {
		session.expiresAt = h.now().Add(FlashSessionTTL)
	}
}

func (h *Hub) finishFlashSession(local *Client, message Message) {
	session := h.flashSessions[local]
	if session == nil || session.local != local || local.localID == "" ||
		h.locals[local.localID] != local || message.FlashSessionID != session.id ||
		message.RequestID != session.requestID || message.RemoteID != session.remote.remoteID ||
		message.PortID != session.target.portID || message.GrantID != session.target.grantID ||
		message.WriteEpoch != local.writeEpoch || message.Success == nil {
		h.fail(local, "stale_flash_session", "Flash session result does not match the active operation")
		return
	}
	if session.starting {
		if !*message.Success {
			code := message.Code
			if code == "" {
				code = "flash_start_failed"
			}
			h.send(session.remote, Message{Type: MsgTypeFlashResult, RequestID: session.requestID,
				FlashSessionID: session.id, Success: boolPointer(false), Code: code,
				LocalID: local.localID, PortID: session.target.portID})
			h.releaseFlashSession(local, "", false)
			return
		}
		session.starting = false
		session.expiresAt = h.now().Add(FlashSessionTTL)
		h.send(session.remote, Message{Type: MsgTypeFlashResult, RequestID: session.requestID,
			FlashSessionID: session.id, Success: boolPointer(true), LocalID: local.localID,
			PortID: session.target.portID, GrantID: session.target.grantID, WriteEpoch: local.writeEpoch})
		h.broadcastFlashState(local)
		h.logEvent(local, "flash_session_started", "remote_id=%q", session.remote.remoteID)
		return
	}
	if session.ending {
		if !*message.Success {
			h.releaseFlashSession(local, message.Code, true)
			return
		}
		h.send(session.remote, Message{Type: MsgTypeFlashResult, RequestID: session.requestID,
			FlashSessionID: session.id, Success: boolPointer(true), LocalID: local.localID,
			PortID: session.target.portID, GrantID: session.target.grantID, WriteEpoch: local.writeEpoch})
		h.releaseFlashSession(local, "", false)
	}
}

func (h *Hub) releaseFlashSession(local *Client, code string, notifyOwner bool) {
	session := h.flashSessions[local]
	if session == nil {
		return
	}
	delete(h.flashSessions, local)
	local.writeEpoch++
	for requestID, request := range h.signalRequests {
		if request.local == local && request.flashID == session.id {
			delete(h.signalRequests, requestID)
			h.send(local, Message{Type: MsgTypeCancelSerialSignals, RequestID: requestID, FlashSessionID: session.id})
			if h.clients[request.remote] {
				h.fail(request.remote, "stale_flash_session", "Flash session ended before the serial control completed")
			}
		}
	}
	if notifyOwner && h.clients[session.remote] {
		if code == "" {
			code = "flash_aborted"
		}
		h.send(session.remote, Message{Type: MsgTypeFlashResult, RequestID: session.requestID,
			FlashSessionID: session.id, Success: boolPointer(false), Code: code,
			LocalID: session.target.localID, PortID: session.target.portID})
	}
	h.broadcastFlashState(local)
	h.logEvent(local, "flash_session_ended", "remote_id=%q code=%q", session.remote.remoteID, code)
}

func (h *Hub) setSerialSignals(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok || target.access != AccessControl {
		h.fail(remote, "read_only", "A fully controlled connection is required")
		return
	}
	local := h.locals[target.localID]
	session := h.flashSessions[local]
	if local == nil || target.portID != message.PortID || session == nil || session.remote != remote ||
		session.starting || session.ending || session.id != message.FlashSessionID {
		h.fail(remote, "stale_flash_session", "Serial signals are available only during your active flash session")
		return
	}
	if local.serialSignalsProtocol != 1 {
		h.fail(remote, "signals_unsupported", "Local does not support remote serial signals")
		return
	}
	if local.writesPaused || message.WriteEpoch != local.writeEpoch || message.GrantID != target.grantID {
		h.fail(remote, "stale_write_state", "Remote write authorization changed")
		return
	}
	if local.configuration != nil {
		h.fail(remote, "configuration_busy", "Serial configuration is changing")
		return
	}
	if message.RequestID == "" || len(message.RequestID) > 128 ||
		(message.DataTerminalReady == nil && message.RequestToSend == nil) || h.signalRequests[message.RequestID] != nil {
		h.fail(remote, "invalid_serial_signals", "Serial signal request is invalid")
		return
	}
	pending := 0
	for _, request := range h.signalRequests {
		if request.remote == remote {
			pending++
		}
	}
	if pending >= MaxPendingSignalCalls {
		h.fail(remote, "serial_busy", "Too many serial control operations are pending")
		return
	}
	h.signalRequests[message.RequestID] = &signalRequest{remote: remote, local: local, target: target,
		flashID: session.id, expiresAt: h.now().Add(SerialSignalsTTL)}
	if !h.send(local, Message{Type: MsgTypeSetSerialSignals, RequestID: message.RequestID,
		FlashSessionID: session.id, LocalID: local.localID, RemoteID: remote.remoteID, PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch, DataTerminalReady: message.DataTerminalReady,
		RequestToSend: message.RequestToSend, Version: ProtocolVersion}) {
		delete(h.signalRequests, message.RequestID)
	}
}

func (h *Hub) finishSerialSignals(local *Client, message Message) {
	request := h.signalRequests[message.RequestID]
	if request == nil || request.local != local || local.localID == "" ||
		h.locals[local.localID] != local || request.target.portID != message.PortID ||
		request.target.grantID != message.GrantID || request.flashID != message.FlashSessionID || message.Success == nil {
		h.fail(local, "stale_serial_signals", "Serial signal result does not match a live request")
		return
	}
	delete(h.signalRequests, message.RequestID)
	target, ok := h.subscriptions[request.remote]
	session := h.flashSessions[local]
	if !ok || target != request.target || session == nil || session.remote != request.remote || session.id != request.flashID ||
		local.writesPaused || local.writeEpoch != message.WriteEpoch {
		return
	}
	h.send(request.remote, Message{Type: MsgTypeSerialSignalsResult, RequestID: message.RequestID,
		FlashSessionID: request.flashID, Success: message.Success, Code: message.Code,
		LocalID: local.localID, PortID: target.portID, GrantID: target.grantID,
		WriteEpoch: local.writeEpoch})
}

func (h *Hub) expireSignalRequests() {
	for id, request := range h.signalRequests {
		if !h.now().Before(request.expiresAt) {
			delete(h.signalRequests, id)
			h.send(request.local, Message{Type: MsgTypeCancelSerialSignals, RequestID: id, FlashSessionID: request.flashID})
			if h.clients[request.remote] {
				h.send(request.remote, Message{Type: MsgTypeSerialSignalsResult, RequestID: id,
					FlashSessionID: request.flashID, Success: boolPointer(false), Code: "serial_signals_timeout",
					LocalID: request.target.localID, PortID: request.target.portID,
					GrantID: request.target.grantID, WriteEpoch: request.local.writeEpoch})
			}
			h.logEvent(request.local, "serial_signals_timeout", "remote_id=%q", request.remote.remoteID)
		}
	}
	for local, session := range h.flashSessions {
		if !h.now().Before(session.expiresAt) {
			h.releaseFlashSession(local, "flash_session_timeout", true)
		}
	}
}

func (h *Hub) forwardFlashSend(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok || target.access != AccessControl {
		h.fail(remote, "read_only", "A fully controlled connection is required for remote flashing")
		return
	}
	local := h.locals[target.localID]
	session := h.flashSessions[local]
	if local == nil || target.portID != message.PortID || session == nil || session.remote != remote ||
		session.starting || session.ending || session.id != message.FlashSessionID {
		h.fail(remote, "stale_flash_session", "Flash session is no longer active")
		return
	}
	if message.GrantID != target.grantID {
		h.fail(remote, "stale_grant", "Flash permission has changed")
		return
	}
	if local.writesPaused {
		h.fail(remote, "writes_paused", "Local paused remote operations")
		return
	}
	if message.WriteEpoch != local.writeEpoch {
		h.fail(remote, "stale_write_state", "Flash write state changed")
		return
	}
	if local.configuration != nil || !validData(message.Data) {
		code := "invalid_data"
		detail := "Flash data must be non-empty Base64"
		if local.configuration != nil {
			code, detail = "configuration_busy", "Serial configuration is changing"
		}
		h.fail(remote, code, detail)
		return
	}
	session.expiresAt = h.now().Add(FlashSessionTTL)
	h.relay(remote, []*Client{local}, Message{Type: MsgTypeSend, RemoteID: remote.remoteID,
		PortID: target.portID, Data: message.Data, GrantID: target.grantID,
		WriteEpoch: local.writeEpoch, FlashSessionID: session.id})
}
