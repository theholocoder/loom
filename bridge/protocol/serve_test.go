package protocol_test

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"runtime"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

// peer is main's side of the bridge's stdio, speaking raw frames: a 4-byte
// big-endian length followed by that many bytes of JSON. A goroutine reads
// every frame the bridge sends; responses and events can then be taken in
// whatever order a test needs.
type peer struct {
	t         *testing.T
	stdin     *io.PipeWriter
	stdout    *io.PipeReader
	done      chan error
	frames    chan map[string]any
	events    []map[string]any
	responses map[float64]map[string]any
}

func startBridge(t *testing.T) *peer {
	t.Helper()
	return startBridgeOn(t, protocol.Machine{})
}

func startBridgeOn(t *testing.T, machine protocol.Machine) *peer {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &peer{t: t, stdin: inW, stdout: outR, done: make(chan error, 1), frames: make(chan map[string]any, 1024), responses: map[float64]map[string]any{}}
	go func() {
		err := protocol.Serve(inR, outW, protocol.Info{Version: "1.2.3"}, machine)
		outW.Close()
		p.done <- err
	}()
	go func() {
		defer close(p.frames)
		for {
			header := make([]byte, 4)
			if _, err := io.ReadFull(outR, header); err != nil {
				return
			}
			payload := make([]byte, binary.BigEndian.Uint32(header))
			if _, err := io.ReadFull(outR, payload); err != nil {
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(payload, &msg); err != nil {
				msg = map[string]any{"unparsable": string(payload)}
			}
			p.frames <- msg
		}
	}()
	t.Cleanup(func() { inW.Close(); outR.Close() })
	return p
}

func (p *peer) sendRaw(payload []byte) {
	p.t.Helper()
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err := p.stdin.Write(append(header, payload...)); err != nil {
		p.t.Fatalf("write frame: %v", err)
	}
}

func (p *peer) send(msg any) {
	p.t.Helper()
	payload, err := json.Marshal(msg)
	if err != nil {
		p.t.Fatal(err)
	}
	p.sendRaw(payload)
}

// frameWithin is the next frame the bridge sent, if one arrives within d.
func (p *peer) frameWithin(d time.Duration) (map[string]any, bool) {
	p.t.Helper()
	select {
	case msg, ok := <-p.frames:
		if !ok {
			p.t.Fatal("the bridge closed its stdout")
		}
		return msg, true
	case <-time.After(d):
		return nil, false
	}
}

// receive is the next frame the bridge sends, whatever it is.
func (p *peer) receive() map[string]any {
	p.t.Helper()
	msg, ok := p.frameWithin(5 * time.Second)
	if !ok {
		p.t.Fatal("timed out waiting for a frame from the bridge")
	}
	return msg
}

// response is the response to request id, keeping events that arrive first.
func (p *peer) response(id float64) map[string]any {
	p.t.Helper()
	for {
		if msg, ok := p.responses[id]; ok {
			delete(p.responses, id)
			return msg
		}
		p.keep(p.receive())
	}
}

// call sends a request and returns its result, failing the test on an error.
func (p *peer) call(id int, method string, params any) map[string]any {
	p.t.Helper()
	p.send(map[string]any{"id": id, "method": method, "params": params})
	reply := p.response(float64(id))
	result, ok := reply["result"].(map[string]any)
	if !ok {
		p.t.Fatalf("%s replied %v", method, reply)
	}
	return result
}

// eventWithin is the next event the bridge sends, if one arrives within d.
func (p *peer) eventWithin(d time.Duration) (map[string]any, bool) {
	p.t.Helper()
	deadline := time.Now().Add(d)
	for len(p.events) == 0 {
		msg, ok := p.frameWithin(time.Until(deadline))
		if !ok {
			return nil, false
		}
		p.keep(msg)
	}
	event := p.events[0]
	p.events = p.events[1:]
	return event, true
}

func (p *peer) nextEvent() map[string]any {
	p.t.Helper()
	event, ok := p.eventWithin(5 * time.Second)
	if !ok {
		p.t.Fatal("timed out waiting for an event from the bridge")
	}
	return event
}

func (p *peer) keep(msg map[string]any) {
	if id, ok := msg["id"].(float64); ok {
		p.responses[id] = msg
	} else {
		p.events = append(p.events, msg)
	}
}

func (p *peer) waitExit() error {
	p.t.Helper()
	select {
	case err := <-p.done:
		return err
	case <-time.After(5 * time.Second):
		p.t.Fatal("bridge did not exit")
		return nil
	}
}

func TestHandshakeReportsProtocolVersionOSAndArchitecture(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "handshake"})

	reply := p.receive()
	if reply["id"] != float64(1) {
		t.Fatalf("reply id = %v, want 1", reply["id"])
	}
	result, ok := reply["result"].(map[string]any)
	if !ok {
		t.Fatalf("reply has no result: %v", reply)
	}
	want := map[string]any{
		"protocolVersion": float64(1),
		"version":         "1.2.3",
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
	}
	for key, value := range want {
		if result[key] != value {
			t.Errorf("handshake %s = %v, want %v", key, result[key], value)
		}
	}
}

func TestPingIsAnsweredWithAnEmptyResult(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": "ping-7", "method": "ping"})

	reply := p.receive()
	if reply["id"] != "ping-7" {
		t.Fatalf("reply id = %v, want ping-7", reply["id"])
	}
	if _, ok := reply["result"].(map[string]any); !ok {
		t.Fatalf("ping reply has no result: %v", reply)
	}
}

func TestUnknownMethodIsAnErrorAndTheBridgeKeepsServing(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "teleport"})
	reply := p.receive()
	errObj, ok := reply["error"].(map[string]any)
	if !ok || errObj["code"] != "unknown_method" {
		t.Fatalf("reply = %v, want an unknown_method error", reply)
	}

	p.send(map[string]any{"id": 2, "method": "ping"})
	if reply := p.receive(); reply["id"] != float64(2) {
		t.Fatalf("bridge stopped serving after an unknown method: %v", reply)
	}
}

func TestAFrameThatIsNotARequestIsRejectedAndTheBridgeKeepsServing(t *testing.T) {
	p := startBridge(t)

	p.sendRaw([]byte("not json"))
	reply := p.receive()
	errObj, ok := reply["error"].(map[string]any)
	if !ok || errObj["code"] != "bad_request" {
		t.Fatalf("reply = %v, want a bad_request error", reply)
	}

	p.send(map[string]any{"id": 2, "method": "ping"})
	if reply := p.receive(); reply["id"] != float64(2) {
		t.Fatalf("bridge stopped serving after a bad frame: %v", reply)
	}
}

func TestStdinEOFShutsTheBridgeDownCleanly(t *testing.T) {
	p := startBridge(t)
	p.send(map[string]any{"id": 1, "method": "ping"})
	p.receive()

	p.stdin.Close()

	if err := p.waitExit(); err != nil {
		t.Fatalf("Serve returned %v on stdin EOF, want nil", err)
	}
}

func TestAnOversizedFrameStopsTheBridgeWithAnError(t *testing.T) {
	p := startBridge(t)

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, protocol.MaxFrameSize+1)
	go p.stdin.Write(header)

	if err := p.waitExit(); err == nil {
		t.Fatal("Serve returned nil for an oversized frame, want an error")
	}
}
