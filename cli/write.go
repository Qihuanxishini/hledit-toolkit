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

// writeFailedBeforeReplaceError 保证 replaceFile 尚未被调用，因此可安全报告零提交。
type writeFailedBeforeReplaceError struct {
	err error
}

func (e *writeFailedBeforeReplaceError) Error() string {
	return fmt.Sprintf("write failed before replace: %v", e.err)
}

func (e *writeFailedBeforeReplaceError) Unwrap() error {
	return e.err
}

func resolveAtomicWriteTarget(path string) (string, error) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve absolute target %q: %w", path, err)
	}
	resolved, err := filepath.EvalSymlinks(absolutePath)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("resolve target %q: %w", absolutePath, err)
	}

	// 已存在但目标缺失的 symlink 不能当作普通新文件覆盖，否则会悄悄破坏链接。
	if _, lstatErr := os.Lstat(absolutePath); lstatErr == nil {
		return "", fmt.Errorf("resolve target %q: %w", absolutePath, err)
	} else if !errors.Is(lstatErr, fs.ErrNotExist) {
		return "", fmt.Errorf("inspect target %q: %w", absolutePath, lstatErr)
	}

	resolvedParent, parentErr := filepath.EvalSymlinks(filepath.Dir(absolutePath))
	if parentErr != nil {
		return "", fmt.Errorf("resolve parent of %q: %w", absolutePath, parentErr)
	}
	return filepath.Join(resolvedParent, filepath.Base(absolutePath)), nil
}

type preparedAtomicReplacement struct {
	targetPath   string
	tempPath     string
	targetInfo   os.FileInfo
	parentInfo   os.FileInfo
	targetExists bool
}

func (replacement *preparedAtomicReplacement) discard() {
	_ = os.Remove(replacement.tempPath)
}

func (replacement *preparedAtomicReplacement) validateIdentity() error {
	parentPath := filepath.Dir(replacement.targetPath)
	parentInfo, err := os.Lstat(parentPath)
	if err != nil {
		return fmt.Errorf("inspect target parent %q: %w", parentPath, err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() || !os.SameFile(replacement.parentInfo, parentInfo) {
		return fmt.Errorf("target parent identity changed for %q", replacement.targetPath)
	}

	targetInfo, err := os.Lstat(replacement.targetPath)
	if !replacement.targetExists {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect target %q: %w", replacement.targetPath, err)
		}
		return fmt.Errorf("target was created before commit: %q", replacement.targetPath)
	}
	if err != nil {
		return fmt.Errorf("inspect target %q: %w", replacement.targetPath, err)
	}
	if targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.Mode().IsRegular() || !os.SameFile(replacement.targetInfo, targetInfo) {
		return fmt.Errorf("target identity changed for %q", replacement.targetPath)
	}
	linkCount, err := fileLinkCount(replacement.targetPath, targetInfo)
	if err != nil {
		return fmt.Errorf("inspect hard links for %q: %w", replacement.targetPath, err)
	}
	if linkCount > 1 {
		return fmt.Errorf("target %q gained hard links before commit", replacement.targetPath)
	}
	return nil
}

func (replacement *preparedAtomicReplacement) validateReadIdentity(target snaplineLoadedTarget) error {
	if !replacement.targetExists || !os.SameFile(target.Info, replacement.targetInfo) {
		return fmt.Errorf("target identity changed since snapshot read for %q", replacement.targetPath)
	}
	if !os.SameFile(target.ParentInfo, replacement.parentInfo) {
		return fmt.Errorf("target parent identity changed since snapshot read for %q", replacement.targetPath)
	}
	return nil
}

// replaceSnaplineFile 是原子替换结果分类测试 seam；生产环境始终指向平台实现。
var replaceSnaplineFile = replaceFile

func (replacement *preparedAtomicReplacement) commit() (warning string, err error) {
	if err := replaceSnaplineFile(replacement.tempPath, replacement.targetPath); err != nil {
		var durabilityErr *postCommitDurabilityError
		if errors.As(err, &durabilityErr) {
			return durabilityErr.Error(), nil
		}
		return "", fmt.Errorf("replace target %q: %w", replacement.targetPath, err)
	}
	return "", nil
}

// prepareAtomicReplacement 在真实目标旁完成临时文件写入与同步，但不替换目标。
// [喵喵喵]: 不清理目录中滞留的 .snapline-* 文件；前缀和 mtime 不能证明归属，
// 自动清理可能删除用户文件。异常终止遗留物只能在确认后由用户处理。(2026-07-31)
func prepareAtomicReplacement(path string, content []byte) (*preparedAtomicReplacement, error) {
	targetPath, err := resolveAtomicWriteTarget(path)
	if err != nil {
		return nil, err
	}
	parentPath := filepath.Dir(targetPath)
	parentInfo, err := os.Lstat(parentPath)
	if err != nil {
		return nil, fmt.Errorf("inspect target parent %q: %w", parentPath, err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return nil, fmt.Errorf("refusing atomic write through non-directory parent %q", parentPath)
	}

	targetInfo, statErr := os.Lstat(targetPath)
	targetExists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, fmt.Errorf("inspect target %q: %w", targetPath, statErr)
	}
	if targetExists {
		if targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.Mode().IsRegular() {
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

	tempFile, err := os.CreateTemp(parentPath, ".snapline-*")
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
	return &preparedAtomicReplacement{
		targetPath: targetPath, tempPath: tempPath, targetInfo: targetInfo,
		parentInfo: parentInfo, targetExists: targetExists,
	}, nil
}

// beforeAtomicRevisionCheck 是 plan/commit 竞争测试 seam；生产环境保持 no-op。
var beforeAtomicRevisionCheck = func(string) {}

// replaceSnaplineTarget 将 snapshot read 捕获的文件/父目录身份与 raw revision 一并
// 绑定到提交；即使外部把路径替换为相同字节的新 inode，也会 fail closed。
func replaceSnaplineTarget(target snaplineLoadedTarget, content []byte) (warning string, err error) {
	replacement, err := prepareAtomicReplacement(target.CanonicalPath, content)
	if err != nil {
		return "", &writeFailedBeforeReplaceError{err: err}
	}
	defer replacement.discard()

	if err := replacement.validateReadIdentity(target); err != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: err}
	}
	beforeAtomicRevisionCheck(replacement.targetPath)
	if err := replacement.validateIdentity(); err != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: err}
	}
	if err := replacement.validateReadIdentity(target); err != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: err}
	}
	currentRevision, revisionErr := rawFileRevisionFromPath(replacement.targetPath)
	if revisionErr != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: revisionErr}
	}
	if currentRevision != target.File.Revision {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, CurrentRevision: currentRevision}
	}
	if err := replacement.validateIdentity(); err != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: err}
	}
	if err := replacement.validateReadIdentity(target); err != nil {
		return "", &sourceChangedBeforeCommitError{ExpectedRevision: target.File.Revision, err: err}
	}
	return replacement.commit()
}
