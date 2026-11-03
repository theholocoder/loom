//go:build !linux

package protocol

import "os"

// clone never clones outside Linux; the caller copies instead.
func clone(dst, src *os.File) bool {
	return false
}
