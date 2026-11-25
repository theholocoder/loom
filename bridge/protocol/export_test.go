package protocol

import "time"

// SetProbeSettleTimeout bounds how long the OpenCode probe waits for its
// plugins to settle, until the returned func puts the bound back.
func SetProbeSettleTimeout(d time.Duration) (restore func()) {
	was := probeSettleTimeout
	probeSettleTimeout = d
	return func() { probeSettleTimeout = was }
}
