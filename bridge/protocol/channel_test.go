package protocol_test

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

// helperEnv makes this test binary, started as a channel's process, act as
// the helper named by its value instead of running the tests (see TestMain).
const helperEnv = "LOOM_CHANNEL_HELPER"

func TestMain(m *testing.M) {
	switch os.Getenv(helperEnv) {
	case "":
		os.Exit(m.Run())
	case "cat":
		_, _ = io.Copy(os.Stdout, os.Stdin)
	case "where":
		cwd, _ := os.Getwd()
		fmt.Printf("%s|%s", cwd, os.Getenv("LOOM_GREETING"))
	case "flood":
		size, _ := strconv.Atoi(os.Getenv("LOOM_FLOOD_BYTES"))
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("x"), size))
	case "hang":
		fmt.Print("ready")
		time.Sleep(time.Minute)
	case "fail":
		fmt.Fprint(os.Stderr, "something broke")
		os.Exit(7)
	}
	os.Exit(0)
}

// helperBridge is a bridge whose Environment can run this test binary.
func helperBridge(t *testing.T) *peer {
	t.Helper()
	return startBridgeOn(t, protocol.Machine{Environ: os.Environ()})
}

// open starts this test binary as helper `mode` on a new channel and returns
// the channel's id.
func (p *peer) open(id int, mode string, extra map[string]any) float64 {
	p.t.Helper()
	self, err := os.Executable()
	if err != nil {
		p.t.Fatal(err)
	}
	env := map[string]string{helperEnv: mode}
	if more, ok := extra["env"].(map[string]string); ok {
		for k, v := range more {
			env[k] = v
		}
	}
	params := map[string]any{"command": self, "env": env}
	if cwd, ok := extra["cwd"]; ok {
		params["cwd"] = cwd
	}
	result := p.call(id, "channel.open", params)
	channel, ok := result["channel"].(float64)
	if !ok {
		p.t.Fatalf("channel.open result has no channel: %v", result)
	}
	return channel
}

// output collects what the channel's process prints until it exits, and
// returns it with the exit event.
func (p *peer) output(channel float64) (string, map[string]any) {
	p.t.Helper()
	var out bytes.Buffer
	for {
		event := p.nextEvent()
		params := event["params"].(map[string]any)
		if params["channel"] != channel {
			continue
		}
		switch event["event"] {
		case "channel.data":
			out.Write(decode(p.t, params["data"]))
		case "channel.exit":
			return out.String(), params
		}
	}
}

func decode(t *testing.T, data any) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(data.(string))
	if err != nil {
		t.Fatalf("channel data is not base64: %v", err)
	}
	return raw
}

func encode(text string) string {
	return base64.StdEncoding.EncodeToString([]byte(text))
}

func TestAChannelCarriesAProcesssStdinAndStdout(t *testing.T) {
	p := helperBridge(t)
	channel := p.open(1, "cat", nil)

	p.call(2, "channel.write", map[string]any{"channel": channel, "data": encode("hello\n")})
	p.call(3, "channel.close", map[string]any{"channel": channel})

	out, exit := p.output(channel)
	if out != "hello\n" {
		t.Errorf("output = %q, want hello", out)
	}
	if exit["exitCode"] != float64(0) {
		t.Errorf("exit = %v, want code 0", exit)
	}
}

func TestChannelsAreMultiplexedOverTheOneStream(t *testing.T) {
	p := helperBridge(t)
	first := p.open(1, "cat", nil)
	second := p.open(2, "cat", nil)
	if first == second {
		t.Fatalf("both channels got id %v", first)
	}

	p.call(3, "channel.write", map[string]any{"channel": first, "data": encode("to the first")})
	p.call(4, "channel.write", map[string]any{"channel": second, "data": encode("to the second")})
	p.call(5, "channel.close", map[string]any{"channel": second})
	p.call(6, "channel.close", map[string]any{"channel": first})

	got := map[float64]string{}
	for exited := 0; exited < 2; {
		event := p.nextEvent()
		params := event["params"].(map[string]any)
		channel := params["channel"].(float64)
		switch event["event"] {
		case "channel.data":
			got[channel] += string(decode(t, params["data"]))
		case "channel.exit":
			exited++
		}
	}
	if got[first] != "to the first" || got[second] != "to the second" {
		t.Errorf("outputs = %v, want each channel's own", got)
	}
}

func TestAChannelsProcessRunsInItsFolderWithTheExtraEnvironment(t *testing.T) {
	p := helperBridge(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	channel := p.open(1, "where", map[string]any{"cwd": dir, "env": map[string]string{"LOOM_GREETING": "hi"}})

	if out, _ := p.output(channel); out != dir+"|hi" {
		t.Errorf("output = %q, want %q", out, dir+"|hi")
	}
}

func TestAChannelSendsNoMoreThanItsWindowUntilMainAcknowledges(t *testing.T) {
	p := helperBridge(t)
	total := protocol.ChannelWindow*2 + 100
	channel := p.open(1, "flood", map[string]any{"env": map[string]string{"LOOM_FLOOD_BYTES": strconv.Itoa(total)}})

	received := 0
	for received < protocol.ChannelWindow {
		event := p.nextEvent()
		if event["event"] != "channel.data" {
			t.Fatalf("got %v before the window was used", event)
		}
		received += len(decode(t, event["params"].(map[string]any)["data"]))
	}
	if received != protocol.ChannelWindow {
		t.Fatalf("received %d bytes, more than the %d byte window", received, protocol.ChannelWindow)
	}
	if event, ok := p.eventWithin(300 * time.Millisecond); ok {
		t.Fatalf("got %v with the window used up", event)
	}

	p.call(2, "channel.ack", map[string]any{"channel": channel, "bytes": total})
	out, exit := p.output(channel)
	if received+len(out) != total {
		t.Errorf("received %d bytes in all, want %d", received+len(out), total)
	}
	if exit["exitCode"] != float64(0) {
		t.Errorf("exit = %v, want code 0", exit)
	}
}

func TestAChannelsExitReportsItsCodeAndStderr(t *testing.T) {
	p := helperBridge(t)
	channel := p.open(1, "fail", nil)

	_, exit := p.output(channel)

	if exit["exitCode"] != float64(7) || exit["stderr"] != "something broke" {
		t.Errorf("exit = %v, want code 7 and its stderr", exit)
	}
}

func TestKillingAChannelStopsItsProcess(t *testing.T) {
	p := helperBridge(t)
	channel := p.open(1, "hang", nil)
	if event := p.nextEvent(); event["event"] != "channel.data" {
		t.Fatalf("got %v, want the helper's ready", event)
	}

	p.call(2, "channel.kill", map[string]any{"channel": channel})

	if _, exit := p.output(channel); exit["exitCode"] == float64(0) {
		t.Errorf("exit = %v, want a killed process", exit)
	}
}

func TestAWriteToAnUnknownChannelIsAnError(t *testing.T) {
	p := helperBridge(t)

	p.send(map[string]any{"id": 1, "method": "channel.write", "params": map[string]any{"channel": 42, "data": encode("x")}})

	errObj, ok := p.response(1)["error"].(map[string]any)
	if !ok || errObj["code"] != "unknown_channel" {
		t.Fatalf("reply error = %v, want unknown_channel", errObj)
	}
}

func TestOpeningAChannelOnACommandNotOnThePathIsANotFoundError(t *testing.T) {
	p := helperBridge(t)

	p.send(map[string]any{"id": 1, "method": "channel.open", "params": map[string]any{"command": "no-such-loom-tool"}})

	errObj, ok := p.response(1)["error"].(map[string]any)
	if !ok || errObj["code"] != "not_found" {
		t.Fatalf("reply error = %v, want not_found", errObj)
	}
}

func TestStdinEOFStopsEveryChannelsProcessBeforeTheBridgeExits(t *testing.T) {
	p := helperBridge(t)
	p.open(1, "hang", nil)
	if event := p.nextEvent(); event["event"] != "channel.data" {
		t.Fatalf("got %v, want the helper's ready", event)
	}

	p.stdin.Close()

	// The helper would hang for a minute; Serve waits for it, so returning
	// within waitExit's 5 s means it was killed.
	if err := p.waitExit(); err != nil {
		t.Fatalf("Serve returned %v, want nil", err)
	}
}
