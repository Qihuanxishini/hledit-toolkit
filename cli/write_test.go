package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func atomicWriteMustSucceed(t *testing.T, path string, content []byte) {
	t.Helper()
	warning, err := atomicWrite(path, content)
	if err != nil {
		t.Fatalf("atomicWrite(%q) failed: %v", path, err)
	}
	if warning != "" {
		t.Fatalf("atomicWrite(%q) warning = %q; want none", path, warning)
	}
}

func assertNoAtomicTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".hledit-") {
			t.Fatalf("found leftover temporary file %q", entry.Name())
		}
	}
}

func TestAtomicWrite(t *testing.T) {
	t.Run("creates and overwrites with no temporary residue", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "test.txt")
		atomicWriteMustSucceed(t, target, []byte("hello world"))
		beforeOverwrite, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		atomicWriteMustSucceed(t, target, []byte("new content"))

		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, []byte("new content")) {
			t.Fatalf("target content = %q; want %q", got, "new content")
		}
		afterOverwrite, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if afterOverwrite.Mode().Perm() != beforeOverwrite.Mode().Perm() {
			t.Fatalf("target permissions = %v; want preserved %v", afterOverwrite.Mode().Perm(), beforeOverwrite.Mode().Perm())
		}
		assertNoAtomicTempFiles(t, dir)
	})

	t.Run("does not reuse the legacy fixed temporary path", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "test.txt")
		legacyTemp := target + ".hledit.tmp"
		if err := os.WriteFile(target, []byte("old"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacyTemp, []byte("sentinel"), 0644); err != nil {
			t.Fatal(err)
		}

		atomicWriteMustSucceed(t, target, []byte("new"))
		legacyContent, err := os.ReadFile(legacyTemp)
		if err != nil {
			t.Fatal(err)
		}
		if string(legacyContent) != "sentinel" {
			t.Fatalf("legacy temporary path changed to %q", legacyContent)
		}
		assertNoAtomicTempFiles(t, dir)
	})

	t.Run("preserves a symlink and updates its target", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.txt")
		link := filepath.Join(dir, "link.txt")
		if err := os.WriteFile(target, []byte("old"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("symlinks are unavailable in this environment: %v", err)
		}

		atomicWriteMustSucceed(t, link, []byte("new"))
		linkInfo, err := os.Lstat(link)
		if err != nil {
			t.Fatal(err)
		}
		if linkInfo.Mode()&os.ModeSymlink == 0 {
			t.Fatal("atomic write replaced the symlink itself")
		}
		targetContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(targetContent) != "new" {
			t.Fatalf("symlink target content = %q; want new", targetContent)
		}
	})

	t.Run("rejects files with multiple hard links", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.txt")
		alias := filepath.Join(dir, "alias.txt")
		if err := os.WriteFile(target, []byte("old"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(target, alias); err != nil {
			t.Skipf("hard links are unavailable in this environment: %v", err)
		}

		warning, err := atomicWrite(target, []byte("new"))
		if err == nil || !strings.Contains(err.Error(), "hard links") {
			t.Fatalf("atomicWrite error = %v; want explicit hard-link rejection", err)
		}
		if warning != "" {
			t.Fatalf("hard-link rejection warning = %q; want none", warning)
		}
		for _, path := range []string{target, alias} {
			content, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if string(content) != "old" {
				t.Fatalf("%s content = %q; want unchanged", path, content)
			}
		}
	})
}

func TestAtomicWriteErrors(t *testing.T) {
	dir := t.TempDir()
	missingParentTarget := filepath.Join(dir, "missing", "test.txt")
	if _, err := atomicWrite(missingParentTarget, []byte("x")); err == nil {
		t.Fatal("expected error for missing parent directory")
	}

	targetDir := filepath.Join(dir, "target-dir")
	if err := os.Mkdir(targetDir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := atomicWrite(targetDir, []byte("x")); err == nil {
		t.Fatal("expected error when target is a directory")
	}
	assertNoAtomicTempFiles(t, dir)
}
