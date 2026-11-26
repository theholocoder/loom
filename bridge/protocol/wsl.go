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

const wslListTimeout = 20 * time.Second

const wslDistroTimeout = 2 * time.Minute

var dockerDistro = regexp.MustCompile(`^docker-desktop(-data)?$`)

var bridgeVersion = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]*$`)

const distroBridgePlace = `root="$HOME/.local/share/loom/bridge"
dir="$root/$1"
bridge="$dir/loom-bridge"
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then set -- $(sha256sum "$1")
  elif command -v shasum >/dev/null 2>&1; then set -- $(shasum -a 256 "$1")
  else echo "loom-bridge can't be checked: the distro has neither sha256sum nor shasum" >&2; return 1; fi
  printf '%s\n' "$1"
}
`

const findScript = distroBridgePlace + `printf '%s\n' "$bridge"
if [ -x "$bridge" ]; then sha256_of "$bridge"; fi
`

const installScript = distroBridgePlace + `set -e
mkdir -p "$dir"
tmp="$bridge.$$.tmp"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
sum=$(sha256_of "$tmp")
if [ "$sum" != "$2" ]; then echo "loom-bridge arrived changed (SHA-256 $sum, want $2)" >&2; exit 1; fi
chmod 755 "$tmp"
mv -f "$tmp" "$bridge"
for old in "$root"/*; do
  if [ "$old" != "$dir" ] && [ -e "$old" ]; then rm -rf "$old"; fi
done
printf '%s\n' "$bridge"
`

type wslDistro struct {
	Name string `json:"name"`
}

type wslListResult struct {
	WSL     string      `json:"wsl,omitempty"`
	Distros []wslDistro `json:"distros"`
}

type wslBridgeParams struct {
	Distro  string `json:"distro"`
	Version string `json:"version"`
	Binary  string `json:"binary"`
}

type wslBridgeResult struct {
	WSL     string `json:"wsl"`
	Path    string `json:"path"`
	Current bool   `json:"current"`
}

type linuxBridge struct {
	data   []byte
	sha256 string
}

func (s *server) wslCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, s.wsl, args...)
	cmd.Env = append(append([]string{}, s.environ...), "WSL_UTF8=1")
	cmd.WaitDelay = time.Second
	return cmd
}

func (s *server) listWSL(ctx context.Context) (*wslListResult, *Error) {
	result := &wslListResult{Distros: []wslDistro{}}
	if s.wsl == "" {
		return result, nil
	}
	result.WSL = s.wsl
	ctx, cancel := context.WithTimeout(ctx, wslListTimeout)
	defer cancel()
	out, err := s.wslCommand(ctx, "-l", "-q").Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &Error{Code: "timeout", Message: fmt.Sprintf("wsl.exe did not list its distros within %v", wslListTimeout)}
	}
	if err != nil {
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

func decodeWSLOutput(out []byte) string {
	out = bytes.TrimPrefix(out, []byte{0xef, 0xbb, 0xbf})
	utf16le := bytes.HasPrefix(out, []byte{0xff, 0xfe}) || (len(out) >= 2 && out[1] == 0)
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

func (s *server) readLinuxBridge(params wslBridgeParams) (*linuxBridge, *Error) {
	if s.wsl == "" {
		return nil, &Error{Code: "not_found", Message: "WSL is not installed"}
	}
	if params.Distro == "" || params.Binary == "" || !bridgeVersion.MatchString(params.Version) {
		return nil, &Error{Code: "bad_params", Message: "a distro, a binary and a version are needed"}
	}
	data, err := os.ReadFile(params.Binary)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("the Linux bridge can't be read: %v", err)}
	}
	sum := sha256.Sum256(data)
	return &linuxBridge{data: data, sha256: hex.EncodeToString(sum[:])}, nil
}

func (s *server) findWSLBridge(ctx context.Context, params wslBridgeParams) (*wslBridgeResult, *Error) {
	linux, e := s.readLinuxBridge(params)
	if e != nil {
		return nil, e
	}
	out, e := s.runInDistro(ctx, "finding loom-bridge", params.Distro, findScript, nil, params.Version)
	if e != nil {
		return nil, e
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	current := len(lines) == 2 && strings.TrimSpace(lines[1]) == linux.sha256
	return &wslBridgeResult{WSL: s.wsl, Path: strings.TrimSpace(lines[0]), Current: current}, nil
}

func (s *server) installWSLBridge(ctx context.Context, params wslBridgeParams) (*wslBridgeResult, *Error) {
	linux, e := s.readLinuxBridge(params)
	if e != nil {
		return nil, e
	}
	out, e := s.runInDistro(ctx, "installing loom-bridge", params.Distro, installScript, linux.data, params.Version, linux.sha256)
	if e != nil {
		return nil, e
	}
	return &wslBridgeResult{WSL: s.wsl, Path: strings.TrimSpace(out), Current: true}, nil
}

func (s *server) runInDistro(ctx context.Context, doing, distro, script string, stdin []byte, args ...string) (string, *Error) {
	ctx, cancel := context.WithTimeout(ctx, wslDistroTimeout)
	defer cancel()
	cmd := s.wslCommand(ctx, append([]string{"-d", distro, "--exec", "/bin/sh", "-c", script, "sh"}, args...)...)
	cmd.Stdin = bytes.NewReader(stdin)
	var stdout, stderr cappedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", &Error{Code: "timeout", Message: fmt.Sprintf("%s in %s did not finish within %v", doing, distro, wslDistroTimeout)}
	}
	if err != nil {
		stderrText := strings.TrimSpace(decodeWSLOutput(stderr.Bytes()))
		if stderrText == "" {
			stderrText = err.Error()
		}
		return "", &Error{Code: "wsl_failed", Message: fmt.Sprintf("%s in %s failed: %s", doing, distro, stderrText)}
	}
	return stdout.String(), nil
}
