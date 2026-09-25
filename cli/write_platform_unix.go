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

func createTemporarySibling(targetPath string, info os.FileInfo) (*os.File, error) {
	temp, err := os.CreateTemp(filepath.Dir(targetPath), ".hledit-*")
	if err != nil {
		return nil, err
	}
	if info != nil {
		if err := temp.Chmod(info.Mode().Perm()); err != nil {
			_ = temp.Close()
			_ = os.Remove(temp.Name())
			return nil, fmt.Errorf("preserve permissions: %w", err)
		}
	}
	return temp, nil
}

func replaceFile(tempPath, targetPath string, _ bool) (string, error) {
	if err := os.Rename(tempPath, targetPath); err != nil {
		return "", err
	}

	parent, err := os.Open(filepath.Dir(targetPath))
	if err != nil {
		return fmt.Sprintf("file was replaced, but directory metadata could not be synchronized: %v", err), nil
	}
	defer parent.Close()
	if err := parent.Sync(); err != nil {
		return fmt.Sprintf("file was replaced, but directory metadata could not be synchronized: %v", err), nil
	}
	return "", nil
}
