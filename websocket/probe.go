package websocket

import (
	"encoding/hex"
	"encoding/json"
)

// Synthetic-data-only experiment; no direct physical serial write path.
const ProbePortID = "p2p-probe"

func negotiatedProbe(local, remote *Client) int {
	if local != nil && remote != nil && local.probeProtocol == 1 && remote.probeProtocol == 1 {
		return 1
	}
	return 0
}

func (h *Hub) probeTarget(sender *Client, message Message) (*Client, *Client, subscription, bool) {
	var remote, local *Client
	if sender.role == RoleLocal {
		local = sender
		remote = h.remotes[message.RemoteID]
	} else {
		remote = sender
	}
	target, approved := h.subscriptions[remote]
	if !approved || target.grantID == "" {
		h.fail(sender, "approval_required", "Probe signaling requires current Local approval")
		return nil, nil, subscription{}, false
	}
	owner := h.locals[target.localID]
	if sender.role == RoleLocal && owner != local {
		h.fail(sender, "permission_denied", "Only the actual Local may signal this probe")
		return nil, nil, subscription{}, false
	}
	local = owner
	if local == nil || negotiatedProbe(local, remote) != 1 || target.portID != ProbePortID {
		h.fail(sender, "probe_unsupported", "P2P signaling is restricted to the synthetic probe")
		return nil, nil, subscription{}, false
	}
	if message.GrantID != target.grantID || message.PortID != target.portID {
		h.fail(sender, "stale_grant", "Probe authorization changed")
		return nil, nil, subscription{}, false
	}
	return local, remote, target, true
}

func (h *Hub) forwardProbeSignal(sender *Client, message Message) {
	local, remote, target, ok := h.probeTarget(sender, message)
	if !ok {
		return
	}
	valid := false
	switch message.ProbeKind {
	case "offer":
		valid = sender.role == RoleRemote && len(message.ProbePayload) > 0 && len(message.ProbePayload) <= 16*1024
	case "answer":
		valid = sender.role == RoleLocal && len(message.ProbePayload) > 0 && len(message.ProbePayload) <= 16*1024
	case "candidate":
		var candidate struct {
			Candidate string `json:"candidate"`
		}
		valid = len(message.ProbePayload) > 0 && len(message.ProbePayload) <= 2048 && json.Unmarshal([]byte(message.ProbePayload), &candidate) == nil && len(candidate.Candidate) <= 1024
	case "fallback":
		valid = message.ProbePayload == ""
	case "receipt":
		var receipt struct {
			Op    string `json:"op"`
			ID    uint32 `json:"id"`
			Bytes uint32 `json:"bytes"`
			SHA   string `json:"sha"`
			Code  string `json:"code"`
		}
		if len(message.ProbePayload) <= 512 && json.Unmarshal([]byte(message.ProbePayload), &receipt) == nil && receipt.ID != 0 {
			_, err := hex.DecodeString(receipt.SHA)
			valid = receipt.Op == "complete" && receipt.Bytes > 0 && receipt.Bytes <= 4*1024*1024 && len(receipt.SHA) == 64 && err == nil || receipt.Op == "rejected" && len(receipt.Code) > 0 && len(receipt.Code) <= 32
		}
	}
	if !valid {
		h.fail(sender, "invalid_probe_signal", "Invalid or oversized probe signaling")
		return
	}
	peer := local
	if sender == local {
		peer = remote
	}
	// Rebuild identity from the approved sockets, never the message body.
	h.relay(sender, []*Client{peer}, Message{Type: MsgTypeProbeSignal, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, ProbeProtocol: 1, ProbeKind: message.ProbeKind, ProbePayload: message.ProbePayload})
}

func (h *Hub) forwardProbeFrame(sender *Client, message Message) {
	local, remote, target, ok := h.probeTarget(sender, message)
	if !ok {
		return
	}
	if !validData(message.Data) {
		h.fail(sender, "invalid_data", "Probe frame must contain 1-16384 bytes")
		return
	}
	if sender == remote && (target.access != AccessControl || local.writesPaused || message.WriteEpoch != local.writeEpoch) {
		h.fail(sender, "probe_write_denied", "Synthetic probe sending requires current unpaused control")
		return
	}
	peer := local
	if sender == local {
		peer = remote
	}
	h.relay(sender, []*Client{peer}, Message{Type: MsgTypeProbeFrame, LocalID: target.localID, RemoteID: remote.remoteID, PortID: target.portID,
		GrantID: target.grantID, WriteEpoch: local.writeEpoch, ProbeProtocol: 1, Data: message.Data})
}
