// Package proc starts the bridge's child processes in their own process group,
// so killing one also kills whatever it started.
package proc

import "os/exec"

// Isolate is a no-op on Windows until the bridge puts its children in a Job
// Object: cancelling cmd's context kills only the process itself.
func Isolate(cmd *exec.Cmd) {}

// Kill kills cmd's process.
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
