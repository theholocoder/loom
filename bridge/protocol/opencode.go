package protocol

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
	"github.com/theholocoder/loom/bridge/shellenv"
)

// probeTimeout bounds the whole OpenCode probe.
const probeTimeout = 15 * time.Second

// probeGrace is how long the probe server gets to exit once its stdin is
// closed before it is killed.
const probeGrace = 5 * time.Second

type probeResult struct {
	// Integrations is OpenCode's `GET /api/integration` list, as it reported it.
	Integrations json.RawMessage `json:"integrations"`
}

// probeOpencode starts a short-lived, private `opencode serve --stdio` and
// asks it for its integrations, which is how main tells whether OpenCode is
// signed in. It never runs `opencode auth list` or `opencode models`, which
// start the user's shared background service.
//
// The server prints {"url": ...} on stdout, guards its API with HTTP Basic
// auth using OPENCODE_SERVER_PASSWORD, and exits when its stdin closes.
func probeOpencode(ctx context.Context, env shellenv.Env) (*probeResult, *Error) {
	path, err := env.LookPath("opencode")
	if err != nil {
		return nil, &Error{Code: "not_found", Message: "opencode is not on the PATH"}
	}
	secret := make([]byte, 24)
	if _, err := rand.Read(secret); err != nil {
		return nil, probeFailed(err)
	}
	password := hex.EncodeToString(secret)

	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0")
	cmd.Env = append(env.ForTools(), "OPENCODE_SERVER_PASSWORD="+password)
	proc.Isolate(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, probeFailed(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, probeFailed(err)
	}
	stderr := &cappedBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, probeFailed(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	defer func() {
		stdin.Close()
		select {
		case <-exited:
		case <-time.After(probeGrace):
			_ = proc.Kill(cmd)
			<-exited
		}
	}()

	urls := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var line struct {
				URL string `json:"url"`
			}
			if json.Unmarshal(scanner.Bytes(), &line) == nil && line.URL != "" {
				urls <- line.URL
				break
			}
		}
		close(urls)
		// Keep reading so the server never blocks writing to a full pipe.
		_, _ = io.Copy(io.Discard, stdout)
	}()
	var url string
	select {
	case url = <-urls:
	case <-ctx.Done():
	}
	if url == "" {
		return nil, probeFailed(errors.New("opencode serve did not report its URL" + stderrSuffix(stderr)))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(url, "/")+"/api/integration", nil)
	if err != nil {
		return nil, probeFailed(err)
	}
	req.SetBasicAuth("opencode", password)
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, probeFailed(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxOutput))
	if err != nil {
		return nil, probeFailed(err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, probeFailed(fmt.Errorf("GET /api/integration answered %s", res.Status))
	}
	// OpenCode wraps most results as {"data": ...}.
	var wrapped struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, probeFailed(errors.New("GET /api/integration answered something other than JSON"))
	}
	if len(wrapped.Data) == 0 {
		return nil, probeFailed(errors.New("GET /api/integration answered no data"))
	}
	return &probeResult{Integrations: wrapped.Data}, nil
}

func probeFailed(err error) *Error {
	return &Error{Code: "probe_failed", Message: err.Error()}
}

func stderrSuffix(stderr *cappedBuffer) string {
	text := strings.TrimSpace(stderr.String())
	if text == "" {
		return ""
	}
	if len(text) > 500 {
		text = text[len(text)-500:]
	}
	return ": " + text
}
