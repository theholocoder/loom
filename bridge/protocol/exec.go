package protocol

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
	"github.com/theholocoder/loom/bridge/shellenv"
)

// defaultExecTimeout bounds a command whose request doesn't say otherwise.
const defaultExecTimeout = 30 * time.Second

// maxOutput bounds what is kept of a command's stdout and of its stderr.
const maxOutput = 1 << 20

type execParams struct {
	// Command is looked up on the Environment's PATH.
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	TimeoutMs int      `json:"timeoutMs"`
}

type execResult struct {
	// Path is where Command was found.
	Path     string `json:"path"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// runCommand runs a command to completion in env, with no stdin. A command
// not on the PATH is a not_found error; one that outlives its timeout is
// killed, with its process group, and is a timeout error.
func runCommand(ctx context.Context, env shellenv.Env, params execParams) (*execResult, *Error) {
	if params.Command == "" {
		return nil, &Error{Code: "bad_params", Message: "exec needs a command"}
	}
	path, err := env.LookPath(params.Command)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("%s is not on the PATH", params.Command)}
	}
	timeout := defaultExecTimeout
	if params.TimeoutMs > 0 {
		timeout = time.Duration(params.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, params.Args...)
	cmd.Env = env.ForTools()
	proc.Isolate(cmd)
	cmd.WaitDelay = time.Second
	stdout, stderr := &cappedBuffer{}, &cappedBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &Error{Code: "timeout", Message: fmt.Sprintf("%s did not finish within %v", params.Command, timeout)}
	}
	if ctx.Err() != nil {
		return nil, &Error{Code: "cancelled", Message: "the bridge is shutting down"}
	}
	var exit *exec.ExitError
	// ErrWaitDelay: the command exited, but something it started kept its
	// output open; what it printed before exiting still counts.
	if err != nil && !errors.As(err, &exit) && !errors.Is(err, exec.ErrWaitDelay) {
		return nil, &Error{Code: "exec_failed", Message: err.Error()}
	}
	return &execResult{Path: path, ExitCode: cmd.ProcessState.ExitCode(), Stdout: stdout.String(), Stderr: stderr.String()}, nil
}

// cappedBuffer keeps the first maxOutput bytes written to it and drops the
// rest, so a chatty command can't exhaust the bridge's memory.
type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := maxOutput - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
