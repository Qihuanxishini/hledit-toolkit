package main

import (
	"encoding/json"
	"errors"
	"os"
)

func emitJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func emitError(code, message string) error {
	return emitJSON(CommandError{OK: false, Error: code, Message: message})
}

// loadCommandTextFile maps the shared text boundary failures to the single JSON
// error contract consumed by read-range, search, and batch.
func loadCommandTextFile(path string) (LoadedTextFile, bool) {
	file, err := loadTextFile(path)
	if err == nil {
		return file, true
	}
	switch {
	case errors.Is(err, errBinaryFile):
		_ = emitError("binary", "file appears to be binary")
	case errors.Is(err, errInvalidUTF8):
		_ = emitError("encoding", "file is not valid UTF-8")
	default:
		// [喵喵喵]: os.ReadFile 对目录返回的平台错误并不一致；仅在失败路径补 stat，避免正常读取多一次系统调用。
		if info, statErr := os.Stat(path); statErr == nil && info.IsDir() {
			_ = emitError("directory", "path is a directory; provide a regular text file")
		} else {
			_ = emitError("io", err.Error())
		}
	}
	return LoadedTextFile{}, false
}
