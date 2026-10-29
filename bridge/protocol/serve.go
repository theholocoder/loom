// Package protocol is the bridge's side of the protocol main speaks over the
// bridge's stdio: frames of a 4-byte big-endian length followed by a JSON
// message. Main sends requests ({id, method, params}); the bridge answers each
// with a response carrying the same id and either a result or an error.
package protocol

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"
	"time"
)

// ProtocolVersion is bumped whenever the frames or messages change in a way
// an older peer would not understand.
const ProtocolVersion = 1

// MaxFrameSize bounds a single frame so a corrupt length can't make the
// bridge allocate without limit.
const MaxFrameSize = 16 << 20

// Info describes this bridge build. Version is the Client's version the
// bridge was built with.
type Info struct {
	Version string
}

// Machine is what the bridge needs from the machine (or WSL distro) it runs
// on to resolve the Environment's shell environment.
type Machine struct {
	// Shell is the user's login shell ($SHELL), or empty when there is none to
	// ask, as on native Windows.
	Shell string
	// Environ is the bridge's own environment, the fallback.
	Environ []string
	// ShellTimeout bounds each attempt at running Shell; zero means
	// shellenv.DefaultTimeout.
	ShellTimeout time.Duration
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Error is the error half of a response.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type handshakeResult struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Version         string `json:"version"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
}

// Serve answers requests read from r on w until r reaches EOF, which is how
// main tells the bridge to shut down. Requests are handled concurrently, so a
// slow command never holds up a ping. It returns nil on a clean EOF and an
// error if the stream breaks or a frame can't be read; either way it first
// stops whatever the requests in flight were running.
func Serve(r io.Reader, w io.Writer, info Info, machine Machine) error {
	out := &writer{w: w}
	ctx, cancel := context.WithCancel(context.Background())
	s := &server{info: info, env: newEnvironment(ctx, machine)}
	var inFlight sync.WaitGroup
	defer inFlight.Wait()
	defer cancel()
	for {
		payload, err := readFrame(r)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var req request
		if err := json.Unmarshal(payload, &req); err != nil || len(req.ID) == 0 {
			if err := out.write(response{ID: json.RawMessage("null"), Error: &Error{Code: "bad_request", Message: "frame is not a request"}}); err != nil {
				return err
			}
			continue
		}
		inFlight.Add(1)
		go func() {
			defer inFlight.Done()
			// A reply that can't be written means main has gone; the read
			// loop sees the same and ends Serve.
			_ = out.write(s.handle(ctx, req))
		}()
	}
}

type server struct {
	info Info
	env  *environment
}

func (s *server) handle(ctx context.Context, req request) response {
	reply := func(result any, err *Error) response {
		if err != nil {
			return response{ID: req.ID, Error: err}
		}
		return response{ID: req.ID, Result: result}
	}
	switch req.Method {
	case "handshake":
		return reply(handshakeResult{
			ProtocolVersion: ProtocolVersion,
			Version:         s.info.Version,
			OS:              runtime.GOOS,
			Arch:            runtime.GOARCH,
		}, nil)
	case "ping":
		return reply(struct{}{}, nil)
	case "environment.get":
		return reply(environmentResult{Source: s.env.get().Source}, nil)
	case "environment.reload":
		return reply(environmentResult{Source: s.env.reload().Source}, nil)
	case "exec":
		var params execParams
		if err := decodeParams(req.Params, &params); err != nil {
			return reply(nil, err)
		}
		return reply(runCommand(ctx, s.env.get(), params))
	case "opencode.probe":
		return reply(probeOpencode(ctx, s.env.get()))
	default:
		return reply(nil, &Error{Code: "unknown_method", Message: fmt.Sprintf("unknown method %q", req.Method)})
	}
}

func decodeParams(raw json.RawMessage, into any) *Error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return &Error{Code: "bad_params", Message: err.Error()}
	}
	return nil
}

func readFrame(r io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(r, header); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("truncated frame header: %w", err)
		}
		return nil, err
	}
	size := binary.BigEndian.Uint32(header)
	if size > MaxFrameSize {
		return nil, fmt.Errorf("frame of %d bytes exceeds the %d byte limit", size, MaxFrameSize)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, fmt.Errorf("truncated frame: %w", err)
	}
	return payload, nil
}

// writer serializes frames so concurrent writers never interleave bytes.
type writer struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *writer) write(msg any) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame, uint32(len(payload)))
	copy(frame[4:], payload)
	w.mu.Lock()
	defer w.mu.Unlock()
	_, err = w.w.Write(frame)
	return err
}
