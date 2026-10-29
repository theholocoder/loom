package protocol

import (
	"sync"

	"github.com/theholocoder/loom/bridge/shellenv"
)

type environmentResult struct {
	// Source is where the environment came from: "interactive", "login" or
	// "bridge" (see shellenv).
	Source string `json:"source"`
}

// environment holds the Environment's resolved shell environment. It is
// resolved once in the background when the bridge starts, and again on
// reload; commands started after a reload get the new one, and those already
// running keep theirs.
type environment struct {
	host  Host
	ready chan struct{}
	mu    sync.Mutex
	env   shellenv.Env
}

func newEnvironment(host Host) *environment {
	if host.ShellTimeout == 0 {
		host.ShellTimeout = shellenv.DefaultTimeout
	}
	e := &environment{host: host, ready: make(chan struct{})}
	go func() {
		e.set(e.resolve())
		close(e.ready)
	}()
	return e
}

// get waits for the first resolution and returns the current environment.
func (e *environment) get() shellenv.Env {
	<-e.ready
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.env
}

// reload re-resolves the environment and makes it the current one.
func (e *environment) reload() shellenv.Env {
	env := e.resolve()
	<-e.ready
	e.set(env)
	return env
}

func (e *environment) resolve() shellenv.Env {
	return shellenv.Resolve(e.host.Shell, e.host.Environ, e.host.ShellTimeout)
}

func (e *environment) set(env shellenv.Env) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.env = env
}
