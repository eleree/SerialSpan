package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"shareserial/resource"
	ws "shareserial/websocket"
)

func limitedServer(t *testing.T, cfg resource.Config, trusted []string) (*httptest.Server, *resource.Manager) {
	t.Helper()
	manager, err := resource.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	hub := ws.NewHubWithResources(manager)
	router, err := newRouterTrusted(hub, trusted)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go hub.Run(ctx)
	server := httptest.NewServer(router)
	t.Cleanup(func() { cancel(); server.Close(); <-hub.Done() })
	return server, manager
}

func TestConnectionLimitsRejectBeforeUpgradeAndReleaseOnFailure(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.MaxConnections = 1
	server, manager := limitedServer(t, cfg, nil)
	_, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/local", http.Header{"Origin": {"https://unrelated.example"}})
	if err == nil || response == nil || response.StatusCode != 403 {
		t.Fatal("cross origin was accepted")
	}
	response.Body.Close()
	if manager.Snapshot().Connections != 0 {
		t.Fatal("failed upgrade leaked admission")
	}
	first := dial(t, server, "remote")
	_, response, err = websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/local", nil)
	if err == nil || response == nil || response.StatusCode != 429 || response.Header.Get("Retry-After") == "" {
		t.Fatal("connection limit was not enforced before upgrade")
	}
	response.Body.Close()
	first.Close()
	deadline := time.Now().Add(time.Second)
	for manager.Snapshot().Connections != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if manager.Snapshot().Connections != 0 {
		t.Fatal("disconnected socket retained its capacity")
	}
	dial(t, server, "local")
}

func TestApplicationRateLimitHasExplicitCloseReasonAndReleasesConnection(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.MessagesPerSecond = 1
	server, manager := limitedServer(t, cfg, nil)
	remote := dial(t, server, "remote")
	for range 2 {
		writeMessage(t, remote, ws.Message{Type: ws.MsgTypeGetPorts})
		if readMessage(t, remote, ws.MsgTypeError).Code != "approval_required" {
			t.Fatal("unexpected baseline response")
		}
	}
	writeMessage(t, remote, ws.Message{Type: ws.MsgTypeGetPorts})
	if readMessage(t, remote, ws.MsgTypeError).Code != "message_rate_limited" {
		t.Fatal("missing resource error")
	}
	_, _, err := remote.ReadMessage()
	if !websocket.IsCloseError(err, 4008) {
		t.Fatal("missing explicit resource close", err)
	}
	if manager.Snapshot().Connections != 0 {
		t.Fatal("limited socket retained capacity")
	}
}

func TestSampleQuotaRejectsWholeResponseWhileLocalPageStillLoads(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.DailyBytes = 1
	server, manager := limitedServer(t, cfg, nil)
	for i, expected := range []int{200, 429} {
		response, err := http.Get(server.URL + "/api/network-sample?bytes=1")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != expected {
			t.Fatal("sample quota response", i, response.StatusCode, err)
		}
		if expected == 429 {
			var result map[string]any
			if json.Unmarshal(body, &result) != nil || result["code"] != "daily_quota_exceeded" {
				t.Fatal("truncated or ambiguous rejection", string(body))
			}
		}
	}
	response, err := http.Get(server.URL + "/local")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || manager.Snapshot().DailyReservedBytes != 1 {
		t.Fatal("local page consumed relay quota")
	}
}

func TestUntrustedForwardingHeadersCannotBypassRequestLimit(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "explicit_proxy"}[trust], func(t *testing.T) {
			cfg := resource.DefaultConfig()
			cfg.HTTPRequestsPerMinute = 1
			var proxies []string
			if trust {
				proxies = []string{"127.0.0.1/32"}
			}
			server, _ := limitedServer(t, cfg, proxies)
			for index, ip := range []string{"192.0.2.1", "192.0.2.2"} {
				request, _ := http.NewRequest("GET", server.URL+"/", nil)
				request.Header.Set("X-Forwarded-For", ip)
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				expected := 200
				if index == 1 && !trust {
					expected = 429
				}
				if response.StatusCode != expected {
					t.Fatal("unexpected trusted proxy behavior", response.StatusCode)
				}
			}
		})
	}
}

func TestWebSocketControlFloodConsumesTheSameRateBudget(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.MessagesPerSecond = 1
	server, _ := limitedServer(t, cfg, nil)
	remote := dial(t, server, "remote")
	for range 3 {
		if err := remote.WriteControl(websocket.PongMessage, nil, time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if message := readMessage(t, remote, ws.MsgTypeError); message.Code != "message_rate_limited" {
		t.Fatal("control-frame flood bypassed budget", message)
	}
	if _, _, err := remote.ReadMessage(); !websocket.IsCloseError(err, 4008) {
		t.Fatal("missing resource close", err)
	}
}
