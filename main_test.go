package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	ws "shareserial/websocket"
)

var socketGrants sync.Map

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ctx, cancel := context.WithCancel(context.Background())
	hub := ws.NewHub()
	go hub.Run(ctx)
	server := httptest.NewServer(newRouter(hub))
	t.Cleanup(func() {
		cancel()
		server.Close()
		select {
		case <-hub.Done():
		case <-time.After(2 * time.Second):
			t.Error("hub shutdown timed out")
		}
	})
	return server
}

func TestNetworkReferenceRouteAndResponseLimit(t *testing.T) {
	server := testServer(t)
	for _, sample := range []struct {
		path   string
		status int
		bytes  int
	}{
		{"/api/network-sample", http.StatusNoContent, 0},
		{"/api/network-sample?bytes=262144", http.StatusOK, 262144},
		{"/api/network-sample?bytes=262145", http.StatusBadRequest, 0},
	} {
		response, err := http.Get(server.URL + sample.path)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != sample.status || len(data) != sample.bytes {
			t.Fatalf("network route %s: status=%d bytes=%d error=%v", sample.path, response.StatusCode, len(data), err)
		}
		if !strings.Contains(response.Header.Get("Cache-Control"), "no-store") {
			t.Fatal("network probe response may be cached")
		}
	}
}

func dial(t *testing.T, server *httptest.Server, role string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/"+role, http.Header{"Origin": []string{server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); socketGrants.Delete(conn) })
	return conn
}

func readMessage(t *testing.T, conn *websocket.Conn, kind ws.MessageType) ws.Message {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var message ws.Message
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message.Type != kind {
		t.Fatalf("want %s, got %+v", kind, message)
	}
	if message.Type == ws.MsgTypeConnect {
		socketGrants.Store(conn, message)
	}
	if message.Type == ws.MsgTypeWriteState {
		if stored, ok := socketGrants.Load(conn); ok {
			grant := stored.(ws.Message)
			grant.WriteEpoch = message.WriteEpoch
			grant.Paused = message.Paused
			socketGrants.Store(conn, grant)
		}
	}
	return message
}

func writeMessage(t *testing.T, conn *websocket.Conn, message ws.Message) {
	t.Helper()
	if message.Type == ws.MsgTypeSend {
		if stored, ok := socketGrants.Load(conn); ok {
			grant := stored.(ws.Message)
			if message.GrantID == "" {
				message.GrantID = grant.GrantID
			}
			if message.WriteEpoch == 0 {
				message.WriteEpoch = grant.WriteEpoch
			}
		}
	}
	if err := conn.WriteJSON(message); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddedPages(t *testing.T) {
	server := testServer(t)
	for _, path := range []string{"/", "/local", "/remote", "/remote/esp32", "/experimental/p2p", "/static/js/i18n.js", "/static/js/p2p-probe-link.js", "/static/js/p2p-probe.js", "/static/js/serial-data.js", "/static/js/serial-config.js", "/static/js/local.js", "/static/js/remote.js", "/static/js/remote-serial-port.js", "/static/js/esp32-manifest.js", "/static/js/esp32-flasher.js", "/static/vendor/esptool-js-0.7.0.js"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK || len(body) == 0 {
			t.Fatalf("asset %s failed: %s %v", path, response.Status, err)
		}
	}
}

func TestRemoteToolsShareOneDocument(t *testing.T) {
	server := testServer(t)
	var pages [][]byte
	for _, path := range []string{"/remote", "/remote/esp32"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("page %s failed: %s %v", path, response.Status, err)
		}
		pages = append(pages, body)
	}
	if string(pages[0]) != string(pages[1]) {
		t.Fatal("Remote tools must use one document so navigation preserves the active connection")
	}
}

func TestCrossOriginRejected(t *testing.T) {
	server := testServer(t)
	conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/local", http.Header{"Origin": []string{"https://unrelated.example"}})
	if conn != nil {
		conn.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatal("cross-origin socket was accepted")
	}
	if response != nil {
		response.Body.Close()
	}
}

func TestWebSocketRelayAndLocalClose(t *testing.T) {
	server := testServer(t)
	local, r1, r2 := dial(t, server, "local"), dial(t, server, "remote"), dial(t, server, "remote")
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeRegister, Version: ws.ProtocolVersion, LocalID: "ABC23", Ports: []ws.PortInfo{{PortID: "usb"}}})
	readMessage(t, local, ws.MsgTypeRegister)
	for index, remote := range []*websocket.Conn{r1, r2} {
		access := ws.AccessRead
		if index == 0 {
			access = ws.AccessControl
		}
		writeMessage(t, remote, ws.Message{Type: ws.MsgTypeConnect, Version: ws.ProtocolVersion, LocalID: "ABC23", Access: access})
		request := readMessage(t, local, ws.MsgTypeConnectionRequest)
		pending := readMessage(t, remote, ws.MsgTypeConnectPending)
		if pending.RequestID != request.RequestID {
			t.Fatal("approval request mismatch")
		}
		writeMessage(t, local, ws.Message{Type: ws.MsgTypeApprove, RequestID: request.RequestID, Access: access})
		readMessage(t, local, ws.MsgTypeRemoteConnected)
		approved := readMessage(t, remote, ws.MsgTypeConnect)
		if approved.Access != access || approved.Version != ws.ProtocolVersion {
			t.Fatal("incorrect grant")
		}
		writeMessage(t, remote, ws.Message{Type: ws.MsgTypeGetPorts, LocalID: "ABC23"})
		ports := readMessage(t, remote, ws.MsgTypePortList)
		if len(ports.Ports) != 1 || ports.Ports[0].PortID != "usb" {
			t.Fatal("incorrect port list")
		}
	}
	payload := base64.StdEncoding.EncodeToString([]byte{0, 0xff, 0x80, 13})
	writeMessage(t, r1, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: payload})
	if readMessage(t, local, ws.MsgTypeSend).Data != payload {
		t.Fatal("serial write changed bytes")
	}
	writeMessage(t, r2, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: payload, Access: ws.AccessControl})
	if readMessage(t, r2, ws.MsgTypeError).Code != "read_only" {
		t.Fatal("reader was allowed to write")
	}
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeData, PortID: "usb", Data: payload})
	for _, remote := range []*websocket.Conn{r1, r2} {
		if readMessage(t, remote, ws.MsgTypeData).Data != payload {
			t.Fatal("serial read changed bytes")
		}
	}
	local.Close()
	for _, remote := range []*websocket.Conn{r1, r2} {
		readMessage(t, remote, ws.MsgTypeLocalDisconnected)
	}
	// Reconnect the same ID, but subscriptions must be established explicitly.
	replacement := dial(t, server, "local")
	writeMessage(t, replacement, ws.Message{Type: ws.MsgTypeRegister, Version: ws.ProtocolVersion, LocalID: "ABC23", Ports: []ws.PortInfo{{PortID: "usb"}}})
	readMessage(t, replacement, ws.MsgTypeRegister)
	writeMessage(t, r1, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: payload})
	if readMessage(t, r1, ws.MsgTypeError).Code != "not_connected" {
		t.Fatal("stale subscription reused")
	}
}

func TestMalformedAndOversizedFrames(t *testing.T) {
	server := testServer(t)
	remote := dial(t, server, "remote")
	if err := remote.WriteMessage(websocket.TextMessage, []byte(`{"type":`)); err != nil {
		t.Fatal(err)
	}
	readMessage(t, remote, ws.MsgTypeError)
	if err := remote.WriteMessage(websocket.BinaryMessage, []byte{0, 1}); err != nil {
		t.Fatal(err)
	}
	readMessage(t, remote, ws.MsgTypeError)
	if err := remote.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", ws.MaxMessageSize+1))); err != nil {
		t.Fatal(err)
	}
	remote.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := remote.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
		t.Fatalf("expected size-limit close, got %v", err)
	}
}
