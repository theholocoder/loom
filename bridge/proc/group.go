package proc

import "time"

// DefaultGrace is how long a stopped Group has to exit on its own before it
// is killed.
const DefaultGrace = 5 * time.Second

// waitDelay bounds how long a Group's Wait waits for its command's output
// pipes once the command has exited: what it started may still hold them,
// and is only stopped after the wait.
const waitDelay = time.Second
