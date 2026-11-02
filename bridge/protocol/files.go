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
