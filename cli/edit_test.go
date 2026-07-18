package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func editTestCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()

	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&buf, r)
		close(done)
	}()

	fn()

	_ = w.Close()
	<-done
	_ = r.Close()

	return buf.String()
}

func editTestWriteTextFile(t *testing.T, dir, name, content string) string {
	t.Helper()

	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func editTestWriteLinesFile(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	return editTestWriteTextFile(t, dir, name, strings.Join(lines, "\n")+"\n")
}

func editTestMustUnmarshal(t *testing.T, out string, target any) {
	t.Helper()
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), target); err != nil {
		t.Fatalf("unmarshal output %q: %v", out, err)
	}
}

func TestReadContentLines(t *testing.T) {
	t.Run("trailing newline", func(t *testing.T) {
		dir := t.TempDir()
		path := editTestWriteTextFile(t, dir, "content.txt", "alpha\nbeta\n")

		got, err := readContentLines(path)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"alpha", "beta"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("readContentLines(%q) = %#v; want %#v", path, got, want)
		}
	})

	t.Run("empty file", func(t *testing.T) {
		dir := t.TempDir()
		path := editTestWriteTextFile(t, dir, "empty.txt", "")

		got, err := readContentLines(path)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("readContentLines(%q) = %#v; want empty slice", path, got)
		}
	})

	t.Run("empty content source string is invalid", func(t *testing.T) {
		_, err := readContentLines("")
		if err == nil {
			t.Fatal("readContentLines(empty string) error = nil; want error")
		}
	})

	t.Run("crlf normalized", func(t *testing.T) {
		dir := t.TempDir()
		path := editTestWriteTextFile(t, dir, "crlf.txt", "alpha\r\nbeta\r\n")

		got, err := readContentLines(path)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"alpha", "beta"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("readContentLines(%q) = %#v; want %#v", path, got, want)
		}
	})
}

func TestCmdReplace(t *testing.T) {
	t.Run("swap one line", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 || got.LinesAdded != 1 || got.LinesDeleted != 1 {
			t.Fatalf("cmdReplace output = %#v; want ok true firstChangedLine 2 lines +1 -1", got)
		}
		if strings.Contains(out, "delta") {
			t.Fatalf("cmdReplace output leaked replacement body: %q", out)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\ndelta\ncharlie\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\ndelta\ncharlie\n")
		}
	})

	t.Run("delete line with empty content source", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		contentSrc := editTestWriteTextFile(t, dir, "empty.txt", "")
		anchor := formatTag(1, "alpha")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 1 || got.LinesAdded != 0 || got.LinesDeleted != 1 {
			t.Fatalf("cmdReplace output = %#v; want ok true firstChangedLine 1 lines +0 -1", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "bravo\n" {
			t.Fatalf("target content = %q; want %q", string(data), "bravo\n")
		}
	})

	t.Run("literal empty content source reports content-source error", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		anchor := formatTag(1, "alpha")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, "")
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "io" {
			t.Fatalf("cmdReplace output = %#v; want io error", got)
		}
		for _, want := range []string{"content-source argument is empty", "use '-' as the content-source", "hledit replace <file> <anchor> -"} {
			if !strings.Contains(got.Message, want) {
				t.Fatalf("error message %q missing %q", got.Message, want)
			}
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\nbravo\n" {
			t.Fatalf("target content = %q; want unchanged", string(data))
		}
	})

	t.Run("expand one line into multiple lines", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta", "echo")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 || got.LinesAdded != 2 || got.LinesDeleted != 1 {
			t.Fatalf("cmdReplace output = %#v; want ok true firstChangedLine 2 lines +2 -1", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\ndelta\necho\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\ndelta\necho\n")
		}
	})

	t.Run("stale anchor", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")
		staleAnchor := formatTag(1, "alpha")

		// Use content guaranteed to differ from "alpha" to avoid hash collisions.
		currentLine := "completely-different-content-for-stale-test"
		if err := os.WriteFile(target, []byte(currentLine+"\nbravo\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		currentAnchor := formatTag(1, currentLine)

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, staleAnchor, contentSrc)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "stale" {
			t.Fatalf("cmdReplace output = %#v; want stale error", got)
		}
		if len(got.Remaps) != 1 || got.Remaps[0].Requested != staleAnchor || got.Remaps[0].Current != currentAnchor {
			t.Fatalf("cmdReplace remaps = %#v; want requested %q current %q", got.Remaps, staleAnchor, currentAnchor)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != currentLine+"\nbravo\n" {
			t.Fatalf("target content = %q; want unchanged %q", string(data), currentLine+"\nbravo\n")
		}
	})

	t.Run("invalid anchor", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, "not-an-anchor", contentSrc)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" {
			t.Fatalf("cmdReplace output = %#v; want invalid error", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\n" {
			t.Fatalf("target content = %q; want unchanged %q", string(data), "alpha\n")
		}
	})
}

func TestCmdReplaceLastChangedLine(t *testing.T) {
	t.Run("single replace lastChangedLine equals firstChangedLine", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "BRAVO")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, anchor, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("cmdReplace failed: %#v", got)
		}
		if got.FirstChangedLine != 2 || got.LastChangedLine != 2 {
			t.Fatalf("firstChangedLine=%d lastChangedLine=%d; want both 2", got.FirstChangedLine, got.LastChangedLine)
		}
	})
}

func TestCmdReplaceRangeLastChangedLine(t *testing.T) {
	t.Run("replace range lastChangedLine reflects end anchor", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "MIDDLE")
		start := formatTag(2, "bravo")
		end := formatTag(3, "charlie")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplaceRange(target, start, end, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("cmdReplaceRange failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 3 {
			t.Fatalf("lastChangedLine = %d, want 3", got.LastChangedLine)
		}
	})
}

func TestCmdReplaceBinaryDetectionEmitsJSONError(t *testing.T) {
	t.Run("binary target returns binary JSON error", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteTextFile(t, dir, "binary.bin", string([]byte{'a', 0x00, 'b', '\n'}))
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplace(target, "1#WS", contentSrc)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "binary" {
			t.Fatalf("cmdReplace output = %#v; want binary error", got)
		}
	})
}

func TestCmdReplaceRange(t *testing.T) {
	t.Run("replace range with one line", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")
		start := formatTag(2, "bravo")
		end := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplaceRange(target, start, end, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 {
			t.Fatalf("cmdReplaceRange output = %#v; want ok true firstChangedLine 2", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\ndelta\ncharlie\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\ndelta\ncharlie\n")
		}
	})

	t.Run("delete range with empty content", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
		contentSrc := editTestWriteTextFile(t, dir, "empty.txt", "")
		start := formatTag(2, "bravo")
		end := formatTag(3, "charlie")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplaceRange(target, start, end, contentSrc)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 {
			t.Fatalf("cmdReplaceRange output = %#v; want ok true firstChangedLine 2", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\ndelta\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\ndelta\n")
		}
	})

	t.Run("start greater than end is invalid", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")
		start := formatTag(3, "charlie")
		end := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdReplaceRange(target, start, end, contentSrc)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" {
			t.Fatalf("cmdReplaceRange output = %#v; want invalid error", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\nbravo\ncharlie\n" {
			t.Fatalf("target content = %q; want unchanged %q", string(data), "alpha\nbravo\ncharlie\n")
		}
	})
}

func TestCmdInsert(t *testing.T) {
	t.Run("before preserves anchored line", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta", "echo")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdInsert(target, anchor, contentSrc, false)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 2 || got.LastChangedLine != 3 {
			t.Fatalf("cmdInsert output = %#v; want ok true firstChangedLine 2 lastChangedLine 3", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\ndelta\necho\nbravo\ncharlie\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\ndelta\necho\nbravo\ncharlie\n")
		}
	})

	t.Run("after preserves anchored line", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta", "echo")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdInsert(target, anchor, contentSrc, true)
		})

		var got EditResult
		editTestMustUnmarshal(t, out, &got)
		if !got.OK || got.FirstChangedLine != 3 || got.LastChangedLine != 4 {
			t.Fatalf("cmdInsert output = %#v; want ok true firstChangedLine 3 lastChangedLine 4", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\nbravo\ndelta\necho\ncharlie\n" {
			t.Fatalf("target content = %q; want %q", string(data), "alpha\nbravo\ndelta\necho\ncharlie\n")
		}
	})

	t.Run("empty content is invalid", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		contentSrc := editTestWriteTextFile(t, dir, "empty.txt", "")
		anchor := formatTag(2, "bravo")

		out := editTestCaptureStdout(t, func() {
			_ = cmdInsert(target, anchor, contentSrc, false)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" || got.Message != "insert requires non-empty content" {
			t.Fatalf("cmdInsert output = %#v; want invalid insert requires non-empty content", got)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\nbravo\n" {
			t.Fatalf("target content = %q; want unchanged %q", string(data), "alpha\nbravo\n")
		}
	})

	t.Run("stale anchor", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "delta")
		staleAnchor := formatTag(2, "bravo")

		// Use content guaranteed to differ from "bravo" to avoid hash collisions.
		currentLine := "completely-different-content-for-stale-insert"
		if err := os.WriteFile(target, []byte("alpha\n"+currentLine+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		currentAnchor := formatTag(2, currentLine)

		out := editTestCaptureStdout(t, func() {
			_ = cmdInsert(target, staleAnchor, contentSrc, false)
		})

		var got EditError
		editTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "stale" {
			t.Fatalf("cmdInsert output = %#v; want stale error", got)
		}
		if len(got.Remaps) != 1 || got.Remaps[0].Requested != staleAnchor || got.Remaps[0].Current != currentAnchor {
			t.Fatalf("cmdInsert remaps = %#v; want requested %q current %q", got.Remaps, staleAnchor, currentAnchor)
		}

		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "alpha\n"+currentLine+"\n" {
			t.Fatalf("target content = %q; want unchanged %q", string(data), "alpha\n"+currentLine+"\n")
		}
	})
}

func TestCmdReplacePreservesCRLFLineEndings(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "crlf.txt")
	if err := os.WriteFile(target, []byte("one\r\ntwo\r\nthree\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	contentSrc := editTestWriteTextFile(t, dir, "content.txt", "TWO")

	out := editTestCaptureStdout(t, func() {
		_ = cmdReplace(target, formatTag(2, "two"), contentSrc)
	})

	var got EditResult
	editTestMustUnmarshal(t, out, &got)
	if !got.OK || got.FirstChangedLine != 2 {
		t.Fatalf("cmdReplace output = %#v; want ok true firstChangedLine 2", got)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "one\r\nTWO\r\nthree\r\n" {
		t.Fatalf("target bytes = %q; want CRLF-preserved content", string(data))
	}
}

func TestCmdReplaceDeletingOnlyLineProducesEmptyFile(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteTextFile(t, dir, "only.txt", "only\n")
	contentSrc := editTestWriteTextFile(t, dir, "empty.txt", "")

	out := editTestCaptureStdout(t, func() {
		_ = cmdReplace(target, formatTag(1, "only"), contentSrc)
	})

	var got EditResult
	editTestMustUnmarshal(t, out, &got)
	if !got.OK || got.LinesAdded != 0 || got.LinesDeleted != 1 {
		t.Fatalf("cmdReplace output = %#v; want successful deletion of the only line", got)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 0 {
		t.Fatalf("target bytes = %q; want an empty file", string(data))
	}
}
