// Package websocket owns the in-memory sessions and the serial relay protocol.
package websocket

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"math/big"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"shareserial/resource"
)

const (
	IDAlphabet              = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	IDLength                = 5
	MaxMessageSize          = 64 * 1024
	MaxDataSize             = 16 * 1024
	ProtocolVersion         = 3
	RXReplayProtocolVersion = 1
	MaxRXReplayQueueBytes   = 192 * 1024
	sendBufferSize          = 256
	writeWait               = 10 * time.Second
	pongWait                = 60 * time.Second
	pingPeriod              = 25 * time.Second
)

type Role string

const (
	RoleLocal  Role = "local"
	RoleRemote Role = "remote"
)

type MessageType string

const (
	MsgTypeRegister            MessageType = "register"
	MsgTypeUnregister          MessageType = "unregister"
	MsgTypeGetPorts            MessageType = "get_ports"
	MsgTypePortList            MessageType = "port_list"
	MsgTypeConnect             MessageType = "connect"
	MsgTypeDisconnect          MessageType = "disconnect"
	MsgTypeSend                MessageType = "send"
	MsgTypeData                MessageType = "data"
	MsgTypeResumeRX            MessageType = "resume_rx"
	MsgTypeReplayData          MessageType = "replay_data"
	MsgTypeReplayGap           MessageType = "replay_gap"
	MsgTypeReplayComplete      MessageType = "replay_complete"
	MsgTypeRXGap               MessageType = "rx_gap"
	MsgTypeRXAck               MessageType = "rx_ack"
	MsgTypeRXHead              MessageType = "rx_head"
	MsgTypeRemoteConnected     MessageType = "remote_connected"
	MsgTypeRemoteDisconnected  MessageType = "remote_disconnected"
	MsgTypeLocalDisconnected   MessageType = "local_disconnected"
	MsgTypeError               MessageType = "error"
	MsgTypeConnectPending      MessageType = "connect_pending"
	MsgTypeConnectionRequest   MessageType = "connection_request"
	MsgTypeApprove             MessageType = "approve"
	MsgTypeReject              MessageType = "reject"
	MsgTypeRequestCancelled    MessageType = "request_cancelled"
	MsgTypeRevoke              MessageType = "revoke"
	MsgTypePermissionRevoked   MessageType = "permission_revoked"
	MsgTypeSetWriteState       MessageType = "set_write_state"
	MsgTypeWriteState          MessageType = "write_state"
	MsgTypeSetSerialConfig     MessageType = "set_serial_config"
	MsgTypeSerialConfigState   MessageType = "serial_config_state"
	MsgTypeSerialConfigResult  MessageType = "serial_config_result"
	MsgTypeCancelSerialConfig  MessageType = "cancel_serial_config"
	MsgTypeSharingStopped      MessageType = "sharing_stopped"
	MsgTypeBeginFlash          MessageType = "begin_flash"
	MsgTypeEndFlash            MessageType = "end_flash"
	MsgTypeFlashKeepalive      MessageType = "flash_keepalive"
	MsgTypeFlashSend           MessageType = "flash_send"
	MsgTypeFlashState          MessageType = "flash_state"
	MsgTypeFlashResult         MessageType = "flash_result"
	MsgTypeSetSerialSignals    MessageType = "set_serial_signals"
	MsgTypeSerialSignalsResult MessageType = "serial_signals_result"
	MsgTypeCancelSerialSignals MessageType = "cancel_serial_signals"
	MsgTypeProbeSignal         MessageType = "p2p_probe_signal"
	MsgTypeProbeFrame          MessageType = "p2p_probe_frame"
)

type PortInfo struct {
	PortID string `json:"portId"`
	Name   string `json:"name"`
}

type Message struct {
	Type                     MessageType        `json:"type"`
	LocalID                  string             `json:"localId,omitempty"`
	RemoteID                 string             `json:"remoteId,omitempty"`
	PortID                   string             `json:"portId,omitempty"`
	Data                     string             `json:"data,omitempty"`
	Ports                    []PortInfo         `json:"ports,omitempty"`
	Code                     string             `json:"code,omitempty"`
	Error                    string             `json:"error,omitempty"`
	Access                   Access             `json:"access,omitempty"`
	RequestID                string             `json:"requestId,omitempty"`
	Version                  int                `json:"version,omitempty"`
	ExpiresIn                int                `json:"expiresIn,omitempty"`
	GrantID                  string             `json:"grantId,omitempty"`
	WriteEpoch               uint64             `json:"writeEpoch,omitempty"`
	Paused                   *bool              `json:"paused,omitempty"`
	SerialConfig             *SerialConfig      `json:"serialConfig,omitempty"`
	ConfigProtocol           int                `json:"configProtocol,omitempty"`
	ConfigRevision           uint64             `json:"configRevision,omitempty"`
	ConfigID                 string             `json:"configId,omitempty"`
	Configuring              *bool              `json:"configuring,omitempty"`
	Success                  *bool              `json:"success,omitempty"`
	PortOpen                 *bool              `json:"portOpen,omitempty"`
	SerialSignalsProtocol    int                `json:"serialSignalsProtocol,omitempty"`
	FlashProtocol            int                `json:"flashProtocol,omitempty"`
	FlashSessionID           string             `json:"flashSessionId,omitempty"`
	FlashActive              *bool              `json:"flashActive,omitempty"`
	FlashStarting            *bool              `json:"flashStarting,omitempty"`
	FlashEnding              *bool              `json:"flashEnding,omitempty"`
	FlashOwnerID             string             `json:"flashOwnerId,omitempty"`
	DataTerminalReady        *bool              `json:"dataTerminalReady,omitempty"`
	RequestToSend            *bool              `json:"requestToSend,omitempty"`
	RXReplayProtocol         int                `json:"rxReplayProtocol,omitempty"`
	RXStreamID               string             `json:"rxStreamId,omitempty"`
	RXSeq                    uint64             `json:"rxSeq,omitempty"`
	ResumeStreamID           string             `json:"resumeStreamId,omitempty"`
	ResumeSeq                uint64             `json:"resumeSeq,omitempty"`
	ThroughSeq               uint64             `json:"throughSeq,omitempty"`
	TargetRemoteID           string             `json:"targetRemoteId,omitempty"`
	ProbeProtocol            int                `json:"p2pProbeProtocol,omitempty"`
	ProbeKind                string             `json:"probeKind,omitempty"`
	ProbePayload             string             `json:"probePayload,omitempty"`
	SerialP2PProtocol        int                `json:"serialP2PProtocol,omitempty"`
	SerialP2PRetryProtocol   int                `json:"serialP2PRetryProtocol,omitempty"`
	SerialP2PTXRelayProtocol int                `json:"serialP2PTXRelayProtocol,omitempty"`
	P2PAttempt               int                `json:"p2pAttempt,omitempty"`
	Direct                   bool               `json:"direct,omitempty"`
	SerialTXRelay            bool               `json:"serialTXRelay,omitempty"`
	DirectRemotes            []string           `json:"directRemotes,omitempty"`
	TXSeq                    uint64             `json:"txSeq,omitempty"`
	ByteLength               int                `json:"byteLength,omitempty"`
	SHA256                   string             `json:"sha256,omitempty"`
	P2PReason                string             `json:"p2pReason,omitempty"`
	P2PDetails               *P2PFailureDetails `json:"p2pDetails,omitempty"`
	P2PReporter              Role               `json:"p2pReporter,omitempty"`
	GapFrom                  uint64             `json:"gapFrom,omitempty"`
	GapTo                    uint64             `json:"gapTo,omitempty"`
	// Legacy inline connection config is rejected; approved changes use a transaction.
	Config json.RawMessage `json:"config,omitempty"`
}

type subscription struct {
	localID string
	portID  string
	access  Access
	grantID string
}

type receiveReplay struct {
	streamID    string
	through     uint64
	nextSeq     uint64
	ackedSeq    uint64
	queued      []Message
	queuedBytes int
}

type inbound struct {
	client    *Client
	message   Message
	limitCode string
}

type flashSession struct {
	id        string
	requestID string
	remote    *Client
	local     *Client
	target    subscription
	starting  bool
	ending    bool
	expiresAt time.Time
}

type signalRequest struct {
	remote    *Client
	local     *Client
	target    subscription
	flashID   string
	expiresAt time.Time
}

// Run is the sole owner of session state and Send channel closure.
// Socket pumps never read or mutate client IDs or subscriptions.
type Hub struct {
	clients        map[*Client]bool
	locals         map[string]*Client
	remotes        map[string]*Client
	ports          map[string]PortInfo
	subscriptions  map[*Client]subscription
	pending        map[*Client]*connectionRequest
	requests       map[string]*connectionRequest
	flashSessions  map[*Client]*flashSession
	signalRequests map[string]*signalRequest
	now            func() time.Time
	register       chan *Client
	unregister     chan *Client
	messages       chan inbound
	done           chan struct{}
	logger         *log.Logger
	resources      *resource.Manager
}

func NewHub() *Hub {
	return NewHubWithResources(resource.NewDefault())
}

func NewHubWithResources(manager *resource.Manager) *Hub {
	return &Hub{
		clients:        make(map[*Client]bool),
		locals:         make(map[string]*Client),
		remotes:        make(map[string]*Client),
		ports:          make(map[string]PortInfo),
		subscriptions:  make(map[*Client]subscription),
		pending:        make(map[*Client]*connectionRequest),
		requests:       make(map[string]*connectionRequest),
		flashSessions:  make(map[*Client]*flashSession),
		signalRequests: make(map[string]*signalRequest),
		now:            time.Now,
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		messages:       make(chan inbound, 256),
		done:           make(chan struct{}),
		logger:         log.Default(),
		resources:      manager,
	}
}

func (h *Hub) Resources() *resource.Manager { return h.resources }

// Run must be called once. Cancellation closes sockets and releases pumps.
func (h *Hub) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	lastUsage := time.Now()
	defer ticker.Stop()
	defer close(h.done)
	defer func() {
		for client := range h.clients {
			h.logEvent(client, "ws_shutdown", "local_id=%q remote_id=%q", client.localID, client.remoteID)
			close(client.send)
			client.lease.Release()
			if client.conn != nil {
				client.conn.Close()
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.expireRequests()
			h.expireConfigurations()
			h.expireSignalRequests()
			if time.Since(lastUsage) >= time.Minute {
				s := h.resources.Snapshot()
				h.logger.Printf("event=resource_usage active_connections=%d tracked_ips=%d ws_in_bytes=%d ws_out_bytes=%d http_out_bytes=%d daily_reserved_bytes=%d rejected_connections=%d rejected_http=%d rejected_transfers=%d", s.Connections, s.TrackedIPs, s.WSBytesIn, s.WSBytesOut, s.HTTPBytesOut, s.DailyReservedBytes, s.RejectedConnections, s.RejectedHTTP, s.RejectedTransfers)
				lastUsage = time.Now()
			}
		case client := <-h.register:
			h.add(client)
		case client := <-h.unregister:
			h.remove(client)
		case event := <-h.messages:
			if h.clients[event.client] {
				if event.limitCode != "" {
					h.stopLimited(event.client, event.limitCode)
				} else {
					h.handle(event.client, event.message)
				}
			}
		}
	}
}

func (h *Hub) Register(client *Client) bool {
	select {
	case h.register <- client:
		return true
	case <-h.done:
		return false
	}
}

func (h *Hub) Unregister(client *Client) {
	select {
	case h.unregister <- client:
	case <-h.done:
	}
}

func (h *Hub) Submit(client *Client, message Message) bool {
	select {
	case <-h.done:
		return false
	default:
	}
	select {
	case h.messages <- inbound{client: client, message: message}:
		return true
	case <-h.done:
		return false
	}
}

func (h *Hub) reportLimit(client *Client, code string) bool {
	select {
	case h.messages <- inbound{client: client, limitCode: code}:
		return true
	case <-h.done:
		return false
	}
}

func (h *Hub) Done() <-chan struct{} { return h.done }

func (h *Hub) add(client *Client) {
	if h.clients[client] {
		return
	}
	h.clients[client] = true
	h.logEvent(client, "ws_open", "active_connections=%d", len(h.clients))
	if client.role == RoleRemote {
		for attempt := 0; attempt < 16; attempt++ {
			id, err := GenerateID()
			if err != nil {
				break
			}
			if h.remotes[id] == nil {
				client.remoteID = id
				h.remotes[id] = client
				return
			}
		}
		h.remove(client)
	} else if client.role != RoleLocal {
		h.remove(client)
	}
}

func (h *Hub) remove(client *Client) {
	h.removeClient(client, false)
}

func (h *Hub) removeClient(client *Client, graceful bool) {
	if !h.clients[client] {
		return
	}
	h.logEvent(client, "ws_close", "local_id=%q remote_id=%q queued_frames=%d elapsed_ms=%d",
		client.localID, client.remoteID, len(client.send), time.Since(client.createdAt).Milliseconds())
	delete(h.clients, client)
	client.lease.Release()
	close(client.send)
	if client.conn != nil && !graceful {
		client.conn.Close()
	}
	if client.role == RoleLocal {
		client.replay = nil
		h.unshare(client)
	} else {
		delete(h.remotes, client.remoteID)
		h.cancelRequest(client, "request_cancelled", false)
		h.detach(client)
	}
}

func (h *Hub) stopLimited(client *Client, code string) {
	if client == nil || !h.clients[client] {
		return
	}
	h.logEvent(client, "resource_limit", "code=%s queued_bytes=%d", code, client.queuedBytes.Load())
	client.terminal <- code
	h.removeClient(client, true)
}

// Buffer overflow disconnects a slow peer, avoiding silent chunk loss and
// unbounded goroutines. This is transport backpressure, not a delivery ACK.
func (h *Hub) send(client *Client, message Message) bool {
	if client == nil || !h.clients[client] {
		return false
	}
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	if code := client.lease.Outbound(len(data)); code != "" {
		h.stopLimited(client, code)
		return false
	}
	return h.enqueue(client, data)
}

func (h *Hub) enqueue(client *Client, data []byte) bool {
	if client == nil || !h.clients[client] {
		return false
	}
	if client.queuedBytes.Load()+int64(len(data)) > h.resources.Config().MaxQueuedBytes {
		h.stopLimited(client, "send_queue_limited")
		return false
	}
	client.queuedBytes.Add(int64(len(data)))
	select {
	case client.send <- data:
		return true
	default:
		client.queuedBytes.Add(-int64(len(data)))
		h.logEvent(client, "ws_send_queue_full", "queued_frames=%d capacity=%d", len(client.send), cap(client.send))
		h.remove(client)
		return false
	}
}

func (h *Hub) relay(source *Client, targets []*Client, message Message) {
	if len(targets) == 0 {
		return
	}
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	if code := source.lease.Outbound(len(data) * len(targets)); code != "" {
		h.stopLimited(source, code)
		return
	}
	for _, target := range targets {
		h.enqueue(target, data)
	}
}

func (h *Hub) fail(client *Client, code, message string) {
	h.send(client, Message{Type: MsgTypeError, Code: code, Error: message})
}

func (h *Hub) handle(client *Client, message Message) {
	if message.Type == MsgTypeSerialSignal {
		h.serialSignal(client, message)
		return
	}
	if message.Type == MsgTypeSerialTX {
		h.serialTX(client, message)
		return
	}
	if message.Type == MsgTypeSerialResume {
		h.serialResume(client, message)
		return
	}
	if message.Type == MsgTypeProbeSignal {
		h.forwardProbeSignal(client, message)
		return
	}
	if message.Type == MsgTypeProbeFrame {
		h.forwardProbeFrame(client, message)
		return
	}
	// Sender identity always comes from the socket. Remote's localId is only
	// used when selecting a target, never as proof of sender identity.
	if client.role == RoleLocal {
		switch message.Type {
		case MsgTypeRegister:
			h.share(client, message)
		case MsgTypeUnregister:
			h.unshare(client)
			h.send(client, Message{Type: MsgTypeUnregister})
		case MsgTypeData:
			if message.SerialP2PProtocol == 1 {
				h.serialRX(client, message)
			} else {
				h.forwardData(client, message)
			}
		case MsgTypeReplayData:
			h.forwardReplayData(client, message)
		case MsgTypeReplayGap:
			h.forwardReplayGap(client, message)
		case MsgTypeReplayComplete:
			h.forwardReplayComplete(client, message)
		case MsgTypeRXHead:
			h.updateRXHead(client, message)
		case MsgTypeApprove:
			h.approve(client, message)
		case MsgTypeReject:
			h.reject(client, message)
		case MsgTypeRevoke:
			h.revoke(client, message)
		case MsgTypeSetWriteState:
			h.setWriteState(client, message)
		case MsgTypeSerialConfigResult:
			h.finishConfiguration(client, message)
		case MsgTypeFlashResult:
			h.finishFlashSession(client, message)
		case MsgTypeSerialSignalsResult:
			h.finishSerialSignals(client, message)
		default:
			h.fail(client, "invalid_message", "Message is not allowed for Local")
		}
		return
	}
	switch message.Type {
	case MsgTypeGetPorts:
		target, approved := h.subscriptions[client]
		if !approved || target.localID != message.LocalID {
			h.fail(client, "approval_required", "Local approval is required before listing ports")
			return
		}
		h.send(client, Message{Type: MsgTypePortList, Ports: []PortInfo{h.ports[message.LocalID]}})
	case MsgTypeConnect:
		h.connect(client, message)
	case MsgTypeRXAck:
		h.forwardRXAck(client, message)
	case MsgTypeSend:
		h.forwardSend(client, message)
	case MsgTypeSetSerialConfig:
		h.configure(client, message)
	case MsgTypeBeginFlash:
		h.beginFlashSession(client, message)
	case MsgTypeEndFlash:
		h.endFlashSession(client, message)
	case MsgTypeFlashKeepalive:
		h.keepFlashSession(client, message)
	case MsgTypeFlashSend:
		h.forwardFlashSend(client, message)
	case MsgTypeSetSerialSignals:
		h.setSerialSignals(client, message)
	case MsgTypeDisconnect:
		h.cancelRequest(client, "request_cancelled", false)
		h.detach(client)
		h.send(client, Message{Type: MsgTypeDisconnect})
	default:
		h.fail(client, "invalid_message", "Message is not allowed for Remote")
	}
}

func (h *Hub) share(client *Client, message Message) {
	if message.Version != ProtocolVersion {
		h.fail(client, "protocol_mismatch", "Update Local and Remote pages for protocol v3")
		return
	}
	if code := client.lease.Request(); code != "" {
		h.stopLimited(client, code)
		return
	}
	if !ValidID(message.LocalID) || len(message.Ports) != 1 ||
		message.Ports[0].PortID == "" || len(message.Ports[0].PortID) > 128 || len(message.Ports[0].Name) > 256 {
		h.fail(client, "invalid_registration", "Register a valid 5-character ID and exactly one serial port")
		return
	}
	if (message.ConfigProtocol != 0 || message.SerialConfig != nil) &&
		(message.ConfigProtocol != 1 || !validSerialConfig(message.SerialConfig)) {
		h.fail(client, "invalid_registration", "Serial configuration capability is invalid")
		return
	}
	if (message.SerialSignalsProtocol != 0 && message.SerialSignalsProtocol != 1) ||
		(message.FlashProtocol != 0 && message.FlashProtocol != 1) ||
		(message.FlashProtocol == 1 && (message.SerialSignalsProtocol != 1 || message.ConfigProtocol != 1)) {
		h.fail(client, "invalid_registration", "Remote flash capabilities are invalid")
		return
	}
	if (message.RXReplayProtocol == 0 && (message.RXStreamID != "" || message.RXSeq != 0)) ||
		(message.RXReplayProtocol != 0 && (message.RXReplayProtocol != RXReplayProtocolVersion || !validRXStreamID(message.RXStreamID))) {
		h.fail(client, "invalid_registration", "Receive replay capability is invalid")
		return
	}
	if message.ProbeProtocol != 0 && (message.ProbeProtocol != 1 || message.Ports[0].PortID != ProbePortID || message.ConfigProtocol != 0 || message.RXReplayProtocol != 0 || message.FlashProtocol != 0 || message.SerialSignalsProtocol != 0) {
		h.fail(client, "invalid_registration", "P2P probe capability is restricted to the synthetic probe port")
		return
	}
	if message.SerialP2PProtocol != 0 && (message.SerialP2PProtocol != 1 || message.ProbeProtocol != 0 || message.RXReplayProtocol != 1) {
		h.fail(client, "invalid_registration", "Serial P2P requires receive replay and a physical serial session")
		return
	}
	if message.SerialP2PRetryProtocol != 0 && (message.SerialP2PRetryProtocol != 1 || message.SerialP2PProtocol != 1) {
		h.fail(client, "invalid_registration", "Serial P2P retry requires serial P2P")
		return
	}
	if message.SerialP2PTXRelayProtocol != 0 && (message.SerialP2PTXRelayProtocol != 1 || message.SerialP2PProtocol != 1) {
		h.fail(client, "invalid_registration", "Serial P2P TX relay requires serial P2P")
		return
	}
	if owner := h.locals[message.LocalID]; owner != nil && owner != client {
		h.logEvent(client, "local_id_conflict", "requested_local_id=%q owner_connection=%d", message.LocalID, owner.connectionID)
		h.fail(client, "local_id_in_use", "Local ID is already in use")
		return
	}
	changed := client.localID != message.LocalID || h.ports[client.localID] != message.Ports[0] ||
		client.rxReplayProtocol != message.RXReplayProtocol || client.rxStreamID != message.RXStreamID ||
		client.serialSignalsProtocol != message.SerialSignalsProtocol || client.flashProtocol != message.FlashProtocol || client.probeProtocol != message.ProbeProtocol || client.serialP2PProtocol != message.SerialP2PProtocol || client.serialP2PRetryProtocol != message.SerialP2PRetryProtocol || client.serialP2PTXRelayProtocol != message.SerialP2PTXRelayProtocol
	if !changed && !sameSerialConfig(client.serialConfig, message.SerialConfig) {
		h.fail(client, "invalid_registration", "Use an authorized configuration transaction to change settings")
		return
	}
	if changed {
		h.unshare(client)
		client.writesPaused = message.Paused != nil && *message.Paused
		client.writeEpoch = 1
		if message.SerialConfig != nil {
			config := *message.SerialConfig
			client.serialConfig = &config
			client.configRevision = 1
		}
	}
	client.localID = message.LocalID
	client.rxReplayProtocol = message.RXReplayProtocol
	client.serialSignalsProtocol = message.SerialSignalsProtocol
	client.flashProtocol = message.FlashProtocol
	client.probeProtocol = message.ProbeProtocol
	client.serialP2PProtocol = message.SerialP2PProtocol
	client.serialP2PRetryProtocol = message.SerialP2PRetryProtocol
	client.serialP2PTXRelayProtocol = message.SerialP2PTXRelayProtocol
	client.rxStreamID = message.RXStreamID
	client.rxSequence = message.RXSeq
	h.locals[client.localID] = client
	h.ports[client.localID] = message.Ports[0]
	if changed {
		h.logEvent(client, "local_shared", "local_id=%q", client.localID)
	}
	registered := Message{Type: MsgTypeRegister, LocalID: client.localID, Version: ProtocolVersion, WriteEpoch: client.writeEpoch,
		Paused: boolPointer(client.writesPaused), SerialSignalsProtocol: client.serialSignalsProtocol, FlashProtocol: client.flashProtocol, SerialP2PProtocol: client.serialP2PProtocol,
		SerialP2PRetryProtocol: client.serialP2PRetryProtocol, SerialP2PTXRelayProtocol: client.serialP2PTXRelayProtocol}
	if client.rxReplayProtocol == RXReplayProtocolVersion {
		registered.RXReplayProtocol, registered.RXStreamID, registered.RXSeq = client.rxReplayProtocol, client.rxStreamID, client.rxSequence
	}
	h.send(client, h.withSerialState(client, registered))
}

func (h *Hub) unshare(client *Client) {
	localID := client.localID
	if localID == "" || h.locals[localID] != client {
		return
	}
	if h.flashSessions[client] != nil {
		h.releaseFlashSession(client, "local_disconnected", true)
	}
	h.logEvent(client, "local_unshared", "local_id=%q", localID)
	h.cancelConfiguration(client, nil, "local_disconnected")
	client.configuration = nil
	client.serialConfig = nil
	client.configRevision = 0
	client.rxReplayProtocol = 0
	client.serialSignalsProtocol = 0
	client.flashProtocol = 0
	client.probeProtocol = 0
	client.serialP2PProtocol = 0
	client.serialP2PRetryProtocol = 0
	client.serialP2PTXRelayProtocol = 0
	client.rxStreamID = ""
	client.rxSequence = 0
	delete(h.locals, localID)
	delete(h.ports, localID)
	client.localID = ""
	for remote, request := range h.pending {
		if request.local == client {
			h.cancelRequest(remote, "local_disconnected", true)
		}
	}
	for remote, target := range h.subscriptions {
		if target.localID == localID {
			delete(h.subscriptions, remote)
			remote.replay = nil
			h.send(remote, Message{Type: MsgTypeLocalDisconnected, LocalID: localID, PortID: target.portID})
		}
	}
}

func (h *Hub) connect(client *Client, message Message) {
	if message.Version != ProtocolVersion {
		h.fail(client, "protocol_mismatch", "Update Local and Remote pages for protocol v3")
		return
	}
	if message.FlashProtocol != 0 && message.FlashProtocol != 1 {
		h.fail(client, "invalid_access", "Remote flash capability is invalid")
		return
	}
	if message.SerialP2PProtocol != 0 && (message.SerialP2PProtocol != 1 || message.ProbeProtocol != 0 || message.RXReplayProtocol != 1) {
		h.fail(client, "invalid_access", "Invalid serial P2P capability")
		return
	}
	if message.SerialP2PRetryProtocol != 0 && (message.SerialP2PRetryProtocol != 1 || message.SerialP2PProtocol != 1) {
		h.fail(client, "invalid_access", "Invalid serial P2P retry capability")
		return
	}
	if message.SerialP2PTXRelayProtocol != 0 && (message.SerialP2PTXRelayProtocol != 1 || message.SerialP2PProtocol != 1) {
		h.fail(client, "invalid_access", "Invalid serial P2P TX relay capability")
		return
	}
	if _, subscribed := h.subscriptions[client]; subscribed && (message.SerialP2PProtocol != client.serialP2PProtocol || message.SerialP2PRetryProtocol != client.serialP2PRetryProtocol || message.SerialP2PTXRelayProtocol != client.serialP2PTXRelayProtocol) {
		h.fail(client, "invalid_access", "Disconnect before changing serial transport capabilities")
		return
	}
	if code := client.lease.Request(); code != "" {
		h.stopLimited(client, code)
		return
	}
	if message.RXReplayProtocol != 0 && message.RXReplayProtocol != RXReplayProtocolVersion ||
		(message.ResumeStreamID == "" && message.ResumeSeq != 0) ||
		(message.ResumeStreamID != "" && !validRXStreamID(message.ResumeStreamID)) {
		h.fail(client, "invalid_rx_resume", "Receive replay cursor is invalid")
		return
	}
	client.rxReplayProtocol = message.RXReplayProtocol
	client.flashProtocol = message.FlashProtocol
	local := h.locals[message.LocalID]
	if local == nil {
		h.fail(client, "local_not_found", "Local ID not found")
		return
	}
	if message.ProbeProtocol != 0 && (message.ProbeProtocol != 1 || local.probeProtocol != 1) {
		h.fail(client, "probe_unsupported", "The selected Local is not a P2P synthetic probe")
		return
	}
	client.probeProtocol = message.ProbeProtocol
	client.serialP2PProtocol = message.SerialP2PProtocol
	client.serialP2PRetryProtocol = message.SerialP2PRetryProtocol
	client.serialP2PTXRelayProtocol = message.SerialP2PTXRelayProtocol
	portID := message.PortID
	if portID == "" {
		portID = h.ports[message.LocalID].PortID
	}
	if h.ports[message.LocalID].PortID != portID {
		h.fail(client, "port_not_available", "Port not available on local")
		return
	}
	if len(message.Config) != 0 && string(message.Config) != "null" {
		h.fail(client, "configuration_unsupported", "Serial configuration must be set on Local")
		return
	}
	access := message.Access
	if access == "" {
		access = AccessRead
	}
	if access != AccessRead && access != AccessControl {
		h.fail(client, "invalid_access", "Access must be read or control")
		return
	}
	if message.ResumeStreamID == local.rxStreamID && message.ResumeStreamID != "" && message.ResumeSeq > local.rxSequence {
		h.fail(client, "invalid_rx_resume", "Receive replay cursor is ahead of the Local stream")
		return
	}
	target := subscription{localID: message.LocalID, portID: portID, access: access}
	current, subscribed := h.subscriptions[client]
	if !subscribed || current.localID != target.localID || current.portID != target.portID || current.access != target.access {
		h.requestConnection(client, local, target, message.ResumeStreamID, message.ResumeSeq)
		return
	}
	connected := h.withRXReplayState(local, client, Message{Type: MsgTypeConnect, LocalID: target.localID, RemoteID: client.remoteID,
		PortID: target.portID, Access: target.access, Version: ProtocolVersion, GrantID: current.grantID,
		WriteEpoch: local.writeEpoch, Paused: boolPointer(local.writesPaused)})
	connected.ProbeProtocol = negotiatedProbe(local, client)
	connected.SerialP2PProtocol = negotiatedSerialP2P(local, client)
	connected.SerialP2PRetryProtocol = negotiatedSerialP2PRetry(local, client)
	connected.SerialP2PTXRelayProtocol = negotiatedSerialP2PTXRelay(local, client)
	h.send(client, h.withFlashState(local, client, h.withSerialState(local, connected)))
}

func (h *Hub) detach(client *Client) {
	client.replay = nil
	client.serialDirect, client.serialLocalReady, client.serialRemoteReady, client.serialFallback = false, false, false, false
	client.serialTXRelay = false
	client.serialTXSequence = 0
	client.serialFallbackReason = ""
	client.serialFallbackDetails = nil
	client.serialFallbackReporter = ""
	client.serialFailureLogged = 0
	client.serialAttempt = 0
	client.serialRetryStarted, client.serialRetryAfter = time.Time{}, time.Time{}
	if target, ok := h.subscriptions[client]; ok {
		if local := h.locals[target.localID]; local != nil {
			if session := h.flashSessions[local]; session != nil && session.remote == client {
				h.releaseFlashSession(local, "permission_revoked", false)
			}
		}
		h.cancelConfiguration(h.locals[target.localID], client, "permission_revoked")
		delete(h.subscriptions, client)
		h.send(h.locals[target.localID], Message{Type: MsgTypeRemoteDisconnected, RemoteID: client.remoteID, PortID: target.portID})
	}
}

func (h *Hub) withRXReplayState(local, remote *Client, message Message) Message {
	if local.rxReplayProtocol == RXReplayProtocolVersion && remote.rxReplayProtocol == RXReplayProtocolVersion {
		message.RXReplayProtocol = RXReplayProtocolVersion
		message.RXStreamID = local.rxStreamID
		message.RXSeq = local.rxSequence
	}
	return message
}

func (h *Hub) forwardSend(client *Client, message Message) {
	target, ok := h.subscriptions[client]
	if !ok {
		h.fail(client, "not_connected", "Not connected")
		return
	}
	if target.access != AccessControl {
		h.fail(client, "read_only", "This connection has read-only access")
		return
	}
	if target.portID != message.PortID {
		h.fail(client, "port_not_available", "Port does not match the connected serial port")
		return
	}
	if !validData(message.Data) {
		h.fail(client, "invalid_data", "Data must be non-empty Base64")
		return
	}
	local := h.locals[target.localID]
	if local == nil {
		h.fail(client, "local_disconnected", "Local is offline")
		return
	}
	if h.flashSessions[local] != nil {
		h.fail(client, "flash_busy", "The serial port is reserved for ESP32 flashing")
		return
	}
	if message.GrantID == "" || message.GrantID != target.grantID {
		h.fail(client, "stale_grant", "Send permission has changed; request access again")
		return
	}
	if local.writesPaused {
		h.fail(client, "writes_paused", "Local paused remote writes; this command was not forwarded")
		return
	}
	if message.WriteEpoch != local.writeEpoch {
		h.fail(client, "stale_write_state", "Write state changed; submit a new command")
		return
	}
	if local.configuration != nil {
		h.fail(client, "configuration_busy", "Serial configuration is changing; submit again after it completes")
		return
	}
	h.relay(client, []*Client{local}, Message{Type: MsgTypeSend, RemoteID: client.remoteID, PortID: target.portID, Data: message.Data, GrantID: target.grantID, WriteEpoch: local.writeEpoch})
}

func (h *Hub) forwardData(client *Client, message Message) {
	if client.localID == "" || h.ports[client.localID].PortID != message.PortID {
		h.fail(client, "port_not_available", "Port is not registered on this Local")
		return
	}
	if !validData(message.Data) {
		h.fail(client, "invalid_data", "Data must be non-empty Base64")
		return
	}
	sequenced := client.rxReplayProtocol == RXReplayProtocolVersion
	if sequenced {
		if message.RXStreamID != client.rxStreamID || message.RXSeq != client.rxSequence+1 {
			h.fail(client, "invalid_rx_sequence", "Local receive sequence is stale or out of order")
			return
		}
		client.rxSequence = message.RXSeq
	} else if message.RXStreamID != "" || message.RXSeq != 0 {
		h.fail(client, "invalid_rx_sequence", "Local sent receive sequence without declaring replay support")
		return
	}
	localID := client.localID
	targets := make([]*Client, 0, MaxRemotesPerLocal)
	replayTargets := make([]*Client, 0, MaxRemotesPerLocal)
	forwarded := Message{Type: MsgTypeData, LocalID: localID, PortID: message.PortID, Data: message.Data}
	if sequenced {
		forwarded.RXStreamID, forwarded.RXSeq = client.rxStreamID, message.RXSeq
	}
	for remote, target := range h.subscriptions {
		if target.localID == localID && target.portID == message.PortID {
			if remote.replay != nil && sequenced && remote.replay.streamID == message.RXStreamID {
				if negotiatedSerialP2P(client, remote) == 1 {
					// Local retains the bounded RX cache. During backfill only advertise
					// the latest cursor; a second server payload queue cannot catch up
					// on a slower relay and would disconnect before ICE can finish.
					h.relay(client, []*Client{remote}, Message{Type: MsgTypeSerialHead, LocalID: localID,
						PortID: message.PortID, GrantID: target.grantID, RXStreamID: message.RXStreamID, RXSeq: message.RXSeq})
					continue
				}
				if message.RXSeq > remote.replay.through {
					replayTargets = append(replayTargets, remote)
				}
				continue
			}
			targets = append(targets, remote)
		}
	}
	copyCount := len(targets) + len(replayTargets)
	if copyCount == 0 {
		return
	}
	encoded, err := json.Marshal(forwarded)
	if err != nil {
		return
	}
	if code := client.lease.Outbound(len(encoded) * copyCount); code != "" {
		h.stopLimited(client, code)
		return
	}
	for _, remote := range replayTargets {
		h.queueRXDuringReplay(remote, forwarded, len(encoded))
	}
	for _, remote := range targets {
		h.enqueue(remote, encoded)
	}
}

func validData(data string) bool {
	if strings.Trim(data, "\r\n") == "" || len(data) > base64.StdEncoding.EncodedLen(MaxDataSize) {
		return false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(data)
	return err == nil && len(decoded) <= MaxDataSize
}

func validRXStreamID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func ValidID(id string) bool {
	if len(id) != IDLength {
		return false
	}
	for _, letter := range id {
		if !strings.ContainsRune(IDAlphabet, letter) {
			return false
		}
	}
	return true
}

func GenerateID() (string, error) {
	id := make([]byte, IDLength)
	for i := range id {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(IDAlphabet))))
		if err != nil {
			return "", err
		}
		id[i] = IDAlphabet[n.Int64()]
	}
	return string(id), nil
}

// Each Client has one socket reader and one writer. Only Hub closes send.
type Client struct {
	connectionID             uint64    // Immutable diagnostic number, assigned before pumps start.
	createdAt                time.Time // Immutable connection start time.
	hub                      *Hub
	conn                     *websocket.Conn
	send                     chan []byte
	role                     Role
	localID                  string               // Hub-owned
	remoteID                 string               // Hub-owned
	writesPaused             bool                 // Hub-owned, applies to all approved Remote writers.
	writeEpoch               uint64               // Hub-owned, invalidates commands from before pause/resume.
	serialConfig             *SerialConfig        // Hub-owned, last physical configuration confirmed by Local.
	configRevision           uint64               // Hub-owned, optimistic concurrency for configuration changes.
	configuration            *configurationChange // Hub-owned, at most one pending operation per Local.
	serialSignalsProtocol    int                  // Hub-owned capability advertised by Local.
	flashProtocol            int                  // Hub-owned capability advertised by Local.
	probeProtocol            int                  // Hub-owned synthetic-only P2P experiment capability.
	serialP2PProtocol        int                  // Hub-owned real serial P2P capability.
	serialP2PRetryProtocol   int                  // Optional bounded retry capability.
	serialP2PTXRelayProtocol int                  // Optional TX-only relay that preserves direct RX.
	serialAttempt            int                  // Hub-owned negotiation round, scoped to this grant.
	serialRetryStarted       time.Time
	serialRetryAfter         time.Time
	serialDirect             bool // Both endpoints confirmed an ordered direct channel.
	serialTXRelay            bool // This Remote uses WSS TX while direct RX remains available.
	serialLocalReady         bool
	serialRemoteReady        bool
	serialFallback           bool   // Upgrade requires a server-accepted, bounded new attempt.
	serialTXSequence         uint64 // Monotonic permits within one grant.
	serialFallbackReason     string // Validated browser diagnostic code; no raw ICE data.
	serialFallbackDetails    *P2PFailureDetails
	serialFallbackReporter   Role
	serialFailureLogged      uint8           // Hub-owned, at most one detail log per reporter and attempt.
	rxReplayProtocol         int             // Hub-owned optional receive replay capability.
	rxStreamID               string          // Hub-owned serial receive stream identity.
	rxSequence               uint64          // Hub-owned latest Local RX sequence.
	replay                   *receiveReplay  // Hub-owned bounded Remote catch-up state.
	lease                    *resource.Lease // Immutable admission reservation; internally synchronized.
	terminal                 chan string     // Hub signals; the single writer emits the close frame.
	queuedBytes              atomic.Int64    // Transport queue accounting, never protocol state.
}

func NewClient(hub *Hub, conn *websocket.Conn, role Role) *Client {
	return &Client{hub: hub, conn: conn, role: role, send: make(chan []byte, sendBufferSize),
		connectionID: connectionSequence.Add(1), createdAt: time.Now(), terminal: make(chan string, 1)}
}

func NewAdmittedClient(hub *Hub, conn *websocket.Conn, role Role, lease *resource.Lease) *Client {
	client := NewClient(hub, conn, role)
	client.lease = lease
	return client
}

func (c *Client) ReadPump() {
	var frames, bytes int64
	handedOff := false
	defer func() {
		if !handedOff {
			c.hub.Unregister(c)
			c.conn.Close()
		}
	}()
	c.conn.SetReadLimit(MaxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	controlLimit := ""
	chargeControl := func(data string) error {
		if code := c.lease.Inbound(len(data)); code != "" {
			controlLimit = code
			return errors.New("WebSocket control rate limit")
		}
		return nil
	}
	pingHandler := c.conn.PingHandler()
	c.conn.SetPingHandler(func(data string) error {
		if err := chargeControl(data); err != nil {
			return err
		}
		return pingHandler(data)
	})
	c.conn.SetPongHandler(func(data string) error {
		if err := chargeControl(data); err != nil {
			return err
		}
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			if controlLimit != "" {
				handedOff = c.hub.reportLimit(c, controlLimit)
				return
			}
			c.logTransportEnd("ws_read_end", err, frames, bytes)
			return
		}
		frames++
		bytes += int64(len(data))
		if code := c.lease.Inbound(len(data)); code != "" {
			handedOff = c.hub.reportLimit(c, code)
			return
		}
		var message Message
		if kind != websocket.TextMessage || json.Unmarshal(data, &message) != nil {
			message = Message{} // Hub reports invalid_message
		}
		if !c.hub.Submit(c, message) {
			return
		}
	}
}

func (c *Client) WritePump() {
	var frames, bytes int64
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.conn.Close()
	writeLimit := func(code string) {
		c.conn.SetWriteDeadline(time.Now().Add(writeWait))
		data, _ := json.Marshal(Message{Type: MsgTypeError, Code: code, Error: "Shared service resource limit reached; retry later"})
		c.conn.WriteMessage(websocket.TextMessage, data)
		c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4008, code))
	}
	for {
		select {
		case code := <-c.terminal:
			writeLimit(code)
			return
		case data, ok := <-c.send:
			select {
			case code := <-c.terminal:
				writeLimit(code)
				return
			default:
			}
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			c.queuedBytes.Add(-int64(len(data)))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				c.logTransportEnd("ws_write_end", err, frames, bytes)
				return
			}
			frames++
			bytes += int64(len(data))
			c.hub.resources.RecordWSWrite(len(data))
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.logTransportEnd("ws_ping_failed", err, frames, bytes)
				return
			}
		}
	}
}
