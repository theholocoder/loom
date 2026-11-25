package protocol

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// frames reads back what a writer wrote, frame by frame, as the bridge
// reads main's: each one within MaxFrameSize.
func frames(t *testing.T, written []byte) [][]byte {
	t.Helper()
	r := bytes.NewReader(written)
	var payloads [][]byte
	for r.Len() > 0 {
		payload, err := readFrame(r)
		if err != nil {
			t.Fatalf("frame %d: %v", len(payloads)+1, err)
		}
		payloads = append(payloads, payload)
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
	if err := answer(out, req, response{ID: req.ID, Result: execResult{Stdout: big}}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	if err := answer(out, request{ID: json.RawMessage("8"), Method: "ping"}, response{ID: json.RawMessage("8"), Result: struct{}{}}); err != nil {
		t.Fatalf("answer after: %v", err)
	}

	payloads := frames(t, written.Bytes())
	if len(payloads) != 2 {
		t.Fatalf("wrote %d frames, want 2", len(payloads))
	}
	var got struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *Error          `json:"error"`
	}
	if err := json.Unmarshal(payloads[0], &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != 7 || got.Result != nil || got.Error == nil || got.Error.Code != "too_large" {
		t.Fatalf("answer = %s, want a too_large error for request 7", payloads[0])
	}
	if !strings.Contains(got.Error.Message, "exec") {
		t.Errorf("message %q doesn't say which method's answer it was", got.Error.Message)
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
