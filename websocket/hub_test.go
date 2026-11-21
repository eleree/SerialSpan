package websocket

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func peer(h *Hub, role Role) *Client {
	c := NewClient(h, nil, role)
	h.add(c)
	return c
}

func sendFrom(h *Hub, client *Client, message Message) {
	if target, ok := h.subscriptions[client]; ok && message.Type == MsgTypeSend {
		message.GrantID = target.grantID
		if local := h.locals[target.localID]; local != nil {
			message.WriteEpoch = local.writeEpoch
		}
	}
	h.handle(client, message)
}

func take(t *testing.T, c *Client, kind MessageType) Message {
	t.Helper()
	select {
	case data, ok := <-c.send:
		if !ok {
			t.Fatal("client unexpectedly closed")
		}
		var message Message
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type != kind {
			t.Fatalf("want %s, got %+v", kind, message)
		}
		return message
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", kind)
		return Message{}
	}
}

func share(t *testing.T, h *Hub, c *Client, id, port string) {
	t.Helper()
	h.handle(c, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: id, Ports: []PortInfo{{PortID: port, Name: port}}})
	takeReady(t, c, MsgTypeRegister)
}

func connect(t *testing.T, h *Hub, remote, local *Client, id, port string) {
	t.Helper()
	access := AccessControl
	for other, target := range h.subscriptions {
		if other != remote && target.localID == id && target.access == AccessControl {
			access = AccessRead
		}
	}
	h.handle(remote, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: id, PortID: port, Access: access})
	request := takeReady(t, local, MsgTypeConnectionRequest)
	takeReady(t, remote, MsgTypeConnectPending)
	h.handle(local, Message{Type: MsgTypeApprove, RequestID: request.RequestID, Access: access})
	takeReady(t, local, MsgTypeRemoteConnected)
	takeReady(t, remote, MsgTypeConnect)
}

func TestBroadcastAndSocketIdentity(t *testing.T) {
	h := NewHub()
	a, b := peer(h, RoleLocal), peer(h, RoleLocal)
	r1, r2, r3 := peer(h, RoleRemote), peer(h, RoleRemote), peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	share(t, h, b, "DEF45", "usb")
	connect(t, h, r1, a, "ABC23", "usb")
	connect(t, h, r2, a, "ABC23", "usb")
	connect(t, h, r3, b, "DEF45", "usb")
	payload := base64.StdEncoding.EncodeToString([]byte{0, 0xff, 0x0d, 0x80})
	h.handle(a, Message{Type: MsgTypeData, LocalID: "DEF45", PortID: "usb", Data: payload})
	for _, remote := range []*Client{r1, r2} {
		message := take(t, remote, MsgTypeData)
		if message.LocalID != "ABC23" || message.Data != payload {
			t.Fatalf("incorrect relay: %+v", message)
		}
	}
	if len(r3.send) != 0 {
		t.Fatal("data leaked to another Local's Remote")
	}
	sendFrom(h, r1, Message{Type: MsgTypeSend, RemoteID: r3.remoteID, LocalID: "DEF45", PortID: "usb", Data: payload})
	message := take(t, a, MsgTypeSend)
	if message.RemoteID != r1.remoteID || message.Data != payload {
		t.Fatalf("sender spoofed: %+v", message)
	}
	if len(b.send) != 0 {
		t.Fatal("send was routed using supplied identity")
	}
	h.handle(r1, Message{Type: MsgTypeDisconnect, RemoteID: r3.remoteID})
	take(t, a, MsgTypeRemoteDisconnected)
	take(t, r1, MsgTypeDisconnect)
	if _, ok := h.subscriptions[r3]; !ok {
		t.Fatal("another Remote was disconnected")
	}
}

func TestCollisionAndReRegistration(t *testing.T) {
	h := NewHub()
	a, b := peer(h, RoleLocal), peer(h, RoleLocal)
	r := peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	h.handle(b, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb"}}})
	if take(t, b, MsgTypeError).Code != "local_id_in_use" {
		t.Fatal("collision not rejected")
	}
	h.remove(b)
	if h.locals["ABC23"] != a {
		t.Fatal("disconnect removed another Local's registration")
	}
	connect(t, h, r, a, "ABC23", "usb")
	share(t, h, a, "DEF45", "new-port")
	take(t, r, MsgTypeLocalDisconnected)
	if h.locals["ABC23"] != nil || len(h.subscriptions) != 0 {
		t.Fatal("stale session retained")
	}
	h.handle(r, Message{Type: MsgTypeGetPorts, LocalID: "ABC23"})
	if take(t, r, MsgTypeError).Code != "approval_required" {
		t.Fatal("stale ID accessible")
	}
}

func TestInvalidConnectDoesNotBind(t *testing.T) {
	h := NewHub()
	a := peer(h, RoleLocal)
	r := peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	for _, message := range []Message{
		{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "DEF45", PortID: "usb"},
		{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "other"},
		{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb", Config: json.RawMessage(`{"baudRate":9600}`)},
	} {
		sendFrom(h, r, message)
		take(t, r, MsgTypeError)
		if len(h.subscriptions) != 0 || len(a.send) != 0 {
			t.Fatal("failed connect created a subscription")
		}
	}
	sendFrom(h, r, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
	if take(t, r, MsgTypeError).Code != "not_connected" {
		t.Fatal("send allowed before connect")
	}
}

func TestDisconnectLifecycle(t *testing.T) {
	for _, closeSocket := range []bool{false, true} {
		t.Run(fmt.Sprint(closeSocket), func(t *testing.T) {
			h := NewHub()
			a := peer(h, RoleLocal)
			r1, r2 := peer(h, RoleRemote), peer(h, RoleRemote)
			share(t, h, a, "ABC23", "usb")
			connect(t, h, r1, a, "ABC23", "usb")
			connect(t, h, r2, a, "ABC23", "usb")
			if closeSocket {
				h.remove(a)
			} else {
				h.handle(a, Message{Type: MsgTypeUnregister})
				take(t, a, MsgTypeUnregister)
			}
			take(t, r1, MsgTypeLocalDisconnected)
			take(t, r2, MsgTypeLocalDisconnected)
			if len(h.subscriptions) != 0 || len(h.locals) != 0 || len(h.ports) != 0 {
				t.Fatal("disconnect left stale state")
			}
			sendFrom(h, r1, Message{Type: MsgTypeSend, PortID: "usb", Data: "QQ=="})
			take(t, r1, MsgTypeError)
			if !closeSocket {
				share(t, h, a, "ABC23", "usb")
				connect(t, h, r1, a, "ABC23", "usb")
			}
		})
	}
}

func TestRepeatedConnectAndSwitch(t *testing.T) {
	h := NewHub()
	a, b := peer(h, RoleLocal), peer(h, RoleLocal)
	r := peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	share(t, h, b, "DEF45", "uart")
	connect(t, h, r, a, "ABC23", "usb")
	h.handle(r, Message{Type: MsgTypeConnect, Version: ProtocolVersion, LocalID: "ABC23", PortID: "usb", Access: AccessControl})
	take(t, r, MsgTypeConnect)
	if len(a.send) != 0 {
		t.Fatal("repeated connect duplicated notification")
	}
	connect(t, h, r, b, "DEF45", "uart")
	take(t, a, MsgTypeRemoteDisconnected)
	h.remove(r)
	take(t, b, MsgTypeRemoteDisconnected)
	h.remove(r) // duplicate cleanup must be safe
	if len(h.subscriptions) != 0 {
		t.Fatal("remote retained after close")
	}
}

func TestValidationAndOrdering(t *testing.T) {
	h := NewHub()
	a := peer(h, RoleLocal)
	r := peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	connect(t, h, r, a, "ABC23", "usb")
	for _, sample := range []struct {
		message Message
		code    string
	}{
		{Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="}, "invalid_message"},
		{Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "DEF45"}, "invalid_message"},
		{Message{Type: MsgTypeSend, PortID: "other", Data: "QQ=="}, "port_not_available"},
		{Message{Type: MsgTypeSend, PortID: "usb", Data: "!invalid!"}, "invalid_data"},
	} {
		sendFrom(h, r, sample.message)
		if got := takeReady(t, r, MsgTypeError); got.Code != sample.code {
			t.Fatalf("want %s, got %+v", sample.code, got)
		}
	}
	if len(a.send) != 0 {
		t.Fatal("invalid message reached the serial port")
	}
	for i := 0; i < 100; i++ {
		data := base64.StdEncoding.EncodeToString([]byte{byte(i)})
		sendFrom(h, r, Message{Type: MsgTypeSend, PortID: "usb", Data: data})
	}
	for i := 0; i < 100; i++ {
		message := take(t, a, MsgTypeSend)
		bytes, _ := base64.StdEncoding.DecodeString(message.Data)
		if len(bytes) != 1 || bytes[0] != byte(i) {
			t.Fatal("serial chunks reordered")
		}
	}
}

func TestSerialPayloadLimit(t *testing.T) {
	if !validData(base64.StdEncoding.EncodeToString(make([]byte, MaxDataSize))) {
		t.Fatal("maximum payload rejected")
	}
	if validData(base64.StdEncoding.EncodeToString(make([]byte, MaxDataSize+1))) {
		t.Fatal("oversized payload accepted")
	}
}

func TestSlowPeerCleanup(t *testing.T) {
	h := NewHub()
	a := peer(h, RoleLocal)
	slow, fast := peer(h, RoleRemote), peer(h, RoleRemote)
	share(t, h, a, "ABC23", "usb")
	connect(t, h, slow, a, "ABC23", "usb")
	connect(t, h, fast, a, "ABC23", "usb")
	for i := 0; i < cap(slow.send); i++ {
		slow.send <- []byte(`{}`)
	}
	h.handle(a, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	take(t, fast, MsgTypeData)
	take(t, a, MsgTypeRemoteDisconnected)
	if h.clients[slow] {
		t.Fatal("slow peer retained")
	}
	if _, ok := h.subscriptions[slow]; ok {
		t.Fatal("slow subscription retained")
	}
}

func TestCancellationReleasesClients(t *testing.T) {
	h := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)
	a := NewClient(h, nil, RoleLocal)
	if !h.Register(a) {
		t.Fatal("register failed")
	}
	h.Submit(a, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb"}}})
	take(t, a, MsgTypeRegister)
	cancel()
	select {
	case <-h.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("hub did not stop")
	}
	if _, ok := <-a.send; ok {
		t.Fatal("outbound channel still open")
	}
	if h.Submit(a, Message{}) || h.Register(a) {
		t.Fatal("stopped hub accepted input")
	}
}

// Hub handlers below run synchronously, so a missing reply is an immediate
// failure. Waiting would hide assertion gaps behind test-process timeouts.
func takeReady(t *testing.T, client *Client, kind MessageType) Message {
	t.Helper()
	if len(client.send) == 0 {
		t.Fatalf("handler produced no %s response", kind)
	}
	return take(t, client, kind)
}

func TestRegistrationBoundaries(t *testing.T) {
	port := PortInfo{PortID: "usb", Name: "USB"}
	for _, tc := range []struct {
		name  string
		id    string
		ports []PortInfo
		valid bool
	}{
		{"valid", "ABC23", []PortInfo{port}, true},
		{"empty_id", "", []PortInfo{port}, false},
		{"short_id", "ABC2", []PortInfo{port}, false},
		{"long_id", "ABC234", []PortInfo{port}, false},
		{"lowercase_id", "abc23", []PortInfo{port}, false},
		{"forbidden_letter", "ABO23", []PortInfo{port}, false},
		{"forbidden_digit", "ABC01", []PortInfo{port}, false},
		{"no_port", "ABC23", nil, false},
		{"two_ports", "ABC23", []PortInfo{port, {PortID: "uart"}}, false},
		{"empty_port", "ABC23", []PortInfo{{Name: "USB"}}, false},
		{"max_port_id", "ABC23", []PortInfo{{PortID: strings.Repeat("p", 128)}}, true},
		{"long_port_id", "ABC23", []PortInfo{{PortID: strings.Repeat("p", 129)}}, false},
		{"max_name", "ABC23", []PortInfo{{PortID: "usb", Name: strings.Repeat("n", 256)}}, true},
		{"long_name", "ABC23", []PortInfo{{PortID: "usb", Name: strings.Repeat("n", 257)}}, false},
		{"max_utf8_name_bytes", "ABC23", []PortInfo{{PortID: "usb", Name: strings.Repeat("中", 85) + "x"}}, true},
		{"long_utf8_name_bytes", "ABC23", []PortInfo{{PortID: "usb", Name: strings.Repeat("中", 86)}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub()
			local := peer(h, RoleLocal)
			h.handle(local, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: tc.id, Ports: tc.ports})
			if tc.valid {
				takeReady(t, local, MsgTypeRegister)
				if h.locals[tc.id] != local || h.ports[tc.id] != tc.ports[0] {
					t.Fatal("valid registration was not retained")
				}
			} else {
				if message := takeReady(t, local, MsgTypeError); message.Code != "invalid_registration" {
					t.Fatalf("wrong rejection: %+v", message)
				}
				if local.localID != "" || len(h.locals) != 0 || len(h.ports) != 0 {
					t.Fatal("invalid registration changed session state")
				}
			}
		})
	}
}

func TestLocalDataMustMatchRegisteredPort(t *testing.T) {
	h := NewHub()
	local, unregistered := peer(h, RoleLocal), peer(h, RoleLocal)
	remote := peer(h, RoleRemote)
	share(t, h, local, "ABC23", "usb")
	connect(t, h, remote, local, "ABC23", "usb")
	for _, tc := range []struct {
		name   string
		sender *Client
		port   string
	}{
		{"wrong_port", local, "uart"},
		{"unregistered", unregistered, "usb"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h.handle(tc.sender, Message{Type: MsgTypeData, PortID: tc.port, Data: "QQ=="})
			if takeReady(t, tc.sender, MsgTypeError).Code != "port_not_available" {
				t.Fatal("wrong error code")
			}
			if len(remote.send) != 0 {
				t.Fatal("invalid Local data reached Remote")
			}
		})
	}
	h.handle(local, Message{Type: MsgTypeData, PortID: "usb", Data: "QQ=="})
	if takeReady(t, remote, MsgTypeData).Data != "QQ==" {
		t.Fatal("valid Local data was not relayed")
	}
}

func TestPayloadValidationBothDirections(t *testing.T) {
	for _, direction := range []MessageType{MsgTypeData, MsgTypeSend} {
		t.Run(string(direction), func(t *testing.T) {
			h := NewHub()
			local, remote := peer(h, RoleLocal), peer(h, RoleRemote)
			share(t, h, local, "ABC23", "usb")
			connect(t, h, remote, local, "ABC23", "usb")
			sender, receiver := local, remote
			if direction == MsgTypeSend {
				sender, receiver = remote, local
			}
			for _, tc := range []struct{ name, data string }{
				{"empty", ""},
				{"line_breaks_only", "\r\n\r\n"},
				{"invalid_alphabet", "!!??"},
				{"missing_padding", "QQ="},
				{"nonzero_padding_bits", "QR=="},
				{"oversize", base64.StdEncoding.EncodeToString(make([]byte, MaxDataSize+1))},
			} {
				t.Run(tc.name, func(t *testing.T) {
					// Keep a failed request from contaminating later payload cases.
					defer func() {
						for len(sender.send) > 0 {
							<-sender.send
						}
						for len(receiver.send) > 0 {
							<-receiver.send
						}
					}()
					sendFrom(h, sender, Message{Type: direction, PortID: "usb", Data: tc.data})
					if takeReady(t, sender, MsgTypeError).Code != "invalid_data" {
						t.Fatal("wrong data error")
					}
					if len(receiver.send) != 0 {
						t.Fatal("invalid payload was forwarded")
					}
				})
			}
			for _, bytes := range [][]byte{{0, 0xff, 13, 0x80}, make([]byte, MaxDataSize)} {
				payload := base64.StdEncoding.EncodeToString(bytes)
				sendFrom(h, sender, Message{Type: direction, PortID: "usb", Data: payload})
				if takeReady(t, receiver, direction).Data != payload {
					t.Fatal("valid payload changed or was rejected")
				}
			}
		})
	}
}
