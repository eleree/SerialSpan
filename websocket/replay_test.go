package websocket

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"shareserial/resource"
)

func shareWithRXReplay(t *testing.T, h *Hub, local *Client, streamID string, sequence uint64) {
	t.Helper()
	h.handle(local, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23",
		Ports: []PortInfo{{PortID: "usb", Name: "usb"}}, RXReplayProtocol: RXReplayProtocolVersion,
		RXStreamID: streamID, RXSeq: sequence})
	registered := take(t, local, MsgTypeRegister)
	if registered.RXReplayProtocol != RXReplayProtocolVersion || registered.RXStreamID != streamID || registered.RXSeq != sequence {
		t.Fatalf("Local replay capability was not confirmed: %+v", registered)
	}
}

func approveRXReplay(t *testing.T, h *Hub, local, remote *Client, streamID string, after, through uint64) (Message, Message) {
	t.Helper()
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb",
		Access: AccessRead, RXReplayProtocol: RXReplayProtocolVersion, ResumeStreamID: streamID, ResumeSeq: after})
	request := take(t, local, MsgTypeConnectionRequest)
	take(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessRead})
	take(t, local, MsgTypeRemoteConnected)
	resume := take(t, local, MsgTypeResumeRX)
	connected := take(t, remote, MsgTypeConnect)
	if resume.RXStreamID != streamID || resume.ResumeSeq != after || resume.ThroughSeq != through ||
		connected.RXStreamID != streamID || connected.RXSeq != through {
		t.Fatalf("incorrect replay handshake: resume=%+v connect=%+v", resume, connected)
	}
	return resume, connected
}

func TestRXReplayWaitsForApprovalAndOrdersLiveFramesAfterAcknowledgedBackfill(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	streamID := strings.Repeat("a", 32)
	shareWithRXReplay(t, h, local, streamID, 2)

	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb",
		Access: AccessRead, RXReplayProtocol: RXReplayProtocolVersion, ResumeStreamID: streamID, ResumeSeq: 0})
	request := take(t, local, MsgTypeConnectionRequest)
	take(t, remote, MsgTypeConnectPending)
	if len(h.subscriptions) != 0 || len(local.send) != 0 {
		t.Fatal("pending replay request created access or disclosed a replay cursor")
	}
	h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: request.RequestID, RXStreamID: streamID, RXSeq: 1})
	if take(t, remote, MsgTypeError).Code != "not_connected" {
		t.Fatal("pending Remote was allowed to acknowledge serial data")
	}
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessRead})
	take(t, local, MsgTypeRemoteConnected)
	resume := take(t, local, MsgTypeResumeRX)
	connected := take(t, remote, MsgTypeConnect)
	if resume.RemoteID != remote.remoteID || resume.GrantID != request.RequestID || resume.ResumeSeq != 0 || resume.ThroughSeq != 2 {
		t.Fatalf("server did not bind replay to the approved socket: %+v", resume)
	}
	if connected.RXReplayProtocol != RXReplayProtocolVersion || connected.RXSeq != 2 || connected.RXStreamID != streamID {
		t.Fatalf("connection lacks current receive cursor: %+v", connected)
	}

	reader := peer(h, RoleRemote)
	h.handle(reader, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb",
		Access: AccessRead, RXReplayProtocol: RXReplayProtocolVersion})
	readerRequest := take(t, local, MsgTypeConnectionRequest)
	take(t, reader, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: readerRequest.RequestID, Access: AccessRead})
	take(t, local, MsgTypeRemoteConnected)
	readerConnect := take(t, reader, MsgTypeConnect)
	if readerConnect.RXStreamID != streamID || readerConnect.RXSeq != 2 || len(local.send) != 0 {
		t.Fatalf("new Remote did not start at the live head: %+v", readerConnect)
	}

	// Live serial input that arrives while the old range is replaying must wait behind it.
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", RXStreamID: streamID, RXSeq: 3, Data: "Qw=="})
	if len(remote.send) != 0 {
		t.Fatal("live frame overtook the pending replay")
	}
	if live := take(t, reader, MsgTypeData); live.RXSeq != 3 || live.Data != "Qw==" {
		t.Fatalf("new Remote did not receive live data: %+v", live)
	}
	grant := h.subscriptions[remote].grantID
	for _, item := range []struct {
		sequence uint64
		payload  string
	}{{1, "QQ=="}, {2, "Qg=="}} {
		h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: remote.remoteID, PortID: "usb",
			GrantID: grant, RXStreamID: streamID, RXSeq: item.sequence, Data: item.payload})
		data := take(t, remote, MsgTypeData)
		if data.RXSeq != item.sequence || data.Data != item.payload || data.RemoteID != "" {
			t.Fatalf("replayed frame was altered or used message identity: %+v", data)
		}
		if item.sequence == 1 {
			h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: grant, RXStreamID: streamID, RXSeq: 2})
			if take(t, remote, MsgTypeError).Code != "invalid_rx_ack" {
				t.Fatal("out-of-order receive acknowledgement was accepted")
			}
		}
		h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: grant, RXStreamID: streamID, RXSeq: item.sequence})
		ack := take(t, local, MsgTypeRXAck)
		if ack.RemoteID != remote.remoteID || ack.RXSeq != item.sequence || ack.GrantID != grant {
			t.Fatalf("acknowledgement sender identity was not server-derived: %+v", ack)
		}
		if len(reader.send) != 0 {
			t.Fatal("replay bytes leaked to another approved Remote")
		}
	}
	h.handle(local, Message{Type: MsgTypeReplayComplete, TargetRemoteID: remote.remoteID, PortID: "uart",
		GrantID: grant, RXStreamID: streamID, ThroughSeq: 2})
	if take(t, local, MsgTypeError).Code != "invalid_rx_replay" {
		t.Fatal("wrong port was accepted for replay completion")
	}
	h.handle(local, Message{Type: MsgTypeReplayComplete, TargetRemoteID: remote.remoteID, PortID: "usb",
		GrantID: grant, RXStreamID: streamID, ThroughSeq: 2})
	if take(t, remote, MsgTypeReplayComplete).ThroughSeq != 2 {
		t.Fatal("valid replay did not complete")
	}
	if live := take(t, remote, MsgTypeData); live.RXSeq != 3 || live.Data != "Qw==" {
		t.Fatalf("queued live frame did not follow the replay: %+v", live)
	}
}

func TestRXReplayAcceptsOrderedCumulativeACKsWithinInflightWindow(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	streamID := strings.Repeat("9", 32)
	shareWithRXReplay(t, h, local, streamID, 8)
	approveRXReplay(t, h, local, remote, streamID, 0, 8)
	grant := h.subscriptions[remote].grantID

	// Local fills its eight-frame window before the first Remote ACK can reach
	// Hub.Run. Every frame is now sent, so the first cumulative ACK is valid.
	for sequence := uint64(1); sequence <= 8; sequence++ {
		h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: remote.remoteID,
			PortID: "usb", GrantID: grant, RXStreamID: streamID, RXSeq: sequence, Data: "QQ=="})
	}
	for sequence := uint64(1); sequence <= 8; sequence++ {
		if data := take(t, remote, MsgTypeData); data.RXSeq != sequence {
			t.Fatalf("in-flight replay window changed order: got %d, want %d", data.RXSeq, sequence)
		}
	}
	for sequence := uint64(1); sequence <= 8; sequence++ {
		h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: grant,
			RXStreamID: streamID, RXSeq: sequence})
		if ack := take(t, local, MsgTypeRXAck); ack.RXSeq != sequence {
			t.Fatalf("cumulative acknowledgement did not advance in order: got %d, want %d", ack.RXSeq, sequence)
		}
	}
	h.handle(local, Message{Type: MsgTypeReplayComplete, TargetRemoteID: remote.remoteID,
		PortID: "usb", GrantID: grant, RXStreamID: streamID, ThroughSeq: 8})
	if complete := take(t, remote, MsgTypeReplayComplete); complete.ThroughSeq != 8 {
		t.Fatalf("valid in-flight replay did not complete: %+v", complete)
	}
}

func TestRXReplayExtensionFallsBackToLiveForLegacyLocal(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	share(t, h, local, "ABC23", "usb")
	streamID := strings.Repeat("e", 32)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb",
		Access: AccessRead, RXReplayProtocol: RXReplayProtocolVersion, ResumeStreamID: streamID, ResumeSeq: 4})
	request := take(t, local, MsgTypeConnectionRequest)
	take(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessRead})
	take(t, local, MsgTypeRemoteConnected)
	connected := take(t, remote, MsgTypeConnect)
	if connected.RXReplayProtocol != 0 || len(local.send) != 0 {
		t.Fatalf("legacy Local accidentally negotiated RX replay: %+v", connected)
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	if data := take(t, remote, MsgTypeData); data.Data != "QQ==" || data.RXSeq != 0 {
		t.Fatalf("legacy Local lost live-only compatibility: %+v", data)
	}
}

func TestRXReplayExplicitlyReportsEvictedDataAndRejectsWrongGrant(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	streamID := strings.Repeat("b", 32)
	shareWithRXReplay(t, h, local, streamID, 4)
	_, _ = approveRXReplay(t, h, local, remote, streamID, 0, 4)
	grant := h.subscriptions[remote].grantID
	// The cache lost sequences 1 and 2, so the authorized Remote gets an explicit gap.
	h.handle(local, Message{Type: MsgTypeReplayGap, TargetRemoteID: remote.remoteID, PortID: "usb",
		GrantID: grant, RXStreamID: streamID, GapFrom: 1, GapTo: 2})
	gap := take(t, remote, MsgTypeRXGap)
	if gap.GapFrom != 1 || gap.GapTo != 2 {
		t.Fatalf("missing receive gap was hidden: %+v", gap)
	}
	if state := h.subscriptions[remote]; state.grantID != grant {
		t.Fatal("gap notification changed authorization")
	}
	h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: remote.remoteID, PortID: "uart",
		GrantID: grant, RXStreamID: streamID, RXSeq: 3, Data: "Qw=="})
	if take(t, local, MsgTypeError).Code != "invalid_rx_replay" {
		t.Fatal("replay to an incorrect port was accepted")
	}
	h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: "OTHER", PortID: "usb",
		GrantID: grant, RXStreamID: streamID, RXSeq: 3, Data: "Qw=="})
	if take(t, local, MsgTypeError).Code != "invalid_rx_replay" {
		t.Fatal("replay identity supplied by Local was trusted without a matching subscription")
	}
	h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: remote.remoteID, PortID: "usb",
		GrantID: "foreign-grant", RXStreamID: streamID, RXSeq: 3, Data: "Qw=="})
	if take(t, local, MsgTypeError).Code != "invalid_rx_replay" {
		t.Fatal("stale grant was allowed to receive cached bytes")
	}
	h.handle(local, Message{Type: MsgTypeReplayData, TargetRemoteID: remote.remoteID, PortID: "usb",
		GrantID: grant, RXStreamID: streamID, RXSeq: 3, Data: "Qw=="})
	if data := take(t, remote, MsgTypeData); data.RXSeq != 3 || data.Data != "Qw==" {
		t.Fatalf("valid replay frame was not delivered: %+v", data)
	}
}

func TestRXReplayRejectsForgedHeadsAndOutOfOrderLiveFrames(t *testing.T) {
	h := NewHub()
	local := peer(h, RoleLocal)
	streamID := strings.Repeat("c", 32)
	shareWithRXReplay(t, h, local, streamID, 1)
	h.handle(local, Message{Type: MsgTypeRXHead, PortID: "usb", RXStreamID: streamID, RXSeq: 0})
	if take(t, local, MsgTypeError).Code != "invalid_rx_sequence" {
		t.Fatal("stale receive head accepted")
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", RXStreamID: streamID, RXSeq: 3, Data: "QQ=="})
	if take(t, local, MsgTypeError).Code != "invalid_rx_sequence" {
		t.Fatal("out-of-order live receive frame accepted")
	}
	if local.rxSequence != 1 {
		t.Fatalf("invalid input advanced the stream head: %d", local.rxSequence)
	}
}

func TestRXReplayLiveQueueIsBoundedAndDisconnectsASlowPeer(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	streamID := strings.Repeat("d", 32)
	shareWithRXReplay(t, h, local, streamID, 1)
	approveRXReplay(t, h, local, remote, streamID, 0, 1)
	bytes := make([]byte, MaxDataSize)
	payload := base64.StdEncoding.EncodeToString(bytes)
	for sequence := uint64(2); h.clients[remote] && sequence < 32; sequence++ {
		h.handle(local, Message{Type: MsgTypeData, PortID: "usb", RXStreamID: streamID,
			RXSeq: sequence, Data: payload})
	}
	if h.clients[remote] {
		t.Fatal("unbounded replay wait queue did not disconnect the slow Remote")
	}
	if disconnected := take(t, local, MsgTypeRemoteDisconnected); disconnected.RemoteID != remote.remoteID {
		t.Fatalf("slow Remote disconnect was not reported: %+v", disconnected)
	}
}

func TestRXLiveFanoutChargesEveryCopyToLocalSource(t *testing.T) {
	h := NewHub()
	local, first, second := peer(h, RoleLocal), peer(h, RoleRemote), peer(h, RoleRemote)
	streamID := strings.Repeat("f", 32)
	shareWithRXReplay(t, h, local, streamID, 0)
	for _, remote := range []*Client{first, second} {
		h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb",
			Access: AccessRead, RXReplayProtocol: RXReplayProtocolVersion})
		request := take(t, local, MsgTypeConnectionRequest)
		take(t, remote, MsgTypeConnectPending)
		h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessRead})
		take(t, local, MsgTypeRemoteConnected)
		take(t, remote, MsgTypeConnect)
	}
	message := Message{Type: MsgTypeData, LocalID: "ABC23", PortID: "usb", RXStreamID: streamID, RXSeq: 1,
		Data: base64.StdEncoding.EncodeToString(make([]byte, 128))}
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	config := resource.DefaultConfig()
	config.ClientBytesPerSecond = int64(len(encoded) * 3 / 4)
	manager, err := resource.New(config)
	if err != nil {
		t.Fatal(err)
	}
	lease, code := manager.Admit("local-source")
	if code != "" {
		t.Fatal(code)
	}
	local.lease = lease
	h.handle(local, message)
	if h.clients[local] {
		t.Fatal("Local fan-out charged only one copy and bypassed the source budget")
	}
	for _, remote := range []*Client{first, second} {
		if take(t, remote, MsgTypeLocalDisconnected).LocalID != "ABC23" {
			t.Fatal("resource limit did not clean up a fan-out subscriber")
		}
	}
}
