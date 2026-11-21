package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shareserial/websocket"
)

func TestSTUNConfigurationBoundsAndInjection(t *testing.T) {
	for _, value := range []string{"", "stun:stun.example.test", "stun:192.0.2.1:18444", "stun:[2001:db8::1]", "stun:[2001:db8::1]:3478", "stun:a.test:3478, stun:b.test:18444"} {
		if _, err := parseSTUNURLs(value); err != nil {
			t.Fatalf("valid STUN configuration rejected: %v", err)
		}
	}
	for _, value := range []string{"https://example.test", "turn:example.test", "stun:user:secret@example.test", "stun://example.test", "stun:a.test/path", "stun:a.test?transport=tcp", "stun:a.test#x", "stun:a.test\n", "stun:a.test:0", "stun:a.test:65536", "stun:", "stun:<script>", "stun:a.test,stun:b.test,stun:c.test,stun:d.test,stun:e.test", strings.Repeat("x", 1025)} {
		if _, err := parseSTUNURLs(value); err == nil {
			t.Fatalf("invalid STUN configuration accepted: %q", value)
		}
	}
	urls, err := parseSTUNURLs("stun:a.test,stun:a.test")
	if err != nil || len(urls) != 1 {
		t.Fatal("duplicate STUN servers were not bounded")
	}
}

func TestDeploymentICEScriptIsBoundedSameOriginAndNotCacheable(t *testing.T) {
	for _, configuration := range []string{"", "stun:192.0.2.1:18444"} {
		router, err := newRouterTrusted(websocket.NewHub(), nil, configuration)
		if err != nil {
			t.Fatal(err)
		}
		var first string
		for _, query := range []string{"", "?stun=stun:attacker.test"} {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/serial-p2p-config.js"+query, nil))
			if response.Code != 200 || !strings.Contains(response.Header().Get("Content-Type"), "application/javascript") ||
				response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("unsafe configuration response: %d %v", response.Code, response.Header())
			}
			body := response.Body.String()
			if configuration == "" && !strings.Contains(body, `"iceServers":[]`) {
				t.Fatal("default contacted an external ICE service")
			}
			if configuration != "" && !strings.Contains(body, configuration) {
				t.Fatal("operator STUN setting was not served")
			}
			if first == "" {
				first = body
			} else if first != body {
				t.Fatal("URL query overrode operator configuration")
			}
		}
	}
	if _, err := newRouterTrusted(websocket.NewHub(), nil, "stun:user:secret@host"); err == nil {
		t.Fatal("invalid configuration reached router")
	}
}
