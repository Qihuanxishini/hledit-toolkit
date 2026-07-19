//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	moveFileReplaceExisting = 0x1
	moveFileWriteThrough    = 0x8
)

var moveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

func fileLinkCount(path string, _ os.FileInfo) (uint64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info); err != nil {
		return 0, err
	}
	return uint64(info.NumberOfLinks), nil
}

func replaceFile(tempPath, targetPath string) error {
	tempPathUTF16, err := syscall.UTF16PtrFromString(tempPath)
	if err != nil {
		return err
	}
	targetPathUTF16, err := syscall.UTF16PtrFromString(targetPath)
	if err != nil {
		return err
	}

	moved, _, callErr := moveFileExW.Call(
		uintptr(unsafe.Pointer(tempPathUTF16)),
		uintptr(unsafe.Pointer(targetPathUTF16)),
		uintptr(moveFileReplaceExisting|moveFileWriteThrough),
	)
	if moved != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return fmt.Errorf("MoveFileExW failed without an operating-system error")
}
