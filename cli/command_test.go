package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func commandTestCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	var output bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&output, r)
		close(done)
	}()
	fn()
	_ = w.Close()
	<-done
	_ = r.Close()
	return strings.TrimSpace(output.String())
}

func commandTestWriteFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func commandTestDecode[T any](t *testing.T, output string, target *T) {
	t.Helper()
	if err := json.Unmarshal([]byte(output), target); err != nil {
		t.Fatalf("decode output %q: %v", output, err)
	}
}

func TestCmdReadRangeJSON(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "range.txt", "one\ntwo\nthree\nfour\n")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 2, 2); err != nil {
			t.Fatal(err)
		}
	})
	var result ReadResult
	commandTestDecode(t, output, &result)
	if !result.OK || result.TotalLines != 4 || len(result.Lines) != 2 || result.Lines[0].Line != 2 || result.Lines[1].Line != 3 {
		t.Fatalf("read-range result = %#v", result)
	}
	if !result.Truncated || result.NextOffset != 4 {
		t.Fatalf("read-range pagination = %#v; want truncated at offset 4", result)
	}
}

func TestCmdReadRangeRejectsOffsetPastEOF(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "range.txt", "one\ntwo\n")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 3, 2); err != nil {
			t.Fatal(err)
		}
	})
	var result ReadRangeError
	commandTestDecode(t, output, &result)
	if result.OK || result.Error != "range" || result.RequestedOffset != 3 || result.TotalLines != 2 {
		t.Fatalf("range error = %#v", result)
	}
}

func TestCmdReadRangeRejectsEmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "empty.txt", "")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 160); err != nil {
			t.Fatal(err)
		}
	})
	var result ReadRangeError
	commandTestDecode(t, output, &result)
	if result.OK || result.Error != "range" || result.RequestedOffset != 1 || result.TotalLines != 0 {
		t.Fatalf("empty-file range error = %#v", result)
	}
}

func TestCmdSearchJSONSupportsRegexContextAndPagination(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "search.txt", "hit-one\ncontext\nhit-two\ntail\n")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(path, "hit", 1, 2, false, 1, false); err != nil {
			t.Fatal(err)
		}
	})
	var result SearchResult
	commandTestDecode(t, output, &result)
	if !result.OK || result.TotalMatches != 2 || len(result.Lines) != 2 || result.Lines[0].Line != 1 || result.Lines[1].Line != 2 || result.NextOffset != 3 {
		t.Fatalf("search result = %#v", result)
	}
}

func TestCmdSearchRejectsBroadRegexAndSupportsLiteral(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "search.txt", ".*\nordinary\n")
	broadOutput := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(path, ".*", 1, 100, false, 0, false); err != nil {
			t.Fatal(err)
		}
	})
	var broad CommandError
	commandTestDecode(t, broadOutput, &broad)
	if broad.OK || broad.Error != "broad_pattern" {
		t.Fatalf("broad search = %#v", broad)
	}

	literalOutput := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(path, ".*", 1, 100, true, 0, false); err != nil {
			t.Fatal(err)
		}
	})
	var literal SearchResult
	commandTestDecode(t, literalOutput, &literal)
	if !literal.OK || literal.TotalMatches != 1 || len(literal.Lines) != 1 || literal.Lines[0].Text != ".*" {
		t.Fatalf("literal search = %#v", literal)
	}
}

func TestCmdSearchRejectsPatternsThatActuallyMatchEveryLine(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "search.txt", "alpha\nbeta\n")
	for _, testCase := range []struct {
		name    string
		pattern string
		literal bool
	}{
		{name: "start anchor regex", pattern: "^"},
		{name: "optional regex", pattern: "x?"},
		{name: "literal on every line", pattern: "a", literal: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			output := commandTestCaptureStdout(t, func() {
				if err := cmdSearch(path, testCase.pattern, 1, 100, testCase.literal, 0, false); err != nil {
					t.Fatal(err)
				}
			})
			var result CommandError
			commandTestDecode(t, output, &result)
			if result.OK || result.Error != "broad_pattern" {
				t.Fatalf("broad search = %#v", result)
			}
		})
	}

	emptyPath := commandTestWriteFile(t, dir, "empty.txt", "")
	emptyOutput := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(emptyPath, "^", 1, 100, false, 0, false); err != nil {
			t.Fatal(err)
		}
	})
	var emptyResult SearchResult
	commandTestDecode(t, emptyOutput, &emptyResult)
	if !emptyResult.OK || emptyResult.TotalLines != 0 || emptyResult.TotalMatches != 0 || len(emptyResult.Lines) != 0 {
		t.Fatalf("empty search = %#v", emptyResult)
	}
}

func TestCmdSearchRejectsInvalidPattern(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "search.txt", "alpha\n")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(path, "[", 1, 100, false, 0, false); err != nil {
			t.Fatal(err)
		}
	})
	var result CommandError
	commandTestDecode(t, output, &result)
	if result.OK || result.Error != "pattern" {
		t.Fatalf("invalid pattern = %#v", result)
	}
}

func TestMainCapabilitiesExposeOnlyCurrentProtocol(t *testing.T) {
	output := commandTestCaptureStdout(t, func() {
		if code := run([]string{"capabilities"}); code != 0 {
			t.Fatalf("capabilities exit code = %d", code)
		}
	})
	var result CLICapabilities
	commandTestDecode(t, output, &result)
	if !result.OK || result.Version != version || !result.ReadRangeMetadata || !result.Search || !result.SearchRegex || !result.SearchLiteral || !result.SearchIgnoreCase || !result.BatchCheck || !result.BatchReadProof || !result.BatchEditDeltas {
		t.Fatalf("capabilities = %#v", result)
	}
}

func TestSplitArgsSeparatorProtectsFlagLikePositionals(t *testing.T) {
	positionals, flagArgs := splitArgs([]string{"--offset", "2", "--literal", "--", "--limit", "--check"})
	if !equalLines(positionals, []string{"--limit", "--check"}) {
		t.Fatalf("positionals = %#v; want flag-like values preserved", positionals)
	}
	if !equalLines(flagArgs, []string{"--offset", "2", "--literal"}) {
		t.Fatalf("flags = %#v", flagArgs)
	}
}

func TestMainRejectsRemovedCommands(t *testing.T) {
	for _, verb := range []string{"read", "anchors", "replace", "replace-range", "insert"} {
		t.Run(verb, func(t *testing.T) {
			stdout, stderr, code := commandTestRunForCode(t, verb)
			if code != 2 || stdout != "" || !strings.Contains(stderr, "unknown verb") {
				t.Fatalf("removed command result = code %d, stdout %q, stderr %q", code, stdout, stderr)
			}
		})
	}
}

func commandTestRunForCode(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout, os.Stderr = outW, errW
	code = run(args)
	_ = outW.Close()
	_ = errW.Close()
	os.Stdout, os.Stderr = oldOut, oldErr
	outBytes, err := io.ReadAll(outR)
	if err != nil {
		t.Fatal(err)
	}
	errBytes, err := io.ReadAll(errR)
	if err != nil {
		t.Fatal(err)
	}
	return string(outBytes), string(errBytes), code
}
