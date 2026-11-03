//go:build !windows

// Package proc starts the bridge's child processes in their own process group,
// so killing one also kills whatever it started.
package proc

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"time"
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

// Detach puts cmd in a new session, away from the bridge's terminal and
// process group, so that it outlives the bridge.
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// A Group is a long-lived command started in its own session and process
// group (setsid), with every process it starts: an agent and its tools.
type Group struct {
	cmd   *exec.Cmd
	pgid  int
	grace time.Duration
	// done is closed once Wait has seen the whole group gone.
	done chan struct{}

	mu       sync.Mutex
	stopping bool
	deadline time.Time
}

// Start starts cmd as a new Group. grace is how long Stop gives the group to
// exit after SIGTERM before it sends SIGKILL.
func Start(cmd *exec.Cmd, grace time.Duration) (*Group, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = waitDelay
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Group{cmd: cmd, pgid: cmd.Process.Pid, grace: grace, done: make(chan struct{})}, nil
}

// Stop sends SIGTERM to the group, and SIGKILL to whatever is left of it once
// the grace is up. It returns at once; Wait returns once the group is gone.
func (g *Group) Stop() {
	g.mu.Lock()
	if g.stopping {
		g.mu.Unlock()
		return
	}
	g.stopping = true
	g.deadline = time.Now().Add(g.grace)
	g.mu.Unlock()
	select {
	case <-g.done:
		return
	default:
	}
	_ = syscall.Kill(-g.pgid, syscall.SIGTERM)
	go func() {
		select {
		case <-g.done:
		case <-time.After(g.grace):
			_ = syscall.Kill(-g.pgid, syscall.SIGKILL)
		}
	}()
}

// Wait waits for the command to exit, then stops what it left running in
// its group the same way Stop does, and returns once the group is gone (or a
// moment after SIGKILL). It returns the command's error.
func (g *Group) Wait() error {
	err := g.cmd.Wait()
	if g.alive() {
		g.Stop()
		g.mu.Lock()
		deadline := g.deadline
		g.mu.Unlock()
		g.until(deadline)
		_ = syscall.Kill(-g.pgid, syscall.SIGKILL)
		g.until(time.Now().Add(time.Second))
	}
	close(g.done)
	return err
}

// until polls until the group is gone or the deadline passes.
func (g *Group) until(deadline time.Time) {
	for g.alive() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
}

// alive reports whether any process is left in the group.
func (g *Group) alive() bool {
	err := syscall.Kill(-g.pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
