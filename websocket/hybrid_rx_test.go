package websocket

import "testing"

func TestHybridRXBackfillDoesNotQueueLivePayloadOrDisconnectBeforeICE(t *testing.T) {
	for _, wireProtocol := range []int{0, 1} {
		t.Run(string(rune('0'+wireProtocol)), func(t *testing.T) {
			h, local, remote, grant := serialPair(t, AccessRead)
			remote.serialDirect = false // The direct channel is still negotiating.
			live := Message{Type: MsgTypeData, PortID: "usb", SerialP2PProtocol: wireProtocol, RXStreamID: local.rxStreamID, RXSeq: 1, Data: "AA=="}
			h.handle(local, live)
			takeReady(t, remote, MsgTypeData)
			if wireProtocol == 1 {
				takeReady(t, remote, MsgTypeSerialHead)
			}
			h.handle(remote, Message{Type: MsgTypeSerialResume, PortID: "usb", GrantID: grant.GrantID, RXStreamID: local.rxStreamID})
			takeReady(t, remote, MsgTypeSerialReplay)
			takeReady(t, local, MsgTypeResumeRX)
			for sequence := uint64(2); sequence <= 302; sequence++ {
				live.RXSeq = sequence
				h.handle(local, live)
				if head := takeReady(t, remote, MsgTypeSerialHead); head.RXSeq != sequence || head.Data != "" {
					t.Fatal("live payload entered the replay socket instead of its cursor")
				}
			}
			if !h.clients[remote] || len(remote.replay.queued) != 0 || remote.replay.queuedBytes != 0 || h.subscriptions[remote].grantID != grant.GrantID {
				t.Fatal("backfill accumulated a second live queue or ended the approved connection")
			}
			h.handle(local, Message{Type: MsgTypeReplayData, PortID: "usb", TargetRemoteID: remote.remoteID, GrantID: grant.GrantID, RXStreamID: local.rxStreamID, RXSeq: 1, Data: "AA=="})
			takeReady(t, remote, MsgTypeData)
			h.handle(remote, Message{Type: MsgTypeRXAck, PortID: "usb", GrantID: grant.GrantID, RXStreamID: local.rxStreamID, RXSeq: 1})
			takeReady(t, local, MsgTypeRXAck)
			h.handle(local, Message{Type: MsgTypeReplayComplete, PortID: "usb", TargetRemoteID: remote.remoteID, GrantID: grant.GrantID, RXStreamID: local.rxStreamID, ThroughSeq: 1})
			takeReady(t, remote, MsgTypeReplayComplete)
			if head := takeReady(t, remote, MsgTypeSerialHead); head.RXSeq != 302 {
				t.Fatal("completion did not advertise the outstanding live tail")
			}
			h.handle(remote, Message{Type: MsgTypeSerialResume, PortID: "usb", GrantID: grant.GrantID, RXStreamID: local.rxStreamID, ResumeSeq: 1})
			if next := takeReady(t, remote, MsgTypeSerialReplay); next.ThroughSeq != 302 {
				t.Fatal("next cache window did not start from the receiver cursor")
			}
			if next := takeReady(t, local, MsgTypeResumeRX); next.ResumeSeq != 1 || next.ThroughSeq != 302 {
				t.Fatal("Local lost the bounded follow-up repair range")
			}
		})
	}
}
