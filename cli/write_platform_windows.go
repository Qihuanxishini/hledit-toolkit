//go:build windows

package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

var replaceFileW = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW")

func fileLinkCount(path string, _ os.FileInfo) (uint64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return 0, err
	}
	return uint64(info.NumberOfLinks), nil
}

func createTemporarySibling(targetPath string, info os.FileInfo) (*os.File, error) {
	if info == nil {
		return os.CreateTemp(filepath.Dir(targetPath), ".hledit-*")
	}
	sd, err := windows.GetNamedSecurityInfo(targetPath, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	// [喵喵喵]: 创建时即附带目标 DACL，防止其他账户在稍后收紧权限前抢先打开临时文件。(2026-09-24)
	attributes := windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd,
	}
	for range 10 {
		tempPath := filepath.Join(filepath.Dir(targetPath), ".hledit-"+rand.Text())
		name, err := windows.UTF16PtrFromString(tempPath)
		if err != nil {
			return nil, err
		}
		handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			&attributes, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if errors.Is(err, windows.ERROR_FILE_EXISTS) || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return os.NewFile(uintptr(handle), tempPath), nil
	}
	return nil, fmt.Errorf("could not reserve a unique temporary file")
}

// replaceFileWindows 是 Windows 部分替换失败的测试 seam；生产环境调用 ReplaceFileW。
var replaceFileWindows = callReplaceFileWindows

func callReplaceFileWindows(targetPath, tempPath, backupPath string) error {
	target, err := windows.UTF16PtrFromString(targetPath)
	if err != nil {
		return err
	}
	temp, err := windows.UTF16PtrFromString(tempPath)
	if err != nil {
		return err
	}
	backup, err := windows.UTF16PtrFromString(backupPath)
	if err != nil {
		return err
	}
	// [喵喵喵]: flags=0 要求权限与流合并成功；不能用忽略合并错误的标志换取表面成功。(2026-09-24)
	replaced, _, callErr := replaceFileW.Call(
		uintptr(unsafe.Pointer(target)), uintptr(unsafe.Pointer(temp)), uintptr(unsafe.Pointer(backup)), 0, 0, 0,
	)
	if replaced != 0 {
		return nil
	}
	if callErr != windows.ERROR_SUCCESS {
		return callErr
	}
	return fmt.Errorf("ReplaceFileW failed without an operating-system error")
}

// moveFileWithoutReplace 在目标路径已被占用时失败，从不覆盖已有文件。
func moveFileWithoutReplace(fromPath, toPath string) error {
	from, err := windows.UTF16PtrFromString(fromPath)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(toPath)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
}

func replaceFile(tempPath, targetPath string, targetExists bool) (string, error) {
	if !targetExists {
		return "", moveFileWithoutReplace(tempPath, targetPath)
	}

	backup, err := os.CreateTemp(filepath.Dir(targetPath), ".hledit-backup-*")
	if err != nil {
		return "", fmt.Errorf("reserve recovery file: %w", err)
	}
	backupPath := backup.Name()
	if err := backup.Close(); err != nil {
		_ = os.Remove(backupPath)
		return "", fmt.Errorf("close recovery file: %w", err)
	}
	if err := replaceFileWindows(targetPath, tempPath, backupPath); err != nil {
		return "", settleFailedReplacement(targetPath, tempPath, backupPath, err)
	}
	if err := os.Remove(backupPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Sprintf("file was replaced, but original recovery file %q could not be removed: %v", backupPath, err), nil
	}
	return "", nil
}

// settleFailedReplacement 把失败的 ReplaceFileW 归类为确定零写入或结果未知；
// 只有能证明原文件仍在目标路径时才清理本次预留的恢复文件。
func settleFailedReplacement(targetPath, tempPath, backupPath string, err error) error {
	unknown := func(cause error) error {
		return &writeOutcomeUnknownError{targetPath: targetPath, tempPath: tempPath, backupPath: backupPath, err: cause}
	}
	var errno windows.Errno
	if !errors.As(err, &errno) {
		return unknown(err)
	}
	if errors.Is(err, windows.ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) {
		// [喵喵喵]: 1177 按契约已把原文件移到 backupPath 并空出目标路径；不覆盖地移回，目标被他人占用时失败而非覆盖。(2026-09-24)
		if restoreErr := moveFileWithoutReplace(backupPath, targetPath); restoreErr != nil {
			return unknown(fmt.Errorf("%w; restoring the original file failed: %v", err, restoreErr))
		}
		return fmt.Errorf("%w; the original file was restored unchanged", err)
	}
	if _, statErr := os.Lstat(targetPath); statErr != nil {
		// [喵喵喵]: 文档外的错误码不能证明原文件未被移走；目标缺失时 backupPath 可能是唯一原始数据。(2026-09-24)
		return unknown(fmt.Errorf("%w; target could not be confirmed after the failed replacement: %v", err, statErr))
	}
	if cleanupErr := os.Remove(backupPath); cleanupErr != nil && !errors.Is(cleanupErr, os.ErrNotExist) {
		return fmt.Errorf("%w; recovery file %q could not be removed: %v", err, backupPath, cleanupErr)
	}
	return err
}
