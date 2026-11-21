package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	ws "shareserial/websocket"
)

// Handler receives a Hub explicitly, so server instances never share hidden
// package-global sessions. Gorilla's default origin check requires same origin.
type Handler struct {
	Hub      *ws.Hub
	Upgrader websocket.Upgrader
}

func New(hub *ws.Hub) *Handler {
	return &Handler{Hub: hub, Upgrader: websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
	}}
}

func (h *Handler) Local(c *gin.Context)  { h.serve(c, ws.RoleLocal) }
func (h *Handler) Remote(c *gin.Context) { h.serve(c, ws.RoleRemote) }

func (h *Handler) serve(c *gin.Context, role ws.Role) {
	lease, code := h.Hub.Resources().Admit(c.ClientIP())
	if code != "" {
		c.Header("Retry-After", "60")
		c.AbortWithStatusJSON(429, gin.H{"code": code, "error": "Shared service is busy; retry later"})
		return
	}
	admitted := false
	defer func() {
		if !admitted {
			lease.Release()
		}
	}()
	conn, err := h.Upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	client := ws.NewAdmittedClient(h.Hub, conn, role, lease)
	if !h.Hub.Register(client) {
		conn.Close()
		return
	}
	admitted = true
	go client.WritePump()
	go client.ReadPump()
}
