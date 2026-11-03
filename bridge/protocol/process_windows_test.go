package protocol_test

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// running reports whether the process pid exists and has not exited.
func running(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	event, _ := windows.WaitForSingleObject(h, 0)
	return event == uint32(windows.WAIT_TIMEOUT)
}

// killStray kills a tool this test started that is still running, by the
// handle of the PID it reported, and waits for it to exit.
func killStray(pid int) {
	if !running(pid) {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = process.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for running(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
}
