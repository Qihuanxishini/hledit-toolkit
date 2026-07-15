package main

import (
	"os"
)

// atomicWrite writes content to path atomically by using a temporary file.
// It follows the specification in SPEC.md §4.3.
func atomicWrite(path string, content []byte) error {
	tmpPath := path + ".hledit.tmp"

	// Resolve the temp file permissions: try to match the original file's mode.
	// If the original doesn't exist (new file), fall back to 0666 (os.Create default).
	var fileMode os.FileMode = 0666
	if info, err := os.Stat(path); err == nil {
		fileMode = info.Mode().Perm()
	}

	// 1. Create a temp file next to the target: path + ".hledit.tmp".
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fileMode)
	if err != nil {
		return err
	}

	// We'll use a helper function to handle the writing and syncing
	// and ensure the file is closed and potentially cleaned up.
	err = func() error {
		defer f.Close()

		// 2. Write content to the temp file.
		if _, err := f.Write(content); err != nil {
			return err
		}

		// 3. Sync the temp file (f.Sync()) to flush to disk.
		if err := f.Sync(); err != nil {
			return err
		}

		return nil
	}()

	if err != nil {
		// 6. On ANY error, attempt to clean up the temp file (os.Remove) and return the error.
		_ = os.Remove(tmpPath)
		return err
	}

	// 5. os.Rename the temp file over the original path (atomic on POSIX).
	if err := os.Rename(tmpPath, path); err != nil {
		// 6. On ANY error, attempt to clean up the temp file (os.Remove) and return the error.
		_ = os.Remove(tmpPath)
		return err
	}

	return nil
}
