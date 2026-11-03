package protocol_test

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// openSpawner opens a channel on a helper that starts a tool, and returns the
// channel and the tool's PID once the helper is ready. The tool is killed at
// the end of the test if it is still running.
func (p *peer) openSpawner(id int, env map[string]string) (float64, int) {
	p.t.Helper()
	pidFile := filepath.Join(p.t.TempDir(), "tool.pid")
	all := map[string]string{"LOOM_PID_FILE": pidFile}
	for k, v := range env {
		all[k] = v
	}
	channel := p.open(id, "spawner", map[string]any{"env": all})
	if event := p.nextEvent(); event["event"] != "channel.data" {
		p.t.Fatalf("got %v, want the helper's ready", event)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		p.t.Fatalf("the helper wrote no tool PID: %v", err)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		p.t.Fatalf("tool PID %q: %v", raw, err)
	}
	p.t.Cleanup(func() { killStray(pid) })
	return channel, pid
}

// assertGone fails the test unless the process pid exits within a few
// seconds.
func assertGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for running(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("tool %d is still running", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestStdinEOFStopsTheToolsAChannelsProcessStarted(t *testing.T) {
	p := helperBridge(t)
	_, tool := p.openSpawner(1, nil)

	p.stdin.Close()

	if err := p.waitExit(); err != nil {
		t.Fatalf("Serve returned %v, want nil", err)
	}
	assertGone(t, tool)
}

func TestKillingAChannelStopsTheToolsItsProcessStarted(t *testing.T) {
	p := helperBridge(t)
	channel, tool := p.openSpawner(1, nil)

	p.call(2, "channel.kill", map[string]any{"channel": channel})

	p.output(channel)
	assertGone(t, tool)
}

func TestAChannelsProcessTakesTheToolsItLeftRunningWithItWhenItExits(t *testing.T) {
	p := helperBridge(t)
	channel, tool := p.openSpawner(1, map[string]string{"LOOM_SPAWNER_EXITS": "1"})

	if _, exit := p.output(channel); exit["exitCode"] != float64(0) {
		t.Fatalf("exit = %v, want the helper's clean exit", exit)
	}
	assertGone(t, tool)
}
