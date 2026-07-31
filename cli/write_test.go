package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func snaplineTargetForWrite(t *testing.T, path string) snaplineLoadedTarget {
	t.Helper()
	target, failure := readSnaplineTarget(path)
	if failure != nil {
		t.Fatalf("readSnaplineTarget(%q) failed: %#v", path, failure)
	}
	return target
}

func replaceSnaplineTargetMustSucceed(t *testing.T, target snaplineLoadedTarget, content []byte) {
	t.Helper()
	warning, err := replaceSnaplineTarget(target, content)
	if err != nil {
		t.Fatalf("replaceSnaplineTarget(%q) failed: %v", target.CanonicalPath, err)
	}
	if warning != "" {
		t.Fatalf("replaceSnaplineTarget(%q) warning = %q; want none", target.CanonicalPath, warning)
	}
}

func assertNoSnaplineTempFiles(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".snapline-") {
			t.Fatalf("found leftover temporary file %q", entry.Name())
		}
	}
}

func TestReplaceSnaplineTargetPreservesPermissionsAndCleansTemp(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	replaceSnaplineTargetMustSucceed(t, snaplineTargetForWrite(t, path), []byte("new content"))
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, []byte("new content")) {
		t.Fatalf("content = %q", content)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().Perm() != before.Mode().Perm() {
		t.Fatalf("permissions = %v; want %v", after.Mode().Perm(), before.Mode().Perm())
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestReplaceSnaplineTargetResolvesSymlinkOnce(t *testing.T) {
	directory := t.TempDir()
	targetPath := filepath.Join(directory, "target.txt")
	linkPath := filepath.Join(directory, "link.txt")
	if err := os.WriteFile(targetPath, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetPath, linkPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	target := snaplineTargetForWrite(t, linkPath)
	if target.CanonicalPath == linkPath {
		t.Fatal("snapshot target was not canonicalized")
	}
	replaceSnaplineTargetMustSucceed(t, target, []byte("new"))
	linkInfo, err := os.Lstat(linkPath)
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatal("canonical write replaced the symlink entry")
	}
	content, _ := os.ReadFile(targetPath)
	if string(content) != "new" {
		t.Fatalf("symlink target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestReplaceSnaplineTargetRejectsHardlinks(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	alias := filepath.Join(directory, "alias.txt")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, alias); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	target := snaplineTargetForWrite(t, path)
	warning, err := replaceSnaplineTarget(target, []byte("new"))
	if err == nil || !strings.Contains(err.Error(), "hard links") || warning != "" {
		t.Fatalf("warning/error = %q / %v; want hard-link rejection", warning, err)
	}
	for _, currentPath := range []string{path, alias} {
		content, readErr := os.ReadFile(currentPath)
		if readErr != nil || string(content) != "old" {
			t.Fatalf("%s content/error = %q / %v", currentPath, content, readErr)
		}
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestReplaceSnaplineTargetRejectsContentRace(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := snaplineTargetForWrite(t, path)
	originalHook := beforeAtomicRevisionCheck
	defer func() { beforeAtomicRevisionCheck = originalHook }()
	beforeAtomicRevisionCheck = func(string) {
		if err := os.WriteFile(path, []byte("external"), 0o644); err != nil {
			t.Fatalf("external write: %v", err)
		}
	}
	warning, err := replaceSnaplineTarget(target, []byte("planned"))
	var changedErr *sourceChangedBeforeCommitError
	if !errors.As(err, &changedErr) || changedErr.CurrentRevision != rawFileRevision([]byte("external")) || warning != "" {
		t.Fatalf("warning/error = %q / %#v", warning, err)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "external" {
		t.Fatalf("race target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestReplaceSnaplineTargetRejectsSameContentIdentitySwap(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	oldPath := filepath.Join(directory, "original-inode.txt")
	if err := os.WriteFile(path, []byte("same bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := snaplineTargetForWrite(t, path)
	originalHook := beforeAtomicRevisionCheck
	defer func() { beforeAtomicRevisionCheck = originalHook }()
	beforeAtomicRevisionCheck = func(string) {
		if err := os.Rename(path, oldPath); err != nil {
			t.Fatalf("move original target: %v", err)
		}
		if err := os.WriteFile(path, []byte("same bytes"), 0o644); err != nil {
			t.Fatalf("create replacement target: %v", err)
		}
	}
	warning, err := replaceSnaplineTarget(target, []byte("planned"))
	var changedErr *sourceChangedBeforeCommitError
	if !errors.As(err, &changedErr) || !strings.Contains(err.Error(), "identity changed") || warning != "" {
		t.Fatalf("warning/error = %q / %v", warning, err)
	}
	for _, currentPath := range []string{path, oldPath} {
		content, readErr := os.ReadFile(currentPath)
		if readErr != nil || string(content) != "same bytes" {
			t.Fatalf("%s content/error = %q / %v", currentPath, content, readErr)
		}
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestReplaceSnaplineTargetRejectsCapturedParentMismatch(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := snaplineTargetForWrite(t, path)
	otherParentInfo, err := os.Stat(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target.ParentInfo = otherParentInfo
	warning, replaceErr := replaceSnaplineTarget(target, []byte("planned"))
	var changedErr *sourceChangedBeforeCommitError
	if !errors.As(replaceErr, &changedErr) || !strings.Contains(replaceErr.Error(), "parent identity changed") || warning != "" {
		t.Fatalf("warning/error = %q / %v", warning, replaceErr)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "source" {
		t.Fatalf("target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

// 未知 .snapline-* 文件不能按前缀或 mtime 自动清理；它可能是用户文件。
func TestReplaceSnaplineTargetNeverDeletesUnknownSnaplineFiles(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	bystander := filepath.Join(directory, ".snapline-user-notes")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bystander, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	staleTime := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(bystander, staleTime, staleTime); err != nil {
		t.Fatal(err)
	}
	replaceSnaplineTargetMustSucceed(t, snaplineTargetForWrite(t, path), []byte("new"))
	content, err := os.ReadFile(bystander)
	if err != nil || string(content) != "keep" {
		t.Fatalf("bystander content/error = %q / %v", content, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".snapline-") && entry.Name() != filepath.Base(bystander) {
			t.Fatalf("found unexpected temporary file %q", entry.Name())
		}
	}
}
