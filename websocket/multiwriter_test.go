package websocket

import "testing"

func changeWrites(t *testing.T, h *Hub, local *Client, paused bool, remotes ...*Client) Message {
	t.Helper()
	h.handle(local, Message{Type: MsgTypeSetWriteState, Version: ProtocolVersion, RequestID: "state", Paused: boolPointer(paused)})
	state := takeReady(t, local, MsgTypeWriteState)
	if state.Paused == nil || *state.Paused != paused || state.WriteEpoch == 0 || state.Version != ProtocolVersion {
		t.Fatal("invalid write state", state)
	}
	for _, remote := range remotes {
		seen := takeReady(t, remote, MsgTypeWriteState)
		if seen.WriteEpoch != state.WriteEpoch || seen.RequestID != "" {
			t.Fatal("incorrect state broadcast")
		}
	}
	return state
}

func TestPauseRetainsRXAndRejectsOldEpochsAndForeignGrants(t *testing.T) {
	h, local, first := accessFixture(t)
	grantAccess(t, h, first, local, requestAccess(t, h, first, local, AccessControl), AccessControl)
	second := peer(h, RoleRemote)
	grantAccess(t, h, second, local, requestAccess(t, h, second, local, AccessControl), AccessControl)
	reader := peer(h, RoleRemote)
	grantAccess(t, h, reader, local, requestAccess(t, h, reader, local, AccessRead), AccessRead)
	oldEpoch := local.writeEpoch
	h.handle(first, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", WriteEpoch: oldEpoch})
	if takeReady(t, first, MsgTypeError).Code != "stale_grant" {
		t.Fatal("missing grant accepted")
	}
	state := changeWrites(t, h, local, true, first, second, reader)
	if len(h.subscriptions) != 3 || state.WriteEpoch <= oldEpoch {
		t.Fatal("pause revoked connections or failed to change epoch")
	}
	sendFrom(h, first, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
	if takeReady(t, first, MsgTypeError).Code != "writes_paused" || len(local.send) != 0 {
		t.Fatal("paused send forwarded")
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "Qg=="})
	for _, remote := range []*Client{first, second, reader} {
		if takeReady(t, remote, MsgTypeData).Data != "Qg==" {
			t.Fatal("pause blocked RX")
		}
	}
	state = changeWrites(t, h, local, false, first, second, reader)
	h.handle(first, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", GrantID: h.subscriptions[first].grantID, WriteEpoch: oldEpoch})
	if takeReady(t, first, MsgTypeError).Code != "stale_write_state" {
		t.Fatal("old command accepted after resume")
	}
	h.handle(first, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", GrantID: h.subscriptions[second].grantID, WriteEpoch: state.WriteEpoch})
	if takeReady(t, first, MsgTypeError).Code != "stale_grant" {
		t.Fatal("foreign grant accepted")
	}
	for _, remote := range []*Client{first, second} {
		sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "Qw=="})
		if takeReady(t, local, MsgTypeSend).WriteEpoch != state.WriteEpoch {
			t.Fatal("new command lacks current epoch")
		}
	}
}

func TestOldGrantCannotSendAfterSameRemoteIsReapproved(t *testing.T) {
	h, local, remote := accessFixture(t)
	grantAccess(t, h, remote, local, requestAccess(t, h, remote, local, AccessControl), AccessControl)
	old := h.subscriptions[remote].grantID
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID})
	takeReady(t, local, MsgTypeRemoteDisconnected)
	takeReady(t, remote, MsgTypePermissionRevoked)
	grantAccess(t, h, remote, local, requestAccess(t, h, remote, local, AccessControl), AccessControl)
	if old == h.subscriptions[remote].grantID {
		t.Fatal("grant generation reused")
	}
	h.handle(remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", GrantID: old, WriteEpoch: local.writeEpoch})
	if takeReady(t, remote, MsgTypeError).Code != "stale_grant" || len(local.send) != 0 {
		t.Fatal("stale grant forwarded")
	}
}

func TestLegacyParticipantsCannotCreateV3Permissions(t *testing.T) {
	h := NewHub()
	local := peer(h, RoleLocal)
	remote := peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 2, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb"}}})
	if takeReady(t, local, MsgTypeError).Code != "protocol_mismatch" || len(h.locals) != 0 {
		t.Fatal("legacy Local registered")
	}
	share(t, h, local, "ABC23", "usb")
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 2, LocalID: "ABC23", Access: AccessControl})
	if takeReady(t, remote, MsgTypeError).Code != "protocol_mismatch" || len(h.pending) != 0 || len(local.send) != 0 {
		t.Fatal("legacy Remote requested access")
	}
}

func TestWriteStateIsBoundToOwningLocalAndSurvivesDuplicateRegistration(t *testing.T) {
	h, local, remote := accessFixture(t)
	other := peer(h, RoleLocal)
	share(t, h, other, "DEF45", "usb")
	h.handle(remote, Message{Type: MsgTypeSetWriteState, LocalID: "ABC23", Paused: boolPointer(true), RequestID: "state", Version: ProtocolVersion})
	if takeReady(t, remote, MsgTypeError).Code != "invalid_message" || local.writesPaused {
		t.Fatal("Remote changed write state")
	}
	h.handle(other, Message{Type: MsgTypeSetWriteState, LocalID: "ABC23", Paused: boolPointer(true), RequestID: "state", Version: ProtocolVersion})
	takeReady(t, other, MsgTypeWriteState)
	if local.writesPaused {
		t.Fatal("foreign Local changed another port")
	}
	changeWrites(t, h, local, true)
	epoch := local.writeEpoch
	h.handle(local, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb", Name: "usb"}}})
	ack := takeReady(t, local, MsgTypeRegister)
	if !local.writesPaused || local.writeEpoch != epoch || ack.Paused == nil || !*ack.Paused {
		t.Fatal("duplicate registration reset pause")
	}
}
