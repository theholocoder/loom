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
// big-endian length followed by that many bytes of JSON.
type peer struct {
	t      *testing.T
	stdin  *io.PipeWriter
	stdout *io.PipeReader
	done   chan error
}

func startBridge(t *testing.T) *peer {
	t.Helper()
	return startBridgeHost(t, protocol.Host{})
}

func startBridgeHost(t *testing.T, host protocol.Host) *peer {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &peer{t: t, stdin: inW, stdout: outR, done: make(chan error, 1)}
	go func() {
		err := protocol.Serve(inR, outW, protocol.Info{Version: "1.2.3"}, host)
		outW.Close()
		p.done <- err
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

func (p *peer) receive() map[string]any {
	p.t.Helper()
	type frame struct {
		msg map[string]any
		err error
	}
	got := make(chan frame, 1)
	go func() {
		header := make([]byte, 4)
		if _, err := io.ReadFull(p.stdout, header); err != nil {
			got <- frame{err: err}
			return
		}
		payload := make([]byte, binary.BigEndian.Uint32(header))
		if _, err := io.ReadFull(p.stdout, payload); err != nil {
			got <- frame{err: err}
			return
		}
		var msg map[string]any
		got <- frame{msg: msg, err: json.Unmarshal(payload, &msg)}
	}()
	select {
	case f := <-got:
		if f.err != nil {
			p.t.Fatalf("read frame: %v", f.err)
		}
		return f.msg
	case <-time.After(5 * time.Second):
		p.t.Fatal("timed out waiting for a frame from the bridge")
		return nil
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
