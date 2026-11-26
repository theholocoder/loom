package protocol

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// On native Windows, the bridge is also how main reaches WSL: it lists the
// distros, and installs the Linux bridge into one, so that the distro's own
// bridge can then be started with `wsl.exe -d <distro> --exec` (ADR 0008).

// wslListTimeout bounds `wsl.exe -l -q`, which hangs when the LXSS service
// is wedged (a distro's first run, a pending Windows update).
const wslListTimeout = 20 * time.Second

// defaultWSLInstallTimeout bounds an install whose request doesn't say
// otherwise: it may have to start the distro first.
const defaultWSLInstallTimeout = 2 * time.Minute

// dockerDistro matches the distros Docker Desktop keeps for itself, which
// hold no one's checkouts.
var dockerDistro = regexp.MustCompile(`^docker-desktop(-data)?$`)

// bridgeVersion is what a version must look like to name a folder.
var bridgeVersion = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]*$`)

// installScript runs inside the distro as `sh -c installScript sh <version>
// <sha256>`, the binary on its stdin. It writes the binary beside its place,
// checks it, moves it in, prunes every other version and prints where it is.
// A binary that doesn't check out is removed, and the versions kept.
const installScript = `set -e
root="$HOME/.local/share/loom/bridge"
dir="$root/$1"
mkdir -p "$dir"
tmp="$dir/loom-bridge.$$.tmp"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$tmp"); else sum=$(shasum -a 256 "$tmp"); fi
sum=${sum%% *}
if [ "$sum" != "$2" ]; then echo "loom-bridge arrived changed (SHA-256 $sum, want $2)" >&2; exit 1; fi
chmod 755 "$tmp"
mv -f "$tmp" "$dir/loom-bridge"
for old in "$root"/*; do
  if [ "$old" != "$dir" ] && [ -e "$old" ]; then rm -rf "$old"; fi
done
printf '%s\n' "$dir/loom-bridge"
`

type wslDistro struct {
	Name string `json:"name"`
}

type wslListResult struct {
	// WSL is wsl.exe's path, which main starts distros' bridges with; empty
	// where there is no WSL.
	WSL     string      `json:"wsl,omitempty"`
	Distros []wslDistro `json:"distros"`
}

type wslInstallParams struct {
	Distro string `json:"distro"`
	// Version names the folder the bridge goes in: the Client's.
	Version string `json:"version"`
	// Binary is the Linux bridge's path on this machine.
	Binary    string `json:"binary"`
	TimeoutMs int    `json:"timeoutMs"`
}

type wslInstallResult struct {
	// Path is where the bridge is in the distro.
	Path string `json:"path"`
}

// wslCommand is wsl.exe run with args, its own messages in UTF-8 where it
// knows WSL_UTF8.
func (s *server) wslCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, s.wsl, args...)
	cmd.Env = append(append([]string{}, s.environ...), "WSL_UTF8=1")
	cmd.WaitDelay = time.Second
	return cmd
}

// listWSL lists the WSL distros installed, but Docker Desktop's own; none
// where there is no WSL.
func (s *server) listWSL(ctx context.Context) (*wslListResult, *Error) {
	result := &wslListResult{Distros: []wslDistro{}}
	if s.wsl == "" {
		return result, nil
	}
	result.WSL = s.wsl
	ctx, cancel := context.WithTimeout(ctx, wslListTimeout)
	defer cancel()
	cmd := s.wslCommand(ctx, "-l", "-q")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &Error{Code: "timeout", Message: fmt.Sprintf("wsl.exe did not list its distros within %v", wslListTimeout)}
	}
	if err != nil {
		// With no distro installed, wsl.exe -l fails; with no wsl.exe, WSL
		// isn't installed: either way, there is none to list.
		return result, nil
	}
	for _, line := range strings.Split(decodeWSLOutput(out), "\n") {
		name := strings.TrimSpace(line)
		if name != "" && !dockerDistro.MatchString(name) {
			result.Distros = append(result.Distros, wslDistro{Name: name})
		}
	}
	return result, nil
}

// decodeWSLOutput is what wsl.exe printed of its own, as text: UTF-16LE,
// unless it took WSL_UTF8 and wrote UTF-8.
func decodeWSLOutput(out []byte) string {
	out = bytes.TrimPrefix(out, []byte{0xef, 0xbb, 0xbf})
	utf16le := bytes.HasPrefix(out, []byte{0xff, 0xfe})
	// Text in UTF-16LE has a NUL as every other byte, which UTF-8 text never has.
	if !utf16le && len(out) >= 2 && out[1] == 0 {
		utf16le = true
	}
	if !utf16le {
		return string(out)
	}
	out = bytes.TrimPrefix(out, []byte{0xff, 0xfe})
	units := make([]uint16, len(out)/2)
	for i := range units {
		units[i] = uint16(out[2*i]) | uint16(out[2*i+1])<<8
	}
	return string(utf16.Decode(units))
}

// installWSL streams the Linux bridge at params.Binary into the distro's
// ~/.local/share/loom/bridge/<version>/, checked there by SHA-256, and prunes
// every other version.
func (s *server) installWSL(ctx context.Context, params wslInstallParams) (*wslInstallResult, *Error) {
	if s.wsl == "" {
		return nil, &Error{Code: "not_found", Message: "WSL is not installed"}
	}
	if params.Distro == "" || params.Binary == "" || !bridgeVersion.MatchString(params.Version) {
		return nil, &Error{Code: "bad_params", Message: "wsl.install needs a distro, a binary and a version"}
	}
	data, err := os.ReadFile(params.Binary)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("the Linux bridge can't be read: %v", err)}
	}
	sum := sha256.Sum256(data)
	timeout := defaultWSLInstallTimeout
	if params.TimeoutMs > 0 {
		timeout = time.Duration(params.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := s.wslCommand(ctx, "-d", params.Distro, "--exec", "/bin/sh", "-c", installScript, "sh", params.Version, hex.EncodeToString(sum[:]))
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr cappedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &Error{Code: "timeout", Message: fmt.Sprintf("installing loom-bridge in %s did not finish within %v", params.Distro, timeout)}
	}
	if err != nil {
		said := strings.TrimSpace(decodeWSLOutput(stderr.Bytes()))
		if said == "" {
			said = err.Error()
		}
		return nil, &Error{Code: "install_failed", Message: fmt.Sprintf("installing loom-bridge in %s failed: %s", params.Distro, said)}
	}
	return &wslInstallResult{Path: strings.TrimSpace(stdout.String())}, nil
}
