package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// writeOutcomeUnknownError 表示替换可能已改变文件位置；相关文件必须留给恢复检查。
type writeOutcomeUnknownError struct {
	targetPath string
	tempPath   string
	backupPath string
	err        error
}

func (e *writeOutcomeUnknownError) Error() string {
	return fmt.Sprintf("write outcome unknown: %v; inspect target %q, replacement candidate %q, and original recovery file %q before editing; recovery files were retained", e.err, e.targetPath, e.tempPath, e.backupPath)
}

func (e *writeOutcomeUnknownError) Unwrap() error {
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
	targetPath        string
	tempPath          string
	targetExists      bool
	retainForRecovery bool
}

func (replacement *preparedAtomicReplacement) discard() {
	if !replacement.retainForRecovery {
		_ = os.Remove(replacement.tempPath)
	}
}

func (replacement *preparedAtomicReplacement) commit() (warning string, err error) {
	warning, err = replaceFile(replacement.tempPath, replacement.targetPath, replacement.targetExists)
	if err != nil {
		var unknownErr *writeOutcomeUnknownError
		if errors.As(err, &unknownErr) {
			// [喵喵喵]: 部分 Windows 替换失败会把原数据移入恢复文件，不能按普通临时文件清理。(2026-09-24)
			replacement.retainForRecovery = true
		}
		return "", fmt.Errorf("replace target %q: %w", replacement.targetPath, err)
	}
	return warning, nil
}

// prepareAtomicReplacement 在真实目标旁完成临时文件写入与同步，但不替换目标。
// [喵喵喵]: 不清理目录中滞留的 .hledit-* 文件——前缀+mtime 无法证明文件归属，
// 曾导致名为 .hledit-* 的真实目标在编辑前被误删（数据丢失）；孤儿临时文件残留是
// 可接受的代价，任何恢复清理的方案都必须能证明文件确由本工具创建。(2026-07-25)
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

	tempFile, err := createTemporarySibling(targetPath, targetInfo)
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
	if err := tempFile.Sync(); err != nil {
		return nil, fmt.Errorf("synchronize temporary file for %q: %w", targetPath, err)
	}
	if err := tempFile.Close(); err != nil {
		return nil, fmt.Errorf("close temporary file for %q: %w", targetPath, err)
	}
	removeTemp = false
	return &preparedAtomicReplacement{targetPath: targetPath, tempPath: tempPath, targetExists: targetExists}, nil
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
	currentRevision, revisionErr := rawFileRevisionFromPath(replacement.targetPath)
	if revisionErr != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: expectedRevision, err: revisionErr}
	}
	if currentRevision != expectedRevision {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: expectedRevision, CurrentRevision: currentRevision}
	}
	return replacement.commit()
}
