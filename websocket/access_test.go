package websocket

import (
	"testing"
	"time"
)

func requestAccess(t *testing.T, h *Hub, remote, local *Client, access Access) string {
	t.Helper()
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: local.localID, Access: access})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	pending := takeReady(t, remote, MsgTypeConnectPending)
	if pending.PortID != "" || len(pending.Ports) != 0 || pending.SerialConfig != nil || pending.ConfigProtocol != 0 {
		t.Fatal("pending response disclosed serial metadata")
	}
	wanted := access
	if wanted == "" {
		wanted = AccessRead
	}
	if request.Access != wanted || pending.Access != wanted {
		t.Fatalf("requested access changed: %+v %+v", request, pending)
	}
	if len(request.RequestID) != 22 || pending.RequestID != request.RequestID || pending.Version != ProtocolVersion {
		t.Fatalf("invalid approval handshake: %+v %+v", request, pending)
	}
	return request.RequestID
}

func grantAccess(t *testing.T, h *Hub, remote, local *Client, requestID string, access Access) {
	t.Helper()
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: requestID, Access: access})
	notification := takeReady(t, local, MsgTypeRemoteConnected)
	grant := takeReady(t, remote, MsgTypeConnect)
	if notification.Access != access || grant.Access != access || grant.RequestID != requestID || grant.Version != ProtocolVersion {
		t.Fatalf("incorrect grant: %+v %+v", notification, grant)
	}
}

func accessFixture(t *testing.T) (*Hub, *Client, *Client) {
	t.Helper()
	h := NewHub()
	local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
	share(t, h, local, "ABC23", "usb")
	return h, local, remote
}

func TestApprovalRequiredBeforeDataOrMetadata(t *testing.T) {
	h, local, remote := accessFixture(t)
	requestID := requestAccess(t, h, remote, local, AccessControl)
	if len(h.subscriptions) != 0 {
		t.Fatal("pending request acquired a subscription")
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	if len(remote.send) != 0 {
		t.Fatal("unapproved Remote received serial bytes")
	}
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", Access: AccessControl})
	if takeReady(t, remote, MsgTypeError).Code != "not_connected" {
		t.Fatal("unapproved write accepted")
	}
	h.handle(remote, Message{Type: MsgTypeGetPorts, LocalID: "ABC23"})
	if takeReady(t, remote, MsgTypeError).Code != "approval_required" {
		t.Fatal("unapproved metadata exposed")
	}
	h.handle(remote, Message{Type: MsgTypeApprove, RequestID: requestID, Access: AccessControl})
	if takeReady(t, remote, MsgTypeError).Code != "invalid_message" {
		t.Fatal("Remote approved itself")
	}
	if len(local.send) != 0 || len(h.subscriptions) != 0 {
		t.Fatal("unauthorized traffic changed access")
	}
	grantAccess(t, h, remote, local, requestID, AccessControl)
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
	takeReady(t, local, MsgTypeSend)
}

func TestAccessModesCannotEscalate(t *testing.T) {
	h, local, remote := accessFixture(t)
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", Access: "admin"})
	if takeReady(t, remote, MsgTypeError).Code != "invalid_access" || len(local.send) != 0 {
		t.Fatal("invalid requested mode accepted")
	}
	id := requestAccess(t, h, remote, local, AccessRead)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: "admin"})
	if takeReady(t, local, MsgTypeError).Code != "invalid_access" {
		t.Fatal("invalid grant mode accepted")
	}
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessControl})
	if takeReady(t, local, MsgTypeError).Code != "permission_denied" {
		t.Fatal("read request escalated with free controller slot")
	}
	if len(remote.send) != 0 || len(h.subscriptions) != 0 {
		t.Fatal("rejected decision granted access")
	}
	grantAccess(t, h, remote, local, id, AccessRead)
}

func TestReadOnlyAndRevocation(t *testing.T) {
	h, local, remote := accessFixture(t)
	requestID := requestAccess(t, h, remote, local, "") // missing access defaults to read
	grantAccess(t, h, remote, local, requestID, AccessRead)
	h.handle(remote, Message{Type: MsgTypeGetPorts, LocalID: "ABC23"})
	if len(takeReady(t, remote, MsgTypePortList).Ports) != 1 {
		t.Fatal("approved reader cannot list its port")
	}
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ==", Access: AccessControl})
	if takeReady(t, remote, MsgTypeError).Code != "read_only" || len(local.send) != 0 {
		t.Fatal("reader escalated by message field")
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	takeReady(t, remote, MsgTypeData)
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID})
	takeReady(t, local, MsgTypeRemoteDisconnected)
	takeReady(t, remote, MsgTypePermissionRevoked)
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "Qg=="})
	if len(remote.send) != 0 {
		t.Fatal("revoked Remote still receives bytes")
	}
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
	if takeReady(t, remote, MsgTypeError).Code != "not_connected" {
		t.Fatal("revoked writer still subscribed")
	}
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: requestID, Access: AccessRead})
	if takeReady(t, local, MsgTypeError).Code != "request_not_found" {
		t.Fatal("old approval replay succeeded")
	}
}

func TestOnlyOwnerCanDecideOrRevoke(t *testing.T) {
	h, local, remote := accessFixture(t)
	other := peer(h, RoleLocal)
	share(t, h, other, "DEF45", "usb")
	requestID := requestAccess(t, h, remote, local, AccessControl)
	for _, kind := range []MessageType{MsgTypeApprove, MsgTypeReject} {
		h.handle(other, Message{Type: kind, RequestID: requestID, Access: AccessControl, LocalID: "ABC23"})
		if takeReady(t, other, MsgTypeError).Code != "permission_denied" {
			t.Fatal("wrong Local decided request")
		}
		if h.requests[requestID] == nil || len(remote.send) != 0 {
			t.Fatal("unauthorized decision consumed request")
		}
	}
	grantAccess(t, h, remote, local, requestID, AccessControl)
	h.handle(other, Message{Type: MsgTypeRevoke, RemoteID: remote.remoteID, LocalID: "ABC23"})
	if takeReady(t, other, MsgTypeError).Code != "permission_denied" || len(remote.send) != 0 {
		t.Fatal("wrong Local revoked access")
	}
	sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
	takeReady(t, local, MsgTypeSend)
}

func TestMultipleWritersAndDowngrade(t *testing.T) {
	h, local, first := accessFixture(t)
	id := requestAccess(t, h, first, local, AccessControl)
	grantAccess(t, h, first, local, id, AccessControl)
	second := peer(h, RoleRemote)
	id = requestAccess(t, h, second, local, AccessControl)
	grantAccess(t, h, second, local, id, AccessControl)
	for _, remote := range []*Client{first, second} {
		sendFrom(h, remote, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
		message := takeReady(t, local, MsgTypeSend)
		if message.RemoteID != remote.remoteID || message.GrantID != h.subscriptions[remote].grantID {
			t.Fatal("writer identity/grant lost")
		}
	}
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: first.remoteID})
	takeReady(t, local, MsgTypeRemoteDisconnected)
	takeReady(t, first, MsgTypePermissionRevoked)
	if h.subscriptions[second].access != AccessControl {
		t.Fatal("revoking one writer affected another")
	}
	reader := peer(h, RoleRemote)
	id = requestAccess(t, h, reader, local, AccessRead)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessControl})
	if takeReady(t, local, MsgTypeError).Code != "permission_denied" {
		t.Fatal("read request escalated to control")
	}
	grantAccess(t, h, reader, local, id, AccessRead)
	downgraded := peer(h, RoleRemote)
	id = requestAccess(t, h, downgraded, local, AccessControl)
	grantAccess(t, h, downgraded, local, id, AccessRead)
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	for _, remote := range []*Client{second, reader, downgraded} {
		takeReady(t, remote, MsgTypeData)
	}
}

func TestRequestDenialCancellationAndExpiry(t *testing.T) {
	for _, action := range []string{"reject", "cancel", "remote_close", "local_close", "expire"} {
		t.Run(action, func(t *testing.T) {
			h, local, remote := accessFixture(t)
			now := time.Unix(1000, 0)
			h.now = func() time.Time { return now }
			id := requestAccess(t, h, remote, local, AccessRead)
			switch action {
			case "reject":
				h.handle(local, Message{Type: MsgTypeReject, RequestID: id})
				takeReady(t, local, MsgTypeRequestCancelled)
				if takeReady(t, remote, MsgTypeError).Code != "connection_denied" {
					t.Fatal("wrong denial")
				}
			case "cancel":
				h.handle(remote, Message{Type: MsgTypeDisconnect})
				takeReady(t, local, MsgTypeRequestCancelled)
				takeReady(t, remote, MsgTypeDisconnect)
			case "remote_close":
				h.remove(remote)
				takeReady(t, local, MsgTypeRequestCancelled)
			case "local_close":
				h.handle(local, Message{Type: MsgTypeUnregister})
				takeReady(t, local, MsgTypeRequestCancelled)
				takeReady(t, local, MsgTypeUnregister)
				if takeReady(t, remote, MsgTypeError).Code != "local_disconnected" {
					t.Fatal("wrong Local close error")
				}
			case "expire":
				now = now.Add(ApprovalTTL - time.Nanosecond)
				h.expireRequests()
				if len(remote.send) != 0 || h.pending[remote] == nil {
					t.Fatal("request expired too soon")
				}
				now = now.Add(time.Nanosecond)
				h.expireRequests()
				takeReady(t, local, MsgTypeRequestCancelled)
				if takeReady(t, remote, MsgTypeError).Code != "approval_timeout" {
					t.Fatal("request did not expire at deadline")
				}
			}
			if len(h.pending) != 0 || len(h.requests) != 0 || len(h.subscriptions) != 0 {
				t.Fatal("request cleanup retained access state")
			}
			h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessRead})
			if takeReady(t, local, MsgTypeError).Code != "request_not_found" {
				t.Fatal("stale decision was accepted")
			}
		})
	}
}

func TestDecisionDeadlineAndDuplicateRequest(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "at_deadline"}[expired], func(t *testing.T) {
			h, local, remote := accessFixture(t)
			now := time.Unix(1000, 0)
			h.now = func() time.Time { return now }
			id := requestAccess(t, h, remote, local, AccessRead)
			now = now.Add(10 * time.Second)
			h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", Access: AccessRead})
			duplicate := takeReady(t, remote, MsgTypeConnectPending)
			if duplicate.RequestID != id || duplicate.ExpiresIn != 50 || len(local.send) != 0 {
				t.Fatal("duplicate request renewed or duplicated approval")
			}
			now = now.Add(50 * time.Second)
			if !expired {
				now = now.Add(-time.Nanosecond)
				grantAccess(t, h, remote, local, id, AccessRead)
				return
			}
			h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessRead})
			takeReady(t, local, MsgTypeRequestCancelled)
			if takeReady(t, local, MsgTypeError).Code != "request_expired" {
				t.Fatal("late decision accepted")
			}
			takeReady(t, remote, MsgTypeError)
			if len(h.subscriptions) != 0 {
				t.Fatal("expired request gained access")
			}
		})
	}
}

func TestPendingAndApprovedLimits(t *testing.T) {
	h, local, _ := accessFixture(t)
	var requests []string
	for i := 0; i < MaxPendingPerLocal; i++ {
		requests = append(requests, requestAccess(t, h, peer(h, RoleRemote), local, AccessRead))
	}
	extra := peer(h, RoleRemote)
	h.handle(extra, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", Access: AccessRead})
	if takeReady(t, extra, MsgTypeError).Code != "too_many_requests" {
		t.Fatal("pending limit exceeded")
	}
	first := h.requests[requests[0]].remote
	h.handle(local, Message{Type: MsgTypeReject, RequestID: requests[0]})
	takeReady(t, local, MsgTypeRequestCancelled)
	takeReady(t, first, MsgTypeError)
	requestAccess(t, h, extra, local, AccessRead)
	h, local, _ = accessFixture(t)
	var approved []*Client
	for i := 0; i < MaxRemotesPerLocal; i++ {
		remote := peer(h, RoleRemote)
		id := requestAccess(t, h, remote, local, AccessRead)
		grantAccess(t, h, remote, local, id, AccessRead)
		approved = append(approved, remote)
	}
	extra = peer(h, RoleRemote)
	id := requestAccess(t, h, extra, local, AccessRead)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessRead})
	if takeReady(t, local, MsgTypeError).Code != "too_many_remotes" {
		t.Fatal("approved limit exceeded")
	}
	if len(extra.send) != 0 {
		t.Fatal("over-limit request was granted")
	}
	h.handle(local, Message{Type: MsgTypeRevoke, RemoteID: approved[0].remoteID})
	takeReady(t, local, MsgTypeRemoteDisconnected)
	takeReady(t, approved[0], MsgTypePermissionRevoked)
	grantAccess(t, h, extra, local, id, AccessRead)
}

func TestSlowLocalCannotLeaveNewApprovalState(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "replace_pending", true: "change_grant"}[active], func(t *testing.T) {
			h, local, remote := accessFixture(t)
			id := requestAccess(t, h, remote, local, AccessRead)
			if active {
				grantAccess(t, h, remote, local, id, AccessRead)
				id = requestAccess(t, h, remote, local, AccessControl)
			}
			for i := 0; i < cap(local.send); i++ {
				local.send <- []byte(`{}`)
			}
			if active {
				h.handle(local, Message{Type: MsgTypeApprove, RequestID: id, Access: AccessControl})
			} else {
				h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", Access: AccessControl})
			}
			if len(h.locals) != 0 || len(h.pending) != 0 || len(h.requests) != 0 || len(h.subscriptions) != 0 {
				t.Fatal("slow Local removal left authorization state")
			}
			takeReady(t, remote, MsgTypeError)
			replacement := peer(h, RoleLocal)
			share(t, h, replacement, "ABC23", "usb")
			h.handle(replacement, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
			if len(remote.send) != 0 {
				t.Fatal("stale grant leaked a replacement Local's data")
			}
		})
	}
}
