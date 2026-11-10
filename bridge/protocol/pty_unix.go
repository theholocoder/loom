//go:build !windows

package protocol

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/theholocoder/loom/bridge/proc"
)

// startTerminal starts cmd as a new process group on a new pseudo-terminal of
// the given size, as its controlling terminal, and returns the terminal's
// master. The process's stderr goes to the terminal too.
func startTerminal(cmd *exec.Cmd, size terminalSize, grace time.Duration) (*os.File, *proc.Group, error) {
	master, tty, err := pty.Open()
	if err != nil {
		return nil, nil, err
	}
	if err := setTerminalSize(master, size); err != nil {
		_ = master.Close()
		_ = tty.Close()
		return nil, nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	// proc.Start adds Setsid; Setctty makes the tty (the child's fd 0) its
	// controlling terminal, so job control and Ctrl+C work.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setctty: true}
	group, err := proc.Start(cmd, grace)
	// The child has its own copy; the master reaches EOF once it is closed.
	_ = tty.Close()
	if err != nil {
		_ = master.Close()
		return nil, nil, err
	}
	return master, group, nil
}

func setTerminalSize(master *os.File, size terminalSize) error {
	return pty.Setsize(master, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)})
}
