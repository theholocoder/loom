package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

// frames splits what a writer wrote into its frames' payloads.
func frames(t *testing.T, written []byte) [][]byte {
	t.Helper()
	var payloads [][]byte
	for len(written) > 0 {
		if len(written) < 4 {
			t.Fatalf("%d bytes left over, short of a frame header", len(written))
		}
		size := int(binary.BigEndian.Uint32(written))
		if len(written) < 4+size {
			t.Fatalf("a frame says %d bytes, but only %d follow", size, len(written)-4)
		}
		payloads = append(payloads, written[4:4+size])
		written = written[4+size:]
	}
	return payloads
}

// An answer too big for a frame would make main drop the bridge, and every
// Session of its Environment with it (issue #260): the request is answered
// with an error instead, and the bridge carries on.
func TestAnswerTooBigForAFrameIsAnError(t *testing.T) {
	var written bytes.Buffer
	out := &writer{w: &written}
	big := strings.Repeat("x", MaxFrameSize)
	req := request{ID: json.RawMessage("7"), Method: "exec"}
	if err := out.respond(req, response{ID: req.ID, Result: execResult{Stdout: big}}); err != nil {
		t.Fatalf("respond: %v", err)
	}
	if err := out.respond(request{ID: json.RawMessage("8"), Method: "ping"}, response{ID: json.RawMessage("8"), Result: struct{}{}}); err != nil {
		t.Fatalf("respond after: %v", err)
	}

	payloads := frames(t, written.Bytes())
	if len(payloads) != 2 {
		t.Fatalf("wrote %d frames, want 2", len(payloads))
	}
	var answer struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *Error          `json:"error"`
	}
	if err := json.Unmarshal(payloads[0], &answer); err != nil {
		t.Fatal(err)
	}
	if answer.ID != 7 || answer.Result != nil || answer.Error == nil || answer.Error.Code != "too_large" {
		t.Fatalf("answer = %s, want a too_large error for request 7", payloads[0])
	}
	if !strings.Contains(answer.Error.Message, "exec") {
		t.Errorf("message %q doesn't say which method's answer it was", answer.Error.Message)
	}
	if string(payloads[1]) != `{"id":8,"result":{}}` {
		t.Errorf("next answer = %s", payloads[1])
	}
}

// Main reads JSON, not HTML: `<`, `>` and `&` go as they are, not as six
// bytes each, so output full of them (a diff of markup) stays small.
func TestFramesLeaveHTMLUnescaped(t *testing.T) {
	var written bytes.Buffer
	out := &writer{w: &written}
	if err := out.write(response{ID: json.RawMessage("1"), Result: execResult{Stdout: "<a> && <b>", Path: "/usr/bin/git"}}); err != nil {
		t.Fatal(err)
	}
	payloads := frames(t, written.Bytes())
	if len(payloads) != 1 || !bytes.Contains(payloads[0], []byte(`"stdout":"<a> && <b>"`)) {
		t.Fatalf("frames = %q", payloads)
	}
	if bytes.HasSuffix(payloads[0], []byte("\n")) {
		t.Errorf("frame ends in a newline: %q", payloads[0])
	}
}
