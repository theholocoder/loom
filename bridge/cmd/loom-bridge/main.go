// Command loom-bridge drives one Environment for the Loom Client. Main starts
// it as a child process and speaks the bridge protocol over its stdio; closing
// its stdin shuts it down. Run as `loom-bridge mcp`, it is instead Loom's own
// MCP server, which a Session's agent starts for Loom's tools.
package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/theholocoder/loom/bridge/mcp"
	"github.com/theholocoder/loom/bridge/protocol"
)

// version is the Client's version, set at build time with
// -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := mcp.Serve(os.Stdin, os.Stdout, version); err != nil {
			fmt.Fprintln(os.Stderr, "loom-bridge mcp:", err)
			os.Exit(1)
		}
		return
	}
	// Without a home, main can't expand `~` and says so.
	home, _ := os.UserHomeDir()
	machine := protocol.Machine{Shell: os.Getenv("SHELL"), Environ: os.Environ(), Home: home}
	// Native Windows has no login shell to ask; a $SHELL there comes from
	// something like Git Bash and isn't the Environment's.
	if runtime.GOOS == "windows" {
		machine.Shell = ""
	}
	// Without its own path, agents get no Loom tools.
	executable, _ := os.Executable()
	if err := protocol.Serve(os.Stdin, os.Stdout, protocol.Info{Version: version, Executable: executable}, machine); err != nil {
		fmt.Fprintln(os.Stderr, "loom-bridge:", err)
		os.Exit(1)
	}
}
