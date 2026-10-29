package protocol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"

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
// ACP stdio. Main writes with channel.write, which is answered once the bytes
// are in the process's stdin, and acknowledges what it has read with
// channel.ack. The bridge sends what the process prints as channel.data
// events, then a channel.exit event once it has exited.
type channel struct {
	id    int
	cmd   *exec.Cmd
	stdin io.WriteCloser
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

// channels holds the bridge's open channels. Every process it starts is
// stopped when ctx ends, which is when the bridge shuts down.
type channels struct {
	ctx     context.Context
	out     *writer
	running sync.WaitGroup

	mu     sync.Mutex
	nextID int
	open   map[int]*channel
}

func newChannels(ctx context.Context, out *writer) *channels {
	return &channels{ctx: ctx, out: out, open: map[int]*channel{}}
}

func (cs *channels) start(env shellenv.Env, params openParams) (*openResult, *Error) {
	if params.Command == "" {
		return nil, &Error{Code: "bad_params", Message: "channel.open needs a command"}
	}
	path, err := env.LookPath(params.Command)
	if err != nil {
		return nil, &Error{Code: "not_found", Message: fmt.Sprintf("%s is not on the PATH", params.Command)}
	}
	cmd := exec.CommandContext(cs.ctx, path, params.Args...)
	cmd.Dir = params.Cwd
	cmd.Env = env.ForTools()
	// exec.Cmd keeps the last of duplicate variables, so these win.
	for name, value := range params.Env {
		cmd.Env = append(cmd.Env, name+"="+value)
	}
	proc.Isolate(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, spawnFailed(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, spawnFailed(err)
	}
	stderr := &tailBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, spawnFailed(err)
	}

	cs.mu.Lock()
	cs.nextID++
	c := &channel{id: cs.nextID, cmd: cmd, stdin: stdin, credit: ChannelWindow}
	c.changed = sync.NewCond(&c.mu)
	cs.open[c.id] = c
	cs.mu.Unlock()

	cs.running.Add(1)
	go func() {
		defer cs.running.Done()
		stop := context.AfterFunc(cs.ctx, c.stop)
		c.pump(stdout, cs.out)
		_ = cmd.Wait()
		stop()
		cs.mu.Lock()
		delete(cs.open, c.id)
		cs.mu.Unlock()
		_ = cs.out.write(event{Event: "channel.exit", Params: exitEvent{Channel: c.id, ExitCode: cmd.ProcessState.ExitCode(), Stderr: strings.TrimSpace(stderr.String())}})
	}()
	return &openResult{Channel: c.id, Path: path}, nil
}

// wait returns once every channel's process has exited and been reported.
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
		return nil, &Error{Code: "bad_params", Message: "channel.ack needs a positive byte count"}
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

func (cs *channels) kill(params channelParams) (any, *Error) {
	c, err := cs.get(params.Channel)
	if err != nil {
		return nil, err
	}
	c.stop()
	return struct{}{}, nil
}

// stop kills the process's group and drops whatever it still prints.
func (c *channel) stop() {
	c.mu.Lock()
	c.stopped = true
	c.changed.Broadcast()
	c.mu.Unlock()
	_ = proc.Kill(c.cmd)
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
