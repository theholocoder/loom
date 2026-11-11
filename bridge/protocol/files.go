package protocol

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type existsParams struct {
	Path string `json:"path"`
}

type existsResult struct {
	Exists bool `json:"exists"`
}

// pathExists says whether anything (a file, a folder, a link) is at a path.
func pathExists(params existsParams) (*existsResult, *Error) {
	if params.Path == "" {
		return nil, &Error{Code: "bad_params", Message: "files.exists needs a path"}
	}
	_, err := os.Lstat(params.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return &existsResult{Exists: false}, nil
	}
	if err != nil {
		return nil, &Error{Code: "stat_failed", Message: err.Error()}
	}
	return &existsResult{Exists: true}, nil
}

type copyParams struct {
	From string `json:"from"`
	To   string `json:"to"`
	// Paths are relative to both From and To, with `/` separators.
	Paths []string `json:"paths"`
}

type copyResult struct {
	Copied int `json:"copied"`
}

// copyFiles copies each path from one folder to the same place in another,
// creating the folders it needs. Files keep their permissions, and are cloned
// copy-on-write where the filesystem can; links are recreated as links.
func copyFiles(params copyParams) (*copyResult, *Error) {
	if params.From == "" || params.To == "" {
		return nil, &Error{Code: "bad_params", Message: "files.copy needs from and to"}
	}
	for _, path := range params.Paths {
		if !filepath.IsLocal(filepath.FromSlash(path)) {
			return nil, &Error{Code: "bad_params", Message: fmt.Sprintf("%q is not a path inside the folder", path)}
		}
	}
	for i, path := range params.Paths {
		local := filepath.FromSlash(path)
		if err := copyPath(filepath.Join(params.From, local), filepath.Join(params.To, local)); err != nil {
			return nil, &Error{Code: "copy_failed", Message: fmt.Sprintf("copied %d of %d files, then: %v", i, len(params.Paths), err)}
		}
	}
	return &copyResult{Copied: len(params.Paths)}, nil
}

func copyPath(from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Readlink(from)
		if err != nil {
			return err
		}
		return os.Symlink(target, to)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a file", from)
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if !clone(dst, src) {
		// On Linux, io.Copy between files uses copy_file_range, which some
		// filesystems also share blocks with.
		if _, err := io.Copy(dst, src); err != nil {
			dst.Close()
			return err
		}
	}
	return dst.Close()
}

type fileWriteParams struct {
	Path string `json:"path"`
	// JSON carries it as base64.
	Data []byte `json:"data"`
}

// writeFile writes a file whole, creating the folders it needs (private to
// the user), and replacing what was there. It is written beside its place
// and renamed in, so a reader never sees half of it.
func writeFile(params fileWriteParams) (*struct{}, *Error) {
	if params.Path == "" {
		return nil, &Error{Code: "bad_params", Message: "files.write needs a path"}
	}
	dir := filepath.Dir(params.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	tmp, err := os.CreateTemp(dir, ".loom-write-*")
	if err != nil {
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	_, err = tmp.Write(params.Data)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), params.Path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return nil, &Error{Code: "write_failed", Message: err.Error()}
	}
	return &struct{}{}, nil
}

type statParams struct {
	Root string `json:"root"`
	// Paths are relative to Root, with `/` separators.
	Paths []string `json:"paths"`
}

type fileStat struct {
	Size    int64 `json:"size"`
	MtimeNs int64 `json:"mtimeNs"`
}

type statResult struct {
	// One per path, in order: null for a path with nothing there, or outside Root.
	Files []*fileStat `json:"files"`
}

// statFiles reads the size and modification time of each path in a folder,
// without following a link at the end of a path, so a caller can tell when
// files change without reading them.
func statFiles(params statParams) (*statResult, *Error) {
	if params.Root == "" {
		return nil, &Error{Code: "bad_params", Message: "files.stat needs a root"}
	}
	files := make([]*fileStat, len(params.Paths))
	for i, path := range params.Paths {
		local := filepath.FromSlash(path)
		if !filepath.IsLocal(local) {
			continue
		}
		if info, err := os.Lstat(filepath.Join(params.Root, local)); err == nil {
			files[i] = &fileStat{Size: info.Size(), MtimeNs: info.ModTime().UnixNano()}
		}
	}
	return &statResult{Files: files}, nil
}
