// Command loom-bridge drives one Environment for the Loom Client. Main starts
// it as a child process and speaks the bridge protocol over its stdio; closing
// its stdin shuts it down.
package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/theholocoder/loom/bridge/protocol"
)

// version is the Client's version, set at build time with
// -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	host := protocol.Host{Shell: os.Getenv("SHELL"), Environ: os.Environ()}
	// Native Windows has no login shell to ask; a $SHELL there comes from
	// something like Git Bash and isn't the Environment's.
	if runtime.GOOS == "windows" {
		host.Shell = ""
	}
	if err := protocol.Serve(os.Stdin, os.Stdout, protocol.Info{Version: version}, host); err != nil {
		fmt.Fprintln(os.Stderr, "loom-bridge:", err)
		os.Exit(1)
	}
}
