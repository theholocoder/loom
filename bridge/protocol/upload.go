package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// uploadIdleTimeout is how long an upload may go without a chunk before it
// is dropped with what it wrote.
var uploadIdleTimeout = 2 * time.Minute

// uploads are the files main is sending in chunks, by id: each is written
// beside its place, hashed as it goes, and renamed in once whole (see
// files.upload.begin, files.upload.chunk and files.upload.end).
type uploads struct {
	mu   sync.Mutex
	next int
	open map[string]*upload
}

type upload struct {
	mu      sync.Mutex
	path    string
	size    int64
	sha256  string
	file    *os.File
	hash    hash.Hash
	written int64
	idle    *time.Timer
	touched time.Time
}

func newUploads() *uploads {
	return &uploads{open: map[string]*upload{}}
}

type uploadBeginParams struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

type uploadBeginResult struct {
	Upload  string `json:"upload,omitempty"`
	Present bool   `json:"present"`
}

// begin starts an upload of a file of Size bytes hashing to Sha256 at Path,
// or says it is there already, so nothing need be sent.
func (u *uploads) begin(params uploadBeginParams) (*uploadBeginResult, *Error) {
	if params.Path == "" || params.Size < 0 || !isSha256(params.Sha256) {
		return nil, &Error{Code: "bad_params", Message: "files.upload.begin needs a path, a size and a sha256"}
	}
	if isPresent(params.Path, params.Size, strings.ToLower(params.Sha256)) {
		return &uploadBeginResult{Present: true}, nil
	}
	file, err := createBeside(params.Path)
	if err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.next++
	id := strconv.Itoa(u.next)
	up := &upload{path: params.Path, size: params.Size, sha256: strings.ToLower(params.Sha256), file: file, hash: sha256.New(), touched: time.Now()}
	up.idle = time.AfterFunc(uploadIdleTimeout, func() { u.expire(id, up) })
	u.open[id] = up
	return &uploadBeginResult{Upload: id}, nil
}

type uploadChunkParams struct {
	Upload string `json:"upload"`
	Offset int64  `json:"offset"`
	// JSON carries it as base64.
	Data []byte `json:"data"`
}

// chunk writes the next bytes of an upload: Offset must be what it has
// written so far, as chunks come one at a time and in order.
func (u *uploads) chunk(params uploadChunkParams) (*struct{}, *Error) {
	up := u.find(params.Upload)
	if up == nil {
		return nil, unknownUpload(params.Upload)
	}
	up.mu.Lock()
	defer up.mu.Unlock()
	if up.file == nil {
		return nil, unknownUpload(params.Upload)
	}
	if params.Offset != up.written {
		return nil, &Error{Code: "bad_offset", Message: fmt.Sprintf("the upload has %d bytes, not %d", up.written, params.Offset)}
	}
	if up.written+int64(len(params.Data)) > up.size {
		return nil, &Error{Code: "too_large", Message: fmt.Sprintf("the upload is of %d bytes", up.size)}
	}
	if _, err := up.file.Write(params.Data); err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	up.hash.Write(params.Data)
	up.written += int64(len(params.Data))
	up.touched = time.Now()
	up.idle.Reset(uploadIdleTimeout)
	return &struct{}{}, nil
}

type uploadParams struct {
	Upload string `json:"upload"`
}

// end puts a whole upload in its place, once its size and hash check out;
// otherwise it drops it.
func (u *uploads) end(params uploadParams) (*struct{}, *Error) {
	up := u.take(params.Upload)
	if up == nil {
		return nil, unknownUpload(params.Upload)
	}
	up.mu.Lock()
	defer up.mu.Unlock()
	if up.file == nil {
		return nil, unknownUpload(params.Upload)
	}
	up.idle.Stop()
	file := up.file
	up.file = nil
	if up.written != up.size {
		discard(file)
		return nil, &Error{Code: "incomplete", Message: fmt.Sprintf("the upload has %d of its %d bytes", up.written, up.size)}
	}
	if hex.EncodeToString(up.hash.Sum(nil)) != up.sha256 {
		discard(file)
		return nil, &Error{Code: "hash_mismatch", Message: "the upload's content doesn't hash to its sha256"}
	}
	if err := putInPlace(file, up.path); err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	return &struct{}{}, nil
}

// abort drops an upload with what it wrote.
func (u *uploads) abort(params uploadParams) (*struct{}, *Error) {
	if !u.drop(params.Upload) {
		return nil, unknownUpload(params.Upload)
	}
	return &struct{}{}, nil
}

// abortAll drops every upload still open, as when main goes.
func (u *uploads) abortAll() {
	u.mu.Lock()
	ids := make([]string, 0, len(u.open))
	for id := range u.open {
		ids = append(ids, id)
	}
	u.mu.Unlock()
	for _, id := range ids {
		u.drop(id)
	}
}

// expire drops an upload its idle timer fired for, unless a chunk came while
// the timer waited on it.
func (u *uploads) expire(id string, up *upload) {
	up.mu.Lock()
	idle := time.Since(up.touched) >= uploadIdleTimeout
	up.mu.Unlock()
	if idle {
		u.drop(id)
	}
}

func (u *uploads) find(id string) *upload {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.open[id]
}

func (u *uploads) take(id string) *upload {
	u.mu.Lock()
	defer u.mu.Unlock()
	up := u.open[id]
	delete(u.open, id)
	return up
}

func (u *uploads) drop(id string) bool {
	up := u.take(id)
	if up == nil {
		return false
	}
	up.mu.Lock()
	defer up.mu.Unlock()
	up.idle.Stop()
	if up.file != nil {
		discard(up.file)
		up.file = nil
	}
	return true
}

func unknownUpload(id string) *Error {
	return &Error{Code: "unknown_upload", Message: fmt.Sprintf("no upload %q is open", id)}
}

type copyToParams struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

type copyToResult struct {
	Present bool `json:"present"`
}

// copyTo puts a copy of a file on this machine at To, cloned copy-on-write
// where the filesystem can, replacing what was there; or says it is there
// already, of Size bytes hashing to Sha256.
func copyTo(params copyToParams) (*copyToResult, *Error) {
	if params.From == "" || params.To == "" || params.Size < 0 || !isSha256(params.Sha256) {
		return nil, &Error{Code: "bad_params", Message: "files.copyTo needs from, to, a size and a sha256"}
	}
	if isPresent(params.To, params.Size, strings.ToLower(params.Sha256)) {
		return &copyToResult{Present: true}, nil
	}
	if err := copyInPlace(params.From, params.To); err != nil {
		return nil, &Error{Code: "copy_failed", Message: err.Error()}
	}
	return &copyToResult{}, nil
}

func copyInPlace(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	if info, err := src.Stat(); err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a file", from)
	}
	dst, err := createBeside(to)
	if err != nil {
		return err
	}
	if !clone(dst, src) {
		if _, err := io.Copy(dst, src); err != nil {
			discard(dst)
			return err
		}
	}
	return putInPlace(dst, to)
}

type removeParams struct {
	Path string `json:"path"`
}

// removePath removes a file or a folder with all in it; nothing there is no error.
func removePath(params removeParams) (*struct{}, *Error) {
	if params.Path == "" {
		return nil, &Error{Code: "bad_params", Message: "files.remove needs a path"}
	}
	if err := os.RemoveAll(params.Path); err != nil {
		return nil, &Error{Code: "remove_failed", Message: err.Error()}
	}
	return &struct{}{}, nil
}

// isPresent says whether a regular file of size bytes hashing to sha is at path.
func isPresent(path string, size int64, sha string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == sha
}

// createBeside makes an empty file next to path, in the folders it needs
// (private to the user), for putInPlace to rename in.
func createBeside(path string) (*os.File, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return os.CreateTemp(dir, ".loom-write-*")
}

// putInPlace closes a file made by createBeside and renames it to path,
// readable by all, or removes it on failure.
func putInPlace(file *os.File, path string) error {
	err := file.Close()
	if err == nil {
		err = os.Chmod(file.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(file.Name(), path)
	}
	if err != nil {
		os.Remove(file.Name())
	}
	return err
}

func discard(file *os.File) {
	file.Close()
	os.Remove(file.Name())
}

func isSha256(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
