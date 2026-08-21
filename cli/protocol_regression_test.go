package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func protocolTestAssertFile(t *testing.T, path, want string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != want {
		t.Fatalf("file content = %q; want %q", string(content), want)
	}
}

func protocolTestAssertBatchSuccess(t *testing.T, output, path string) {
	t.Helper()
	if strings.Contains(output, "line endings") {
		t.Fatalf("output = %q; must not warn about line endings", output)
	}
	var result BatchEditResult
	batchTestMustUnmarshal(t, output, &result)
	if !result.OK {
		t.Fatalf("batch result ok = false: %q", output)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := rawFileRevision(content); result.Revision != want {
		t.Fatalf("revision = %q; want raw-byte revision %q", result.Revision, want)
	}
}

func TestReadRangePreservesRawRevisionAndLogicalLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target.txt")
	content := append([]byte(utf8BOM), []byte("a\r\nb\r\n")...)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 10); err != nil {
			t.Fatal(err)
		}
	})
	var result ReadResult
	commandTestDecode(t, output, &result)
	if result.Revision != rawFileRevision(content) {
		t.Fatalf("revision = %q; want %q", result.Revision, rawFileRevision(content))
	}
	if len(result.Lines) != 2 || result.Lines[0].Text != "a" || result.Lines[1].Text != "b" {
		t.Fatalf("lines = %#v; want BOM/CRLF-free logical lines", result.Lines)
	}
}

func TestReadRangeAndSearchErrorsStayStructured(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.txt")
	missingOutput := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(missing, 1, 1); err != nil {
			t.Fatal(err)
		}
	})
	var missingError CommandError
	commandTestDecode(t, missingOutput, &missingError)
	if missingError.OK || missingError.Error != "io" {
		t.Fatalf("missing read error = %#v", missingError)
	}

	binary := filepath.Join(dir, "binary.dat")
	if err := os.WriteFile(binary, []byte("prefix\x00suffix"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryOutput := commandTestCaptureStdout(t, func() {
		if err := cmdSearch(binary, "prefix", 1, 100, false, 0, false); err != nil {
			t.Fatal(err)
		}
	})
	var binaryError CommandError
	commandTestDecode(t, binaryOutput, &binaryError)
	if binaryError.OK || binaryError.Error != "binary" {
		t.Fatalf("binary search error = %#v", binaryError)
	}
}

func TestReadRangePaginatesWithoutTruncatingNextLine(t *testing.T) {
	lines := []string{strings.Repeat("a", 30*1024), strings.Repeat("b", 30*1024), "tail"}
	budget := readJSONLineBudget(rawFileRevision([]byte("fixture")), len(lines), readOutputMaxBytes)
	page, textTruncated, nextOffset := collectAnnotatedLines(lines, 0, 160, budget)
	if textTruncated || len(page) != 1 || page[0].TextTruncated || nextOffset != 2 {
		t.Fatalf("page = %#v, textTruncated=%v, nextOffset=%d; want one complete line then offset 2", page, textTruncated, nextOffset)
	}
}

func TestReadRangeMarksOnlyAnOversizedSourceLineTruncated(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "long.txt", strings.Repeat("界", 70*1024)+"\nnext\n")
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 160); err != nil {
			t.Fatal(err)
		}
	})
	if len(output)+1 > readOutputMaxBytes {
		t.Fatalf("JSON output = %d bytes; want <= %d", len(output)+1, readOutputMaxBytes)
	}
	var result ReadResult
	commandTestDecode(t, output, &result)
	if !result.Truncated || result.NextOffset != 0 || len(result.Lines) != 1 || !result.Lines[0].TextTruncated {
		t.Fatalf("long-line result = %#v", result)
	}
	if !strings.HasSuffix(result.Lines[0].Text, jsonTextTruncationSuffix) {
		t.Fatalf("truncated text = %q; want suffix %q", result.Lines[0].Text, jsonTextTruncationSuffix)
	}
}

func TestReadRangeJSONBudgetAccountsForEscaping(t *testing.T) {
	dir := t.TempDir()
	line := strings.Repeat("\x01", 128)
	path := commandTestWriteFile(t, dir, "escaped.txt", strings.Repeat(line+"\n", 600))
	output := commandTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 2000); err != nil {
			t.Fatal(err)
		}
	})
	if len(output)+1 > readOutputMaxBytes {
		t.Fatalf("escaped JSON output = %d bytes; want <= %d", len(output)+1, readOutputMaxBytes)
	}
	var result ReadResult
	commandTestDecode(t, output, &result)
	if !result.Truncated || result.NextOffset <= 1 || len(result.Lines) == 0 {
		t.Fatalf("escaped pagination = %#v", result)
	}
}

func TestSearchRegexLiteralCaseContextAndPagination(t *testing.T) {
	lines := []string{"Alpha", "context", "beta", "ALPINE", "tail", "a.*b"}
	regex, err := filterLinesWithMode(lines, "^al", false, true)
	if err != nil || !equalLines(intsToStrings(regex), []string{"1", "4"}) {
		t.Fatalf("case-insensitive regex = %#v, err=%v", regex, err)
	}
	literal, err := filterLinesWithMode(lines, "a.*b", true, false)
	if err != nil || !equalLines(intsToStrings(literal), []string{"6"}) {
		t.Fatalf("literal matches = %#v, err=%v", literal, err)
	}
	if got := applyContext(lines, []int{1, 4}, 1); !equalLines(intsToStrings(got), []string{"1", "2", "3", "4", "5"}) {
		t.Fatalf("context lines = %#v", got)
	}
	page, textTruncated, nextOffset := collectMatchLines(lines, []int{1, 4, 6}, 1, 2, 10*1024)
	if textTruncated || len(page) != 2 || page[0].Line != 1 || page[1].Line != 4 || nextOffset != 5 {
		t.Fatalf("search page = %#v, textTruncated=%v, nextOffset=%d", page, textTruncated, nextOffset)
	}
}

func intsToStrings(values []int) []string {
	result := make([]string, len(values))
	for i, value := range values {
		result[i] = intToStr(value)
	}
	return result
}

func TestBatchPreservesMixedLineEndingsAndBOM(t *testing.T) {
	tests := []struct {
		name    string
		content string
		edit    BatchEditOp
		want    string
	}{
		{name: "replace", content: "a\r\nb\nc\r\nd\n", edit: BatchEditOp{OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"}}, want: "a\r\nB\nc\r\nd\n"},
		{name: "range replace", content: "a\r\nb\nc\r\nd\n", edit: BatchEditOp{OP: "replace", Pos: formatTag(2, "b"), EndPos: formatTag(3, "c"), Lines: []string{"BC"}}, want: "a\r\nBC\r\nd\n"},
		{name: "insert before", content: "a\r\nb\n", edit: BatchEditOp{OP: "insert", Pos: formatTag(1, "a"), Lines: []string{"N"}}, want: "N\r\na\r\nb\n"},
		{name: "insert after unterminated", content: "a\r\nb", edit: BatchEditOp{OP: "insert", Pos: formatTag(2, "b"), After: true, Lines: []string{"N"}}, want: "a\r\nb\r\nN"},
		{name: "delete to EOF", content: "a\r\nb\nc", edit: BatchEditOp{OP: "delete", Pos: formatTag(2, "b"), EndPos: formatTag(3, "c")}, want: "a"},
		{name: "delete all", content: "a\r\nb\n", edit: BatchEditOp{OP: "delete", Pos: formatTag(1, "a"), EndPos: formatTag(2, "b")}, want: ""},
		{name: "BOM", content: utf8BOM + "a\r\nb\n", edit: BatchEditOp{OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"}}, want: utf8BOM + "a\r\nB\n"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			path := commandTestWriteFile(t, dir, "target.txt", testCase.content)
			output := batchTestRun(t, path, BatchEditRequest{Edits: []BatchEditOp{testCase.edit}}, false)
			protocolTestAssertBatchSuccess(t, output, path)
			protocolTestAssertFile(t, path, testCase.want)
		})
	}
}

func TestBatchMultipleMixedEOLChangesPreserveEachRegion(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "a\r\nb\nc\r\nd\ne\r\n")
	output := batchTestRun(t, path, BatchEditRequest{Edits: []BatchEditOp{
		{OP: "replace", Pos: formatTag(1, "a"), Lines: []string{"A"}},
		{OP: "insert", Pos: formatTag(3, "c"), After: true, Lines: []string{"N"}},
		{OP: "delete", Pos: formatTag(4, "d")},
	}}, false)
	protocolTestAssertBatchSuccess(t, output, path)
	protocolTestAssertFile(t, path, "A\r\nb\nc\r\nN\r\ne\r\n")
}

func TestBatchCheckPreservesRawBytes(t *testing.T) {
	dir := t.TempDir()
	path := commandTestWriteFile(t, dir, "target.txt", "a\r\nb\n")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	output := batchTestRun(t, path, BatchEditRequest{Edits: []BatchEditOp{{OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"}}}}, true)
	var result BatchEditResult
	batchTestMustUnmarshal(t, output, &result)
	if !result.OK || !result.Checked || !result.ContentChanged || result.Revision != rawFileRevision(before) {
		t.Fatalf("check result = %#v", result)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("batch --check changed file: before=%v after=%v", before, after)
	}
}
