package websocket

import (
	"strings"
	"testing"
	"time"
)

func retryPair(t *testing.T, localRetry, remoteRetry int) (*Hub, *Client, *Client, Message, func(time.Duration)) {
	t.Helper()
	h := NewHub()
	clock := time.Unix(1800000000, 0)
	h.now = func() time.Time { return clock }
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	h.handle(local, Message{Type: MsgTypeRegister, Version: 3, LocalID: "ABC23", SerialP2PProtocol: 1, SerialP2PRetryProtocol: localRetry, SerialP2PTXRelayProtocol: 1,
		RXReplayProtocol: 1, RXStreamID: strings.Repeat("a", 32), Ports: []PortInfo{{PortID: "usb"}}})
	if takeReady(t, local, MsgTypeRegister).SerialP2PRetryProtocol != localRetry {
		t.Fatal("retry capability not registered")
	}
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: "ABC23", SerialP2PProtocol: 1, SerialP2PRetryProtocol: remoteRetry, SerialP2PTXRelayProtocol: 1, RXReplayProtocol: 1, Access: AccessControl})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	takeReady(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: AccessControl})
	approved := takeReady(t, local, MsgTypeRemoteConnected)
	grant := takeReady(t, remote, MsgTypeConnect)
	want := 0
	if localRetry == 1 && remoteRetry == 1 {
		want = 1
	}
	if approved.SerialP2PRetryProtocol != want || grant.SerialP2PRetryProtocol != want {
		t.Fatal("retry must be negotiated by both endpoints")
	}
	return h, local, remote, grant, func(d time.Duration) { clock = clock.Add(d) }
}

func retryFallback(t *testing.T, h *Hub, local, remote *Client, grant Message, reason string, details *P2PFailureDetails) {
	t.Helper()
	h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, P2PAttempt: remote.serialAttempt,
		ProbeKind: "fallback", P2PReason: reason, P2PDetails: details})
	takeReady(t, local, MsgTypeSerialState)
	takeReady(t, remote, MsgTypeSerialState)
}

func TestSerialP2PRetryCreatesScopedRoundsWithoutResettingTXSequence(t *testing.T) {
	h, local, remote, grant, advance := retryPair(t, 1, 1)
	remote.serialTXSequence = 19
	remote.serialFailureLogged = 3
	retryFallback(t, h, local, remote, grant, "connection_failed", nil)
	advance(5 * time.Second)
	h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "retry"})
	for _, endpoint := range []*Client{local, remote} {
		state := takeReady(t, endpoint, MsgTypeSerialState)
		if state.ProbeKind != "retry" || state.P2PAttempt != 1 || state.SerialP2PRetryProtocol != 1 || state.Direct {
			t.Fatal("retry did not reset both endpoints to the same round")
		}
	}
	if remote.serialFallback || remote.serialLocalReady || remote.serialRemoteReady || remote.serialTXSequence != 19 || remote.serialFailureLogged != 0 {
		t.Fatal("retry revived transport state or reset command replay protection")
	}
	for _, kind := range []string{"offer", "answer", "candidate", "ready", "fallback", "retry"} {
		h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: kind})
	}
	h.handle(remote, Message{Type: MsgTypeSerialTX, PortID: "usb", GrantID: grant.GrantID, TXSeq: 20})
	if len(local.send) != 0 || len(remote.send) != 0 || remote.serialDirect || remote.serialFallback {
		t.Fatal("old round messages affected the new attempt")
	}
	h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, P2PAttempt: 1, ProbeKind: "offer", ProbePayload: "new offer"})
	if takeReady(t, local, MsgTypeSerialSignal).P2PAttempt != 1 {
		t.Fatal("offer lost its round")
	}
	for _, endpoint := range []*Client{local, remote} {
		h.handle(endpoint, Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID, P2PAttempt: 1, ProbeKind: "ready"})
		takeReady(t, local, MsgTypeSerialState)
		takeReady(t, remote, MsgTypeSerialState)
	}
	intent := Message{Type: MsgTypeSerialTX, PortID: "usb", GrantID: grant.GrantID, P2PAttempt: 1, WriteEpoch: local.writeEpoch,
		TXSeq: 19, ByteLength: 1, SHA256: strings.Repeat("a", 64)}
	h.handle(remote, intent)
	if takeReady(t, remote, MsgTypeError).Code != "invalid_p2p_tx" {
		t.Fatal("previous command sequence was accepted")
	}
	intent.TXSeq++
	h.handle(remote, intent)
	if takeReady(t, local, MsgTypeSerialPermit).P2PAttempt != 1 || takeReady(t, remote, MsgTypeSerialPermit).P2PAttempt != 1 {
		t.Fatal("permit lost its round")
	}
}

func TestSerialP2PRetryRequiresOwnerCapabilityBackoffAndRecoverableFailure(t *testing.T) {
	for _, scenario := range []string{"local", "other-local", "grant", "port", "future", "negative", "early", "legacy-local", "legacy-remote", "active", "expired", "payload", "reason", "details", "application", "candidate_error", "dtls"} {
		t.Run(scenario, func(t *testing.T) {
			localRetry, remoteRetry := 1, 1
			if scenario == "legacy-local" {
				localRetry = 0
			}
			if scenario == "legacy-remote" {
				remoteRetry = 0
			}
			h, local, remote, grant, advance := retryPair(t, localRetry, remoteRetry)
			reason := "connection_failed"
			var details *P2PFailureDetails
			if scenario == "application" || scenario == "candidate_error" {
				reason = scenario
			}
			if scenario == "dtls" {
				details = &P2PFailureDetails{ICE: "connected", DTLS: "failed", SCTP: "closed"}
			}
			if scenario != "active" {
				retryFallback(t, h, local, remote, grant, reason, details)
			}
			if scenario != "early" {
				advance(5 * time.Second)
			}
			message := Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "retry"}
			sender := remote
			switch scenario {
			case "local":
				sender = local
				message.RemoteID = remote.remoteID
			case "other-local":
				sender = peer(h, RoleLocal)
				message.RemoteID = remote.remoteID
			case "grant":
				message.GrantID = "old"
			case "port":
				message.PortID = "other"
			case "future":
				message.P2PAttempt = 1
			case "negative":
				message.P2PAttempt = -1
			case "expired":
				advance(175 * time.Second)
			case "payload":
				message.ProbePayload = "unexpected"
			case "reason":
				message.P2PReason = "connection_failed"
			case "details":
				message.P2PDetails = &P2PFailureDetails{}
			}
			h.handle(sender, message)
			takeReady(t, sender, MsgTypeError)
			if remote.serialAttempt != 0 || len(local.send) != 0 || len(remote.send) != 0 {
				t.Fatal("rejected retry changed or disclosed the pair")
			}
		})
	}
}

func TestSerialP2PRetryHasFourRoundsAndDoesNotExtendItsWindow(t *testing.T) {
	h, local, remote, grant, advance := retryPair(t, 1, 1)
	start := remote.serialRetryStarted
	for attempt := 0; attempt < 4; attempt++ {
		retryFallback(t, h, local, remote, grant, "negotiation_timeout", nil)
		advance((5 * time.Second) << attempt)
		h.handle(remote, Message{Type: MsgTypeSerialSignal, PortID: "usb", GrantID: grant.GrantID, P2PAttempt: attempt, ProbeKind: "retry"})
		if attempt == 3 {
			takeReady(t, remote, MsgTypeError)
			break
		}
		takeReady(t, local, MsgTypeSerialState)
		takeReady(t, remote, MsgTypeSerialState)
		if remote.serialAttempt != attempt+1 || remote.serialRetryStarted != start {
			t.Fatal("retry limit or window was reset")
		}
	}
	if remote.serialAttempt != 3 || len(local.send) != 0 {
		t.Fatal("retry attempts were unbounded")
	}
}

func TestSerialP2PRetryCapabilityCannotChangeWithinGrant(t *testing.T) {
	h, _, remote, grant, _ := retryPair(t, 1, 1)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: 3, LocalID: grant.LocalID, RXReplayProtocol: 1, SerialP2PProtocol: 1})
	if takeReady(t, remote, MsgTypeError).Code != "invalid_access" || remote.serialP2PRetryProtocol != 1 {
		t.Fatal("retry capability changed without reapproval")
	}
	h.detach(remote)
	if remote.serialAttempt != 0 || !remote.serialRetryStarted.IsZero() || !remote.serialRetryAfter.IsZero() {
		t.Fatal("detach retained a retry lifecycle")
	}
}

func TestSerialP2PRetiredSignalErrorRetainsGrantAndTargetContext(t *testing.T) {
	h, local, remote, grant := serialPair(t, AccessRead)
	h.detach(remote)
	takeReady(t, local, MsgTypeRemoteDisconnected)
	h.handle(local, Message{Type: MsgTypeSerialSignal, RemoteID: remote.remoteID, PortID: "usb", GrantID: grant.GrantID, ProbeKind: "fallback"})
	problem := takeReady(t, local, MsgTypeError)
	if problem.Code != "p2p_not_authorized" || problem.GrantID != grant.GrantID || problem.PortID != "usb" || problem.RemoteID != remote.remoteID {
		t.Fatal("retired signal lost its correlation context")
	}
}
