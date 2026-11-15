package protocol_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

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

func TestFilesCheckFolderTakesAFolderOrOneThatCouldBeMadeLeavingNothing(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "there", "file"), "x", 0o644)
	p := startBridge(t)

	p.call(1, "files.checkFolder", map[string]any{"path": filepath.Join(dir, "there")})
	p.call(2, "files.checkFolder", map[string]any{"path": filepath.Join(dir, "loom", "worktrees")})

	if _, err := os.Lstat(filepath.Join(dir, "loom")); !os.IsNotExist(err) {
		t.Fatalf("files.checkFolder left %s behind: %v", filepath.Join(dir, "loom"), err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "there", "file")); err != nil {
		t.Fatalf("files.checkFolder touched what was there: %v", err)
	}
}

func TestFilesCheckFolderUnderAFileIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "taken")
	write(t, path, "x", 0o644)
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "files.checkFolder", "params": map[string]any{"path": filepath.Join(path, "worktrees")}})

	errObj, ok := p.response(1)["error"].(map[string]any)
	if !ok || errObj["code"] != "not_a_folder" {
		t.Fatalf("reply error = %v, want not_a_folder", errObj)
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

func TestFilesWriteWritesAFileCreatingItsFolders(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "attachments", "7", "notes.txt")
	p := startBridge(t)

	// JSON carries bytes as base64: "aGVsbG8K" is "hello\n".
	p.call(1, "files.write", map[string]any{"path": path, "data": "aGVsbG8K"})

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello\n" {
		t.Fatalf("files.write wrote %q, want %q", got, "hello\n")
	}
}

func TestFilesWriteReplacesAFileAlreadyThere(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.txt")
	write(t, path, "old content", 0o644)
	p := startBridge(t)

	p.call(1, "files.write", map[string]any{"path": path, "data": "bmV3"})

	if got, _ := os.ReadFile(path); string(got) != "new" {
		t.Fatalf("files.write left %q, want %q", got, "new")
	}
}

func TestFilesWriteNeedsAPath(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "files.write", "params": map[string]any{"data": "eA=="}})

	if code := p.response(1)["error"].(map[string]any)["code"]; code != "bad_params" {
		t.Fatalf("files.write without a path: error %v, want bad_params", code)
	}
}

func TestFilesStatReadsEachPathsSizeAndTime(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "src", "a.txt"), "abc", 0o644)
	when := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, "src", "a.txt"), when, when); err != nil {
		t.Fatal(err)
	}
	p := startBridge(t)

	files := p.call(1, "files.stat", map[string]any{"root": dir, "paths": []string{"src/a.txt", "gone.txt", "../escape"}})["files"].([]any)

	if len(files) != 3 {
		t.Fatalf("files.stat gave %d entries, want 3", len(files))
	}
	first := files[0].(map[string]any)
	if first["size"] != float64(3) || first["mtimeNs"] != float64(when.UnixNano()) {
		t.Errorf("files.stat src/a.txt = %v, want size 3 and mtime %d", first, when.UnixNano())
	}
	if files[1] != nil || files[2] != nil {
		t.Errorf("files.stat of a missing path and one outside the root = %v, %v, want null", files[1], files[2])
	}
}

func TestFilesStatNeedsARoot(t *testing.T) {
	p := startBridge(t)

	p.send(map[string]any{"id": 1, "method": "files.stat", "params": map[string]any{"paths": []string{"a"}}})

	if code := p.response(1)["error"].(map[string]any)["code"]; code != "bad_params" {
		t.Fatalf("files.stat without a root: error %v, want bad_params", code)
	}
}
