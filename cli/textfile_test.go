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

func TestParseTextFileDetectsMixedLineEndings(t *testing.T) {
	cases := []struct {
		name    string
		content string
		mixed   bool
	}{
		{"pure LF", "a\nb\n", false},
		{"pure CRLF", "a\r\nb\r\n", false},
		{"mixed", "a\r\nb\nc\r\nd\n", true},
		{"mostly LF one CRLF", "m1\nm2\nm3\r\nm4\nm5\n", true},
		{"lone CR is not a line ending", "a\rb\n", false},
		{"empty", "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			file, err := parseTextFile([]byte(testCase.content))
			if err != nil {
				t.Fatal(err)
			}
			if file.HasMixedLineEndings != testCase.mixed {
				t.Fatalf("HasMixedLineEndings = %v; want %v", file.HasMixedLineEndings, testCase.mixed)
			}
		})
	}
}

// 混合行尾文件的归一化是文档化行为，但必须显式返回 warning，不得静默改写未编辑行。
func TestBatchEditWarnsOnMixedLineEndingNormalization(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "mixed.txt")
	if err := os.WriteFile(target, []byte("a\r\nb\nc\r\nd\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"},
	}}}, false)
	if !strings.Contains(output, mixedLineEndingWarning) {
		t.Fatalf("output = %q; want mixed line ending warning", output)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(content), "a\r\nB\r\nc\r\nd\r\n"; got != want {
		t.Fatalf("content = %q; want %q", got, want)
	}
}

func TestBatchEditDoesNotWarnOnUniformLineEndings(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "uniform.txt")
	if err := os.WriteFile(target, []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(1, "a"), Lines: []string{"A"},
	}}}, false)
	if strings.Contains(output, "line endings") {
		t.Fatalf("output = %q; must not warn on uniform line endings", output)
	}
}
