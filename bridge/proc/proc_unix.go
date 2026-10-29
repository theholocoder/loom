//go:build !windows

// Package proc starts the bridge's child processes in their own process group,
// so killing one also kills whatever it started.
package proc

import (
	"os/exec"
	"syscall"
)

// Isolate puts cmd in a new session and process group, detached from any
// terminal, and makes cancelling its context kill the whole group.
func Isolate(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error { return Kill(cmd) }
}

// Kill sends SIGKILL to cmd's process group.
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
