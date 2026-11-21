package main

import (
	"encoding/base64"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
	ws "shareserial/websocket"
)

func TestConcurrentRemoteWritersAndPauseOverRealWebSockets(t *testing.T) {
	server := testServer(t)
	local := dial(t, server, "local")
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeRegister, Version: ws.ProtocolVersion, LocalID: "ABC23", Ports: []ws.PortInfo{{PortID: "usb"}}})
	readMessage(t, local, ws.MsgTypeRegister)
	first, second := dial(t, server, "remote"), dial(t, server, "remote")
	grants := make([]ws.Message, 0, 2)
	for _, remote := range []*websocket.Conn{first, second} {
		writeMessage(t, remote, ws.Message{Type: ws.MsgTypeConnect, Version: ws.ProtocolVersion, LocalID: "ABC23", Access: ws.AccessControl})
		request := readMessage(t, local, ws.MsgTypeConnectionRequest)
		readMessage(t, remote, ws.MsgTypeConnectPending)
		writeMessage(t, local, ws.Message{Type: ws.MsgTypeApprove, RequestID: request.RequestID, Access: ws.AccessControl})
		readMessage(t, local, ws.MsgTypeRemoteConnected)
		grants = append(grants, readMessage(t, remote, ws.MsgTypeConnect))
	}
	var writers sync.WaitGroup
	errors := make(chan error, 2)
	for index, remote := range []*websocket.Conn{first, second} {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for i := range 2 {
				data := base64.StdEncoding.EncodeToString([]byte{byte(index), byte(i), 0, 255})
				if err := remote.WriteJSON(ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: data, GrantID: grants[index].GrantID, WriteEpoch: grants[index].WriteEpoch}); err != nil {
					errors <- err
					return
				}
			}
		}()
	}
	writers.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for range 4 {
		message := readMessage(t, local, ws.MsgTypeSend)
		data, err := base64.StdEncoding.DecodeString(message.Data)
		if err != nil || len(data) != 4 || data[2] != 0 || data[3] != 255 {
			t.Fatal("binary relay changed")
		}
		index := int(data[0])
		if index > 1 || message.RemoteID != grants[index].RemoteID || message.GrantID != grants[index].GrantID || int(data[1]) != seen[message.RemoteID] {
			t.Fatal("writer identity or per-source order lost", message)
		}
		seen[message.RemoteID]++
	}
	paused := true
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeSetWriteState, Version: ws.ProtocolVersion, RequestID: "pause", Paused: &paused})
	readMessage(t, local, ws.MsgTypeWriteState)
	readMessage(t, first, ws.MsgTypeWriteState)
	readMessage(t, second, ws.MsgTypeWriteState)
	writeMessage(t, first, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: "QQ=="})
	if readMessage(t, first, ws.MsgTypeError).Code != "writes_paused" {
		t.Fatal("paused command forwarded")
	}
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeData, PortID: "usb", Data: "Qg=="})
	readMessage(t, first, ws.MsgTypeData)
	readMessage(t, second, ws.MsgTypeData)
	paused = false
	writeMessage(t, local, ws.Message{Type: ws.MsgTypeSetWriteState, Version: ws.ProtocolVersion, RequestID: "resume", Paused: &paused})
	readMessage(t, local, ws.MsgTypeWriteState)
	readMessage(t, first, ws.MsgTypeWriteState)
	readMessage(t, second, ws.MsgTypeWriteState)
	writeMessage(t, second, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: "Qw==", WriteEpoch: 1})
	if readMessage(t, second, ws.MsgTypeError).Code != "stale_write_state" {
		t.Fatal("pre-pause command accepted after resume")
	}
	writeMessage(t, second, ws.Message{Type: ws.MsgTypeSend, PortID: "usb", Data: "RA=="})
	if readMessage(t, local, ws.MsgTypeSend).Data != "RA==" {
		t.Fatal("new command did not resume")
	}
}
