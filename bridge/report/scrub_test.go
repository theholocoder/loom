package report

import (
	"strings"
	"testing"

	"github.com/getsentry/sentry-go"
)

var machine = Machine{Home: "/home/erin", User: "erin", Host: "erins-laptop"}

func TestScrubMessage(t *testing.T) {
	cases := []struct{ name, message, sent string }{
		{"a path under the home folder", "open /home/erin/code/billing/main.go: no such file", "open <path>: no such file"},
		{"a path elsewhere", "stat /srv/code/secret: permission denied", "stat <path>: permission denied"},
		{"a Windows path", `open C:\Users\Erin\code\x.txt: denied`, "open <path>: denied"},
		{"a URL", "fetch https://gitlab.acme.example/team/repo failed", "fetch <url> failed"},
		{"an email address", "commit by erin@acme.example failed", "commit by <email> failed"},
		{"quoted text", `unknown method "secret.method"`, `unknown method "<redacted>"`},
		{"guillemets", "ouvre «Projet secret»", `ouvre "<redacted>"`},
		{"nothing in a version", "loom@0.1.0 crashed", "loom@0.1.0 crashed"},
		{"single-quoted text, leaving contractions", "couldn't run 'my secret script' as it isn't there", `couldn't run "<redacted>" as it isn't there`},
		{"an unquoted branch", "could not push loom/fix-login", "could not push <path>"},
		{"a host name", "dial tcp: lookup gitlab.acme.internal: no such host", "dial tcp: lookup <host>: no such host"},
		{"the user and host names", "erin on erins-laptop", "<user> on <host>"},
		{"every line but the first", "exec failed\nwhat it printed: private", "exec failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ScrubMessage(c.message, machine); got != c.sent {
				t.Errorf("ScrubMessage(%q) = %q, want %q", c.message, got, c.sent)
			}
		})
	}
}

func TestScrubMessageKeepsWhatIsntPrivate(t *testing.T) {
	for _, message := range []string{"runtime error: index out of range [3] with length 2", "frame of 20000000 bytes is over the limit"} {
		if got := ScrubMessage(message, machine); got != message {
			t.Errorf("ScrubMessage(%q) = %q, want it unchanged", message, got)
		}
	}
}

func TestScrubMessageCutsALongOneShort(t *testing.T) {
	got := []rune(ScrubMessage(strings.Repeat("x", 1000), machine))
	if len(got) != MaxMessage || got[len(got)-1] != '…' {
		t.Errorf("got %d runes ending %q, want %d ending with …", len(got), got[len(got)-1], MaxMessage)
	}
}

func TestScrubDropsWhoAndWhereTheUserIs(t *testing.T) {
	event := &sentry.Event{
		ServerName:  "erins-laptop",
		User:        sentry.User{Username: "erin", IPAddress: "1.2.3.4"},
		Request:     &sentry.Request{URL: "https://x"},
		Modules:     map[string]string{"x": "1"},
		Breadcrumbs: []*sentry.Breadcrumb{{Message: "private"}},
		Message:     "could not read /home/erin/x",
		Tags:        map[string]string{"where": "/home/erin/x"},
		Contexts:    map[string]sentry.Context{"os": {"name": "linux"}, "device": {"hostname": "erins-laptop", "nested": map[string]any{"at": "/home/erin/x"}}},
		Exception: []sentry.Exception{{
			Type:  "*fs.PathError",
			Value: "open /home/erin/x: denied",
			Stacktrace: &sentry.Stacktrace{Frames: []sentry.Frame{
				{Module: "github.com/theholocoder/loom/bridge/protocol", Function: "readFile", ContextLine: "return err", Vars: map[string]any{"path": "/home/erin/x"}},
				{Module: "os", Function: "Open", AbsPath: "/home/erin/sdk/go/src/os/file.go", ContextLine: "x"},
			}},
		}},
	}
	got := Scrub(event, machine)
	if got.ServerName != "" || got.User.Username != "" || got.User.IPAddress != "0.0.0.0" || got.Request != nil || got.Modules != nil || got.Breadcrumbs != nil {
		t.Errorf("kept who or where the user is: %+v", got)
	}
	if got.Message != "could not read <path>" || got.Tags["where"] != "<path>" || got.Contexts["device"]["hostname"] != "<host>" || got.Contexts["os"]["name"] != "linux" {
		t.Errorf("message %q, tags %v, contexts %v", got.Message, got.Tags, got.Contexts)
	}
	if nested := got.Contexts["device"]["nested"].(map[string]any); nested["at"] != "<path>" {
		t.Errorf("nested context %v", nested)
	}
	exception := got.Exception[0]
	if exception.Value != "open <path>: denied" {
		t.Errorf("exception value %q", exception.Value)
	}
	own, other := exception.Stacktrace.Frames[0], exception.Stacktrace.Frames[1]
	if own.Vars != nil || own.ContextLine != "return err" {
		t.Errorf("the bridge's own frame: %+v", own)
	}
	if other.ContextLine != "" || other.AbsPath != "<path>" {
		t.Errorf("another frame: %+v", other)
	}
}
