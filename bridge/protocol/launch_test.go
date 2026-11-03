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
	return p.call(id, "launch", map[string]any{
		"command": detachedCopyOfTestBinary(p.t),
		"cwd":     cwd,
		"env":     map[string]string{helperEnv: mode, "LOOM_RECORD": record},
	})
}

// detachedCopyOfTestBinary copies this test binary into a folder of its own,
// so a launched helper that outlives the test never holds the build's exe
// (Windows can't delete a running one, which fails `go test` at the end).
func detachedCopyOfTestBinary(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(liveDir(t), filepath.Base(self))
	if err := os.WriteFile(copyPath, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return copyPath
}

// liveDir makes a folder a launched program may still be using as its cwd when
// the test ends. Windows can't delete such a folder, so removal retries and
// never fails the test (t.TempDir would).
func liveDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "loom-launch-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for i := 0; i < 50; i++ {
			if os.RemoveAll(dir) == nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
	return dir
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
	folder := liveDir(t)
	record := filepath.Join(t.TempDir(), "record")

	p.launchHelper(1, "record", folder, record)

	cwd, _ := recorded(t, record)
	if want, _ := filepath.EvalSymlinks(folder); cwd != folder && cwd != want {
		t.Errorf("cwd = %q, want %q", cwd, folder)
	}
}

func TestLaunchRepliesWithoutWaitingForTheProgram(t *testing.T) {
	p := startBridge(t)

	finished := filepath.Join(liveDir(t), "finished")
	// The helper outlives the test, so it runs somewhere never deleted.
	p.launchHelper(1, "linger", os.TempDir(), finished)

	// The reply is in, but the program is still sleeping: launch didn't wait.
	if _, err := os.Stat(finished); err == nil {
		t.Error("the program had already finished when launch replied; launch waited for it")
	}
}

func TestALaunchedProgramKeepsTheFullPath(t *testing.T) {
	shell := fakeShell(t, `PATH="/mnt/c/Windows:$PATH" exec /bin/sh -c "$2"`)
	p := startBridgeOn(t, protocol.Machine{Shell: shell, Environ: []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent"}})
	record := filepath.Join(t.TempDir(), "record")

	p.launchHelper(1, "record", liveDir(t), record)

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
