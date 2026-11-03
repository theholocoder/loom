package protocol

import (
	"fmt"
	"os/exec"

	"github.com/theholocoder/loom/bridge/proc"
	"github.com/theholocoder/loom/bridge/shellenv"
)

type launchParams struct {
	// Command is looked up on the Environment's full PATH, /mnt/* included.
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
}

type launchResult struct {
	// Path is where Command was found.
	Path string `json:"path"`
}

// launch starts one of the user's own programs, like their editor or
// terminal, and replies once it has started, without waiting for it. It
// gets the full environment, PATH included, runs detached from the bridge
// and is left running when the bridge stops.
func launch(env shellenv.Env, params launchParams) (*launchResult, *Error) {
	if params.Command == "" {
		return nil, &Error{Code: "bad_params", Message: "launch needs a command"}
	}
	path, err := env.LookPathFull(params.Command)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("%s is not on the PATH", params.Command)}
	}
	cmd := exec.Command(path, params.Args...)
	cmd.Dir = params.Cwd
	cmd.Env = env.Full()
	// exec.Cmd keeps the last of duplicate variables, so these win.
	for name, value := range params.Env {
		cmd.Env = append(cmd.Env, name+"="+value)
	}
	proc.Detach(cmd)
	if err := cmd.Start(); err != nil {
		return nil, &Error{Code: "exec_failed", Message: err.Error()}
	}
	// Reaps it whenever it exits; nothing waits on the result.
	go func() { _ = cmd.Wait() }()
	return &launchResult{Path: path}, nil
}
