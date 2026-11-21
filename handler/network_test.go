package handler

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func networkResponse(query string) *httptest.ResponseRecorder {
	router := gin.New()
	router.GET("/api/network-sample", NetworkSample)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/network-sample"+query, nil))
	return response
}

func TestNetworkPingHasNoBodyAndCannotBeCached(t *testing.T) {
	response := networkResponse("")
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 ||
		!strings.Contains(response.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("invalid lightweight probe: %d %v", response.Code, response.Header())
	}
}

func TestNetworkSampleSizeAndEncoding(t *testing.T) {
	for _, count := range []int{1, 64 * 1024, MaxNetworkSampleBytes} {
		response := networkResponse("?bytes=" + strconv.Itoa(count))
		if response.Code != http.StatusOK || response.Body.Len() != count ||
			response.Header().Get("X-Network-Sample-Bytes") != strconv.Itoa(count) ||
			response.Header().Get("Content-Encoding") != "identity" ||
			response.Header().Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("invalid bandwidth sample for %d: status=%d bytes=%d headers=%v", count, response.Code, response.Body.Len(), response.Header())
		}
	}
}

func TestNetworkSampleRejectsUnboundedOrAmbiguousInput(t *testing.T) {
	for _, query := range []string{"?bytes=-1", "?bytes=262145", "?bytes=999999999999999999999", "?bytes=", "?bytes=abc", "?bytes=1&bytes=2", "?bytes=https://example.com"} {
		response := networkResponse(query)
		if response.Code != http.StatusBadRequest || response.Body.Len() != 0 {
			t.Errorf("query %q accepted: status=%d bytes=%d", query, response.Code, response.Body.Len())
		}
	}
}
