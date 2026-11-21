package websocket

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

const ConfigurationTTL = 30 * time.Second

// SerialConfig contains only Web Serial settings supported by both pages.
type SerialConfig struct {
	BaudRate    int    `json:"baudRate"`
	DataBits    int    `json:"dataBits"`
	StopBits    int    `json:"stopBits"`
	Parity      string `json:"parity"`
	FlowControl string `json:"flowControl"`
}

func validSerialConfig(config *SerialConfig) bool {
	if config == nil || (config.DataBits != 7 && config.DataBits != 8) ||
		(config.StopBits != 1 && config.StopBits != 2) ||
		(config.Parity != "none" && config.Parity != "odd" && config.Parity != "even") ||
		(config.FlowControl != "none" && config.FlowControl != "hardware") {
		return false
	}
	switch config.BaudRate {
	case 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600:
		return true
	}
	return false
}

func sameSerialConfig(a, b *SerialConfig) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

type configurationChange struct {
	id             string
	requestID      string
	flashSessionID string
	remote         *Client
	target         subscription
	desired        SerialConfig
	expiresAt      time.Time
	cancelled      bool
}

func (h *Hub) withSerialState(local *Client, message Message) Message {
	if local.serialConfig != nil {
		config := *local.serialConfig
		message.SerialConfig = &config
		message.ConfigProtocol = 1
		message.ConfigRevision = local.configRevision
		message.Configuring = boolPointer(local.configuration != nil)
		if message.PortID == "" {
			message.PortID = h.ports[local.localID].PortID
		}
		if local.configuration != nil {
			message.ConfigID = local.configuration.id
		}
	}
	return message
}

func (h *Hub) broadcastSerialState(local *Client) {
	state := h.withSerialState(local, Message{Type: MsgTypeSerialConfigState, LocalID: local.localID,
		PortID: h.ports[local.localID].PortID, Version: ProtocolVersion,
		WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused)})
	if !h.send(local, state) {
		return
	}
	// Existing v3 Remotes also need the new epoch even if they do not render
	// configuration fields. New pages additionally honor configuring.
	state.Type = MsgTypeWriteState
	for remote, target := range h.subscriptions {
		if target.localID == local.localID {
			h.send(remote, state)
		}
	}
}

func (h *Hub) configurationError(remote *Client, requestID, code, detail string) {
	h.send(remote, Message{Type: MsgTypeError, RequestID: requestID, Code: code, Error: detail})
}

func (h *Hub) configure(remote *Client, message Message) {
	target, approved := h.subscriptions[remote]
	fail := func(code, detail string) { h.configurationError(remote, message.RequestID, code, detail) }
	if !approved {
		fail("not_connected", "Request access before changing serial settings")
		return
	}
	if target.access != AccessControl {
		fail("read_only", "Read-only access cannot change serial settings")
		return
	}
	local := h.locals[target.localID]
	if local == nil || message.PortID != target.portID {
		fail("port_not_available", "The approved Local and port must match")
		return
	}
	if session := h.flashSessions[local]; session != nil {
		if session.remote != remote || session.starting || session.ending || message.FlashSessionID != session.id {
			fail("flash_busy", "The serial port is reserved for ESP32 flashing")
			return
		}
	} else if message.FlashSessionID != "" {
		fail("stale_flash_session", "Flash session is no longer active")
		return
	}
	if message.GrantID == "" || message.GrantID != target.grantID {
		fail("stale_grant", "Configuration authorization has changed")
		return
	}
	if local.writesPaused {
		fail("writes_paused", "Local paused remote operations")
		return
	}
	if message.WriteEpoch != local.writeEpoch {
		fail("stale_write_state", "Write state changed; submit a new configuration request")
		return
	}
	if local.serialConfig == nil || message.ConfigProtocol != 1 {
		fail("configuration_unsupported", "Update Local to enable remote configuration")
		return
	}
	if local.configuration != nil {
		fail("configuration_busy", "Another configuration request is still pending")
		return
	}
	for _, signal := range h.signalRequests {
		if signal.local == local {
			fail("serial_busy", "A serial control operation is still pending")
			return
		}
	}
	if message.ConfigRevision != local.configRevision {
		fail("stale_configuration", "Serial settings have changed; review the current settings")
		return
	}
	if message.RequestID == "" || len(message.RequestID) > 128 || !validSerialConfig(message.SerialConfig) {
		fail("invalid_configuration", "Specify a request ID and supported serial settings")
		return
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		fail("request_failed", "Unable to create a configuration transaction")
		return
	}
	change := &configurationChange{id: base64.RawURLEncoding.EncodeToString(bytes[:]), requestID: message.RequestID,
		flashSessionID: message.FlashSessionID,
		remote:         remote, target: target, desired: *message.SerialConfig, expiresAt: h.now().Add(ConfigurationTTL)}
	local.configuration = change
	local.writeEpoch++
	h.broadcastSerialState(local)
	if local.configuration != change || h.locals[target.localID] != local {
		return
	}
	h.send(local, Message{Type: MsgTypeSetSerialConfig, Version: ProtocolVersion, ConfigProtocol: 1,
		ConfigID: change.id, RequestID: change.requestID, LocalID: target.localID, PortID: target.portID,
		RemoteID: remote.remoteID, GrantID: target.grantID, WriteEpoch: local.writeEpoch,
		FlashSessionID: change.flashSessionID, ConfigRevision: local.configRevision, SerialConfig: &change.desired})
	h.logEvent(local, "serial_config_requested", "remote_id=%q config_revision=%d", remote.remoteID, local.configRevision)
}

// Cancellation prevents the next hardware step. An already-started driver call
// must settle before Local reports the actual parameters; it cannot be recalled.
func (h *Hub) cancelConfiguration(local, remote *Client, code string) {
	if local == nil || local.configuration == nil {
		return
	}
	change := local.configuration
	if remote != nil && change.remote != remote || change.cancelled {
		return
	}
	change.cancelled = true
	h.send(local, Message{Type: MsgTypeCancelSerialConfig, ConfigID: change.id, Code: code})
}

func (h *Hub) finishConfiguration(local *Client, message Message) {
	change := local.configuration
	if change == nil || local.localID == "" || h.locals[local.localID] != local ||
		message.ConfigID != change.id || message.PortID != change.target.portID ||
		message.ConfigProtocol != 1 || message.FlashSessionID != change.flashSessionID || message.Success == nil || message.PortOpen == nil {
		h.fail(local, "stale_configuration", "Configuration transaction no longer belongs to this Local")
		return
	}
	if !h.now().Before(change.expiresAt) {
		h.stopConfiguration(local, "configuration_timeout")
		return
	}
	if !*message.PortOpen || !validSerialConfig(message.SerialConfig) ||
		(*message.Success && !sameSerialConfig(message.SerialConfig, &change.desired)) ||
		(!*message.Success && !sameSerialConfig(message.SerialConfig, local.serialConfig)) {
		h.stopConfiguration(local, "configuration_failed")
		return
	}
	if !sameSerialConfig(local.serialConfig, message.SerialConfig) {
		config := *message.SerialConfig
		local.serialConfig = &config
		local.configRevision++
	}
	local.configuration = nil
	local.writeEpoch++
	code := ""
	if !*message.Success {
		code = "configuration_failed"
		switch message.Code {
		case "serial_busy", "permission_revoked", "writes_paused", "configuration_cancelled":
			code = message.Code
		}
	}
	if current, ok := h.subscriptions[change.remote]; ok && current == change.target {
		h.send(change.remote, h.withSerialState(local, Message{Type: MsgTypeSerialConfigResult,
			RequestID: change.requestID, ConfigID: change.id, Success: message.Success,
			Code: code, LocalID: local.localID, PortID: change.target.portID, GrantID: change.target.grantID,
			FlashSessionID: change.flashSessionID, WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused), Version: ProtocolVersion}))
	}
	h.broadcastSerialState(local)
	h.logEvent(local, "serial_config_completed", "success=%t config_revision=%d", *message.Success, local.configRevision)
}

func (h *Hub) stopConfiguration(local *Client, code string) {
	change := local.configuration
	if change == nil {
		return
	}
	if current, ok := h.subscriptions[change.remote]; ok && current == change.target {
		h.configurationError(change.remote, change.requestID, code, "Serial state is uncertain; sharing has stopped")
	}
	h.send(local, Message{Type: MsgTypeSharingStopped, ConfigID: change.id, Code: code})
	h.unshare(local)
}

func (h *Hub) expireConfigurations() {
	for _, local := range h.locals {
		if local.configuration != nil && !h.now().Before(local.configuration.expiresAt) {
			h.stopConfiguration(local, "configuration_timeout")
		}
	}
}
