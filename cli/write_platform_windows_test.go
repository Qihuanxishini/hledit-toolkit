//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func windowsTestDACL(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if sddl := sd.String(); sddl != "" {
		return sddl
	}
	t.Fatal("cannot format DACL")
	return ""
}

// windowsTestDACLComparable 忽略 auto-inherited 等继承记账标志，只比较保护状态与 ACE 实质。
// [喵喵喵]: 新建对象的显式 DACL 不带 AI 记账位，权限实质相同，不能按原始 SDDL 字符串比较。(2026-09-24)
func windowsTestDACLComparable(t *testing.T, path string) string {
	t.Helper()
	sddl := windowsTestDACL(t, path)
	index := strings.IndexByte(sddl, '(')
	if index < 0 {
		return sddl
	}
	prefix := "D:"
	if strings.Contains(sddl[:index], "P") {
		prefix = "D:P"
	}
	return prefix + sddl[index:]
}

func windowsTestRestrictFile(t *testing.T, path string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsAtomicWritePreservesMetadata(t *testing.T) {
	for _, restricted := range []bool{false, true} {
		name := "inherited DACL"
		if restricted {
			name = "protected DACL"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := commandTestWriteFile(t, dir, "target.txt", "old")
			if restricted {
				windowsTestRestrictFile(t, path)
			}
			before := windowsTestDACL(t, path)
			stream := path + ":reviewData"
			if err := os.WriteFile(stream, []byte("sentinel"), 0o600); err != nil {
				t.Fatal(err)
			}

			atomicWriteMustSucceed(t, path, []byte("new"))

			protocolTestAssertFile(t, path, "new")
			if after := windowsTestDACL(t, path); after != before {
				t.Errorf("DACL changed: before=%s after=%s", before, after)
			}
			protocolTestAssertFile(t, stream, "sentinel")
			assertNoAtomicTempFiles(t, dir)
		})
	}
}

func TestWindowsTemporaryFileUsesTargetDACL(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "private")
	windowsTestRestrictFile(t, path)
	before := windowsTestDACLComparable(t, path)
	replacement, err := prepareAtomicReplacement(path, []byte("new private contents"))
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.discard()
	if got := windowsTestDACLComparable(t, replacement.tempPath); got != before {
		t.Fatalf("temporary DACL = %s; want %s", got, before)
	}
	protocolTestAssertFile(t, path, "private")
}

func TestWindowsAtomicWriteSharingViolationIsZeroWrite(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old")
	pathUTF16, err := windows.UTF16PtrFromString(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(pathUTF16, windows.GENERIC_READ, windows.FILE_SHARE_READ,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if warning, err := atomicWrite(path, []byte("new")); err == nil || warning != "" {
		t.Fatalf("warning=%q err=%v; want zero-write failure", warning, err)
	}
	protocolTestAssertFile(t, path, "old")
	assertNoAtomicTempFiles(t, dir)
}

// windowsTestSimulatePartialReplacement 模拟官方定义的 1177：原文件已改名到恢复路径，
// 候选文件也已继承附加流；occupy 非空时再由“其他进程”占用目标路径。
func windowsTestSimulatePartialReplacement(t *testing.T, occupy string) {
	t.Helper()
	originalCall := replaceFileWindows
	t.Cleanup(func() { replaceFileWindows = originalCall })
	replaceFileWindows = func(target, temp, backup string) error {
		if err := os.Rename(target, backup); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(temp+":reviewData", []byte("sentinel"), 0o600); err != nil {
			t.Fatal(err)
		}
		if occupy != "" {
			if err := os.WriteFile(target, []byte(occupy), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return windows.ERROR_UNABLE_TO_MOVE_REPLACEMENT_2
	}
}

func TestWindowsPartialReplacementRestoresOriginal(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old\n")
	if err := os.WriteFile(path+":reviewData", []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	windowsTestSimulatePartialReplacement(t, "")
	var result BatchEditError
	batchTestMustUnmarshal(t, batchTestRun(t, path, BatchEditRequest{
		Edits: []BatchEditOp{{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{"new"}}},
	}, false), &result)
	if result.OK || result.Error != "io" || !strings.Contains(result.Message, "original file was restored") {
		t.Fatalf("result=%+v; want confirmed zero-write io failure", result)
	}
	protocolTestAssertFile(t, path, "old\n")
	protocolTestAssertFile(t, path+":reviewData", "sentinel")
	assertNoAtomicTempFiles(t, dir)
}

func TestWindowsPartialReplacementRetainsRecoveryFilesWhenTargetIsOccupied(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old\n")
	windowsTestSimulatePartialReplacement(t, "created by another process")
	requestPath := commandTestWriteFile(t, dir, "request.json",
		`{"edits":[{"op":"replace","pos":"`+formatTag(1, "old")+`","lines":["new"]}]}`)
	input, err := os.Open(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	previousStdin := os.Stdin
	os.Stdin = input
	defer func() { os.Stdin = previousStdin }()
	var commandErr error
	output := commandTestCaptureStdout(t, func() { commandErr = runBatchApply(path) })
	var unknown *writeOutcomeUnknownError
	if !errors.As(commandErr, &unknown) || output != "" {
		t.Fatalf("err=%v stdout=%q; want propagated unknown outcome, not zero-write JSON", commandErr, output)
	}
	protocolTestAssertFile(t, path, "created by another process")
	protocolTestAssertFile(t, unknown.backupPath, "old\n")
	protocolTestAssertFile(t, unknown.tempPath, "new\n")
	protocolTestAssertFile(t, unknown.tempPath+":reviewData", "sentinel")
	// [喵喵喵]: 插件依据该短语保留完整诊断并切换恢复指引，措辞变更必须同步 src/result.ts。
	if !strings.Contains(unknown.Error(), "recovery files were retained") {
		t.Fatalf("missing plugin recovery marker: %v", unknown)
	}
	for _, retained := range []string{unknown.targetPath, unknown.backupPath, unknown.tempPath} {
		if !strings.Contains(unknown.Error(), filepath.Base(retained)) {
			t.Fatalf("missing recovery diagnostic for %q: %v", retained, unknown)
		}
	}
}

func TestWindowsUndocumentedFailureWithMissingTargetIsUnknown(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old")
	originalCall := replaceFileWindows
	t.Cleanup(func() { replaceFileWindows = originalCall })
	replaceFileWindows = func(target, _, backup string) error {
		if err := os.Rename(target, backup); err != nil {
			t.Fatal(err)
		}
		return windows.ERROR_ACCESS_DENIED
	}
	warning, err := atomicWrite(path, []byte("new"))
	var unknown *writeOutcomeUnknownError
	if warning != "" || !errors.As(err, &unknown) {
		t.Fatalf("warning=%q err=%v; want unknown outcome", warning, err)
	}
	protocolTestAssertFile(t, unknown.backupPath, "old")
	protocolTestAssertFile(t, unknown.tempPath, "new")
}

func TestWindowsKnownReplacementFailuresCleanOnlyOwnedFiles(t *testing.T) {
	for _, cause := range []error{windows.ERROR_UNABLE_TO_REMOVE_REPLACED, windows.ERROR_UNABLE_TO_MOVE_REPLACEMENT, windows.ERROR_ACCESS_DENIED} {
		t.Run(cause.Error(), func(t *testing.T) {
			dir := t.TempDir()
			path := commandTestWriteFile(t, dir, "target.txt", "old")
			originalCall := replaceFileWindows
			t.Cleanup(func() { replaceFileWindows = originalCall })
			replaceFileWindows = func(_, _, _ string) error { return cause }
			warning, err := atomicWrite(path, []byte("new"))
			var unknown *writeOutcomeUnknownError
			if warning != "" || !errors.Is(err, cause) || errors.As(err, &unknown) {
				t.Fatalf("warning=%q err=%v; want known zero-write failure", warning, err)
			}
			protocolTestAssertFile(t, path, "old")
			assertNoAtomicTempFiles(t, dir)
		})
	}
}

func TestWindowsSuccessfulReplaceReportsRecoveryCleanupWarning(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old")
	originalCall := replaceFileWindows
	t.Cleanup(func() { replaceFileWindows = originalCall })
	var backupPath string
	replaceFileWindows = func(target, temp, backup string) error {
		if err := originalCall(target, temp, backup); err != nil {
			return err
		}
		backupPath = backup
		name, err := windows.UTF16PtrFromString(backup)
		if err != nil {
			t.Fatal(err)
		}
		handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ,
			nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { windows.CloseHandle(handle) })
		return nil
	}
	warning, err := atomicWrite(path, []byte("new"))
	if err != nil || !strings.Contains(warning, "file was replaced") || !strings.Contains(warning, filepath.Base(backupPath)) {
		t.Fatalf("warning=%q err=%v; want successful write with recovery cleanup warning", warning, err)
	}
	protocolTestAssertFile(t, path, "new")
	protocolTestAssertFile(t, backupPath, "old")
}

func TestWindowsReadOnlyTargetIsZeroWrite(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "old")
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	if warning, err := atomicWrite(path, []byte("new")); err == nil || warning != "" {
		t.Fatalf("warning=%q err=%v; want read-only rejection", warning, err)
	}
	protocolTestAssertFile(t, path, "old")
	assertNoAtomicTempFiles(t, dir)
}
