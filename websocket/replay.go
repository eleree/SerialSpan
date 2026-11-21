package websocket

import (
	"encoding/json"
)

func (h *Hub) updateRXHead(local *Client, message Message) {
	if local == nil || local.localID == "" || h.locals[local.localID] != local ||
		local.rxReplayProtocol != RXReplayProtocolVersion || message.PortID != h.ports[local.localID].PortID ||
		message.RXStreamID != local.rxStreamID || message.RXSeq < local.rxSequence {
		h.fail(local, "invalid_rx_sequence", "Local receive stream state is stale")
		return
	}
	if message.RXSeq == local.rxSequence {
		return
	}
	gap := Message{Type: MsgTypeRXGap, LocalID: local.localID, PortID: message.PortID,
		RXStreamID: local.rxStreamID, GapFrom: local.rxSequence + 1, GapTo: message.RXSeq}
	local.rxSequence = message.RXSeq
	for remote, target := range h.subscriptions {
		if target.localID == local.localID && target.portID == message.PortID {
			h.send(remote, gap)
		}
	}
}

func (h *Hub) replayRemote(local *Client, message Message) (*Client, subscription, *receiveReplay, bool) {
	if local == nil || local.localID == "" || h.locals[local.localID] != local ||
		local.rxReplayProtocol != RXReplayProtocolVersion || message.RXStreamID != local.rxStreamID {
		return nil, subscription{}, nil, false
	}
	remote := h.remotes[message.TargetRemoteID]
	target, ok := h.subscriptions[remote]
	if remote == nil || !ok || target.localID != local.localID || target.portID != message.PortID ||
		target.grantID == "" || target.grantID != message.GrantID || remote.replay == nil ||
		remote.replay.streamID != local.rxStreamID {
		return nil, subscription{}, nil, false
	}
	return remote, target, remote.replay, true
}

func (h *Hub) forwardReplayData(local *Client, message Message) {
	remote, target, replay, ok := h.replayRemote(local, message)
	if !ok || !validData(message.Data) || message.RXSeq != replay.nextSeq || message.RXSeq > replay.through {
		h.fail(local, "invalid_rx_replay", "Replay data does not match an authorized receive transfer")
		return
	}
	outgoing, err := json.Marshal(Message{Type: MsgTypeData, LocalID: target.localID, PortID: target.portID,
		Data: message.Data, RXStreamID: replay.streamID, RXSeq: message.RXSeq})
	if err != nil {
		return
	}
	if code := local.lease.Outbound(len(outgoing)); code != "" {
		h.stopLimited(local, code)
		return
	}
	if h.enqueue(remote, outgoing) {
		replay.nextSeq++
	}
}

func (h *Hub) forwardReplayGap(local *Client, message Message) {
	remote, target, replay, ok := h.replayRemote(local, message)
	if !ok || message.GapFrom != replay.nextSeq || message.GapTo < message.GapFrom || message.GapTo > replay.through {
		h.fail(local, "invalid_rx_replay", "Replay gap does not match an authorized receive transfer")
		return
	}
	h.relay(local, []*Client{remote}, Message{Type: MsgTypeRXGap, LocalID: target.localID, PortID: target.portID,
		RXStreamID: replay.streamID, GapFrom: message.GapFrom, GapTo: message.GapTo})
	if h.clients[remote] && h.locals[target.localID] == local {
		replay.nextSeq = message.GapTo + 1
		replay.ackedSeq = message.GapTo
	}
}

func (h *Hub) forwardReplayComplete(local *Client, message Message) {
	remote, target, replay, ok := h.replayRemote(local, message)
	if !ok || message.ThroughSeq != replay.through || replay.nextSeq != replay.through+1 || replay.ackedSeq != replay.through {
		h.fail(local, "invalid_rx_replay", "Receive replay completed before all available data was acknowledged")
		return
	}
	h.relay(local, []*Client{remote}, Message{Type: MsgTypeReplayComplete, LocalID: target.localID, PortID: target.portID,
		RXStreamID: replay.streamID, ThroughSeq: replay.through})
	if !h.clients[remote] || h.locals[target.localID] != local {
		return
	}
	queued := replay.queued
	remote.replay = nil
	if negotiatedSerialP2P(local, remote) == 1 {
		// The modern receiver merges any directly received live tail, then
		// requests the next bounded cache window if its cursor still lags.
		h.relay(local, []*Client{remote}, Message{Type: MsgTypeSerialHead, LocalID: target.localID,
			PortID: target.portID, GrantID: target.grantID, RXStreamID: local.rxStreamID, RXSeq: local.rxSequence})
		return
	}
	for _, queuedMessage := range queued {
		data, err := json.Marshal(queuedMessage)
		if err != nil || !h.enqueue(remote, data) {
			return
		}
	}
}

func (h *Hub) forwardRXAck(remote *Client, message Message) {
	target, ok := h.subscriptions[remote]
	if !ok || target.portID != message.PortID || target.grantID == "" || target.grantID != message.GrantID {
		h.fail(remote, "not_connected", "Receive acknowledgement is not authorized")
		return
	}
	local := h.locals[target.localID]
	replay := remote.replay
	if local == nil || replay == nil || replay.streamID != message.RXStreamID ||
		message.RXSeq > replay.through {
		h.fail(remote, "invalid_rx_ack", "Receive acknowledgement is stale or out of order")
		return
	}
	if message.RXSeq <= replay.ackedSeq {
		return
	}
	// ACKs are cumulative: the receiver can acknowledge any sent sequence up
	// to the highest frame already admitted to the Remote's ordered socket.
	if message.RXSeq > replay.nextSeq-1 {
		h.fail(remote, "invalid_rx_ack", "Receive acknowledgement is out of order")
		return
	}
	replay.ackedSeq = message.RXSeq
	h.send(local, Message{Type: MsgTypeRXAck, LocalID: target.localID, RemoteID: remote.remoteID,
		PortID: target.portID, GrantID: target.grantID, RXStreamID: replay.streamID, RXSeq: replay.ackedSeq})
}

func (h *Hub) queueRXDuringReplay(remote *Client, message Message, encodedBytes int) {
	replay := remote.replay
	if replay == nil {
		return
	}
	if len(replay.queued) >= sendBufferSize || replay.queuedBytes+encodedBytes > MaxRXReplayQueueBytes {
		h.stopLimited(remote, "send_queue_limited")
		return
	}
	replay.queued = append(replay.queued, message)
	replay.queuedBytes += encodedBytes
}
