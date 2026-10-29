// Package shellenv resolves the environment the bridge runs commands with: the
// user's login shell environment, as a terminal would have it, rather than the
// bridge's own, which a desktop launcher leaves without the user's PATH
// additions (mise, asdf, ~/.local/bin...).
package shellenv

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
)

// DefaultTimeout bounds each attempt at running the user's shell.
const DefaultTimeout = 5 * time.Second

// Where an Env came from.
const (
	// SourceInteractive is `$SHELL -ilc`, an interactive login shell.
	SourceInteractive = "interactive"
	// SourceLogin is `$SHELL -lc`, used when the interactive shell fails.
	SourceLogin = "login"
	// SourceBridge is the bridge's own environment, used when there is no
	// shell to ask (native Windows) or both attempts fail.
	SourceBridge = "bridge"
)

// Env is a resolved environment.
type Env struct {
	Source string
	vars   []string
}

// Resolve asks shell for its environment with `-ilc 'env -0'`, then `-lc`,
// giving each attempt timeout, and falls back to own. An empty shell means
// there is none to ask. Cancelling ctx stops the attempt in flight.
func Resolve(ctx context.Context, shell string, own []string, timeout time.Duration) Env {
	if shell != "" {
		for _, attempt := range []struct{ flags, source string }{{"-ilc", SourceInteractive}, {"-lc", SourceLogin}} {
			if vars, err := fromShell(ctx, shell, attempt.flags, own, timeout); err == nil {
				return Env{Source: attempt.source, vars: vars}
			}
		}
	}
	return Env{Source: SourceBridge, vars: append([]string(nil), own...)}
}

// fromShell runs `env -0` in shell between two markers, so whatever the
// user's profile prints around it is ignored.
func fromShell(ctx context.Context, shell, flags string, own []string, timeout time.Duration) ([]string, error) {
	mark := make([]byte, 8)
	if _, err := rand.Read(mark); err != nil {
		return nil, err
	}
	marker := "__LOOM_ENV_" + hex.EncodeToString(mark) + "__"
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, flags, "printf '%s' "+marker+"; env -0; printf '%s' "+marker)
	cmd.Env = own
	proc.Isolate(cmd)
	// Profile scripts may leave background jobs holding stdout open.
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	start := bytes.Index(out, []byte(marker))
	end := bytes.LastIndex(out, []byte(marker))
	if start < 0 || end <= start {
		return nil, errors.New("shell printed no environment")
	}
	var vars []string
	for _, entry := range strings.Split(string(out[start+len(marker):end]), "\x00") {
		if i := strings.IndexByte(entry, '='); i > 0 {
			vars = append(vars, entry)
		}
	}
	if len(vars) == 0 {
		return nil, errors.New("shell printed an empty environment")
	}
	return vars, nil
}

// ForTools is the environment for agents, git and the Forge CLIs: PATH has
// its /mnt/* entries removed, which in WSL are the Windows PATH, slow to
// search and holding Windows builds of the same tools.
func (e Env) ForTools() []string {
	out := make([]string, 0, len(e.vars))
	for _, entry := range e.vars {
		if name, value, _ := strings.Cut(entry, "="); sameName(name, "PATH") {
			entry = name + "=" + stripMnt(value)
		}
		out = append(out, entry)
	}
	return out
}

// LookPath finds name on the PATH of ForTools, the way a shell would.
func (e Env) LookPath(name string) (string, error) {
	exts := []string{""}
	if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
		exts = strings.Split(strings.ToLower(e.get("PATHEXT")), string(os.PathListSeparator))
		if e.get("PATHEXT") == "" {
			exts = []string{".com", ".exe", ".bat", ".cmd"}
		}
	}
	if strings.ContainsAny(name, `/\`) {
		return firstExecutable([]string{name}, exts)
	}
	var candidates []string
	for _, dir := range filepath.SplitList(stripMnt(e.get("PATH"))) {
		if dir != "" {
			candidates = append(candidates, filepath.Join(dir, name))
		}
	}
	return firstExecutable(candidates, exts)
}

// get is the value of the variable key, compared as Windows does on Windows.
func (e Env) get(key string) string {
	for _, entry := range e.vars {
		name, value, _ := strings.Cut(entry, "=")
		if sameName(name, key) {
			return value
		}
	}
	return ""
}

func firstExecutable(candidates, exts []string) (string, error) {
	for _, candidate := range candidates {
		for _, ext := range exts {
			info, err := os.Stat(candidate + ext)
			if err != nil || info.IsDir() {
				continue
			}
			if runtime.GOOS == "windows" || info.Mode()&0o111 != 0 {
				return candidate + ext, nil
			}
		}
	}
	return "", exec.ErrNotFound
}

// sameName compares variable names the way the OS does: case-insensitively on
// Windows.
func sameName(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func stripMnt(path string) string {
	sep := string(os.PathListSeparator)
	var kept []string
	for _, dir := range strings.Split(path, sep) {
		if dir != "/mnt" && !strings.HasPrefix(dir, "/mnt/") {
			kept = append(kept, dir)
		}
	}
	return strings.Join(kept, sep)
}
