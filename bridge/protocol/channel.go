package protocol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
	"github.com/theholocoder/loom/bridge/shellenv"
)

// ChannelWindow is how many bytes of a channel's output the bridge sends
// ahead of main's acknowledgements. Once it is used up the bridge stops
// reading the process's stdout, so a process that outruns main blocks on its
// own pipe instead of filling the bridge's memory.
const ChannelWindow = 256 << 10

// channelChunk bounds the data in a single channel.data event.
const channelChunk = 32 << 10

// maxExitStderr is how much of the end of a process's stderr its exit event
// carries.
const maxExitStderr = 4 << 10

// A channel is a long-lived process whose stdin and stdout main drives over
// the bridge's stream, multiplexed with every other channel's: an agent's
// ACP stdio, or the shell of a terminal in Loom. A terminal channel's process
// runs on a pseudo-terminal, whose master is both its stdin and its stdout,
// and gets the stderr too: its exit carries none. Main writes with channel.write, which is answered once the bytes
// are in the process's stdin, and acknowledges what it has read with
// channel.ack. The bridge sends what the process prints as channel.data
// events, then a channel.exit event once it has exited.
type channel struct {
	id    int
	group *proc.Group
	stdin io.WriteCloser
	// terminal is the pseudo-terminal's master, for a terminal channel.
	terminal *os.File
	// writing keeps writes in the order main sent them.
	writing sync.Mutex

	mu     sync.Mutex
	credit int
	// stopped is set when the channel is killed: its output is dropped.
	stopped bool
	// changed is signalled when credit or stopped change.
	changed *sync.Cond
}

type openParams struct {
	// Command is looked up on the Environment's PATH.
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
	// Pty makes it a terminal channel: the process runs on a pseudo-terminal
	// of this size, with the Environment's full environment, as in the
	// user's own terminal. Command is then looked up on the full PATH, and
	// defaults to the user's login shell.
	Pty *terminalSize `json:"pty"`
}

// terminalSize is a terminal's size in character cells.
type terminalSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type resizeParams struct {
	Channel int `json:"channel"`
	terminalSize
}

type openResult struct {
	Channel int `json:"channel"`
	// Path is where Command was found.
	Path string `json:"path"`
}

type channelParams struct {
	Channel int `json:"channel"`
}

type writeParams struct {
	Channel int    `json:"channel"`
	Data    []byte `json:"data"`
}

type ackParams struct {
	Channel int `json:"channel"`
	Bytes   int `json:"bytes"`
}

type event struct {
	Event  string `json:"event"`
	Params any    `json:"params"`
}

type dataEvent struct {
	Channel int    `json:"channel"`
	Data    []byte `json:"data"`
}

type exitEvent struct {
	Channel  int    `json:"channel"`
	ExitCode int    `json:"exitCode"`
	Stderr   string `json:"stderr"`
}

// channels holds the bridge's open channels. Each process runs in its own
// process group (proc.Group) with whatever it starts, and every group is
// stopped when ctx ends, which is when the bridge shuts down.
type channels struct {
	ctx context.Context
	// shell is what a terminal channel runs when given no command.
	shell   string
	out     *writer
	grace   time.Duration
	running sync.WaitGroup

	mu     sync.Mutex
	nextID int
	open   map[int]*channel
}

func newChannels(ctx context.Context, out *writer, grace time.Duration, shell string) *channels {
	if grace <= 0 {
		grace = proc.DefaultGrace
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	return &channels{ctx: ctx, out: out, grace: grace, shell: shell, open: map[int]*channel{}}
}

func (cs *channels) start(env shellenv.Env, params openParams) (*openResult, *Error) {
	if params.Pty != nil {
		if params.Command == "" {
			params.Command = cs.shell
		}
		if params.Pty.Cols <= 0 || params.Pty.Rows <= 0 {
			return nil, &Error{Code: "bad_params", Message: "a terminal needs at least one column and one row"}
		}
	}
	if params.Command == "" {
		return nil, &Error{Code: "bad_params", Message: "channel.open needs a command"}
	}
	lookPath, vars := env.LookPath, env.ForTools()
	if params.Pty != nil {
		lookPath, vars = env.LookPathFull, append(env.Full(), "TERM=xterm-256color", "COLORTERM=truecolor")
	}
	path, err := lookPath(params.Command)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("%s is not on the PATH", params.Command)}
	}
	cmd := exec.Command(path, params.Args...)
	cmd.Dir = params.Cwd
	cmd.Env = vars
	// exec.Cmd keeps the last of duplicate variables, so these win.
	for name, value := range params.Env {
		cmd.Env = append(cmd.Env, name+"="+value)
	}
	stderr := &tailBuffer{}
	var (
		stdin    io.WriteCloser
		stdout   io.ReadCloser
		terminal *os.File
		group    *proc.Group
	)
	if params.Pty != nil {
		terminal, group, err = startTerminal(cmd, *params.Pty, cs.grace)
		if err != nil {
			return nil, spawnFailed(err)
		}
		stdin, stdout = terminal, terminal
	} else {
		pipeIn, err := cmd.StdinPipe()
		if err != nil {
			return nil, spawnFailed(err)
		}
		// Not StdoutPipe: Wait would close it once the process exits. This
		// pipe reaches EOF only when the process and everything it started
		// that holds it have gone, so its last output is never lost.
		pipeOut, stdoutW, err := os.Pipe()
		if err != nil {
			_ = pipeIn.Close()
			return nil, spawnFailed(err)
		}
		cmd.Stdout = stdoutW
		cmd.Stderr = stderr
		group, err = proc.Start(cmd, cs.grace)
		_ = stdoutW.Close()
		if err != nil {
			_ = pipeOut.Close()
			return nil, spawnFailed(err)
		}
		stdin, stdout = pipeIn, pipeOut
	}

	cs.mu.Lock()
	cs.nextID++
	c := &channel{id: cs.nextID, group: group, stdin: stdin, terminal: terminal, credit: ChannelWindow}
	c.changed = sync.NewCond(&c.mu)
	cs.open[c.id] = c
	cs.mu.Unlock()

	cs.running.Add(1)
	go func() {
		defer cs.running.Done()
		stop := context.AfterFunc(cs.ctx, c.stop)
		// The group is waited for alongside the pump: once the process has
		// exited, Wait stops what it left running, which may hold stdout.
		exited := make(chan struct{})
		go func() {
			_ = group.Wait()
			close(exited)
		}()
		c.pump(stdout, cs.out)
		<-exited
		_ = stdout.Close()
		stop()
		cs.mu.Lock()
		delete(cs.open, c.id)
		cs.mu.Unlock()
		_ = cs.out.write(event{Event: "channel.exit", Params: exitEvent{Channel: c.id, ExitCode: cmd.ProcessState.ExitCode(), Stderr: strings.TrimSpace(stderr.String())}})
	}()
	return &openResult{Channel: c.id, Path: path}, nil
}

// wait returns once every channel's process group has gone and its exit been
// reported.
func (cs *channels) wait() {
	cs.running.Wait()
}

func (cs *channels) get(id int) (*channel, *Error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.open[id]
	if !ok {
		return nil, &Error{Code: "unknown_channel", Message: fmt.Sprintf("no open channel %d", id)}
	}
	return c, nil
}

func (cs *channels) write(params writeParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	c.writing.Lock()
	defer c.writing.Unlock()
	if _, err := c.stdin.Write(params.Data); err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	return struct{}{}, nil
}

func (cs *channels) ack(params ackParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	if params.Bytes < 0 {
		return nil, &Error{Code: "bad_params", Message: "channel.ack needs a byte count of zero or more"}
	}
	c.mu.Lock()
	c.credit += params.Bytes
	c.changed.Broadcast()
	c.mu.Unlock()
	return struct{}{}, nil
}

// closeStdin closes the process's stdin, which tells most processes to exit.
func (cs *channels) closeStdin(params channelParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	c.writing.Lock()
	defer c.writing.Unlock()
	_ = c.stdin.Close()
	return struct{}{}, nil
}

// resize sets a terminal channel's size, which sends its process SIGWINCH.
func (cs *channels) resize(params resizeParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	if c.terminal == nil {
		return nil, &Error{Code: "not_a_terminal", Message: fmt.Sprintf("channel %d is not a terminal", params.Channel)}
	}
	if params.Cols <= 0 || params.Rows <= 0 {
		return nil, &Error{Code: "bad_params", Message: "a terminal needs at least one column and one row"}
	}
	if err := setTerminalSize(c.terminal, params.terminalSize); err != nil {
		return nil, &Error{Code: "resize_failed", Message: err.Error()}
	}
	return struct{}{}, nil
}

func (cs *channels) kill(params channelParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	c.stop()
	return struct{}{}, nil
}

// stop stops the process's group (SIGTERM, then SIGKILL once the grace is
// up) and drops whatever it still prints. It doesn't wait for the group.
func (c *channel) stop() {
	c.mu.Lock()
	c.stopped = true
	c.changed.Broadcast()
	c.mu.Unlock()
	c.group.Stop()
}

// pump sends the process's stdout as channel.data events, never more than the
// credit main has given, until it reaches EOF or the channel is stopped.
func (c *channel) pump(stdout io.Reader, out *writer) {
	buf := make([]byte, channelChunk)
	for {
		c.mu.Lock()
		for c.credit == 0 && !c.stopped {
			c.changed.Wait()
		}
		stopped, room := c.stopped, min(c.credit, len(buf))
		c.mu.Unlock()
		if stopped {
			return
		}
		n, err := stdout.Read(buf[:room])
		if n > 0 {
			c.mu.Lock()
			c.credit -= n
			c.mu.Unlock()
			data := make([]byte, n)
			copy(data, buf[:n])
			if out.write(event{Event: "channel.data", Params: dataEvent{Channel: c.id, Data: data}}) != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func spawnFailed(err error) *Error {
	var notFound *exec.Error
	if errors.As(err, &notFound) {
		return &Error{Code: "not_found", Message: err.Error()}
	}
	return &Error{Code: "spawn_failed", Message: err.Error()}
}

// tailBuffer keeps the last maxExitStderr bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - maxExitStderr; over > 0 {
		b.buf = b.buf[over:]
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
