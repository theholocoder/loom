# Error reporting and feedback go to Sentry, scrubbed of everything the user works on

Loom has no server (ADR 0006), so a crash or an error on a user's machine was invisible to its makers. Release builds now report to two Sentry projects of TheHolocoder's organization: `loom` for main, the preload and the renderer (`@sentry/electron`), and `loom-bridge` for the bridge (`sentry-go`). They send the errors Loom raises, uncaught or logged with `console.error`; native crashes (minidumps); warnings and errors as logs; a sample of traces (10% in a release); and the feedback the user writes in the feedback form. Development, the tests and the self-test send nothing unless `LOOM_SENTRY=1` (`just dev-report`); `LOOM_SENTRY=0` turns a release build's reporting off, for its makers rather than its users. Reports carry the `production` environment from a packaged build and `development` otherwise.

Reporting is always on in a release: there is no setting to turn it off. Issue #126 asks for it on the condition that nothing private is sent: no conversations, Projects, repositories, files or people. So:

- The SDKs' own data collection is turned off (`dataCollection`, `SendDefaultPII`): no user, IP address, request, cookies, headers, bodies or local variables. Screenshots, Session Replay and console, click, request and navigation breadcrumbs are left out.
- Every event, span, breadcrumb and log is scrubbed before it leaves, by shape rather than by knowing what's private (`apps/client/src/shared/scrub.ts`, `bridge/report/scrub.go`). A message keeps only its first line, cut to 300 characters, so a command's output or an agent's reply never goes. Quoted text (what the user named: a branch, a folder, a Session's title), paths, URLs, email addresses, host names, and the machine's home folder, user name and host name are replaced in every string. The user's IP address is set to `0.0.0.0`, so Sentry doesn't record where they are, and the projects scrub IP addresses too.
- Loom's own messages quote what the user named, and put what a command printed in their Details, so that the scrubber takes them out. A message that interpolates a name has to quote it.
- Feedback is the one exception: what the user writes, and the email address they give to get an answer, are sent as written. The form says so.

## Consequences

- An error's message is often less than it said on screen. Its type and stack trace, with source maps uploaded by the Release workflow, are what to go by.
- A native crash's minidump holds the crashed process's stack memory, which the scrubber can't read. It could hold a fragment of what the process was working on.
- Loom depends on Sentry being reachable for this. An event that can't be sent is kept in `userData` and sent later, and never holds anything up.
- The bridge reports its panics, the error that ends it, and an answer too big for a frame (by method and size, which it then answers with a `too_large` error), and no logs or traces. `loom-bridge mcp`, which the agents start, reports nothing.
- An agent's own error text, which Loom quotes after its own sentence, is sent once scrubbed: it is what the agent says went wrong, not the conversation.
