// Package proc starts the bridge's child processes in their own process group,
// so killing one also kills whatever it started.
package proc

import (
	"os/exec"
	"strconv"
	"syscall"
)

// Isolate makes cancelling cmd's context kill cmd's whole process tree.
func Isolate(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return Kill(cmd) }
}

// Kill kills cmd's process tree. Until the bridge puts its children in a Job
// Object, it walks the tree with taskkill: tools installed through npm are
// .cmd shims, so killing only the process would leave its node child running.
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}

// Detach starts cmd in its own process group, so that it outlives the bridge
// and doesn't get the bridge's console signals.
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}
