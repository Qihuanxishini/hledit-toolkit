package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func coverageTestCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()

	outCh := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		outCh <- string(out)
	}()

	fn()
	_ = w.Close()
	out := <-outCh
	_ = r.Close()
	return out
}

func coverageTestWriteFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSupplementalParseAnchorAtoiError(t *testing.T) {
	_, err := parseAnchor("999999999999999999999999999999999999999999999999999999999#WS")
	if err == nil {
		t.Fatal("expected parse error for enormous line number")
	}
}

func TestSupplementalReadLongFileAndRangeBranches(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("a", 9000) + "\nsecond\n"
	path := coverageTestWriteFile(t, dir, "long.txt", long)

	out := coverageTestCaptureStdout(t, func() { _ = cmdRead(path, "", 0, false) })
	if !strings.HasPrefix(out, "1#") || !strings.Contains(out, strings.Repeat("a", 32)) {
		t.Fatalf("cmdRead long-file output unexpected prefix: %.80q", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReadRange(path, 1, 0, "", 0, false) })
	if !strings.Contains(out, "1#") || !strings.Contains(out, "2#") {
		t.Fatalf("cmdReadRange limit<=0 output unexpected: %q", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReadRange(filepath.Join(dir, "missing.txt"), 1, 1, "", 0, false) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("missing read-range did not emit io error: %s", out)
	}

	bin := filepath.Join(dir, "bin.dat")
	if err := os.WriteFile(bin, []byte("prefix\x00suffix"), 0644); err != nil {
		t.Fatal(err)
	}
	out = coverageTestCaptureStdout(t, func() { _ = cmdReadRange(bin, 1, 1, "", 0, false) })
	if !strings.Contains(out, `"error":"binary"`) {
		t.Fatalf("binary read-range did not emit binary error: %s", out)
	}
}

func TestSupplementalReadContentLinesFromStdin(t *testing.T) {
	old := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = r
	_, _ = w.WriteString("one\r\ntwo\n")
	_ = w.Close()
	got, err := readContentLines("-")
	os.Stdin = old
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "one,two" {
		t.Fatalf("readContentLines(stdin) = %#v, want [one two]", got)
	}
}

func TestSupplementalCommandWriteErrors(t *testing.T) {
	targetDir := t.TempDir()
	contentDir := t.TempDir()
	content := coverageTestWriteFile(t, contentDir, "content.txt", "replacement\n")

	replacePath := coverageTestWriteFile(t, targetDir, "replace.go", "package main\n")
	rangePath := coverageTestWriteFile(t, targetDir, "range.go", "one\ntwo\n")
	insertPath := coverageTestWriteFile(t, targetDir, "insert.go", "one\n")

	if err := os.Chmod(targetDir, 0555); err != nil {
		t.Skipf("cannot make directory read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(targetDir, 0755) })

	out := coverageTestCaptureStdout(t, func() { _ = cmdReplace(replacePath, formatTag(1, "package main"), content) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Skipf("environment allowed atomic write in read-only directory; output: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(rangePath, formatTag(1, "one"), formatTag(2, "two"), content) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdReplaceRange write failure expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdInsert(insertPath, formatTag(1, "one"), content, true) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdInsert write failure expected io error: %s", out)
	}
}

func TestTrailingNewlinePreservation(t *testing.T) {
	t.Run("replace preserves trailing newline when original has one", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.txt")
		if err := os.WriteFile(target, []byte("alpha\nbravo\ncharlie\n"), 0644); err != nil {
			t.Fatal(err)
		}
		contentSrc := filepath.Join(dir, "content.txt")
		if err := os.WriteFile(contentSrc, []byte("delta\n"), 0644); err != nil {
			t.Fatal(err)
		}
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})
		editTestMustUnmarshal(t, out, &EditResult{})

		data, _ := os.ReadFile(target)
		if string(data) != "alpha\ndelta\ncharlie\n" {
			t.Fatalf("content = %q; want trailing newline preserved", string(data))
		}
	})

	t.Run("replace preserves no-trailing-newline when original lacks one", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.txt")
		if err := os.WriteFile(target, []byte("alpha\nbravo"), 0644); err != nil {
			t.Fatal(err)
		}
		contentSrc := filepath.Join(dir, "content.txt")
		if err := os.WriteFile(contentSrc, []byte("delta"), 0644); err != nil {
			t.Fatal(err)
		}
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})
		editTestMustUnmarshal(t, out, &EditResult{})

		data, _ := os.ReadFile(target)
		if string(data) != "alpha\ndelta" {
			t.Fatalf("content = %q; want no trailing newline", string(data))
		}
	})

	t.Run("replace-range with multi-line replacement", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "x", "y", "z")
		startAnchor := formatTag(2, "bravo")
		endAnchor := formatTag(3, "charlie")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplaceRange(target, startAnchor, endAnchor, contentSrc)
		})
		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 {
			t.Fatalf("output = %#v; want ok firstChangedLine 2", got)
		}

		data, _ := os.ReadFile(target)
		if string(data) != "alpha\nx\ny\nz\ndelta\n" {
			t.Fatalf("content = %q; want %q", string(data), "alpha\nx\ny\nz\ndelta\n")
		}
	})

	t.Run("insert preserves trailing newline when original has one", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.txt")
		if err := os.WriteFile(target, []byte("alpha\nbravo\n"), 0644); err != nil {
			t.Fatal(err)
		}
		contentSrc := filepath.Join(dir, "content.txt")
		if err := os.WriteFile(contentSrc, []byte("inserted\n"), 0644); err != nil {
			t.Fatal(err)
		}
		anchor := formatTag(1, "alpha")

		out := editTestCaptureStdout(t, func() {
			_ = cmdInsert(target, anchor, contentSrc, false)
		})
		editTestMustUnmarshal(t, out, &EditResult{})

		data, _ := os.ReadFile(target)
		if string(data) != "inserted\nalpha\nbravo\n" {
			t.Fatalf("content = %q; want trailing newline preserved", string(data))
		}
	})
}

func TestReplaceRangeStartGreaterThanEnd(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
	contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")

	startAnchor := formatTag(3, "charlie")
	endAnchor := formatTag(1, "alpha")

	out := editTestCaptureStdout(t, func() {
		_ = cmdReplaceRange(target, startAnchor, endAnchor, contentSrc)
	})

	var got EditError
	editTestMustUnmarshal(t, out, &got)
	if got.OK || got.Error != "invalid" {
		t.Fatalf("output = %#v; want invalid error", got)
	}
}

func TestCoverageEditIOAndInvalidBranches(t *testing.T) {
	dir := t.TempDir()
	path := coverageTestWriteFile(t, dir, "main.go", "package main\n\nfunc main() {}\n")
	missingContent := filepath.Join(dir, "missing-content.txt")

	out := coverageTestCaptureStdout(t, func() { _ = cmdReplace(filepath.Join(dir, "missing.go"), "1#WV", missingContent) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdReplace missing file expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplace(path, "999#WV", missingContent) })
	if !strings.Contains(out, `"error":"stale"`) {
		t.Fatalf("cmdReplace out-of-range anchor expected stale error: %s", out)
	}

	fresh := formatTag(1, "package main")
	out = coverageTestCaptureStdout(t, func() { _ = cmdReplace(path, fresh, missingContent) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdReplace missing content expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(filepath.Join(dir, "missing.go"), fresh, fresh, missingContent) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdReplaceRange missing file expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(path, "bad", fresh, missingContent) })
	if !strings.Contains(out, `"error":"invalid"`) {
		t.Fatalf("cmdReplaceRange bad start expected invalid error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(path, fresh, "bad", missingContent) })
	if !strings.Contains(out, `"error":"invalid"`) {
		t.Fatalf("cmdReplaceRange bad end expected invalid error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(path, fresh, "2#ZZ", missingContent) })
	if !strings.Contains(out, `"error":"stale"`) {
		t.Fatalf("cmdReplaceRange stale expected stale error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdReplaceRange(path, fresh, fresh, missingContent) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdReplaceRange missing content expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdInsert(filepath.Join(dir, "missing.go"), fresh, missingContent, false) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdInsert missing file expected io error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdInsert(path, "bad", missingContent, false) })
	if !strings.Contains(out, `"error":"invalid"`) {
		t.Fatalf("cmdInsert bad anchor expected invalid error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdInsert(path, "999#WV", missingContent, false) })
	if !strings.Contains(out, `"error":"stale"`) {
		t.Fatalf("cmdInsert out-of-range expected stale error: %s", out)
	}

	out = coverageTestCaptureStdout(t, func() { _ = cmdInsert(path, fresh, missingContent, false) })
	if !strings.Contains(out, `"error":"io"`) {
		t.Fatalf("cmdInsert missing content expected io error: %s", out)
	}
}
