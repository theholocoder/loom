package protocol

import (
	"os"
	"syscall"
)

// ficlone is the FICLONE ioctl: _IOW(0x94, 9, int).
const ficlone = 0x40049409

// clone makes dst share src's blocks, copy-on-write, on filesystems that can
// (Btrfs, XFS, bcachefs); it reports whether it did.
func clone(dst, src *os.File) bool {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, dst.Fd(), ficlone, src.Fd())
	return errno == 0
}
