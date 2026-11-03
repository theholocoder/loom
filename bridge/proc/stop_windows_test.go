package proc

import (
	"os"
	"os/exec"
	"testing"
)

func TestStopAfterExitDoesNotKillByPID(t *testing.T) {
	killed := false
	defer func(old func(*exec.Cmd) error) { killTree = old }(killTree)
	killTree = func(*exec.Cmd) error { killed = true; return nil }

	group, err := Start(exec.Command(os.Args[0], "-test.run=^$"), DefaultGrace)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Wait(); err != nil {
		t.Fatal(err)
	}
	// Even without a Job Object (the fallback), a finished group is not killed.
	group.job = 0
	group.Stop()
	if killed {
		t.Fatal("Stop killed by PID after the command exited")
	}
}
