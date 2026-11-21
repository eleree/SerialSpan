package websocket

import (
	"testing"
	"time"
)

func flashFixture(t *testing.T) (*Hub, *Client, *Client) {
	t.Helper()
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	config := &SerialConfig{BaudRate: 115200, DataBits: 8, StopBits: 1, Parity: "none", FlowControl: "none"}
	h.handle(local, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23",
		Ports: []PortInfo{{PortID: "usb", Name: "USB"}}, ConfigProtocol: 1, SerialConfig: config,
		SerialSignalsProtocol: 1, FlashProtocol: 1})
	registered := takeReady(t, local, MsgTypeRegister)
	if registered.FlashProtocol != 1 || registered.SerialSignalsProtocol != 1 {
		t.Fatal("Local flash capability not acknowledged")
	}
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: local.localID,
		Access: AccessControl, FlashProtocol: 1})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	takeReady(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessControl})
	takeReady(t, local, MsgTypeRemoteConnected)
	connected := takeReady(t, remote, MsgTypeConnect)
	if connected.FlashProtocol != 1 || connected.SerialSignalsProtocol != 1 {
		t.Fatal("Remote flash capability not negotiated")
	}
	return h, local, remote
}

func startFlashSession(t *testing.T, h *Hub, local, remote *Client) Message {
	t.Helper()
	target := h.subscriptions[remote]
	requestID := "start-flash"
	h.handle(remote, Message{Type: MsgTypeBeginFlash, RequestID: requestID, LocalID: target.localID,
		PortID: target.portID, GrantID: target.grantID, WriteEpoch: local.writeEpoch})
	state := takeReady(t, local, MsgTypeFlashState)
	start := takeReady(t, local, MsgTypeBeginFlash)
	remoteState := takeReady(t, remote, MsgTypeFlashState)
	if state.FlashActive == nil || !*state.FlashActive || state.FlashStarting == nil || !*state.FlashStarting ||
		state.FlashSessionID == "" || state.FlashSessionID != start.FlashSessionID ||
		remoteState.FlashOwnerID != remote.remoteID || remoteState.FlashSessionID != "" ||
		start.WriteEpoch != local.writeEpoch {
		t.Fatalf("flash start not locked or owner session disclosed early: %+v %+v %+v", state, start, remoteState)
	}
	h.handle(local, Message{Type: MsgTypeFlashResult, RequestID: requestID, FlashSessionID: start.FlashSessionID,
		RemoteID: start.RemoteID, PortID: start.PortID, GrantID: start.GrantID, WriteEpoch: start.WriteEpoch, Success: boolPointer(true)})
	if result := takeReady(t, remote, MsgTypeFlashResult); result.Success == nil || !*result.Success || result.FlashSessionID != start.FlashSessionID {
		t.Fatalf("flash start result missing: %+v", result)
	}
	activeState := takeReady(t, remote, MsgTypeFlashState)
	takeReady(t, local, MsgTypeFlashState)
	if activeState.FlashSessionID != start.FlashSessionID || activeState.FlashStarting == nil || *activeState.FlashStarting {
		t.Fatalf("flash session not activated: %+v", activeState)
	}
	return activeState
}

func TestRemoteFlashSessionExclusivelyOwnsSerialWritesAndReleases(t *testing.T) {
	h, local, owner := flashFixture(t)
	ownerState := startFlashSession(t, h, local, owner)
	ownerGrant := h.subscriptions[owner]

	other := peer(h, RoleRemote)
	other.flashProtocol = 1
	requestID := requestAccess(t, h, other, local, AccessControl)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: requestID, Access: AccessControl})
	takeReady(t, local, MsgTypeRemoteConnected)
	otherGrant := takeReady(t, other, MsgTypeConnect)
	if otherGrant.FlashActive == nil || !*otherGrant.FlashActive || otherGrant.FlashSessionID != "" {
		t.Fatalf("another Remote did not see the exclusive flash state: %+v", otherGrant)
	}
	h.handle(other, Message{Type: MsgTypeFlashSend, PortID: "usb", Data: "QQ==", GrantID: h.subscriptions[other].grantID,
		WriteEpoch: local.writeEpoch, FlashSessionID: ownerState.FlashSessionID})
	if takeReady(t, other, MsgTypeError).Code != "stale_flash_session" || len(local.send) != 0 {
		t.Fatal("another full-control Remote used the owner's flash session")
	}

	h.handle(other, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", GrantID: h.subscriptions[other].grantID, WriteEpoch: local.writeEpoch})
	if takeReady(t, other, MsgTypeError).Code != "flash_busy" || len(local.send) != 0 {
		t.Fatal("ordinary Remote write interleaved with ESP32 flashing")
	}
	h.handle(owner, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", GrantID: ownerGrant.grantID, WriteEpoch: local.writeEpoch})
	if takeReady(t, owner, MsgTypeError).Code != "flash_busy" || len(local.send) != 0 {
		t.Fatal("ordinary send path bypassed the flash-only transport")
	}
	h.handle(owner, Message{Type: MsgTypeFlashSend, PortID: "usb", Data: "Qg==", GrantID: ownerGrant.grantID,
		WriteEpoch: local.writeEpoch, FlashSessionID: ownerState.FlashSessionID})
	flashData := takeReady(t, local, MsgTypeSend)
	if flashData.Data != "Qg==" || flashData.FlashSessionID != ownerState.FlashSessionID {
		t.Fatalf("flash bytes were not bound to the active owner: %+v", flashData)
	}

	h.handle(owner, Message{Type: MsgTypeEndFlash, RequestID: "end-flash", PortID: "usb", GrantID: ownerGrant.grantID,
		WriteEpoch: local.writeEpoch, FlashSessionID: ownerState.FlashSessionID})
	endingLocal := takeReady(t, local, MsgTypeFlashState)
	end := takeReady(t, local, MsgTypeEndFlash)
	takeReady(t, owner, MsgTypeFlashState)
	if endingLocal.FlashEnding == nil || !*endingLocal.FlashEnding || end.FlashSessionID != ownerState.FlashSessionID {
		t.Fatalf("flash session did not enter ending state: %+v %+v", endingLocal, end)
	}
	h.handle(local, Message{Type: MsgTypeFlashResult, RequestID: "end-flash", FlashSessionID: end.FlashSessionID,
		RemoteID: end.RemoteID, PortID: end.PortID, GrantID: end.GrantID, WriteEpoch: end.WriteEpoch, Success: boolPointer(true)})
	if result := takeReady(t, owner, MsgTypeFlashResult); result.Success == nil || !*result.Success {
		t.Fatalf("flash end not acknowledged: %+v", result)
	}
	if inactive := takeReady(t, owner, MsgTypeFlashState); inactive.FlashActive == nil || *inactive.FlashActive {
		t.Fatalf("flash lock was not released: %+v", inactive)
	}
	takeReady(t, other, MsgTypeFlashState)
	takeReady(t, local, MsgTypeFlashState)
	if h.flashSessions[local] != nil {
		t.Fatal("flash session still owns the port")
	}
	h.handle(other, Message{Type: MsgTypeSend, PortID: "usb", Data: "Qw==", GrantID: h.subscriptions[other].grantID, WriteEpoch: local.writeEpoch})
	if takeReady(t, local, MsgTypeSend).Data != "Qw==" {
		t.Fatal("normal serial access did not resume after flash lock release")
	}
}

func TestFlashControlSignalsAreOwnerBoundAndStopOnPause(t *testing.T) {
	h, local, owner := flashFixture(t)
	state := startFlashSession(t, h, local, owner)
	target := h.subscriptions[owner]
	other := peer(h, RoleRemote)
	requestID := requestAccess(t, h, other, local, AccessControl)
	grantAccess(t, h, other, local, requestID, AccessControl)
	otherTarget := h.subscriptions[other]
	h.handle(other, Message{Type: MsgTypeSetSerialSignals, RequestID: "foreign-signal", PortID: otherTarget.portID,
		GrantID: otherTarget.grantID, WriteEpoch: local.writeEpoch, FlashSessionID: state.FlashSessionID,
		RequestToSend: boolPointer(true)})
	if takeReady(t, other, MsgTypeError).Code != "stale_flash_session" || len(local.send) != 0 {
		t.Fatal("another Remote changed reset signals during the flash session")
	}

	h.handle(owner, Message{Type: MsgTypeSetSerialSignals, RequestID: "signal-1", PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch, FlashSessionID: state.FlashSessionID,
		DataTerminalReady: boolPointer(false), RequestToSend: boolPointer(true)})
	request := takeReady(t, local, MsgTypeSetSerialSignals)
	if request.LocalID != local.localID || request.RemoteID != owner.remoteID || request.FlashSessionID != state.FlashSessionID ||
		request.RequestToSend == nil || !*request.RequestToSend {
		t.Fatalf("signal operation not bound to approved owner: %+v", request)
	}
	h.handle(local, Message{Type: MsgTypeSerialSignalsResult, RequestID: request.RequestID, FlashSessionID: request.FlashSessionID,
		PortID: request.PortID, GrantID: request.GrantID, WriteEpoch: request.WriteEpoch, Success: boolPointer(true)})
	if result := takeReady(t, owner, MsgTypeSerialSignalsResult); result.Success == nil || !*result.Success {
		t.Fatalf("serial signal result not returned: %+v", result)
	}

	h.handle(local, Message{Type: MsgTypeSetWriteState, Version: ProtocolVersion, RequestID: "pause-flash", Paused: boolPointer(true)})
	if h.flashSessions[local] != nil || !local.writesPaused {
		t.Fatal("pausing remote operations did not release the flash lock")
	}
	if result := takeReady(t, owner, MsgTypeFlashResult); result.Success == nil || *result.Success || result.Code != "writes_paused" {
		t.Fatalf("owner was not told the flash session was aborted: %+v", result)
	}
	state = takeReady(t, owner, MsgTypeFlashState)
	if state.FlashActive == nil || *state.FlashActive {
		t.Fatalf("paused state did not clear flash ownership: %+v", state)
	}
	paused := takeReady(t, owner, MsgTypeWriteState)
	if paused.Paused == nil || !*paused.Paused {
		t.Fatalf("paused state not broadcast after flash abort: %+v", paused)
	}
}

func TestExpiredSignalRequestIsCancelledOnLocalQueue(t *testing.T) {
	h, local, owner := flashFixture(t)
	state := startFlashSession(t, h, local, owner)
	target := h.subscriptions[owner]
	h.handle(owner, Message{Type: MsgTypeSetSerialSignals, RequestID: "slow-signal", PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch, FlashSessionID: state.FlashSessionID,
		RequestToSend: boolPointer(true)})
	request := takeReady(t, local, MsgTypeSetSerialSignals)
	if request.RequestID != "slow-signal" {
		t.Fatalf("unexpected serial signal request: %+v", request)
	}
	base := h.now()
	h.now = func() time.Time { return base.Add(SerialSignalsTTL + time.Second) }
	h.expireSignalRequests()
	if cancelled := takeReady(t, local, MsgTypeCancelSerialSignals); cancelled.RequestID != request.RequestID {
		t.Fatalf("expired operation was not cancelled locally: %+v", cancelled)
	}
	if result := takeReady(t, owner, MsgTypeSerialSignalsResult); result.Success == nil || *result.Success || result.Code != "serial_signals_timeout" ||
		result.LocalID != local.localID || result.PortID != target.portID || result.GrantID != target.grantID || result.WriteEpoch != local.writeEpoch {
		t.Fatalf("Remote was not told the signal operation expired: %+v", result)
	}
	if len(h.signalRequests) != 0 {
		t.Fatal("expired serial signal request remained pending")
	}
}

func TestFlashRequiresControlAndLocalCapabilities(t *testing.T) {
	h, local, _ := flashFixture(t)
	reader := peer(h, RoleRemote)
	request := requestAccess(t, h, reader, local, AccessRead)
	grantAccess(t, h, reader, local, request, AccessRead)
	target := h.subscriptions[reader]
	h.handle(reader, Message{Type: MsgTypeBeginFlash, RequestID: "read-flash", PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch})
	if takeReady(t, reader, MsgTypeError).Code != "read_only" || h.flashSessions[local] != nil {
		t.Fatal("read-only Remote started a flash session")
	}
	if h.flashSessions[local] != nil {
		t.Fatal("read-only Remote caused a Local flash lock")
	}

	h2 := NewHub()
	local2, remote2 := peer(h2, RoleLocal), peer(h2, RoleRemote)
	share(t, h2, local2, "ABC23", "usb")
	h2.handle(remote2, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: local2.localID, Access: AccessControl, FlashProtocol: 1})
	requestMessage := takeReady(t, local2, MsgTypeConnectionRequest)
	takeReady(t, remote2, MsgTypeConnectPending)
	h2.handle(local2, Message{Type: MsgTypeApprove, RequestID: requestMessage.RequestID, Access: AccessControl})
	takeReady(t, local2, MsgTypeRemoteConnected)
	takeReady(t, remote2, MsgTypeConnect)
	target = h2.subscriptions[remote2]
	h2.handle(remote2, Message{Type: MsgTypeBeginFlash, RequestID: "old-local", PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local2.writeEpoch})
	if takeReady(t, remote2, MsgTypeError).Code != "flash_unsupported" || h2.flashSessions[local2] != nil {
		t.Fatal("Local without flash capability started a flash session")
	}
}

func TestSlowFlashSessionToleratesDelayedKeepaliveButStillExpires(t *testing.T) {
	h, local, owner := flashFixture(t)
	base := h.now()
	now := base
	h.now = func() time.Time { return now }
	state := startFlashSession(t, h, local, owner)
	target := h.subscriptions[owner]
	keepalive := Message{Type: MsgTypeFlashKeepalive, FlashSessionID: state.FlashSessionID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch}

	// A delayed heartbeat used to lose the lock at 30 seconds even though
	// the connection and the owner's authorization were still valid.
	now = base.Add(31 * time.Second)
	h.expireSignalRequests()
	if h.flashSessions[local] == nil {
		t.Fatal("slow flash session expired before the delayed heartbeat")
	}
	h.handle(owner, keepalive)
	now = base.Add(100 * time.Second)
	h.expireSignalRequests()
	if h.flashSessions[local] == nil {
		t.Fatal("valid delayed heartbeat did not renew the session")
	}

	// A stale authorization must not extend the lease indefinitely.
	keepalive.GrantID = "stale-grant"
	h.handle(owner, keepalive)
	now = base.Add(122 * time.Second)
	epoch := local.writeEpoch
	h.expireSignalRequests()
	if h.flashSessions[local] != nil || local.writeEpoch <= epoch {
		t.Fatal("session without a valid heartbeat did not release and invalidate old writes")
	}
	if result := takeReady(t, owner, MsgTypeFlashResult); result.Code != "flash_session_timeout" || result.Success == nil || *result.Success {
		t.Fatalf("owner did not receive a timeout: %+v", result)
	}
	takeReady(t, owner, MsgTypeFlashState)
	takeReady(t, local, MsgTypeFlashState)
	h.handle(owner, Message{Type: MsgTypeFlashSend, PortID: target.portID, Data: "QQ==",
		GrantID: target.grantID, WriteEpoch: epoch, FlashSessionID: state.FlashSessionID})
	if takeReady(t, owner, MsgTypeError).Code != "stale_flash_session" || len(local.send) != 0 {
		t.Fatal("late flash bytes executed after expiry")
	}
}
