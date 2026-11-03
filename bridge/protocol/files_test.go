package protocol_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/theholocoder/loom/bridge/protocol"
)

func write(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func TestTheHandshakeReportsTheUsersHome(t *testing.T) {
	p := startBridgeOn(t, protocol.Machine{Home: "/home/dev"})

	result := p.call(1, "handshake", nil)

	if result["home"] != "/home/dev" {
		t.Fatalf("handshake home = %v, want /home/dev", result["home"])
	}
}

func TestFilesExistSaysWhetherAPathIsTaken(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "taken", "file"), "x", 0o644)
	p := startBridge(t)

	for i, c := range []struct {
		path string
		want bool
	}{
		{filepath.Join(dir, "taken"), true},
		{filepath.Join(dir, "taken", "file"), true},
		{filepath.Join(dir, "free"), false},
	} {
		if got := p.call(i+1, "files.exists", map[string]any{"path": c.path})["exists"]; got != c.want {
			t.Errorf("files.exists %s = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestFilesCopyCopiesRelativePathsIntoAnotherFolder(t *testing.T) {
	from, to := t.TempDir(), t.TempDir()
	write(t, filepath.Join(from, ".env"), "SECRET=1\n", 0o600)
	write(t, filepath.Join(from, "config", "local", "settings.json"), "{}", 0o644)
	write(t, filepath.Join(from, "not-asked"), "no", 0o644)
	p := startBridge(t)

	result := p.call(1, "files.copy", map[string]any{"from": from, "to": to, "paths": []string{".env", "config/local/settings.json"}})

	if result["copied"] != float64(2) {
		t.Fatalf("copied = %v, want 2", result["copied"])
	}
	for path, want := range map[string]string{".env": "SECRET=1\n", "config/local/settings.json": "{}"} {
		got, err := os.ReadFile(filepath.Join(to, path))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q (%v), want %q", path, got, err, want)
		}
	}
	if _, err := os.Stat(filepath.Join(to, "not-asked")); !os.IsNotExist(err) {
		t.Errorf("a path not asked for was copied")
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(filepath.Join(to, ".env")); info.Mode().Perm() != 0o600 {
			t.Errorf(".env mode = %v, want 0600", info.Mode().Perm())
		}
	}
}

func TestFilesCopyRecreatesSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs privileges on Windows")
	}
	from, to := t.TempDir(), t.TempDir()
	if err := os.Symlink("../shared/.env", filepath.Join(from, ".env")); err != nil {
		t.Fatal(err)
	}
	p := startBridge(t)

	p.call(1, "files.copy", map[string]any{"from": from, "to": to, "paths": []string{".env"}})

	if target, err := os.Readlink(filepath.Join(to, ".env")); err != nil || target != "../shared/.env" {
		t.Fatalf("link = %q (%v), want ../shared/.env", target, err)
	}
}

func TestFilesCopyRefusesPathsOutsideItsFolders(t *testing.T) {
	from, to := t.TempDir(), t.TempDir()
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "files.copy", "params": map[string]any{"from": from, "to": to, "paths": []string{"../escape"}}})

	errObj, ok := p.response(1)["error"].(map[string]any)
	if !ok || errObj["code"] != "bad_params" {
		t.Fatalf("reply error = %v, want bad_params", errObj)
	}
}

func TestFilesCopyOfAMissingFileIsAnError(t *testing.T) {
	from, to := t.TempDir(), t.TempDir()
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "files.copy", "params": map[string]any{"from": from, "to": to, "paths": []string{"gone"}}})

	errObj, ok := p.response(1)["error"].(map[string]any)
	if !ok || errObj["code"] != "copy_failed" {
		t.Fatalf("reply error = %v, want copy_failed", errObj)
	}
}
