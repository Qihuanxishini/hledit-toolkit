package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTextFileRejectsInvalidUTF8(t *testing.T) {
	_, err := parseTextFile([]byte{'a', 0xff, 'b'})
	if !errors.Is(err, errInvalidUTF8) {
		t.Fatalf("parseTextFile error = %v; want errInvalidUTF8", err)
	}
}

func TestReadFileLinesReportsInvalidUTF8(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "invalid.txt")
	if err := os.WriteFile(target, []byte{'a', 0xff, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}

	output := readTestCaptureStdout(t, func() {
		lines, errored := readFileLines(target)
		if !errored || lines != nil {
			t.Fatalf("readFileLines = %#v, %v; want nil, true", lines, errored)
		}
	})
	if !strings.Contains(output, `"error":"encoding"`) {
		t.Fatalf("output = %q; want encoding error", output)
	}
}

func TestLoadedTextFilePreservesUTF8BOM(t *testing.T) {
	content := append([]byte(utf8BOM), []byte("alpha\r\nbeta\r\n")...)
	file, err := parseTextFile(content)
	if err != nil {
		t.Fatalf("parseTextFile returned error: %v", err)
	}
	if !file.HasUTF8BOM {
		t.Fatal("HasUTF8BOM = false; want true")
	}
	if got, want := file.Lines, []string{"alpha", "beta"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Lines = %#v; want %#v", got, want)
	}

	joined := []byte(file.JoinLines([]string{"alpha", "gamma"}))
	want := append([]byte(utf8BOM), []byte("alpha\r\ngamma\r\n")...)
	if !bytes.Equal(joined, want) {
		t.Fatalf("JoinLines bytes = %v; want %v", joined, want)
	}
}

func TestBatchEditPreservesUTF8BOM(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "bom.txt")
	original := append([]byte(utf8BOM), []byte("alpha\n")...)
	if err := os.WriteFile(target, original, 0o644); err != nil {
		t.Fatal(err)
	}

	batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(1, "alpha"), Lines: []string{"beta"},
	}}}, false)
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	want := append([]byte(utf8BOM), []byte("beta\n")...)
	if !bytes.Equal(content, want) {
		t.Fatalf("content = %v; want %v", content, want)
	}
}
