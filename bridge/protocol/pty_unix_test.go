//go:build !windows

package protocol_test

import (
	"strings"
	"testing"
	"time"
)

// openTerminal starts `sh -c script` on a new terminal channel of the given
// size and returns the channel's id.
func (p *peer) openTerminal(id int, script string, cols, rows int) float64 {
	p.t.Helper()
	result := p.call(id, "channel.open", map[string]any{
		"command": "/bin/sh",
		"args":    []string{"-c", script},
		"pty":     map[string]any{"cols": cols, "rows": rows},
	})
	channel, ok := result["channel"].(float64)
	if !ok {
		p.t.Fatalf("channel.open result has no channel: %v", result)
	}
	return channel
}

// until collects what the channel prints until it contains want, failing
// the test if it hasn't within 5 s.
func (p *peer) until(channel float64, want string) string {
	p.t.Helper()
	var out strings.Builder
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), want) {
		event, ok := p.eventWithin(time.Until(deadline))
		if !ok {
			p.t.Fatalf("output so far is %q, still waiting for %q", out.String(), want)
		}
		params := event["params"].(map[string]any)
		if params["channel"] != channel {
			continue
		}
		switch event["event"] {
		case "channel.data":
			out.Write(decode(p.t, params["data"]))
		case "channel.exit":
			p.t.Fatalf("channel exited (%v) with output %q, before %q", params, out.String(), want)
		}
	}
	return out.String()
}

func TestATerminalChannelRunsItsProcessOnATerminalOfTheGivenSize(t *testing.T) {
	p := helperBridge(t)

	channel := p.openTerminal(1, `[ -t 0 ] && [ -t 1 ] && echo "on a tty"; stty size`, 100, 30)

	out, exit := p.output(channel)
	if !strings.Contains(out, "on a tty") || !strings.Contains(out, "30 100") {
		t.Errorf("output = %q, want it on a 30x100 terminal", out)
	}
	if exit["exitCode"] != float64(0) {
		t.Errorf("exit = %v, want code 0", exit)
	}
}

func TestResizingATerminalChannelChangesTheSizeItsProcessSees(t *testing.T) {
	p := helperBridge(t)
	// Prints its size, then again on each line it reads.
	channel := p.openTerminal(1, `stty size; while read line; do stty size; done`, 80, 24)
	p.until(channel, "24 80")

	p.call(2, "channel.resize", map[string]any{"channel": channel, "cols": 132, "rows": 40})
	p.call(3, "channel.write", map[string]any{"channel": channel, "data": encode("\n")})

	p.until(channel, "40 132")
}

func TestKeysTypedIntoATerminalChannelReachItsShellAndAreEchoed(t *testing.T) {
	p := helperBridge(t)
	channel := p.openTerminal(1, `read name; echo "hello, $name"`, 80, 24)

	p.call(2, "channel.write", map[string]any{"channel": channel, "data": encode("loom\r")})

	out := p.until(channel, "hello, loom")
	if !strings.HasPrefix(out, "loom") {
		t.Errorf("output = %q, want the typed keys echoed first", out)
	}
}

func TestResizingAChannelThatIsNotATerminalIsAnError(t *testing.T) {
	p := helperBridge(t)
	channel := p.open(1, "cat", nil)

	p.send(map[string]any{"id": 2, "method": "channel.resize", "params": map[string]any{"channel": channel, "cols": 80, "rows": 24}})

	errObj, ok := p.response(2)["error"].(map[string]any)
	if !ok || errObj["code"] != "not_a_terminal" {
		t.Fatalf("reply error = %v, want not_a_terminal", errObj)
	}
}

func TestATerminalChannelWithNoCommandRunsTheUsersShellWithAColourTerminal(t *testing.T) {
	p := helperBridge(t)

	result := p.call(1, "channel.open", map[string]any{"pty": map[string]any{"cols": 80, "rows": 24}})
	channel := result["channel"].(float64)
	if result["path"] != "/bin/sh" {
		t.Errorf("path = %v, want /bin/sh when there is no $SHELL", result["path"])
	}
	p.call(2, "channel.write", map[string]any{"channel": channel, "data": encode("echo \"[$TERM $COLORTERM]\"; exit\r")})

	p.until(channel, "[xterm-256color truecolor]")
}

func TestKillingATerminalChannelStopsItsShellAndWhatItStarted(t *testing.T) {
	p := helperBridge(t)
	channel := p.openTerminal(1, `sleep 60 & echo started; wait`, 80, 24)
	p.until(channel, "started")

	p.call(2, "channel.kill", map[string]any{"channel": channel})

	if _, exit := p.output(channel); exit["exitCode"] == float64(0) {
		t.Errorf("exit = %v, want a killed shell", exit)
	}
}
