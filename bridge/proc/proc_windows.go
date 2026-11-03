// Package proc starts the bridge's child processes in their own process group,
// so killing one also kills whatever it started.
package proc

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Isolate makes cancelling cmd's context kill cmd's whole process tree.
func Isolate(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return Kill(cmd) }
}

// Kill kills cmd's process tree. Short-lived commands have no Job Object (see
// Group), so it walks the tree with taskkill: tools installed through npm
// are .cmd shims, so killing only the process would leave its node child
// running.
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}

// Detach starts cmd in its own process group, so that it outlives the bridge
// and doesn't get the bridge's console signals.
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// A Group is a long-lived command in its own Job Object, with every process
// it starts: an agent and its tools. The job kills them all when its last
// handle closes, which the bridge holds, so they go even if the bridge
// crashes.
type Group struct {
	cmd *exec.Cmd

	mu sync.Mutex
	// job is zero once Wait has closed it, or when the command could not be
	// put in one, in which case Stop falls back to Kill.
	job windows.Handle
}

// Start starts cmd as a new Group. It starts cmd suspended and only resumes
// it once it is in its Job Object, so nothing it starts escapes the job.
// grace is unused: Windows has no SIGTERM, so Stop ends the job at once.
func Start(cmd *exec.Cmd, grace time.Duration) (*Group, error) {
	job, jobErr := newJob()
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = waitDelay
	}
	if err := cmd.Start(); err != nil {
		if jobErr == nil {
			_ = windows.CloseHandle(job)
		}
		return nil, err
	}
	pid := uint32(cmd.Process.Pid)
	if jobErr == nil {
		if err := assign(job, pid); err != nil {
			_ = windows.CloseHandle(job)
			job = 0
		}
	} else {
		job = 0
	}
	if err := resume(pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if job != 0 {
			_ = windows.CloseHandle(job)
		}
		return nil, fmt.Errorf("resuming %s: %w", cmd.Path, err)
	}
	return &Group{cmd: cmd, job: job}, nil
}

// Stop ends the whole job: there is no gentler signal to send on Windows.
// It returns at once; Wait returns once the command has exited.
func (g *Group) Stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.job != 0 {
		_ = windows.TerminateJobObject(g.job, 1)
		return
	}
	_ = Kill(g.cmd)
}

// Wait waits for the command to exit, then ends whatever it left running in
// its job. It returns the command's error.
func (g *Group) Wait() error {
	err := g.cmd.Wait()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.job != 0 {
		_ = windows.TerminateJobObject(g.job, 1)
		_ = windows.CloseHandle(g.job)
		g.job = 0
	}
	return err
}

// newJob creates a Job Object that kills its processes when its last handle
// closes.
func newJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func assign(job windows.Handle, pid uint32) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	return windows.AssignProcessToJobObject(job, process)
}

// resume resumes the main thread of a process started suspended, its only
// thread.
func resume(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		_ = windows.CloseHandle(thread)
		return err
	}
	return errors.New("its thread was not found")
}
