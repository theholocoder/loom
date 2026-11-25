// Package report sends the bridge's crashes and errors to Loom's Sentry
// project (issue #126), and nothing of what the user works on: no paths,
// repositories, commands, output or names. Main turns it on by setting
// LOOM_BRIDGE_SENTRY_DSN, with LOOM_SENTRY_RELEASE and
// LOOM_SENTRY_ENVIRONMENT, in the environment it starts the bridge with
// (apps/client/src/main/telemetry.ts); without them, as in the tests, it
// does nothing. Every event is scrubbed on its way out (Scrub), as main's
// are (apps/client/src/shared/scrub.ts).
package report

import (
	"os"
	"os/user"
	"time"

	"github.com/getsentry/sentry-go"
)

// The variables main passes, taken out of the bridge's own environment once
// read, so that what the bridge starts doesn't inherit them.
const (
	dsnVariable         = "LOOM_BRIDGE_SENTRY_DSN"
	releaseVariable     = "LOOM_SENTRY_RELEASE"
	environmentVariable = "LOOM_SENTRY_ENVIRONMENT"
)

// flushTimeout bounds how long a crash waits for its report to go out.
const flushTimeout = 2 * time.Second

var enabled bool

// Init starts reporting if main asked for it.
func Init() {
	dsn := os.Getenv(dsnVariable)
	release := os.Getenv(releaseVariable)
	environment := os.Getenv(environmentVariable)
	for _, name := range []string{dsnVariable, releaseVariable, environmentVariable} {
		_ = os.Unsetenv(name)
	}
	if dsn == "" {
		return
	}
	machine := thisMachine()
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Release:          release,
		Environment:      environment,
		SendDefaultPII:   false,
		AttachStacktrace: true,
		// The bridge leaves no breadcrumbs of its own; none could say anything useful that isn't private.
		MaxBreadcrumbs: -1,
		// Which modules the bridge is built from is in its source, not worth sending.
		Integrations: func(integrations []sentry.Integration) []sentry.Integration {
			kept := integrations[:0]
			for _, integration := range integrations {
				if integration.Name() != "Modules" {
					kept = append(kept, integration)
				}
			}
			return kept
		},
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			return Scrub(event, machine)
		},
	})
	enabled = err == nil
}

func thisMachine() Machine {
	machine := Machine{}
	machine.Home, _ = os.UserHomeDir()
	if u, err := user.Current(); err == nil {
		machine.User = u.Username
	}
	machine.Host, _ = os.Hostname()
	return machine
}

// Recover, deferred at the top of a goroutine, reports a panic there and
// panics again with it: the bridge still crashes as it would have, and main
// still starts it again.
func Recover() {
	if !enabled {
		return
	}
	if r := recover(); r != nil {
		sentry.CurrentHub().Recover(r)
		sentry.Flush(flushTimeout)
		panic(r)
	}
}

// Error reports err, which ends the bridge, and waits for it to go out.
func Error(err error) {
	if !enabled || err == nil {
		return
	}
	sentry.CaptureException(err)
	sentry.Flush(flushTimeout)
}
