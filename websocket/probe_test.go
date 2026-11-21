package websocket

import (
	"encoding/base64"
	"strings"
	"testing"
)

func probePair(t *testing.T) (*Hub, *Client, *Client, Message) {
	t.Helper()
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", ProbeProtocol: 1, Ports: []PortInfo{{PortID: ProbePortID}}})
	take(t, local, MsgTypeRegister)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: "ABC23", ProbeProtocol: 1})
	request := take(t, local, MsgTypeConnectionRequest)
	take(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessRead})
	if take(t, local, MsgTypeRemoteConnected).ProbeProtocol != 1 {
		t.Fatal("Local did not negotiate probe")
	}
	connected := take(t, remote, MsgTypeConnect)
	if connected.ProbeProtocol != 1 {
		t.Fatal("Remote did not negotiate probe")
	}
	return h, local, remote, connected
}

func TestProbeRelayChecksRoleEpochAndPauseAndNeverWritesPhysicalPort(t *testing.T) {
	h, local, remote, grant := probePair(t)
	frame := Message{Type: MsgTypeProbeFrame, PortID: ProbePortID, GrantID: grant.GrantID, WriteEpoch: local.writeEpoch, Data: base64.StdEncoding.EncodeToString([]byte{0, 192, 219, 255})}
	h.handle(remote, frame)
	if take(t, remote, MsgTypeError).Code != "probe_write_denied" {
		t.Fatal("reader submitted a synthetic frame")
	}
	target := h.subscriptions[remote]
	target.access = AccessControl
	h.subscriptions[remote] = target
	frame.WriteEpoch = local.writeEpoch + 1
	h.handle(remote, frame)
	take(t, remote, MsgTypeError)
	frame.WriteEpoch = local.writeEpoch
	local.writesPaused = true
	h.handle(remote, frame)
	take(t, remote, MsgTypeError)
	if len(local.send) != 0 {
		t.Fatal("forbidden probe frame reached Local")
	}
	local.writesPaused = false
	frame.RemoteID = "forged"
	h.handle(remote, frame)
	forwarded := take(t, local, MsgTypeProbeFrame)
	if forwarded.RemoteID != remote.remoteID || forwarded.Data != frame.Data {
		t.Fatal("probe identity or bytes changed")
	}
	frame.RemoteID = remote.remoteID
	h.handle(local, frame)
	if take(t, remote, MsgTypeProbeFrame).Data != frame.Data {
		t.Fatal("reverse probe bytes changed")
	}
	// An approved reader may send a typed completion receipt, not a data frame.
	target.access = AccessRead
	h.subscriptions[remote] = target
	h.handle(remote, Message{Type: MsgTypeProbeSignal, PortID: ProbePortID, GrantID: grant.GrantID, ProbeKind: "receipt", ProbePayload: `{"op":"complete","id":1,"bytes":4,"sha":"` + strings.Repeat("a", 64) + `"}`})
	if take(t, local, MsgTypeProbeSignal).ProbeKind != "receipt" {
		t.Fatal("reader receipt blocked")
	}
}

func TestProbePendingRequestCannotExchangeCandidates(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", ProbeProtocol: 1, Ports: []PortInfo{{PortID: ProbePortID}}})
	take(t, local, MsgTypeRegister)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: "ABC23", ProbeProtocol: 1})
	request := take(t, local, MsgTypeConnectionRequest)
	take(t, remote, MsgTypeConnectPending)
	h.handle(remote, Message{Type: MsgTypeProbeSignal, PortID: ProbePortID, GrantID: request.RequestID, ProbeKind: "candidate", ProbePayload: `{"candidate":""}`})
	if take(t, remote, MsgTypeError).Code != "approval_required" {
		t.Fatal("pending request acquired a peer")
	}
	if len(local.send) != 0 {
		t.Fatal("pending signaling leaked")
	}
}

func TestProbeSignalingNeedsApprovalCurrentGrantAndActualLocal(t *testing.T) {
	h, local, remote, grant := probePair(t)
	message := Message{Type: MsgTypeProbeSignal, GrantID: grant.GrantID, PortID: ProbePortID, ProbeKind: "offer", ProbePayload: "test SDP", RemoteID: "FORGED", LocalID: "ZZZZZ"}
	h.handle(remote, message)
	forwarded := take(t, local, MsgTypeProbeSignal)
	if forwarded.LocalID != "ABC23" || forwarded.RemoteID != remote.remoteID {
		t.Fatal("probe accepted payload identity")
	}
	message.GrantID = "stale"
	h.handle(remote, message)
	if take(t, remote, MsgTypeError).Code != "stale_grant" {
		t.Fatal("stale grant accepted")
	}
	if len(local.send) != 0 {
		t.Fatal("stale signaling forwarded")
	}
	other := peer(h, RoleLocal)
	message.GrantID = grant.GrantID
	message.RemoteID = remote.remoteID
	message.ProbeKind = "answer"
	h.handle(other, message)
	if take(t, other, MsgTypeError).Code != "permission_denied" {
		t.Fatal("wrong Local accepted")
	}
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID})
	take(t, local, MsgTypeRemoteDisconnected)
	take(t, remote, MsgTypePermissionRevoked)
	h.handle(remote, message)
	if take(t, remote, MsgTypeError).Code != "approval_required" {
		t.Fatal("revoked peer retained signaling")
	}
}

func TestProbeIsSyntheticOnlyAndSignalsAreBounded(t *testing.T) {
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", ProbeProtocol: 1, Ports: []PortInfo{{PortID: "COM7"}}})
	if take(t, local, MsgTypeError).Code != "invalid_registration" {
		t.Fatal("physical port accepted probe capability")
	}
	share(t, h, local, "ABC23", "COM7")
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: "ABC23", ProbeProtocol: 1})
	if take(t, remote, MsgTypeError).Code != "probe_unsupported" {
		t.Fatal("probe connected to a normal serial port")
	}
	h, local, remote, grant := probePair(t)
	for _, message := range []Message{
		{ProbeKind: "offer", ProbePayload: strings.Repeat("x", 16*1024+1)},
		{ProbeKind: "answer", ProbePayload: "wrong direction"},
		{ProbeKind: "candidate", ProbePayload: `{"candidate":"` + strings.Repeat("x", 1025) + `"}`},
		{ProbeKind: "send", ProbePayload: "data"},
	} {
		message.Type = MsgTypeProbeSignal
		message.GrantID = grant.GrantID
		message.PortID = ProbePortID
		h.handle(remote, message)
		take(t, remote, MsgTypeError)
	}
	if len(local.send) != 0 {
		t.Fatal("invalid signal reached peer")
	}
}
