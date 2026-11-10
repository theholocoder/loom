package protocol_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/theholocoder/loom/bridge/protocol"
)

// fakeOpencodeVar holds the fakeOpencode script (JSON) of a test binary run
// as the "opencode" helper (see TestMain): it stands in for `opencode serve
// --stdio`, serving the script on a loopback port, printing {"url": ...} as
// OpenCode does, and exiting when its stdin closes.
const fakeOpencodeVar = "LOOM_FAKE_OPENCODE"

// fakeOpencode is what the stand-in answers, by path; a path it has no answer
// for gets a 404. Each request's path is appended to Log, one per line.
type fakeOpencode struct {
	Answers map[string]fakeAnswer `json:"answers"`
	Log     string                `json:"log"`
}

// fakeAnswer is one path's answer: Body is sent as is, with Status (200 when 0).
type fakeAnswer struct {
	Status int    `json:"status,omitempty"`
	Body   string `json:"body"`
}

func serveFakeOpencode(script string) {
	var fake fakeOpencode
	if err := json.Unmarshal([]byte(script), &fake); err != nil {
		fmt.Fprintln(os.Stderr, "fake opencode: bad script:", err)
		os.Exit(2)
	}
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "fake opencode: unscripted command", os.Args[1:])
		os.Exit(2)
	}
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode:"+os.Getenv("OPENCODE_SERVER_PASSWORD")))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(2)
	}
	go func() {
		_ = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != expected {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if log, err := os.OpenFile(fake.Log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				fmt.Fprintf(log, "%s %s\n", r.URL.Path, r.Header.Get("x-opencode-directory"))
				log.Close()
			}
			answer, ok := fake.Answers[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if answer.Status != 0 {
				w.WriteHeader(answer.Status)
			}
			_, _ = io.WriteString(w, answer.Body)
		}))
	}()
	fmt.Printf("{\"url\":\"http://%s\"}\n", listener.Addr())
	_, _ = io.Copy(io.Discard, os.Stdin)
}

// probeWith starts a bridge whose PATH has only a fake `opencode` answering
// as given, and returns it with the file the fake logs requests to.
func probeWith(t *testing.T, answers map[string]fakeAnswer) (*peer, string) {
	t.Helper()
	bin := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := "opencode"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := copyFile(self, filepath.Join(bin, name)); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "requests.log")
	script, _ := json.Marshal(fakeOpencode{Answers: answers, Log: log})
	environ := []string{"PATH=" + bin, helperEnv + "=opencode", fakeOpencodeVar + "=" + string(script)}
	for _, entry := range os.Environ() {
		if name, _, _ := strings.Cut(entry, "="); !strings.EqualFold(name, "PATH") && name != helperEnv && name != fakeOpencodeVar {
			environ = append(environ, entry)
		}
	}
	return startBridgeOn(t, protocol.Machine{Environ: environ}), log
}

func copyFile(from, to string) error {
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, data, 0o755)
}

// requests is what the fake was asked, in order: "path directory" lines.
func requests(t *testing.T, log string) []string {
	t.Helper()
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// data wraps a list as OpenCode does: {"location": ..., "data": list}.
func data(list string) fakeAnswer {
	return fakeAnswer{Body: `{"location":{"directory":"/x"},"data":` + list + `}`}
}

func asJSON(t *testing.T, value any) string {
	t.Helper()
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// models is a model list as OpenCode gives it, its keys sorted as the bridge passes them on.
const models = `[{"id":"pulse-free","name":"Pulse Free","providerID":"opencode"}]`

func TestProbeListsTheCheckoutsModelsCommandsAndSkillsWithoutTheirContent(t *testing.T) {
	checkout := t.TempDir()
	skills := asJSON(t, []map[string]any{
		{"id": "release", "name": "release", "description": "Cut a release.", "path": filepath.Join(checkout, ".agents", "skills", "release", "SKILL.md"), "content": "# Release, at length"},
		{"id": "tdd", "name": "tdd", "path": filepath.Join(t.TempDir(), "SKILL.md"), "content": "# TDD"},
		{"id": "opencode", "name": "OpenCode", "path": "skill://opencode/SKILL.md", "content": "# OpenCode"},
	})
	p, log := probeWith(t, map[string]fakeAnswer{
		"/api/integration": data(`[]`),
		"/api/model":       data(models),
		"/api/command":     data(`[{"name":"review","description":"review changes"}]`),
		"/api/skill":       data(skills),
	})

	result := p.call(1, "opencode.probe", map[string]any{"directory": checkout})

	if got, want := asJSON(t, result["models"]), models; got != want {
		t.Errorf("models = %s, want %s", got, want)
	}
	if got, want := asJSON(t, result["commands"]), `[{"description":"review changes","name":"review"}]`; got != want {
		t.Errorf("commands = %s, want %s", got, want)
	}
	wantSkills := `[{"description":"Cut a release.","id":"release","name":"release","source":"project"},{"id":"tdd","name":"tdd","source":"personal"},{"id":"opencode","name":"OpenCode","source":"built-in"}]`
	if got := asJSON(t, result["skills"]); got != wantSkills {
		t.Errorf("skills = %s, want %s", got, wantSkills)
	}
	// The skills after the models: OpenCode lists none before it has loaded the checkout.
	want := []string{"/api/integration ", "/api/model " + checkout, "/api/command " + checkout, "/api/skill " + checkout}
	if got := requests(t, log); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("asked %q, want %q", got, want)
	}
}

func TestProbeStillListsTheModelsWhenCommandsAndSkillsCantBeListed(t *testing.T) {
	cases := map[string]map[string]fakeAnswer{
		"an OpenCode without them": {},
		"errors": {
			"/api/command": {Status: http.StatusInternalServerError, Body: "boom"},
			"/api/skill":   {Status: http.StatusInternalServerError, Body: "boom"},
		},
		"answers that aren't lists": {
			"/api/command": {Body: "not json"},
			"/api/skill":   data(`{"not":"a list"}`),
		},
	}
	for name, broken := range cases {
		t.Run(name, func(t *testing.T) {
			answers := map[string]fakeAnswer{"/api/integration": data(`[]`), "/api/model": data(models)}
			for path, answer := range broken {
				answers[path] = answer
			}
			p, _ := probeWith(t, answers)

			result := p.call(1, "opencode.probe", map[string]any{"directory": t.TempDir()})

			if got := asJSON(t, result["models"]); got != models {
				t.Errorf("models = %s, want %s", got, models)
			}
			if _, ok := result["commands"]; ok {
				t.Errorf("commands = %v, want none", result["commands"])
			}
			if _, ok := result["skills"]; ok {
				t.Errorf("skills = %v, want none", result["skills"])
			}
		})
	}
}

func TestProbeFailsWhenTheModelsCantBeListed(t *testing.T) {
	p, _ := probeWith(t, map[string]fakeAnswer{
		"/api/integration": data(`[]`),
		"/api/model":       {Status: http.StatusInternalServerError, Body: "boom"},
	})

	p.send(map[string]any{"id": 1, "method": "opencode.probe", "params": map[string]any{"directory": t.TempDir()}})
	reply := p.response(1)

	failure, _ := reply["error"].(map[string]any)
	if failure["code"] != "probe_failed" || !strings.Contains(fmt.Sprint(failure["message"]), "/api/model") {
		t.Errorf("reply = %v, want a probe_failed error naming /api/model", reply)
	}
}
