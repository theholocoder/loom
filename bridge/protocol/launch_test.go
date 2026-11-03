package protocol_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

// launchHelper asks the bridge to launch this test binary as the helper
// named mode, in cwd, and returns the result.
func (p *peer) launchHelper(id int, mode, cwd, record string) map[string]any {
	p.t.Helper()
	self, err := os.Executable()
	if err != nil {
		p.t.Fatal(err)
	}
	return p.call(id, "launch", map[string]any{
		"command": self,
		"cwd":     cwd,
		"env":     map[string]string{helperEnv: mode, "LOOM_RECORD": record},
	})
}

// recorded waits for the record helper's file and returns its two lines.
func recorded(t *testing.T, file string) (cwd, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(file); err == nil {
			cwd, path, _ = strings.Cut(string(data), "\n")
			return cwd, path
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the launched program never wrote %s", file)
	return "", ""
}

func TestALaunchedProgramRunsInTheGivenFolder(t *testing.T) {
	p := startBridge(t)
	folder := t.TempDir()
	record := filepath.Join(t.TempDir(), "record")

	p.launchHelper(1, "record", folder, record)

	cwd, _ := recorded(t, record)
	if want, _ := filepath.EvalSymlinks(folder); cwd != folder && cwd != want {
		t.Errorf("cwd = %q, want %q", cwd, folder)
	}
}

func TestLaunchRepliesWithoutWaitingForTheProgram(t *testing.T) {
	p := startBridge(t)

	started := time.Now()
	// The helper outlives the test, so it runs somewhere never deleted.
	p.launchHelper(1, "hang", os.TempDir(), "")

	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("launch took %v, want a reply once the program started", elapsed)
	}
}

func TestALaunchedProgramKeepsTheFullPath(t *testing.T) {
	shell := fakeShell(t, `PATH="/mnt/c/Windows:$PATH" exec /bin/sh -c "$2"`)
	p := startBridgeOn(t, protocol.Machine{Shell: shell, Environ: []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent"}})
	record := filepath.Join(t.TempDir(), "record")

	p.launchHelper(1, "record", t.TempDir(), record)

	if _, path := recorded(t, record); !strings.HasPrefix(path, "/mnt/c/Windows:") {
		t.Errorf("PATH = %q, want it to keep /mnt/c/Windows", path)
	}
}

func TestLaunchingAProgramNotOnThePathIsNotFound(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "launch", "params": map[string]any{"command": "no-such-loom-editor", "cwd": t.TempDir()}})
	reply := p.response(1)

	if e, _ := reply["error"].(map[string]any); e["code"] != "not_found" {
		t.Errorf("launch replied %v, want a not_found error", reply)
	}
}
