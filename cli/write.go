package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// postCommitDurabilityError 表示目标文件已经替换成功，但目录元数据未能持久化。
// 调用方必须把它作为“已写入但持久性降级”处理，不能误报为零修改。
type postCommitDurabilityError struct {
	err error
}

func (e *postCommitDurabilityError) Error() string {
	return fmt.Sprintf("file was replaced, but directory metadata could not be synchronized: %v", e.err)
}

func (e *postCommitDurabilityError) Unwrap() error {
	return e.err
}

func resolveAtomicWriteTarget(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("resolve target %q: %w", path, err)
	}

	// 已存在但目标缺失的 symlink 不能当作普通新文件覆盖，否则会悄悄破坏链接。
	if _, lstatErr := os.Lstat(path); lstatErr == nil {
		return "", fmt.Errorf("resolve target %q: %w", path, err)
	} else if !errors.Is(lstatErr, fs.ErrNotExist) {
		return "", fmt.Errorf("inspect target %q: %w", path, lstatErr)
	}

	resolvedParent, parentErr := filepath.EvalSymlinks(filepath.Dir(path))
	if parentErr != nil {
		return "", fmt.Errorf("resolve parent of %q: %w", path, parentErr)
	}
	return filepath.Join(resolvedParent, filepath.Base(path)), nil
}

// atomicWrite 在真实目标旁创建唯一临时文件；成功时保留 symlink，并拒绝破坏 hardlink 关系。
// warning 非空表示内容已替换，但目录持久化失败；err 仅表示替换前或替换本身失败。
func atomicWrite(path string, content []byte) (warning string, err error) {
	targetPath, err := resolveAtomicWriteTarget(path)
	if err != nil {
		return "", err
	}

	targetInfo, statErr := os.Stat(targetPath)
	targetExists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return "", fmt.Errorf("inspect target %q: %w", targetPath, statErr)
	}
	if targetExists {
		if !targetInfo.Mode().IsRegular() {
			return "", fmt.Errorf("refusing atomic write to non-regular file %q", targetPath)
		}
		linkCount, linkErr := fileLinkCount(targetPath, targetInfo)
		if linkErr != nil {
			return "", fmt.Errorf("inspect hard links for %q: %w", targetPath, linkErr)
		}
		if linkCount > 1 {
			return "", fmt.Errorf("refusing atomic write to %q: file has %d hard links; preserving link identity would require a non-atomic in-place write", targetPath, linkCount)
		}
	}

	tempFile, err := os.CreateTemp(filepath.Dir(targetPath), ".hledit-*")
	if err != nil {
		return "", fmt.Errorf("create temporary sibling for %q: %w", targetPath, err)
	}
	tempPath := tempFile.Name()
	tempOpen := true
	defer func() {
		if tempOpen {
			_ = tempFile.Close()
		}
		_ = os.Remove(tempPath)
	}()

	if _, err := tempFile.Write(content); err != nil {
		return "", fmt.Errorf("write temporary file for %q: %w", targetPath, err)
	}
	if targetExists {
		if err := tempFile.Chmod(targetInfo.Mode().Perm()); err != nil {
			return "", fmt.Errorf("preserve permissions for %q: %w", targetPath, err)
		}
	}
	if err := tempFile.Sync(); err != nil {
		return "", fmt.Errorf("synchronize temporary file for %q: %w", targetPath, err)
	}
	if err := tempFile.Close(); err != nil {
		return "", fmt.Errorf("close temporary file for %q: %w", targetPath, err)
	}
	tempOpen = false

	if err := replaceFile(tempPath, targetPath); err != nil {
		var durabilityErr *postCommitDurabilityError
		if errors.As(err, &durabilityErr) {
			return durabilityErr.Error(), nil
		}
		return "", fmt.Errorf("replace target %q: %w", targetPath, err)
	}
	return "", nil
}
