package websocket

import (
	"bytes"
	"encoding/base64"
	"log"
	"strings"
	"testing"
)

func TestSerialP2PDiagnosticsAreTypedPrivateAndBoundToGrant(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	var output bytes.Buffer
	h.logger = log.New(&output, "", 0)
	message := Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "fallback", P2PReason: "stun:secret@10.0.0.99\ninjected"}
	h.handle(remote, message)
	takeReady(t, remote, MsgTypeError)
	if remote.serialFallback {
		t.Fatal("unvalidated diagnostic code changed transport state")
	}
	message.P2PReason = "negotiation_timeout"
	h.handle(remote, message)
	for _, client := range []*Client{local, remote} {
		state := takeReady(t, client, MsgTypeSerialState)
		if state.P2PReason != "negotiation_timeout" || state.Direct {
			t.Fatal("fallback cause was not preserved")
		}
	}
	logged := output.String()
	if !strings.Contains(logged, "event=serial_p2p_state") || !strings.Contains(logged, "negotiation_timeout") {
		t.Fatal("fallback is not diagnosable on server")
	}
	if strings.Contains(logged, "secret") || strings.Contains(logged, "10.0.0.99") || strings.Contains(logged, grant.GrantID) {
		t.Fatal("diagnostics exposed raw input or authorization")
	}
	message.P2PReason = "application"
	h.handle(remote, message)
	takeReady(t, local, MsgTypeSerialState)
	if takeReady(t, remote, MsgTypeSerialState).P2PReason != "negotiation_timeout" {
		t.Fatal("late peer diagnostic replaced the original fallback cause")
	}
	if output.String() != logged {
		t.Fatal("repeated fallback amplified diagnostic logs")
	}
	message.GrantID = "old"
	h.handle(remote, message)
	takeReady(t, remote, MsgTypeError)
	if output.String() != logged {
		t.Fatal("stale grant logged diagnostics for another state")
	}
}

func TestSerialP2PFailureDetailsAreBoundedAndReporterComesFromSocket(t *testing.T) {
	for _, scenario := range []string{"ice", "dtls", "sctp", "negative", "large", "pairs", "unavailable", "ready", "application", "channel-error", "channel-state", "serial-buffer", "assessment-buffer", "code-negative", "code-large", "code-mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			h, local, remote, grant := serialPair(t, AccessControl)
			d := &P2PFailureDetails{ICE: "disconnected", DTLS: "failed", SCTP: "closed", StatsAvailable: true, ChecksSent: 3, ResponsesReceived: 2, ValidPairs: 1}
			message := Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "fallback", P2PReason: "connection_failed", P2PDetails: d}
			switch scenario {
			case "ice":
				d.ICE = "private-address"
			case "dtls":
				d.DTLS = "secret"
			case "sctp":
				d.SCTP = "unknown"
			case "negative":
				d.ChecksSent = -1
			case "large":
				d.ResponsesReceived = 1000001
			case "pairs":
				d.ValidPairs = 65
			case "unavailable":
				d.StatsAvailable = false
			case "ready":
				message.ProbeKind = "ready"
				message.P2PReason = ""
			case "application":
				d.ApplicationCause = "private-address"
			case "channel-error":
				d.ChannelError = "secret"
			case "channel-state":
				d.ChannelState = "private-address"
			case "serial-buffer":
				d.SerialBufferedAmount = 1048577
			case "assessment-buffer":
				d.AssessmentBufferedAmount = -1
			case "code-negative":
				code := -1
				d.SCTPCauseCode = &code
				d.ChannelError = "sctp-failure"
			case "code-large":
				code := 65536
				d.SCTPCauseCode = &code
				d.ChannelError = "sctp-failure"
			case "code-mismatch":
				code := 12
				d.SCTPCauseCode = &code
				d.ChannelError = "dtls-failure"
			}
			h.handle(remote, message)
			takeReady(t, remote, MsgTypeError)
			if remote.serialFallback || len(local.send) != 0 {
				t.Fatal("invalid details changed the approved pair")
			}
		})
	}
	h, local, remote, grant := serialPair(t, AccessControl)
	var output bytes.Buffer
	h.logger = log.New(&output, "", 0)
	d := &P2PFailureDetails{ICE: "disconnected", DTLS: "failed", SCTP: "closed", StatsAvailable: true, ChecksSent: 3, ResponsesReceived: 2, ValidPairs: 1}
	code := 12
	d.ChannelError, d.SCTPCauseCode, d.ChannelState, d.AssessmentActive = "sctp-failure", &code, "closing", true
	message := Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "fallback", P2PReason: "connection_failed", P2PDetails: d, P2PReporter: RoleLocal}
	h.handle(remote, message)
	for _, client := range []*Client{local, remote} {
		state := takeReady(t, client, MsgTypeSerialState)
		if state.P2PReporter != RoleRemote || state.P2PDetails == nil || state.P2PDetails.DTLS != "failed" {
			t.Fatal("failure details lost their actual reporter")
		}
	}
	if !strings.Contains(output.String(), `reported_dtls="failed"`) || !strings.Contains(output.String(), "responses_received=2") {
		t.Fatal("server did not retain useful handshake diagnostics")
	}
	d.DTLS = "new"
	code = 99
	h.handle(remote, message)
	takeReady(t, local, MsgTypeSerialState)
	if stored := takeReady(t, remote, MsgTypeSerialState).P2PDetails; stored.DTLS != "failed" || *stored.SCTPCauseCode != 12 {
		t.Fatal("later details replaced the first failure")
	}
}

func TestSerialP2PFailureLogsKeepBothReportersOnceWithoutReplacingPrimary(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	var output bytes.Buffer
	h.logger = log.New(&output, "", 0)
	d := &P2PFailureDetails{ICE: "connected", DTLS: "connected", SCTP: "connected", ApplicationCause: "rx_send", ChannelState: "open", AssessmentActive: true, AssessmentBufferedAmount: 4096}
	message := Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "fallback", P2PReason: "application", P2PDetails: d, P2PReporter: RoleRemote}
	for i := 0; i < 3; i++ {
		h.handle(local, message)
		takeReady(t, local, MsgTypeSerialState)
		takeReady(t, remote, MsgTypeSerialState)
	}
	if strings.Count(output.String(), "event=serial_p2p_failure_details ") != 1 {
		t.Fatal("duplicate primary snapshots were logged")
	}
	code := 12
	message.P2PDetails = &P2PFailureDetails{ICE: "connected", DTLS: "connected", SCTP: "closed", ChannelError: "sctp-failure", SCTPCauseCode: &code, ChannelState: "closed"}
	message.P2PReason = "channel_error"
	for i := 0; i < 3; i++ {
		h.handle(remote, message)
		takeReady(t, local, MsgTypeSerialState)
		state := takeReady(t, remote, MsgTypeSerialState)
		if state.P2PReporter != RoleLocal || state.P2PReason != "application" || state.P2PDetails.ApplicationCause != "rx_send" {
			t.Fatal("secondary report replaced the primary failure")
		}
	}
	logged := output.String()
	if strings.Count(logged, "event=serial_p2p_failure_details ") != 2 || !strings.Contains(logged, "primary=false") || !strings.Contains(logged, "sctp_cause=12") || !strings.Contains(logged, "assessment_active=true") {
		t.Fatal("both socket-derived reporters were not captured exactly once")
	}
	message.GrantID = "old"
	h.handle(remote, message)
	takeReady(t, remote, MsgTypeError)
	if output.String() != logged {
		t.Fatal("stale authorization logged a snapshot")
	}
	h.detach(remote)
	if remote.serialFailureLogged != 0 {
		t.Fatal("old grant retained its diagnostic log mask")
	}
}

func serialPair(t *testing.T, access Access) (*Hub, *Client, *Client, Message) {
	t.Helper()
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", SerialP2PProtocol: 1, SerialP2PTXRelayProtocol: 1,
		RXReplayProtocol: 1, RXStreamID: strings.Repeat("a", 32), Ports: []PortInfo{{PortID: "usb"}}})
	if takeReady(t, local, MsgTypeRegister).SerialP2PProtocol != 1 {
		t.Fatal("capability not registered")
	}
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: "ABC23", SerialP2PProtocol: 1, SerialP2PTXRelayProtocol: 1, RXReplayProtocol: 1, Access: access})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	takeReady(t, remote, MsgTypeConnectPending)
	h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: request.RequestID, ProbeKind: "offer", ProbePayload: "pending"})
	takeReady(t, remote, MsgTypeError)
	if len(local.send) != 0 {
		t.Fatal("pending peer negotiated")
	}
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: access})
	localConnected := takeReady(t, local, MsgTypeRemoteConnected)
	if localConnected.SerialP2PProtocol != 1 || localConnected.SerialP2PTXRelayProtocol != 1 {
		t.Fatal("Local capability missing")
	}
	grant := takeReady(t, remote, MsgTypeConnect)
	if grant.SerialP2PProtocol != 1 || grant.SerialP2PTXRelayProtocol != 1 {
		t.Fatal("Remote capability missing")
	}
	for _, sender := range []*Client{local, remote} {
		h.handle(sender, Message{Type: MsgTypeSerialSignal, PortID: "usb", RemoteID: remote.remoteID, GrantID: grant.GrantID, ProbeKind: "ready"})
		takeReady(t, local, MsgTypeSerialState)
		takeReady(t, remote, MsgTypeSerialState)
	}
	if !remote.serialDirect {
		t.Fatal("both sides did not become direct")
	}
	return h, local, remote, grant
}

func TestSerialP2PTXPermitsHaveCurrentSocketIdentityAndRejectReplay(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	intent := Message{Type: MsgTypeSerialTX, LocalID: "ZZZZZ", RemoteID: "FORGED", PortID: "usb", GrantID: grant.GrantID,
		WriteEpoch: local.writeEpoch, TXSeq: 1, ByteLength: 4, SHA256: strings.Repeat("a", 64)}
	h.handle(remote, intent)
	permit := takeReady(t, local, MsgTypeSerialPermit)
	takeReady(t, remote, MsgTypeSerialPermit)
	if permit.RemoteID != remote.remoteID || permit.LocalID != local.localID || permit.SHA256 != intent.SHA256 || permit.ByteLength != 4 || permit.WriteEpoch != local.writeEpoch {
		t.Fatalf("permit lost identity or binding: %+v", permit)
	}
	h.handle(remote, intent)
	if takeReady(t, remote, MsgTypeError).Code != "invalid_p2p_tx" {
		t.Fatal("duplicate permit accepted")
	}
	if len(local.send) != 0 {
		t.Fatal("duplicate reached Local")
	}
}

func TestSerialP2PTXPermissionBoundaries(t *testing.T) {
	for _, scenario := range []string{"read", "paused", "epoch", "port", "grant", "configuration", "flash", "fallback", "size", "hash", "sequence"} {
		t.Run(scenario, func(t *testing.T) {
			h, local, remote, grant := serialPair(t, AccessControl)
			intent := Message{Type: MsgTypeSerialTX, PortID: "usb", GrantID: grant.GrantID, WriteEpoch: local.writeEpoch,
				TXSeq: 1, ByteLength: 4, SHA256: strings.Repeat("a", 64)}
			switch scenario {
			case "read":
				target := h.subscriptions[remote]
				target.access = AccessRead
				h.subscriptions[remote] = target
			case "paused":
				local.writesPaused = true
			case "epoch":
				intent.WriteEpoch++
			case "port":
				intent.PortID = "other"
			case "grant":
				intent.GrantID = "old"
			case "configuration":
				local.configuration = &configurationChange{}
			case "flash":
				h.flashSessions[local] = &flashSession{}
			case "fallback":
				remote.serialDirect = false
			case "size":
				intent.ByteLength = MaxDataSize + 1
			case "hash":
				intent.SHA256 = strings.Repeat("z", 64)
			case "sequence":
				intent.TXSeq = 0
			}
			h.handle(remote, intent)
			takeReady(t, remote, MsgTypeError)
			if len(local.send) != 0 {
				t.Fatal("forbidden write permit reached Local")
			}
		})
	}
}

func TestSerialP2PTXQueueRelayPreservesDirectRXAndWSSWrites(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	other := peer(h, RoleRemote)
	h.handle(other, Message{Type: MsgTypeConnect, Version: 3, LocalID: local.localID, SerialP2PProtocol: 1,
		SerialP2PRetryProtocol: 1, RXReplayProtocol: 1, Access: AccessControl})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	takeReady(t, other, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessControl})
	takeReady(t, local, MsgTypeRemoteConnected)
	otherGrant := takeReady(t, other, MsgTypeConnect)
	for _, endpoint := range []*Client{local, other} {
		h.handle(endpoint, Message{Type: MsgTypeSerialSignal, RemoteID: other.remoteID, PortID: "usb", GrantID: otherGrant.GrantID, ProbeKind: "ready"})
		takeReady(t, local, MsgTypeSerialState)
		takeReady(t, other, MsgTypeSerialState)
	}
	if !other.serialDirect {
		t.Fatal("second approved peer did not become direct")
	}
	relay := Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID,
		P2PAttempt: remote.serialAttempt, ProbeKind: "tx_relay", P2PReason: "tx_queue"}
	h.handle(remote, relay)
	if takeReady(t, remote, MsgTypeError).Code != "invalid_p2p_signal" || remote.serialTXRelay {
		t.Fatal("Remote forged the Local-only TX relay switch")
	}
	h.handle(local, relay)
	for _, endpoint := range []*Client{local, remote} {
		state := takeReady(t, endpoint, MsgTypeSerialState)
		if state.ProbeKind != "tx_relay" || !state.Direct || !state.SerialTXRelay || state.P2PReason != "tx_queue" {
			t.Fatal("TX relay switch closed direct RX or was not delivered to both endpoints")
		}
	}
	if len(other.send) != 0 || !other.serialDirect || other.serialTXRelay {
		t.Fatal("one Remote's TX backlog affected the other direct peer")
	}
	if !remote.serialDirect || !remote.serialTXRelay {
		t.Fatal("Hub did not preserve the direct RX authorization")
	}
	intent := Message{Type: MsgTypeSerialTX, PortID: "usb", GrantID: grant.GrantID, WriteEpoch: local.writeEpoch,
		TXSeq: 1, ByteLength: 2, SHA256: strings.Repeat("a", 64)}
	h.handle(remote, intent)
	if takeReady(t, remote, MsgTypeError).Code != "p2p_tx_relay" || len(local.send) != 0 || remote.serialTXSequence != 0 {
		t.Fatal("server issued a new P2P TX permit after switching this Remote to relay TX")
	}
	h.handle(remote, Message{Type: MsgTypeSend, PortID: "usb", GrantID: grant.GrantID, WriteEpoch: local.writeEpoch, Data: "AP8="})
	if data := takeReady(t, local, MsgTypeSend); data.Data != "AP8=" || !remote.serialDirect {
		t.Fatal("authorized WSS TX failed after routing this peer's TX to relay")
	}
	if !remote.serialDirect || !other.serialDirect || other.serialTXRelay {
		t.Fatal("the per-Remote TX mode revoked direct RX")
	}
}

func TestSerialP2PTXRelayRequiresNegotiatedClientCapability(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	remote.serialP2PTXRelayProtocol = 0
	h.handle(local, Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID,
		P2PAttempt: remote.serialAttempt, ProbeKind: "tx_relay", P2PReason: "tx_queue"})
	if takeReady(t, local, MsgTypeError).Code != "invalid_p2p_signal" || !remote.serialDirect || remote.serialTXRelay {
		t.Fatal("TX-only relay mode was enabled without bilateral capability negotiation")
	}
}

func TestSerialP2PTXRelayIsNotNegotiatedForAnOlderRemote(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessControl)
	remote.serialP2PTXRelayProtocol = 0 // Simulate an older approved Remote.
	if negotiatedSerialP2PTXRelay(local, remote) != 0 {
		t.Fatal("TX-only relay was negotiated without both endpoint capabilities")
	}
	h.handle(local, Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID,
		P2PAttempt: remote.serialAttempt, ProbeKind: "tx_relay", P2PReason: "tx_queue"})
	if takeReady(t, local, MsgTypeError).Code != "invalid_p2p_signal" || !remote.serialDirect || remote.serialTXRelay {
		t.Fatal("a Local switched an older Remote to an unsupported split transport")
	}
}

func TestSerialP2PNegotiationOwnerGrantBoundsAndFallback(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessRead)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: local.localID, RXReplayProtocol: 1})
	if takeReady(t, remote, MsgTypeError).Code != "invalid_access" || remote.serialP2PProtocol != 1 {
		t.Fatal("transport capability changed within a live grant")
	}
	other := peer(h, RoleLocal)
	message := Message{Type: MsgTypeSerialSignal, PortID: "usb", RemoteID: remote.remoteID, GrantID: grant.GrantID, ProbeKind: "answer", ProbePayload: "sdp"}
	h.handle(other, message)
	takeReady(t, other, MsgTypeError)
	for _, kind := range []string{"ready", "fallback", "candidate"} {
		forged := message
		forged.ProbeKind, forged.ProbePayload = kind, ""
		if kind == "candidate" {
			forged.ProbePayload = `{"candidate":"candidate:forged"}`
		}
		h.handle(other, forged)
		if takeReady(t, other, MsgTypeError).Code != "p2p_not_authorized" {
			t.Fatal("another Local acquired transport state or ICE access")
		}
		if !remote.serialDirect || remote.serialFallback || len(local.send) != 0 || len(remote.send) != 0 {
			t.Fatal("forged transport state changed or disclosed the approved pair")
		}
	}
	message.GrantID = "old"
	h.handle(local, message)
	takeReady(t, local, MsgTypeError)
	message.GrantID = grant.GrantID
	message.ProbePayload = strings.Repeat("s", 16385)
	h.handle(local, message)
	takeReady(t, local, MsgTypeError)
	message.ProbePayload = "sdp"
	h.handle(local, message)
	if takeReady(t, remote, MsgTypeSerialSignal).RemoteID != remote.remoteID {
		t.Fatal("wrong identity")
	}
	message.ProbeKind, message.ProbePayload = "fallback", ""
	h.handle(remote, message)
	takeReady(t, local, MsgTypeSerialState)
	takeReady(t, remote, MsgTypeSerialState)
	message.ProbeKind = "ready"
	h.handle(local, message)
	takeReady(t, local, MsgTypeSerialState)
	takeReady(t, remote, MsgTypeSerialState)
	if remote.serialDirect {
		t.Fatal("late ready revived fallback")
	}
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID})
	takeReady(t, local, MsgTypeRemoteDisconnected)
	takeReady(t, remote, MsgTypePermissionRevoked)
	h.handle(remote, message)
	takeReady(t, remote, MsgTypeError)
	if len(local.send) != 0 {
		t.Fatal("revoked signal leaked")
	}
}

func TestSerialP2PRXUsesMetadataAndCanRepairMissingTail(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessRead)
	rx := Message{Type: MsgTypeData, PortID: "usb", SerialP2PProtocol: 1, RXStreamID: local.rxStreamID, RXSeq: 1, DirectRemotes: []string{remote.remoteID}}
	h.handle(local, rx)
	if head := takeReady(t, remote, MsgTypeSerialHead); head.RXSeq != 1 || head.Data != "" || head.GrantID != grant.GrantID {
		t.Fatal("unexpected RX head")
	}
	if local.rxSequence != 1 {
		t.Fatal("global RX head not advanced")
	}
	h.handle(remote, Message{Type: MsgTypeSerialResume, PortID: "usb", GrantID: grant.GrantID, RXStreamID: local.rxStreamID, ResumeSeq: 0})
	takeReady(t, remote, MsgTypeSerialReplay)
	if resume := takeReady(t, local, MsgTypeResumeRX); resume.ThroughSeq != 1 || resume.ResumeSeq != 0 {
		t.Fatal("incorrect replay range")
	}
	h.handle(local, Message{Type: MsgTypeReplayData, PortID: "usb", TargetRemoteID: remote.remoteID, GrantID: grant.GrantID,
		RXStreamID: local.rxStreamID, RXSeq: 1, Data: base64.StdEncoding.EncodeToString([]byte{0, 192, 219, 255})})
	takeReady(t, remote, MsgTypeData)
	h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: grant.GrantID, RXStreamID: local.rxStreamID, RXSeq: 1})
	takeReady(t, local, MsgTypeRXAck)
	h.handle(local, Message{Type: MsgTypeReplayComplete, PortID: "usb", TargetRemoteID: remote.remoteID, GrantID: grant.GrantID, RXStreamID: local.rxStreamID, ThroughSeq: 1})
	takeReady(t, remote, MsgTypeReplayComplete)
	if head := takeReady(t, remote, MsgTypeSerialHead); head.RXSeq != 1 {
		t.Fatal("replay completion lost the latest live cursor")
	}
	if remote.replay != nil {
		t.Fatal("live replay did not finish")
	}
	// A paused writer retains its receive repair capability.
	local.writesPaused = true
	h.handle(remote, Message{Type: MsgTypeSerialResume, PortID: "usb", GrantID: "old", RXStreamID: local.rxStreamID})
	takeReady(t, remote, MsgTypeError)
	h.handle(local, rx)
	takeReady(t, local, MsgTypeError)
}

func TestSerialP2PMixedRXKeepsLegacyAndDirectRecipientsSeparate(t *testing.T) {
	h, local, remote, _ := serialPair(t, AccessControl)
	legacy := peer(h, RoleRemote)
	connect(t, h, legacy, local, local.localID, "usb")
	data := base64.StdEncoding.EncodeToString([]byte{0, 255})
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", SerialP2PProtocol: 1, RXStreamID: local.rxStreamID,
		RXSeq: 1, Data: data, DirectRemotes: []string{remote.remoteID}})
	if takeReady(t, legacy, MsgTypeData).Data != data {
		t.Fatal("legacy bytes changed")
	}
	takeReady(t, remote, MsgTypeSerialHead)
	if len(remote.send) != 0 {
		t.Fatal("direct payload also relayed")
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", SerialP2PProtocol: 1, RXStreamID: local.rxStreamID,
		RXSeq: 2, DirectRemotes: []string{remote.remoteID}})
	takeReady(t, local, MsgTypeError)
	if local.rxSequence != 1 {
		t.Fatal("missing legacy payload advanced the head")
	}
}
