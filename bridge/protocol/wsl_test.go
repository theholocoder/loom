//go:build !windows

package protocol_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/theholocoder/loom/bridge/protocol"
)

// fakeWSL writes a stand-in for wsl.exe on Linux: `-l -q` prints listing, and
// `-d <distro> --exec <command…>` runs the command for the distro `distro`
// with home as its HOME, its stdin first piped through filter (`cat` to pass
// it as it is). It refuses any other command line, as a wsl.exe would fail it.
func fakeWSL(t *testing.T, distro, home, filter string, listing []byte) string {
	t.Helper()
	dir := t.TempDir()
	write(t, filepath.Join(dir, "listing"), string(listing), 0o644)
	script := `#!/bin/sh
if [ "$1" = -l ] && [ "$2" = -q ] && [ $# -eq 2 ]; then exec cat "` + filepath.Join(dir, "listing") + `"; fi
if [ "$1" != -d ] || [ "$2" != "` + distro + `" ] || [ "$3" != --exec ]; then echo "wsl: bad command line: $*" >&2; exit 1; fi
shift 3
export HOME="` + home + `"
` + filter + ` | "$@"
`
	path := filepath.Join(dir, "wsl.exe")
	write(t, path, script, 0o755)
	return path
}

// utf16LE is s as wsl.exe writes its own output without WSL_UTF8.
func utf16LE(s string) []byte {
	var out []byte
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func distroNames(t *testing.T, result map[string]any) []string {
	t.Helper()
	var names []string
	for _, d := range result["distros"].([]any) {
		names = append(names, d.(map[string]any)["name"].(string))
	}
	return names
}

func TestWSLListNamesTheInstalledDistrosButDockersOwn(t *testing.T) {
	for name, listing := range map[string][]byte{
		"UTF-8":    []byte("Ubuntu-24.04\r\ndocker-desktop\r\nDebian\r\n\r\n"),
		"UTF-16LE": append([]byte{0xff, 0xfe}, utf16LE("Ubuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n")...),
	} {
		t.Run(name, func(t *testing.T) {
			p := startBridgeOn(t, protocol.Machine{WSL: fakeWSL(t, "Ubuntu-24.04", t.TempDir(), "cat", listing)})

			got := distroNames(t, p.call(1, "wsl.list", nil))

			if strings.Join(got, ",") != "Ubuntu-24.04,Debian" {
				t.Fatalf("wsl.list = %v, want [Ubuntu-24.04 Debian]", got)
			}
		})
	}
}

func TestWSLListIsEmptyWhereThereIsNoWSL(t *testing.T) {
	p := startBridge(t)

	if got := p.call(1, "wsl.list", nil)["distros"].([]any); len(got) != 0 {
		t.Fatalf("wsl.list = %v, want none", got)
	}
}

func TestWSLInstallStreamsTheBridgeIntoTheDistrosHomeAndPrunesOlderVersions(t *testing.T) {
	home := t.TempDir()
	binary := filepath.Join(t.TempDir(), "loom-bridge-linux-x64")
	write(t, binary, "#!/bin/sh\necho the bridge\n", 0o644)
	bridges := filepath.Join(home, ".local", "share", "loom", "bridge")
	write(t, filepath.Join(bridges, "1.0.0", "loom-bridge"), "old", 0o755)
	write(t, filepath.Join(home, ".local", "share", "loom", "other"), "kept", 0o644)
	p := startBridgeOn(t, protocol.Machine{WSL: fakeWSL(t, "Ubuntu", home, "cat", nil)})

	result := p.call(1, "wsl.install", map[string]any{"distro": "Ubuntu", "version": "1.2.3", "binary": binary})

	installed := filepath.Join(bridges, "1.2.3", "loom-bridge")
	if result["path"] != installed {
		t.Fatalf("wsl.install path = %v, want %s", result["path"], installed)
	}
	data, err := os.ReadFile(installed)
	if err != nil || string(data) != "#!/bin/sh\necho the bridge\n" {
		t.Fatalf("installed bridge = %q (%v)", data, err)
	}
	if info, _ := os.Stat(installed); info.Mode()&0o111 == 0 {
		t.Fatalf("installed bridge mode = %v, want executable", info.Mode())
	}
	entries, _ := os.ReadDir(bridges)
	if len(entries) != 1 || entries[0].Name() != "1.2.3" {
		t.Fatalf("bridge versions left = %v, want only 1.2.3", entries)
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "share", "loom", "other")); err != nil {
		t.Fatalf("pruning reached beyond the bridge's folder: %v", err)
	}
}

func TestWSLInstallRefusesABinaryThatArrivedChangedAndKeepsTheInstalledOne(t *testing.T) {
	home := t.TempDir()
	binary := filepath.Join(t.TempDir(), "loom-bridge-linux-x64")
	write(t, binary, "a binary", 0o644)
	bridges := filepath.Join(home, ".local", "share", "loom", "bridge")
	write(t, filepath.Join(bridges, "1.0.0", "loom-bridge"), "old", 0o755)
	// The stream is damaged on its way into the distro.
	p := startBridgeOn(t, protocol.Machine{WSL: fakeWSL(t, "Ubuntu", home, "tr a b", nil)})

	p.send(map[string]any{"id": 1, "method": "wsl.install", "params": map[string]any{"distro": "Ubuntu", "version": "1.2.3", "binary": binary}})
	reply := p.response(1)

	if reply["error"] == nil {
		t.Fatalf("wsl.install = %v, want an error", reply)
	}
	if _, err := os.Stat(filepath.Join(bridges, "1.2.3", "loom-bridge")); !os.IsNotExist(err) {
		t.Fatalf("a damaged bridge was installed: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(bridges, "1.0.0", "loom-bridge")); string(data) != "old" {
		t.Fatalf("the installed bridge went: %q", data)
	}
}

func TestWSLInstallRefusesAVersionThatIsNotOne(t *testing.T) {
	home := t.TempDir()
	binary := filepath.Join(t.TempDir(), "loom-bridge-linux-x64")
	write(t, binary, "a binary", 0o644)
	p := startBridgeOn(t, protocol.Machine{WSL: fakeWSL(t, "Ubuntu", home, "cat", nil)})

	p.send(map[string]any{"id": 1, "method": "wsl.install", "params": map[string]any{"distro": "Ubuntu", "version": "../../evil", "binary": binary}})
	reply := p.response(1)

	if e, _ := reply["error"].(map[string]any); e == nil || e["code"] != "bad_params" {
		t.Fatalf("wsl.install = %v, want bad_params", reply)
	}
}
