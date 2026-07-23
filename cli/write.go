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

// sourceChangedBeforeCommitError 表示临时文件已准备完成，但目标在替换前不再是规划时的 revision。
type sourceChangedBeforeCommitError struct {
	ExpectedRevision string
	CurrentRevision  string
	err              error
}

func (e *sourceChangedBeforeCommitError) Error() string {
	if e.err != nil {
		return fmt.Sprintf("source changed before commit: re-read current target: %v", e.err)
	}
	return fmt.Sprintf("source changed before commit: expected %s, current %s", e.ExpectedRevision, e.CurrentRevision)
}

func (e *sourceChangedBeforeCommitError) Unwrap() error {
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

type preparedAtomicReplacement struct {
	targetPath string
	tempPath   string
}

func (replacement *preparedAtomicReplacement) discard() {
	_ = os.Remove(replacement.tempPath)
}

func (replacement *preparedAtomicReplacement) commit() (warning string, err error) {
	if err := replaceFile(replacement.tempPath, replacement.targetPath); err != nil {
		var durabilityErr *postCommitDurabilityError
		if errors.As(err, &durabilityErr) {
			return durabilityErr.Error(), nil
		}
		return "", fmt.Errorf("replace target %q: %w", replacement.targetPath, err)
	}
	return "", nil
}

// prepareAtomicReplacement 在真实目标旁完成临时文件写入与同步，但不替换目标。
func prepareAtomicReplacement(path string, content []byte) (*preparedAtomicReplacement, error) {
	targetPath, err := resolveAtomicWriteTarget(path)
	if err != nil {
		return nil, err
	}

	targetInfo, statErr := os.Stat(targetPath)
	targetExists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, fmt.Errorf("inspect target %q: %w", targetPath, statErr)
	}
	if targetExists {
		if !targetInfo.Mode().IsRegular() {
			return nil, fmt.Errorf("refusing atomic write to non-regular file %q", targetPath)
		}
		linkCount, linkErr := fileLinkCount(targetPath, targetInfo)
		if linkErr != nil {
			return nil, fmt.Errorf("inspect hard links for %q: %w", targetPath, linkErr)
		}
		if linkCount > 1 {
			return nil, fmt.Errorf("refusing atomic write to %q: file has %d hard links; preserving link identity would require a non-atomic in-place write", targetPath, linkCount)
		}
	}

	tempFile, err := os.CreateTemp(filepath.Dir(targetPath), ".hledit-*")
	if err != nil {
		return nil, fmt.Errorf("create temporary sibling for %q: %w", targetPath, err)
	}
	tempPath := tempFile.Name()
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = tempFile.Close()
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := tempFile.Write(content); err != nil {
		return nil, fmt.Errorf("write temporary file for %q: %w", targetPath, err)
	}
	if targetExists {
		if err := tempFile.Chmod(targetInfo.Mode().Perm()); err != nil {
			return nil, fmt.Errorf("preserve permissions for %q: %w", targetPath, err)
		}
	}
	if err := tempFile.Sync(); err != nil {
		return nil, fmt.Errorf("synchronize temporary file for %q: %w", targetPath, err)
	}
	if err := tempFile.Close(); err != nil {
		return nil, fmt.Errorf("close temporary file for %q: %w", targetPath, err)
	}
	removeTemp = false
	return &preparedAtomicReplacement{targetPath: targetPath, tempPath: tempPath}, nil
}

// atomicWrite 在完整临时文件准备后原子替换目标。
func atomicWrite(path string, content []byte) (warning string, err error) {
	replacement, err := prepareAtomicReplacement(path, content)
	if err != nil {
		return "", err
	}
	defer replacement.discard()
	return replacement.commit()
}

// beforeAtomicRevisionCheck 是 plan/commit 竞争测试 seam；生产环境保持 no-op。
var beforeAtomicRevisionCheck = func(string) {}

// atomicWriteIfRevision 只在临时文件准备完成后目标仍匹配 expectedRevision 时执行替换。
func atomicWriteIfRevision(path string, content []byte, expectedRevision string) (warning string, err error) {
	replacement, err := prepareAtomicReplacement(path, content)
	if err != nil {
		return "", err
	}
	defer replacement.discard()

	beforeAtomicRevisionCheck(replacement.targetPath)
	currentContent, readErr := os.ReadFile(replacement.targetPath)
	if readErr != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: expectedRevision, err: readErr}
	}
	currentRevision := rawFileRevision(currentContent)
	if currentRevision != expectedRevision {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: expectedRevision, CurrentRevision: currentRevision}
	}
	return replacement.commit()
}
