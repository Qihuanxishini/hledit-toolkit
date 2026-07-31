package main

import (
	"bytes"
	"errors"
	"slices"
	"testing"
)

func TestParseTextFileRejectsInvalidUTF8AndNUL(t *testing.T) {
	if _, err := parseTextFile([]byte{'a', 0xff, 'b'}); !errors.Is(err, errInvalidUTF8) {
		t.Fatalf("invalid UTF-8 error = %v", err)
	}
	if _, err := parseTextFile([]byte{'a', 0, 'b'}); !errors.Is(err, errBinaryFile) {
		t.Fatalf("NUL error = %v", err)
	}
}

func TestLoadedTextFilePreservesUTF8BOM(t *testing.T) {
	content := append([]byte(utf8BOM), []byte("alpha\r\nbeta\r\n")...)
	file, err := parseTextFile(content)
	if err != nil {
		t.Fatal(err)
	}
	if !file.HasUTF8BOM || !slices.Equal(file.Lines, []string{"alpha", "beta"}) || file.Revision != rawFileRevision(content) {
		t.Fatalf("parsed file = %#v", file)
	}
	encoded := file.EncodeContent([]string{"alpha", "gamma"}, []LineEnding{CRLFLineEnding, CRLFLineEnding})
	want := append([]byte(utf8BOM), []byte("alpha\r\ngamma\r\n")...)
	if !bytes.Equal(encoded, want) {
		t.Fatalf("encoded = %q; want %q", encoded, want)
	}
}

func TestParseTextFileBOMOnlyHasZeroLogicalLines(t *testing.T) {
	file, err := parseTextFile([]byte(utf8BOM))
	if err != nil {
		t.Fatal(err)
	}
	if !file.HasUTF8BOM || len(file.Lines) != 0 || len(file.LineEndings) != 0 {
		t.Fatalf("BOM-only file = %#v", file)
	}
	if encoded := file.EncodeContent(nil, nil); !bytes.Equal(encoded, []byte(utf8BOM)) {
		t.Fatalf("encoded BOM-only file = %q", encoded)
	}
}

func TestParseTextFileTracksPerLineTerminators(t *testing.T) {
	tests := []struct {
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
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			file, err := parseTextFile([]byte(test.content))
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(file.Lines, test.lines) || !slices.Equal(file.LineEndings, test.endings) {
				t.Fatalf("lines/endings = %#v / %#v; want %#v / %#v", file.Lines, file.LineEndings, test.lines, test.endings)
			}
			if encoded := string(file.EncodeContent(file.Lines, file.LineEndings)); encoded != test.content {
				t.Fatalf("round trip = %q; want %q", encoded, test.content)
			}
		})
	}
}
