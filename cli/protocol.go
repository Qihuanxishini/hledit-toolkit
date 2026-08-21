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
		_ = emitError("io", err.Error())
	}
	return LoadedTextFile{}, false
}
