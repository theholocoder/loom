package protocol_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/protocol"
)

func sha(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func (p *peer) errorOf(id int, method string, params any) map[string]any {
	p.t.Helper()
	p.send(map[string]any{"id": id, "method": method, "params": params})
	errObj, ok := p.response(float64(id))["error"].(map[string]any)
	if !ok {
		p.t.Fatalf("%s succeeded, want an error", method)
	}
	return errObj
}

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".loom-write-*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestAnUploadInChunksLandsTheFileWholeOnceItsHashChecksOut(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "7", "abc", "dump.bin")
	content := "first chunk|second chunk|third"
	p := startBridge(t)

	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": len(content), "sha256": sha(content)})
	if begun["present"] != false {
		t.Fatalf("begin = %v, want present false", begun)
	}
	upload := begun["upload"]
	for i, part := range []struct {
		offset int
		data   string
	}{{0, "first chunk|"}, {12, "second chunk|"}, {25, "third"}} {
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatalf("the file is at its place before the upload ends: %v", err)
		}
		p.call(2+i, "files.upload.chunk", map[string]any{"upload": upload, "offset": part.offset, "data": []byte(part.data)})
	}
	p.call(5, "files.upload.end", map[string]any{"upload": upload})

	got, err := os.ReadFile(target)
	if err != nil || string(got) != content {
		t.Fatalf("uploaded file = %q, %v; want %q", got, err, content)
	}
	if info, _ := os.Stat(target); runtime.GOOS != "windows" && info.Mode().Perm() != 0o644 {
		t.Errorf("uploaded file mode = %v, want 0644", info.Mode().Perm())
	}
	if left := leftovers(t, filepath.Dir(target)); len(left) != 0 {
		t.Errorf("upload left %v behind", left)
	}
}

func TestAnUploadOfAFileAlreadyThereSendsNothing(t *testing.T) {
	target := filepath.Join(t.TempDir(), "notes.md")
	write(t, target, "# Plan\n", 0o644)
	p := startBridge(t)

	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": 7, "sha256": sha("# Plan\n")})

	if begun["present"] != true {
		t.Fatalf("begin = %v, want present true", begun)
	}
	if left := leftovers(t, filepath.Dir(target)); len(left) != 0 {
		t.Errorf("begin left %v behind", left)
	}
}

func TestAnUploadReplacesAFileThatDiffers(t *testing.T) {
	target := filepath.Join(t.TempDir(), "notes.md")
	write(t, target, "edited by the agent", 0o644)
	p := startBridge(t)

	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": 7, "sha256": sha("# Plan\n")})
	p.call(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("# Plan\n")})
	p.call(3, "files.upload.end", map[string]any{"upload": begun["upload"]})

	if got, _ := os.ReadFile(target); string(got) != "# Plan\n" {
		t.Fatalf("file = %q, want the upload", got)
	}
}

func TestAChunkOutOfOrderIsRefused(t *testing.T) {
	target := filepath.Join(t.TempDir(), "a.txt")
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": 6, "sha256": sha("abcdef")})

	errObj := p.errorOf(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 3, "data": []byte("def")})

	if errObj["code"] != "bad_offset" {
		t.Fatalf("error = %v, want bad_offset", errObj)
	}
}

func TestAChunkPastTheSizeIsRefused(t *testing.T) {
	target := filepath.Join(t.TempDir(), "a.txt")
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": 2, "sha256": sha("ab")})

	errObj := p.errorOf(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("abc")})

	if errObj["code"] != "too_large" {
		t.Fatalf("error = %v, want too_large", errObj)
	}
}

func TestAnUploadWhoseHashDiffersLeavesNothing(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "a.txt")
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": target, "size": 3, "sha256": sha("abc")})
	p.call(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("abd")})

	errObj := p.errorOf(3, "files.upload.end", map[string]any{"upload": begun["upload"]})

	if errObj["code"] != "hash_mismatch" {
		t.Fatalf("error = %v, want hash_mismatch", errObj)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Errorf("a file is at %s: %v", target, err)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("upload left %v behind", left)
	}
}

func TestAnUploadCutShortIsRefusedAtItsEnd(t *testing.T) {
	dir := t.TempDir()
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": filepath.Join(dir, "a.txt"), "size": 3, "sha256": sha("abc")})
	p.call(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("ab")})

	errObj := p.errorOf(3, "files.upload.end", map[string]any{"upload": begun["upload"]})

	if errObj["code"] != "incomplete" {
		t.Fatalf("error = %v, want incomplete", errObj)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("upload left %v behind", left)
	}
}

func TestAnAbortedUploadLeavesNothingAndIsGone(t *testing.T) {
	dir := t.TempDir()
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": filepath.Join(dir, "a.txt"), "size": 3, "sha256": sha("abc")})
	p.call(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("a")})

	p.call(3, "files.upload.abort", map[string]any{"upload": begun["upload"]})

	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("abort left %v behind", left)
	}
	if errObj := p.errorOf(4, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 1, "data": []byte("b")}); errObj["code"] != "unknown_upload" {
		t.Fatalf("error = %v, want unknown_upload", errObj)
	}
}

func TestUploadsStillOpenAreRemovedWhenStdinCloses(t *testing.T) {
	dir := t.TempDir()
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": filepath.Join(dir, "a.txt"), "size": 3, "sha256": sha("abc")})
	p.call(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("a")})

	p.stdin.Close()
	if err := p.waitExit(); err != nil {
		t.Fatal(err)
	}

	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("the bridge left %v behind", left)
	}
}

func TestAnUploadLeftIdleIsRemoved(t *testing.T) {
	defer protocol.SetUploadIdleTimeout(50 * time.Millisecond)()
	dir := t.TempDir()
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": filepath.Join(dir, "a.txt"), "size": 3, "sha256": sha("abc")})

	deadline := time.Now().Add(5 * time.Second)
	for len(leftovers(t, dir)) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the idle upload was never removed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if errObj := p.errorOf(2, "files.upload.chunk", map[string]any{"upload": begun["upload"], "offset": 0, "data": []byte("a")}); errObj["code"] != "unknown_upload" {
		t.Fatalf("error = %v, want unknown_upload", errObj)
	}
}

func TestPingsAreAnsweredBetweenTheChunksOfAnUpload(t *testing.T) {
	chunk := strings.Repeat("x", 1<<20)
	p := startBridge(t)
	begun := p.call(1, "files.upload.begin", map[string]any{"path": filepath.Join(t.TempDir(), "big.bin"), "size": 4 << 20, "sha256": sha(strings.Repeat(chunk, 4))})

	for i := range 4 {
		p.send(map[string]any{"id": 10 + i, "method": "files.upload.chunk", "params": map[string]any{"upload": begun["upload"], "offset": i << 20, "data": []byte(chunk)}})
		p.send(map[string]any{"id": 20 + i, "method": "ping"})
		start := time.Now()
		if _, ok := p.response(float64(20 + i))["result"]; !ok {
			t.Fatalf("ping %d was not answered", i)
		}
		if waited := time.Since(start); waited > 2*time.Second {
			t.Fatalf("ping %d took %v", i, waited)
		}
		p.response(float64(10 + i))
	}
	p.call(30, "files.upload.end", map[string]any{"upload": begun["upload"]})
}

func TestFilesCopyToPutsAFileInPlaceReplacingWhatWasThere(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "store", "abc.log")
	to := filepath.Join(dir, "env", "7", "abc", "crash.log")
	write(t, from, "panic\n", 0o600)
	write(t, to, "edited", 0o644)
	p := startBridge(t)

	result := p.call(1, "files.copyTo", map[string]any{"from": from, "to": to, "size": 6, "sha256": sha("panic\n")})

	if result["present"] != false {
		t.Fatalf("copyTo = %v, want present false", result)
	}
	if got, _ := os.ReadFile(to); string(got) != "panic\n" {
		t.Fatalf("copy = %q, want panic", got)
	}
	if info, _ := os.Stat(to); runtime.GOOS != "windows" && info.Mode().Perm() != 0o644 {
		t.Errorf("copy mode = %v, want 0644", info.Mode().Perm())
	}
	if left := leftovers(t, filepath.Dir(to)); len(left) != 0 {
		t.Errorf("copyTo left %v behind", left)
	}
}

func TestFilesCopyToLeavesAFileAlreadyThere(t *testing.T) {
	dir := t.TempDir()
	to := filepath.Join(dir, "crash.log")
	write(t, to, "panic\n", 0o644)
	p := startBridge(t)

	result := p.call(1, "files.copyTo", map[string]any{"from": filepath.Join(dir, "missing"), "to": to, "size": 6, "sha256": sha("panic\n")})

	if result["present"] != true {
		t.Fatalf("copyTo = %v, want present true", result)
	}
}

func TestFilesRemoveTakesAFolderAndAllInIt(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "7", "abc", "a.txt"), "a", 0o644)
	p := startBridge(t)

	p.call(1, "files.remove", map[string]any{"path": filepath.Join(dir, "7")})
	p.call(2, "files.remove", map[string]any{"path": filepath.Join(dir, "7")})

	if _, err := os.Stat(filepath.Join(dir, "7")); !os.IsNotExist(err) {
		t.Fatalf("folder still there: %v", err)
	}
}
