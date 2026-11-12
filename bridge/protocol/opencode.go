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
	"path/filepath"
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

// maxModelsOutput bounds what `GET /api/model` may answer: about 1 KB a model,
// with room for users of providers listing hundreds. It stays well under
// MaxFrameSize.
const maxModelsOutput = 8 << 20

// maxSkillsOutput bounds what `GET /api/skill` may answer: it carries each
// skill's whole SKILL.md, which the probe leaves out of what it reports.
const maxSkillsOutput = 32 << 20

type probeParams struct {
	// Directory, when given, is a checkout to list the models of.
	Directory string `json:"directory,omitempty"`
}

type probeResult struct {
	// Integrations is OpenCode's `GET /api/integration` list, as it reported it.
	Integrations json.RawMessage `json:"integrations"`
	// Models is OpenCode's `GET /api/model` list for the checkout params.Directory,
	// as it reported it; absent without a directory.
	Models json.RawMessage `json:"models,omitempty"`
	// DefaultModel is which model OpenCode's `GET /api/model/default` says a
	// session runs without one picked, for params.Directory; absent without a
	// directory, or when OpenCode doesn't say.
	DefaultModel *modelRef `json:"defaultModel,omitempty"`
	// Commands is OpenCode's `GET /api/command` list for params.Directory, as
	// it reported it; absent without a directory, or when OpenCode can't list
	// them.
	Commands json.RawMessage `json:"commands,omitempty"`
	// Skills is OpenCode's `GET /api/skill` list for params.Directory, each
	// with only its id, name, description and where it comes from; absent when there are none, or as
	// Commands is.
	Skills []probeSkill `json:"skills,omitempty"`
}

// modelRef is which model a model is: not its settings, which may hold a key.
type modelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
}

// probeSkill is what the probe reports of a skill: not its path or content.
type probeSkill struct {
	// ID is OpenCode's id for it.
	ID string `json:"id"`
	// Name is what the user types after `/`.
	Name string `json:"name"`
	// Description says what it does, as its SKILL.md does.
	Description string `json:"description,omitempty"`
	// Source is where it comes from (see skillSource); absent when unknown.
	Source string `json:"source,omitempty"`
}

// apiSkill is a skill as OpenCode's `GET /api/skill` lists it: only what the
// probe reads.
type apiSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Path is its SKILL.md, absolute, or `skill://…` for OpenCode's own.
	Path string `json:"path"`
}

// skillSource says where the skill at path comes from: "project" when it is
// in the checkout directory, "built-in" for OpenCode's own (`skill://…`), and
// "personal" when it is elsewhere on the machine; "" without a path. Symlinks
// are resolved on both sides, and case is ignored where the OS does.
func skillSource(path, directory string) string {
	switch {
	case path == "":
		return ""
	case strings.HasPrefix(path, "skill://"):
		return "built-in"
	}
	rel, err := filepath.Rel(resolved(directory), resolved(path))
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "personal"
	}
	return "project"
}

// resolved is path with its symlinks resolved, as far as it exists: what
// doesn't exist (any more) is kept as written.
func resolved(path string) string {
	path = filepath.Clean(path)
	rest := ""
	for {
		if real, err := filepath.EvalSymlinks(path); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return filepath.Join(path, rest)
		}
		rest = filepath.Join(filepath.Base(path), rest)
		path = parent
	}
}

// probeOpencode starts a short-lived, private `opencode serve --stdio` and
// asks it for its integrations, which is how main tells whether OpenCode is
// signed in, and, given a directory, the models, commands and skills it
// offers there. It never runs `opencode auth list` or `opencode models`,
// which start the user's shared background service.
//
// The server prints {"url": ...} on stdout, guards its API with HTTP Basic
// auth using OPENCODE_SERVER_PASSWORD, and exits when its stdin closes.
func probeOpencode(ctx context.Context, env shellenv.Env, params probeParams) (*probeResult, *Error) {
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

	base := strings.TrimRight(url, "/")
	integrations, failure := probeGet(ctx, base, password, "/api/integration", "", maxOutput)
	if failure != nil {
		return nil, failure
	}
	result := &probeResult{Integrations: integrations}
	if params.Directory != "" {
		models, failure := probeGet(ctx, base, password, "/api/model", params.Directory, maxModelsOutput)
		if failure != nil {
			return nil, failure
		}
		result.Models = models
		// Without a default the models are still worth having.
		if model, failure := probeGet(ctx, base, password, "/api/model/default", params.Directory, maxOutput); failure == nil {
			var ref modelRef
			if json.Unmarshal(model, &ref) == nil && ref.ID != "" && ref.ProviderID != "" {
				result.DefaultModel = &ref
			}
		}
		// After the models, which wait for OpenCode to load the checkout: until
		// then it lists no skills. Without them the models are still worth having.
		if commands, failure := probeGet(ctx, base, password, "/api/command", params.Directory, maxOutput); failure == nil {
			result.Commands = commands
		}
		if skills, failure := probeGet(ctx, base, password, "/api/skill", params.Directory, maxSkillsOutput); failure == nil {
			var listed []apiSkill
			if json.Unmarshal(skills, &listed) == nil {
				for _, skill := range listed {
					result.Skills = append(result.Skills, probeSkill{ID: skill.ID, Name: skill.Name, Description: skill.Description, Source: skillSource(skill.Path, params.Directory)})
				}
			}
		}
	}
	return result, nil
}

// probeGet asks the probe server for `path` and returns its data. A directory
// scopes the request to that checkout, as OpenCode reads it from the
// x-opencode-directory header (it ignores a `directory` query parameter).
func probeGet(ctx context.Context, base, password, path, directory string, limit int64) (json.RawMessage, *Error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return nil, probeFailed(err)
	}
	req.SetBasicAuth("opencode", password)
	req.Header.Set("Accept", "application/json")
	if directory != "" {
		req.Header.Set("x-opencode-directory", directory)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, probeFailed(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, limit))
	if err != nil {
		return nil, probeFailed(err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, probeFailed(fmt.Errorf("GET %s answered %s", path, res.Status))
	}
	// OpenCode wraps most results as {"data": ...}.
	var wrapped struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, probeFailed(fmt.Errorf("GET %s answered something other than JSON", path))
	}
	if len(wrapped.Data) == 0 {
		return nil, probeFailed(fmt.Errorf("GET %s answered no data", path))
	}
	return wrapped.Data, nil
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
