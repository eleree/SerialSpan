package websocket

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func diagnosticHub() (*Hub, *bytes.Buffer) {
	h := NewHub()
	output := new(bytes.Buffer)
	h.logger = log.New(output, "", 0)
	return h, output
}

func TestDiagnosticsCorrelateConflictWithoutTakingOverOldSession(t *testing.T) {
	h, output := diagnosticHub()
	owner, reconnecting := peer(h, RoleLocal), peer(h, RoleLocal)
	share(t, h, owner, "ABC23", "private-port-name")
	h.handle(reconnecting, Message{Type: MsgTypeRegister, Version: ProtocolVersion, LocalID: "ABC23", Ports: []PortInfo{{PortID: "usb"}}})
	if take(t, reconnecting, MsgTypeError).Code != "local_id_in_use" || h.locals["ABC23"] != owner {
		t.Fatal("diagnostics changed collision ownership")
	}
	h.remove(owner)
	share(t, h, reconnecting, "ABC23", "private-port-name")
	entries := output.String()
	for _, event := range []string{"ws_open", "local_shared", "local_id_conflict", "ws_close", "local_unshared"} {
		if !strings.Contains(entries, "event="+event+" ") {
			t.Errorf("missing diagnostic event %s: %s", event, entries)
		}
	}
	conflict := fmt.Sprintf("event=local_id_conflict connection=%d role=local requested_local_id=%q owner_connection=%d", reconnecting.connectionID, "ABC23", owner.connectionID)
	if !strings.Contains(entries, conflict) {
		t.Fatalf("collision cannot be correlated with both sockets: %s", entries)
	}
	if strings.Contains(entries, "private-port-name") {
		t.Fatal("port metadata leaked into lifecycle logs")
	}
}

func TestSlowPeerDiagnosticOmitsSerialPayload(t *testing.T) {
	h, output := diagnosticHub()
	remote := peer(h, RoleRemote)
	payload := base64.StdEncoding.EncodeToString([]byte("private-serial-payload"))
	for i := 0; i <= sendBufferSize; i++ {
		h.send(remote, Message{Type: MsgTypeData, Data: payload})
	}
	entries := output.String()
	if h.clients[remote] || !strings.Contains(entries, "event=ws_send_queue_full ") {
		t.Fatal("queue overflow did not disconnect/log the slow peer")
	}
	if strings.Contains(entries, payload) || strings.Contains(entries, "private-serial-payload") {
		t.Fatal("serial data leaked into diagnostics")
	}
}

type diagnosticTimeout struct{}

func (diagnosticTimeout) Error() string   { return "private-error-detail" }
func (diagnosticTimeout) Timeout() bool   { return true }
func (diagnosticTimeout) Temporary() bool { return true }

func TestTransportDiagnosticsKeepCodesAndRedactPeerText(t *testing.T) {
	h, output := diagnosticHub()
	client := NewClient(h, nil, RoleLocal)
	client.logTransportEnd("ws_read_end", &websocket.CloseError{Code: 1008, Text: "private-close-text\nforged=event"}, 3, 42)
	client.logTransportEnd("ws_write_end", diagnosticTimeout{}, 5, 84)
	entries := output.String()
	if !strings.Contains(entries, "cause=peer_close timeout=false close_code=1008 frames=3 bytes=42") ||
		!strings.Contains(entries, "cause=timeout timeout=true close_code=0 frames=5 bytes=84") {
		t.Fatalf("missing transport diagnostic categories: %s", entries)
	}
	for _, forbidden := range []string{"private-close-text", "forged=event", "private-error-detail"} {
		if strings.Contains(entries, forbidden) {
			t.Fatalf("untrusted error text leaked into logs: %s", forbidden)
		}
	}
}
