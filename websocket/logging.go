package websocket

import (
	"errors"
	"io"
	"net"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Diagnostic connection numbers are process-local, never protocol identities.
// Assign them before either socket pump starts; pumps must not read Hub-owned IDs.
var connectionSequence atomic.Uint64

func (h *Hub) logEvent(client *Client, event, fields string, args ...any) {
	values := []any{event, client.connectionID, client.role}
	h.logger.Printf("event=%s connection=%d role=%s "+fields, append(values, args...)...)
}

func (c *Client) logTransportEnd(event string, err error, frames, bytes int64) {
	cause, closeCode, timeout := "io_error", 0, false
	var peerClose *websocket.CloseError
	var networkError net.Error
	switch {
	case errors.As(err, &peerClose):
		cause, closeCode = "peer_close", peerClose.Code
	case errors.As(err, &networkError) && networkError.Timeout():
		cause, timeout = "timeout", true
	case errors.Is(err, net.ErrClosed):
		cause = "socket_closed"
	case errors.Is(err, io.EOF):
		cause = "peer_eof"
	}
	// Close reasons and raw error strings can contain peer-supplied text. Keep
	// diagnostics to error categories/codes and sizes; never log serial payloads.
	c.hub.logEvent(c, event, "cause=%s timeout=%t close_code=%d frames=%d bytes=%d elapsed_ms=%d",
		cause, timeout, closeCode, frames, bytes, time.Since(c.createdAt).Milliseconds())
}
