package protocol_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

// fakeShell writes a stand-in for the user's login shell. Loom runs it as
// `$SHELL -ilc <command>`, then `$SHELL -lc <command>`; the script body sees
// the flags as $1 and the command as $2.
func fakeShell(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("native Windows has no login shell; the bridge uses its own environment")
	}
	path := filepath.Join(t.TempDir(), "fake-shell")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// run asks the bridge to run a command in the Environment and returns its
// result, failing the test on an error reply.
func (p *peer) run(id int, command string, args ...string) map[string]any {
	p.t.Helper()
	p.send(map[string]any{"id": id, "method": "exec", "params": map[string]any{"command": command, "args": args}})
	reply := p.receive()
	result, ok := reply["result"].(map[string]any)
	if !ok {
		p.t.Fatalf("exec %s replied %v", command, reply)
	}
	return result
}

func (p *peer) environment(id int, method string) map[string]any {
	p.t.Helper()
	p.send(map[string]any{"id": id, "method": method})
	reply := p.receive()
	result, ok := reply["result"].(map[string]any)
	if !ok {
		p.t.Fatalf("%s replied %v", method, reply)
	}
	return result
}

// A desktop launcher's environment: no shell PATH additions, no FOO.
var launcherEnv = []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent"}

func TestCommandsRunWithTheInteractiveLoginShellsEnvironment(t *testing.T) {
	shell := fakeShell(t, `[ "$1" = "-ilc" ] || exit 1
FOO=from-shell exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	if got := p.environment(1, "environment.get")["source"]; got != "interactive" {
		t.Errorf("environment source = %v, want interactive", got)
	}
	if got := p.run(2, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "from-shell" {
		t.Errorf("FOO = %q, want from-shell", got)
	}
}

func TestALoginShellIsUsedWhenTheInteractiveOneFails(t *testing.T) {
	shell := fakeShell(t, `[ "$1" = "-lc" ] || exit 1
FOO=from-login exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	if got := p.environment(1, "environment.get")["source"]; got != "login" {
		t.Errorf("environment source = %v, want login", got)
	}
	if got := p.run(2, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "from-login" {
		t.Errorf("FOO = %q, want from-login", got)
	}
}

func TestTheBridgesOwnEnvironmentIsUsedWhenTheShellFails(t *testing.T) {
	shell := fakeShell(t, `exit 1`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: append([]string{"FOO=from-bridge"}, launcherEnv...)})

	if got := p.environment(1, "environment.get")["source"]; got != "bridge" {
		t.Errorf("environment source = %v, want bridge", got)
	}
	if got := p.run(2, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "from-bridge" {
		t.Errorf("FOO = %q, want from-bridge", got)
	}
}

func TestAShellThatHangsTimesOutAndFallsBack(t *testing.T) {
	shell := fakeShell(t, `exec sleep 30`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv, ShellTimeout: 200 * time.Millisecond})

	started := time.Now()
	if got := p.environment(1, "environment.get")["source"]; got != "bridge" {
		t.Errorf("environment source = %v, want bridge", got)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Errorf("resolving took %v, want the two 200ms timeouts", elapsed)
	}
}

func TestProfileOutputAroundTheEnvironmentIsIgnored(t *testing.T) {
	shell := fakeShell(t, `echo "Welcome to the machine"
FOO=from-shell /bin/sh -c "$2"
echo "bye"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	if got := p.run(1, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "from-shell" {
		t.Errorf("FOO = %q, want from-shell", got)
	}
}

func TestMntEntriesAreStrippedFromThePathOfCommands(t *testing.T) {
	shell := fakeShell(t, `PATH="/mnt/c/Windows:/usr/bin:/mnt/c/Program Files/Git/bin:/bin" exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	if got := p.run(1, "sh", "-c", `printf %s "$PATH"`)["stdout"]; got != "/usr/bin:/bin" {
		t.Errorf("PATH = %q, want /usr/bin:/bin", got)
	}
}

func TestCommandsAreLookedUpOnTheShellsPath(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "hello"), []byte("#!/bin/sh\necho hi from $0 \"$@\"\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	shell := fakeShell(t, `PATH="`+bin+`:/usr/bin:/bin" exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	result := p.run(1, "hello", "there")

	if got := strings.TrimSpace(result["stdout"].(string)); got != "hi from "+filepath.Join(bin, "hello")+" there" {
		t.Errorf("stdout = %q", got)
	}
	if result["exitCode"] != float64(3) {
		t.Errorf("exitCode = %v, want 3", result["exitCode"])
	}
}

func TestACommandNotOnThePathIsANotFoundError(t *testing.T) {
	shell := fakeShell(t, `PATH=/usr/bin:/bin exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	p.send(map[string]any{"id": 1, "method": "exec", "params": map[string]any{"command": "no-such-loom-tool"}})

	errObj, ok := p.receive()["error"].(map[string]any)
	if !ok || errObj["code"] != "not_found" {
		t.Fatalf("reply error = %v, want not_found", errObj)
	}
}

func TestReloadReReadsTheShellEnvironment(t *testing.T) {
	dir := t.TempDir()
	value := filepath.Join(dir, "foo")
	if err := os.WriteFile(value, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	shell := fakeShell(t, `FOO="$(cat `+value+`)" exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})
	if got := p.run(1, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "before" {
		t.Fatalf("FOO = %q, want before", got)
	}

	if err := os.WriteFile(value, []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := p.run(2, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "before" {
		t.Errorf("FOO = %q before reload, want the environment read at start", got)
	}
	if got := p.environment(3, "environment.reload")["source"]; got != "interactive" {
		t.Errorf("reload source = %v, want interactive", got)
	}
	if got := p.run(4, "sh", "-c", `printf %s "$FOO"`)["stdout"]; got != "after" {
		t.Errorf("FOO = %q after reload, want after", got)
	}
}

func TestPingIsAnsweredWhileACommandRuns(t *testing.T) {
	shell := fakeShell(t, `exec /bin/sh -c "$2"`)
	p := startBridgeHost(t, protocol.Host{Shell: shell, Environ: launcherEnv})

	p.send(map[string]any{"id": 1, "method": "exec", "params": map[string]any{"command": "sleep", "args": []string{"2"}}})
	p.send(map[string]any{"id": 2, "method": "ping"})

	if reply := p.receive(); reply["id"] != float64(2) {
		t.Fatalf("first reply = %v, want the ping's", reply)
	}
}
