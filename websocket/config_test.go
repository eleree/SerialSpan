package websocket

import (
	"strings"
	"testing"
	"time"
)

func configurationFixture(t *testing.T, access Access) (*Hub, *Client, *Client) {
	t.Helper()
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	config := &SerialConfig{BaudRate: 115200, DataBits: 8, StopBits: 1, Parity: "none", FlowControl: "none"}
	h.handle(local, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23",
		Ports: []PortInfo{{PortID: "usb", Name: "USB"}}, ConfigProtocol: 1, SerialConfig: config})
	ready := takeReady(t, local, MsgTypeRegister)
	if ready.ConfigRevision != 1 || ready.ConfigProtocol != 1 || !sameSerialConfig(ready.SerialConfig, config) {
		t.Fatalf("configuration not acknowledged: %+v", ready)
	}
	grantAccess(t, h, remote, local, requestAccess(t, h, remote, local, access), access)
	return h, local, remote
}

func TestAllSupportedSerialConfigurations(t *testing.T) {
	for _, baud := range []int{9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600} {
		for _, bits := range []int{7, 8} {
			for _, stop := range []int{1, 2} {
				for _, parity := range []string{"none", "odd", "even"} {
					for _, flow := range []string{"none", "hardware"} {
						if !validSerialConfig(&SerialConfig{BaudRate: baud, DataBits: bits, StopBits: stop, Parity: parity, FlowControl: flow}) {
							t.Fatal("supported serial configuration rejected")
						}
					}
				}
			}
		}
	}
}

func configurationMessage(h *Hub, local, remote *Client) Message {
	return Message{Type: MsgTypeSetSerialConfig, ConfigProtocol: 1, PortID: "usb", RequestID: "edit-1",
		GrantID: h.subscriptions[remote].grantID, WriteEpoch: local.writeEpoch, ConfigRevision: local.configRevision,
		SerialConfig: &SerialConfig{BaudRate: 9600, DataBits: 7, StopBits: 2, Parity: "even", FlowControl: "hardware"}}
}

func startConfiguration(t *testing.T, h *Hub, local, remote *Client) Message {
	t.Helper()
	h.handle(remote, configurationMessage(h, local, remote))
	state := takeReady(t, local, MsgTypeSerialConfigState)
	request := takeReady(t, local, MsgTypeSetSerialConfig)
	remoteState := takeReady(t, remote, MsgTypeWriteState)
	if state.Configuring == nil || !*state.Configuring || state.WriteEpoch != 2 ||
		request.ConfigID == "" || request.ConfigID != state.ConfigID || request.ConfigID != remoteState.ConfigID {
		t.Fatalf("configuration not locked: %+v %+v %+v", state, request, remoteState)
	}
	return request
}

func configurationResult(request Message, success bool, config *SerialConfig) Message {
	return Message{Type: MsgTypeSerialConfigResult, ConfigProtocol: 1, ConfigID: request.ConfigID,
		PortID: request.PortID, Success: boolPointer(success), PortOpen: boolPointer(true), SerialConfig: config}
}

func TestConfigurationAuthorizationAndInputBoundaries(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		access     Access
		change     func(*Hub, *Client, *Client, *Message)
	}{
		{"reader", "read_only", AccessRead, func(_ *Hub, _, _ *Client, _ *Message) {}},
		{"unapproved", "not_connected", AccessControl, func(h *Hub, _, r *Client, _ *Message) { delete(h.subscriptions, r) }},
		{"grant", "stale_grant", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.GrantID = "previous" }},
		{"empty-grant", "stale_grant", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.GrantID = "" }},
		{"port", "port_not_available", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.PortID = "other" }},
		{"paused", "writes_paused", AccessControl, func(_ *Hub, l, _ *Client, _ *Message) { l.writesPaused = true }},
		{"epoch", "stale_write_state", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.WriteEpoch = 0 }},
		{"capability", "configuration_unsupported", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.ConfigProtocol = 0 }},
		{"legacy-local", "configuration_unsupported", AccessControl, func(_ *Hub, l, _ *Client, _ *Message) { l.serialConfig = nil }},
		{"revision", "stale_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.ConfigRevision = 0 }},
		{"baud", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig.BaudRate = -1 }},
		{"data-bits", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig.DataBits = 6 }},
		{"stop-bits", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig.StopBits = 3 }},
		{"parity", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig.Parity = "mark" }},
		{"flow", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig.FlowControl = "software" }},
		{"missing", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.SerialConfig = nil }},
		{"request-id", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.RequestID = "" }},
		{"long-id", "invalid_configuration", AccessControl, func(_ *Hub, _, _ *Client, m *Message) { m.RequestID = strings.Repeat("x", 129) }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			h, local, remote := configurationFixture(t, scenario.access)
			message := configurationMessage(h, local, remote)
			scenario.change(h, local, remote, &message)
			h.handle(remote, message)
			if response := takeReady(t, remote, MsgTypeError); response.Code != scenario.code || response.RequestID != message.RequestID {
				t.Fatalf("wrong rejection: %+v", response)
			}
			if len(local.send) != 0 || local.configuration != nil || local.writeEpoch != 1 {
				t.Fatal("rejected request reached hardware owner or changed state")
			}
		})
	}
}

func TestConfigurationIdentityLockAndCommit(t *testing.T) {
	h, local, remote := configurationFixture(t, AccessControl)
	message := configurationMessage(h, local, remote)
	message.LocalID, message.RemoteID = "OTHER", "OTHER"
	h.handle(remote, message)
	takeReady(t, local, MsgTypeSerialConfigState)
	request := takeReady(t, local, MsgTypeSetSerialConfig)
	takeReady(t, remote, MsgTypeWriteState)
	if request.LocalID != local.localID || request.RemoteID != remote.remoteID || request.GrantID != h.subscriptions[remote].grantID {
		t.Fatal("peer-supplied identity escaped the authenticated subscription")
	}
	h.handle(remote, configurationMessage(h, local, remote))
	if takeReady(t, remote, MsgTypeError).Code != "configuration_busy" {
		t.Fatal("overlapping configuration accepted")
	}
	h.handle(remote, Message{Type: MsgTypeSend, PortID: "usb", GrantID: message.GrantID, WriteEpoch: local.writeEpoch, Data: "QQ=="})
	if takeReady(t, remote, MsgTypeError).Code != "configuration_busy" || len(local.send) != 0 {
		t.Fatal("serial send accepted during configuration")
	}
	other := peer(h, RoleLocal)
	result := configurationResult(request, true, request.SerialConfig)
	h.handle(other, result)
	if takeReady(t, other, MsgTypeError).Code != "stale_configuration" || local.configuration == nil {
		t.Fatal("another Local completed the operation")
	}
	stale := result
	stale.ConfigID = "old-operation"
	h.handle(local, stale)
	if takeReady(t, local, MsgTypeError).Code != "stale_configuration" {
		t.Fatal("stale completion accepted")
	}
	h.handle(local, result)
	completed := takeReady(t, remote, MsgTypeSerialConfigResult)
	state := takeReady(t, remote, MsgTypeWriteState)
	takeReady(t, local, MsgTypeSerialConfigState)
	if completed.Success == nil || !*completed.Success || completed.ConfigRevision != 2 ||
		state.Configuring == nil || *state.Configuring || local.configuration != nil || local.writeEpoch != 3 ||
		!sameSerialConfig(local.serialConfig, request.SerialConfig) {
		t.Fatalf("unconfirmed or inconsistent commit: %+v %+v", completed, state)
	}
	h.handle(remote, Message{Type: MsgTypeSend, PortID: "usb", GrantID: message.GrantID, WriteEpoch: 2, Data: "QQ=="})
	if takeReady(t, remote, MsgTypeError).Code != "stale_write_state" {
		t.Fatal("pre-completion write was replayed")
	}
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "Qg=="})
	takeReady(t, local, MsgTypeSend)
}

func TestConfigurationBusyFailurePreservesActualSettings(t *testing.T) {
	h, local, remote := configurationFixture(t, AccessControl)
	request := startConfiguration(t, h, local, remote)
	result := configurationResult(request, false, local.serialConfig)
	result.Code = "serial_busy"
	h.handle(local, result)
	completed := takeReady(t, remote, MsgTypeSerialConfigResult)
	takeReady(t, remote, MsgTypeWriteState)
	takeReady(t, local, MsgTypeSerialConfigState)
	if completed.Success == nil || *completed.Success || completed.Code != "serial_busy" || local.configRevision != 1 ||
		local.serialConfig.BaudRate != 115200 || local.configuration != nil {
		t.Fatal("failed configuration changed actual parameters")
	}
}

func TestConfigurationCancellationKeepsLockUntilLocalSettles(t *testing.T) {
	for _, pause := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoke", true: "pause"}[pause], func(t *testing.T) {
			h, local, remote := configurationFixture(t, AccessControl)
			request := startConfiguration(t, h, local, remote)
			if pause {
				h.handle(local, Message{Type: MsgTypeSetWriteState, Version: 3, RequestID: "pause", Paused: boolPointer(true)})
				takeReady(t, local, MsgTypeCancelSerialConfig)
				takeReady(t, local, MsgTypeWriteState)
				takeReady(t, remote, MsgTypeWriteState)
			} else {
				h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID})
				takeReady(t, local, MsgTypeCancelSerialConfig)
				takeReady(t, local, MsgTypeRemoteDisconnected)
				takeReady(t, remote, MsgTypePermissionRevoked)
			}
			if local.configuration == nil || !local.configuration.cancelled {
				t.Fatal("cancel released the physical operation lock before Local settled")
			}
			h.handle(local, configurationResult(request, false, local.serialConfig))
			if pause {
				takeReady(t, remote, MsgTypeSerialConfigResult)
				takeReady(t, remote, MsgTypeWriteState)
			} else if len(remote.send) != 0 {
				t.Fatal("revoked Remote received configuration metadata")
			}
			takeReady(t, local, MsgTypeSerialConfigState)
			if local.configuration != nil || local.writesPaused != pause || local.configRevision != 1 {
				t.Fatal("cancel completion restored permission or changed parameters")
			}
		})
	}
}

func TestConfigurationTimeoutAndUncertainResultStopSharing(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncertain-result", true: "timeout"}[timeout], func(t *testing.T) {
			h, local, remote := configurationFixture(t, AccessControl)
			request := startConfiguration(t, h, local, remote)
			if timeout {
				deadline := h.now().Add(ConfigurationTTL)
				h.now = func() time.Time { return deadline }
				h.expireConfigurations()
			} else {
				result := configurationResult(request, false, local.serialConfig)
				result.PortOpen = boolPointer(false)
				h.handle(local, result)
			}
			takeReady(t, remote, MsgTypeError)
			takeReady(t, remote, MsgTypeLocalDisconnected)
			takeReady(t, local, MsgTypeSharingStopped)
			takeReady(t, local, MsgTypeCancelSerialConfig)
			if local.localID != "" || local.configuration != nil || len(h.subscriptions) != 0 {
				t.Fatal("uncertain hardware state remained shareable")
			}
			h.handle(local, configurationResult(request, true, request.SerialConfig))
			if takeReady(t, local, MsgTypeError).Code != "stale_configuration" || len(h.locals) != 0 {
				t.Fatal("late hardware result revived a timed-out session")
			}
		})
	}
}

func TestConfigurationRegistrationCannotOverwriteLiveParameters(t *testing.T) {
	h, local, remote := configurationFixture(t, AccessControl)
	bad := &SerialConfig{BaudRate: 9600, DataBits: 8, StopBits: 1, Parity: "none", FlowControl: "none"}
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb", Name: "USB"}}, ConfigProtocol: 1, SerialConfig: bad})
	if takeReady(t, local, MsgTypeError).Code != "invalid_registration" || local.serialConfig.BaudRate != 115200 || len(remote.send) != 0 {
		t.Fatal("repeat register bypassed configuration authorization")
	}
}

func TestConcurrentConfigurationAndReadOnlyObservers(t *testing.T) {
	h, local, first := configurationFixture(t, AccessControl)
	second, observer := peer(h, RoleRemote), peer(h, RoleRemote)
	grantAccess(t, h, second, local, requestAccess(t, h, second, local, AccessControl), AccessControl)
	grantAccess(t, h, observer, local, requestAccess(t, h, observer, local, AccessRead), AccessRead)
	request := startConfiguration(t, h, local, first)
	for _, remote := range []*Client{second, observer} {
		state := takeReady(t, remote, MsgTypeWriteState)
		if state.SerialConfig.BaudRate != 115200 || state.Configuring == nil || !*state.Configuring {
			t.Fatal("observer learned desired settings before physical confirmation")
		}
	}
	h.handle(second, configurationMessage(h, local, second))
	if takeReady(t, second, MsgTypeError).Code != "configuration_busy" || len(local.send) != 0 {
		t.Fatal("a second writer bypassed the configuration lock")
	}
	h.handle(local, configurationResult(request, true, request.SerialConfig))
	takeReady(t, first, MsgTypeSerialConfigResult)
	takeReady(t, local, MsgTypeSerialConfigState)
	for _, remote := range []*Client{first, second, observer} {
		state := takeReady(t, remote, MsgTypeWriteState)
		if state.Configuring == nil || *state.Configuring || state.ConfigRevision != 2 || state.WriteEpoch != 3 || state.SerialConfig.BaudRate != 9600 {
			t.Fatal("approved observers did not receive the confirmed settings and epoch")
		}
	}
}

func TestMalformedConfigurationCapabilityCannotRegister(t *testing.T) {
	for _, config := range []*SerialConfig{nil, {BaudRate: 115200, DataBits: 6, StopBits: 1, Parity: "none", FlowControl: "none"}} {
		h := NewHub()
		local := peer(h, RoleLocal)
		h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb"}}, ConfigProtocol: 1, SerialConfig: config})
		if takeReady(t, local, MsgTypeError).Code != "invalid_registration" || len(h.locals) != 0 {
			t.Fatal("invalid configuration capability was published")
		}
	}
}

func TestMismatchedPhysicalConfigurationResultStopsSharing(t *testing.T) {
	for _, success := range []bool{false, true} {
		h, local, remote := configurationFixture(t, AccessControl)
		request := startConfiguration(t, h, local, remote)
		config := request.SerialConfig
		if success {
			config = local.serialConfig
		}
		h.handle(local, configurationResult(request, success, config))
		takeReady(t, remote, MsgTypeError)
		takeReady(t, remote, MsgTypeLocalDisconnected)
		if local.localID != "" || local.configuration != nil {
			t.Fatal("inconsistent physical result was advertised as ready")
		}
	}
}
