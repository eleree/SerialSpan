package websocket

import (
	"encoding/json"
	"testing"

	"shareserial/resource"
)

func admittedPeer(t *testing.T, h *Hub, role Role, ip string) *Client {
	t.Helper()
	lease, code := h.resources.Admit(ip)
	if code != "" {
		t.Fatal(code)
	}
	client := NewAdmittedClient(h, nil, role, lease)
	h.add(client)
	return client
}

func TestRelayFanoutChargesEachCopyAndRejectsAllBeforeDelivery(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.DailyBytes = 100000
	manager, _ := resource.New(cfg)
	h := NewHubWithResources(manager)
	local := admittedPeer(t, h, RoleLocal, "local")
	a := admittedPeer(t, h, RoleRemote, "a")
	b := admittedPeer(t, h, RoleRemote, "b")
	share(t, h, local, "ABC23", "usb")
	connect(t, h, a, local, "ABC23", "usb")
	connect(t, h, b, local, "ABC23", "usb")
	message := Message{Type: MsgTypeData, LocalID: "ABC23", PortID: "usb", Data: "QQ=="}
	encoded, _ := json.Marshal(message)
	before := manager.Snapshot().DailyReservedBytes
	h.forwardData(local, message)
	if manager.Snapshot().DailyReservedBytes-before != int64(len(encoded)*2) {
		t.Fatal("fan-out did not charge both copies")
	}
	takeReady(t, a, MsgTypeData)
	takeReady(t, b, MsgTypeData)
	remaining := cfg.DailyBytes - manager.Snapshot().DailyReservedBytes - int64(len(encoded)*2) + 1
	if code := local.lease.Outbound(int(remaining)); code != "" {
		t.Fatal(code)
	}
	h.forwardData(local, message)
	if h.clients[local] {
		t.Fatal("source retained relay authority after quota failure")
	}
	if code := <-local.terminal; code != "daily_quota_exceeded" {
		t.Fatal(code)
	}
	for _, remote := range []*Client{a, b} {
		for len(remote.send) > 0 {
			data := <-remote.send
			var got Message
			json.Unmarshal(data, &got)
			if got.Type == MsgTypeData {
				t.Fatal("partial fan-out before quota rejection")
			}
		}
	}
}

func TestByteBoundedQueueStopsPeerBeforeFrameCountLimit(t *testing.T) {
	cfg := resource.DefaultConfig()
	cfg.MaxQueuedBytes = 100
	manager, _ := resource.New(cfg)
	h := NewHubWithResources(manager)
	client := peer(h, RoleRemote)
	if !h.enqueue(client, make([]byte, 100)) {
		t.Fatal("exact queue boundary rejected")
	}
	if h.enqueue(client, []byte{1}) || h.clients[client] {
		t.Fatal("byte queue bound bypassed")
	}
	if code := <-client.terminal; code != "send_queue_limited" {
		t.Fatal(code)
	}
}
