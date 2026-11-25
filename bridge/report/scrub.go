package report

import (
	"regexp"
	"strings"

	"github.com/getsentry/sentry-go"
)

// Machine is what names this machine and its user, taken out wherever it
// shows up.
type Machine struct {
	Home string
	User string
	Host string
}

// MaxMessage is the longest message kept, after its first line is taken.
const MaxMessage = 300

var (
	url         = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s'"` + "`" + `<>()]*`)
	email       = regexp.MustCompile(`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`)
	windowsPath = regexp.MustCompile(`(?i)(?:\b[a-z]:|\\\\[^\s\\'"` + "`" + `]+)\\[^\s'"` + "`" + `<>|:]*`)
	// An absolute or `~` path: a slash that starts a word.
	unixPath = regexp.MustCompile(`(^|[\s(=:,\[{])~?/[^\s'"` + "`" + `<>)\]},;:]+`)
	// Something with slashes in it, which in a message is a path or a branch.
	relativePath = regexp.MustCompile(`\b[\w.@+-]+(?:/[\w.@+-]+)+/?`)
	// Quoted text. A single quote counts only away from letters, so "isn't" stays.
	quoted       = regexp.MustCompile(`"[^"\n]*"|` + "`[^`\\n]*`" + `|“[^”\n]*”|‘[^’\n]*’`)
	singleQuoted = regexp.MustCompile(`(^|[^\w])'[^'\n]*'([^\w]|$)`)
	// A host name, such as a self-hosted Forge's, under the common top-level domains.
	host = regexp.MustCompile(`(?i)\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|me|sh|cloud|tech|site|xyz|info|biz|local|lan|internal|intranet|corp|home|example|test|localdomain|eu|de|fr|uk|nl|ch|be|es|it|pt|ca|us|jp|cn|ru|br|in|au|nz|se|no|fi|dk|pl|cz|at|ie|il|kr|tw|sg)\b`)
)

// ScrubText takes the machine's names, quoted text, paths, URLs and email addresses out
// of text.
func ScrubText(text string, machine Machine) string {
	out := quoted.ReplaceAllLiteralString(text, `"<redacted>"`)
	out = singleQuoted.ReplaceAllString(out, `${1}"<redacted>"${2}`)
	if len(machine.Home) > 1 {
		out = regexp.MustCompile(`(?i)`+regexp.QuoteMeta(machine.Home)).ReplaceAllLiteralString(out, "~")
	}
	out = url.ReplaceAllLiteralString(out, "<url>")
	out = email.ReplaceAllLiteralString(out, "<email>")
	out = windowsPath.ReplaceAllLiteralString(out, "<path>")
	out = unixPath.ReplaceAllString(out, "${1}<path>")
	for _, name := range []struct{ value, placeholder string }{{machine.User, "<user>"}, {machine.Host, "<host>"}} {
		if len(name.value) >= 3 {
			out = regexp.MustCompile(`(?i)(^|[^\w-])`+regexp.QuoteMeta(name.value)+`([^\w-]|$)`).ReplaceAllString(out, "${1}"+name.placeholder+"${2}")
		}
	}
	return out
}

// ScrubMessage is a message as it may be sent: its first line, with no
// quoted text or paths, and no longer than MaxMessage.
func ScrubMessage(text string, machine Machine) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	line = strings.TrimRight(line, "\r")
	line = ScrubText(line, machine)
	line = relativePath.ReplaceAllLiteralString(line, "<path>")
	line = host.ReplaceAllLiteralString(line, "<host>")
	if runes := []rune(line); len(runes) > MaxMessage {
		line = string(runes[:MaxMessage-1]) + "…"
	}
	return line
}

// Scrub is an event as it may be sent: without who and where the user is,
// or what the SDK gathered besides the error and where in the bridge it was,
// and with its messages scrubbed.
func Scrub(event *sentry.Event, machine Machine) *sentry.Event {
	event.ServerName = ""
	// Not where the event came from either: an address set here is one Sentry
	// takes no other in place of, nor works out a location from.
	event.User = sentry.User{IPAddress: "0.0.0.0"}
	event.Request = nil
	event.Modules = nil
	event.Breadcrumbs = nil
	event.Message = ScrubMessage(event.Message, machine)
	event.Transaction = ScrubMessage(event.Transaction, machine)
	for key, value := range event.Tags {
		event.Tags[key] = ScrubText(value, machine)
	}
	for name, context := range event.Contexts {
		for key, value := range context {
			if s, ok := value.(string); ok {
				context[key] = ScrubText(s, machine)
			}
		}
		event.Contexts[name] = context
	}
	for i := range event.Exception {
		exception := &event.Exception[i]
		exception.Value = ScrubMessage(exception.Value, machine)
		scrubStacktrace(exception.Stacktrace, machine)
	}
	for i := range event.Threads {
		scrubStacktrace(event.Threads[i].Stacktrace, machine)
	}
	return event
}

// A frame keeps where in the bridge it is, never its variables, and its
// source only from the bridge's own code.
func scrubStacktrace(stacktrace *sentry.Stacktrace, machine Machine) {
	if stacktrace == nil {
		return
	}
	for i := range stacktrace.Frames {
		frame := &stacktrace.Frames[i]
		frame.Vars = nil
		frame.AbsPath = ScrubText(frame.AbsPath, machine)
		frame.Filename = ScrubText(frame.Filename, machine)
		if !strings.HasPrefix(frame.Module, "github.com/theholocoder/loom/") {
			frame.PreContext, frame.ContextLine, frame.PostContext = nil, "", nil
		}
	}
}
