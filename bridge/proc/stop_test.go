package proc_test

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
)

// A Group whose command has exited must ignore Stop: its PID may already
// belong to an unrelated process.
func TestStopAfterTheCommandHasExitedDoesNothing(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	group, err := proc.Start(cmd, proc.DefaultGrace)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Wait(); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	go func() {
		group.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return")
	}
}
