// Command loom-bridge drives one Environment for the Loom Client. Main starts
// it as a child process and speaks the bridge protocol over its stdio; closing
// its stdin shuts it down.
package main

import (
	"fmt"
	"os"

	"github.com/theholocoder/loom/bridge/protocol"
)

// version is the Client's version, set at build time with
// -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	if err := protocol.Serve(os.Stdin, os.Stdout, protocol.Info{Version: version}); err != nil {
		fmt.Fprintln(os.Stderr, "loom-bridge:", err)
		os.Exit(1)
	}
}
