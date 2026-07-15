package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWrite(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "test-atomic-write")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	targetFile := filepath.Join(tmpDir, "test.txt")
	content := []byte("hello world")

	// Test 1: Write new file
	err = atomicWrite(targetFile, content)
	if err != nil {
		t.Fatalf("atomicWrite failed: %v", err)
	}

	// Verify content
	got, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("expected %q, got %q", string(content), string(got))
	}

	// Verify no temp file left behind
	files, _ := os.ReadDir(tmpDir)
	for _, f := range files {
		if f.Name() == filepath.Base(targetFile)+".hledit.tmp" {
			t.Errorf("found leftover temp file: %s", f.Name())
		}
	}

	// Test 2: Overwrite existing file
	newContent := []byte("new content")
	err = atomicWrite(targetFile, newContent)
	if err != nil {
		t.Fatalf("atomicWrite failed during overwrite: %v", err)
	}

	got, err = os.ReadFile(targetFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, newContent) {
		t.Errorf("expected %q, got %q", string(newContent), string(got))
	}
}

func TestAtomicWriteErrors(t *testing.T) {
	tmpDir := t.TempDir()

	// Create error: parent directory does not exist, so os.Create(tmp) fails.
	missingParentTarget := filepath.Join(tmpDir, "missing", "test.txt")
	if err := atomicWrite(missingParentTarget, []byte("x")); err == nil {
		t.Fatal("expected create error for missing parent directory")
	}

	// Rename error: target path is an existing directory. Creating
	// target.hledit.tmp succeeds next to it, but renaming a file over a
	// directory should fail and clean up the temp file.
	targetDir := filepath.Join(tmpDir, "target-dir")
	if err := os.Mkdir(targetDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(targetDir, []byte("x")); err == nil {
		t.Fatal("expected rename error when target is a directory")
	}
	if _, err := os.Stat(targetDir + ".hledit.tmp"); !os.IsNotExist(err) {
		t.Fatalf("expected temp cleanup after rename error, stat err=%v", err)
	}
}
