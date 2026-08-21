package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
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

	output := commandTestCaptureStdout(t, func() {
		_, ok := loadCommandTextFile(target)
		if ok {
			t.Fatal("loadCommandTextFile unexpectedly succeeded")
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

	joined := file.EncodeContent([]string{"alpha", "gamma"}, []LineEnding{CRLFLineEnding, CRLFLineEnding})
	want := append([]byte(utf8BOM), []byte("alpha\r\ngamma\r\n")...)
	if !bytes.Equal(joined, want) {
		t.Fatalf("EncodeContent bytes = %v; want %v", joined, want)
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

func TestParseTextFileTracksPerLineTerminators(t *testing.T) {
	cases := []struct {
		name    string
		content string
		lines   []string
		endings []LineEnding
	}{
		{"pure LF", "a\nb\n", []string{"a", "b"}, []LineEnding{LFLineEnding, LFLineEnding}},
		{"pure CRLF", "a\r\nb\r\n", []string{"a", "b"}, []LineEnding{CRLFLineEnding, CRLFLineEnding}},
		{"mixed", "a\r\nb\nc\r\nd\n", []string{"a", "b", "c", "d"}, []LineEnding{CRLFLineEnding, LFLineEnding, CRLFLineEnding, LFLineEnding}},
		{"no trailing newline", "a\nb", []string{"a", "b"}, []LineEnding{LFLineEnding, NoLineEnding}},
		{"lone CR is line text", "a\rb\n", []string{"a\rb"}, []LineEnding{LFLineEnding}},
		{"trailing lone CR is line text", "a\n b\r", []string{"a", " b\r"}, []LineEnding{LFLineEnding, NoLineEnding}},
		{"empty", "", []string{}, []LineEnding{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			file, err := parseTextFile([]byte(testCase.content))
			if err != nil {
				t.Fatal(err)
			}
			if len(file.Lines) != len(file.LineEndings) {
				t.Fatalf("len(Lines)=%d len(LineEndings)=%d; invariant violated", len(file.Lines), len(file.LineEndings))
			}
			if !slices.Equal(file.Lines, testCase.lines) {
				t.Fatalf("Lines = %#v; want %#v", file.Lines, testCase.lines)
			}
			if !slices.Equal(file.LineEndings, testCase.endings) {
				t.Fatalf("LineEndings = %#v; want %#v", file.LineEndings, testCase.endings)
			}
			// 无损性：原样编码必须逐字节还原源文本（不含被剥离的 BOM）。
			if rejoined := string(file.EncodeContent(file.Lines, file.LineEndings)); rejoined != testCase.content {
				t.Fatalf("EncodeContent round-trip = %q; want %q", rejoined, testCase.content)
			}
		})
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
