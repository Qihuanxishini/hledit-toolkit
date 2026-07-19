//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func fileLinkCount(_ string, info os.FileInfo) (uint64, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("unexpected file metadata type %T", info.Sys())
	}
	return uint64(stat.Nlink), nil
}

func replaceFile(tempPath, targetPath string) error {
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}

	parent, err := os.Open(filepath.Dir(targetPath))
	if err != nil {
		return &postCommitDurabilityError{err: err}
	}
	defer parent.Close()
	if err := parent.Sync(); err != nil {
		return &postCommitDurabilityError{err: err}
	}
	return nil
}
