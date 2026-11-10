package protocol

import (
	"errors"
	"os"
	"os/exec"
	"time"

	"github.com/theholocoder/loom/bridge/proc"
)

// errNoTerminals is why a native Windows Environment can't open a terminal:
// Loom supports terminals on Unix and in WSL only.
var errNoTerminals = errors.New("terminals are not supported in a native Windows Environment; use WSL")

func startTerminal(*exec.Cmd, terminalSize, time.Duration) (*os.File, *proc.Group, error) {
	return nil, nil, errNoTerminals
}

func setTerminalSize(*os.File, terminalSize) error {
	return errNoTerminals
}
