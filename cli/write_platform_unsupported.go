//go:build !windows && !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package main

import (
	"fmt"
	"os"
	"runtime"
)

func fileLinkCount(_ string, _ os.FileInfo) (uint64, error) {
	return 0, fmt.Errorf("hard-link safety is unsupported on %s", runtime.GOOS)
}

func replaceFile(_, _ string) error {
	return fmt.Errorf("atomic replacement is unsupported on %s", runtime.GOOS)
}
