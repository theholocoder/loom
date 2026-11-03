//go:build !windows

package protocol_test

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

// running reports whether the process pid exists. A tool whose parent died
// is reaped by init, so a dead one doesn't linger as a zombie for long.
func running(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// killStray kills a tool this test started that is still running.
func killStray(pid int) {
	if running(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func TestKillingAChannelAsksItsProcessToExitFirst(t *testing.T) {
	p := helperBridge(t)
	mark := filepath.Join(t.TempDir(), "terminated")
	channel := p.open(1, "graceful", map[string]any{"env": map[string]string{"LOOM_MARK_FILE": mark}})
	if event := p.nextEvent(); event["event"] != "channel.data" {
		t.Fatalf("got %v, want the helper's ready", event)
	}

	p.call(2, "channel.kill", map[string]any{"channel": channel})

	if _, exit := p.output(channel); exit["exitCode"] != float64(0) {
		t.Errorf("exit = %v, want the helper's own clean exit", exit)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Errorf("the helper never saw SIGTERM: %v", err)
	}
}

func TestAChannelsProcessThatIgnoresSIGTERMIsKilledOnceTheGraceIsUp(t *testing.T) {
	const grace = 300 * time.Millisecond
	p := startBridgeOn(t, protocol.Machine{Environ: os.Environ(), StopGrace: grace})
	channel := p.open(1, "stubborn", nil)
	if event := p.nextEvent(); event["event"] != "channel.data" {
		t.Fatalf("got %v, want the helper's ready", event)
	}
	start := time.Now()

	p.call(2, "channel.kill", map[string]any{"channel": channel})

	if _, exit := p.output(channel); exit["exitCode"] == float64(0) {
		t.Errorf("exit = %v, want a killed process", exit)
	}
	if elapsed := time.Since(start); elapsed < grace {
		t.Errorf("killed after %v, want the %v grace first", elapsed, grace)
	}
}
