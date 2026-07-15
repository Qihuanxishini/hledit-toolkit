package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func readTestCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()

	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}

	os.Stdout = w
	defer func() {
		os.Stdout = oldStdout
	}()

	outCh := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		outCh <- string(b)
	}()

	fn()
	_ = w.Close()
	out := <-outCh
	_ = r.Close()
	return out
}

func readTestLines(t *testing.T, output string) []string {
	t.Helper()
	output = strings.TrimSuffix(output, "\n")
	if output == "" {
		return nil
	}
	return strings.Split(output, "\n")
}

func readTestWriteFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write file %s: %v", path, err)
	}
	return path
}

func TestCmdReadAnnotatesSmallFile(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "small.txt", "alpha\nbeta\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	want := []string{
		formatTag(1, "alpha") + ":alpha",
		formatTag(2, "beta") + ":beta",
	}
	if len(got) != len(want) {
		t.Fatalf("cmdRead output line count = %d; want %d (%q)", len(got), len(want), output)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("cmdRead line %d = %q; want %q", i+1, got[i], want[i])
		}
	}
}

func TestCmdReadDropsTrailingPhantomEmptyLine(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "trailing-newline.txt", "solo\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 1 {
		t.Fatalf("cmdRead output line count = %d; want 1 (%q)", len(got), output)
	}
	want := formatTag(1, "solo") + ":solo"
	if got[0] != want {
		t.Fatalf("cmdRead line = %q; want %q", got[0], want)
	}
}

func TestCmdReadMissingFileEmitsIOErrorJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "missing.txt")

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	var got EditError
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if got.OK {
		t.Fatalf("cmdRead missing file ok = true; want false")
	}
	if got.Error != "io" {
		t.Fatalf("cmdRead missing file error = %q; want %q", got.Error, "io")
	}
}

func TestCmdReadBinaryDetectionEmitsJSONError(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "binary.bin", string([]byte{'a', 0x00, 'b', '\n'}))

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	var got EditError
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if got.OK {
		t.Fatalf("cmdRead binary ok = true; want false")
	}
	if got.Error != "binary" {
		t.Fatalf("cmdRead binary error = %q; want %q", got.Error, "binary")
	}
}

func TestCmdReadTruncatesAfterTwoThousandLines(t *testing.T) {
	dir := t.TempDir()
	var b strings.Builder
	for i := 0; i < 2001; i++ {
		b.WriteString("x\n")
	}
	path := readTestWriteFile(t, dir, "many-lines.txt", b.String())

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 2001 {
		t.Fatalf("cmdRead output line count = %d; want 2001", len(got))
	}
	if got[0] != formatTag(1, "x")+":x" {
		t.Fatalf("cmdRead first line = %q; want tagged line 1", got[0])
	}
	if got[1999] != formatTag(2000, "x")+":x" {
		t.Fatalf("cmdRead 2000th line = %q; want tagged line 2000", got[1999])
	}
	if got[2000] != "-- truncated: use read-range --offset 2001 --" {
		t.Fatalf("cmdRead truncation notice = %q; want offset 2001", got[2000])
	}
}

func TestCmdReadRangeUsesAbsoluteLineNumbersAndExactRange(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "range.txt", "one\ntwo\nthree\nfour\nfive\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 2, 2, "", 0, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 3 {
		t.Fatalf("cmdReadRange output line count = %d; want 3 (%q)", len(got), output)
	}
	if got[0] != formatTag(2, "two")+":two" {
		t.Fatalf("cmdReadRange first line = %q; want line 2", got[0])
	}
	if got[1] != formatTag(3, "three")+":three" {
		t.Fatalf("cmdReadRange second line = %q; want line 3", got[1])
	}
	if got[2] != "-- truncated: use read-range --offset 4 --" {
		t.Fatalf("cmdReadRange truncation notice = %q; want offset 4", got[2])
	}
}

func TestCmdReadRangeOffsetLessThanOneIsTreatedAsOne(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "offset0.txt", "first\nsecond\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 0, 1, "", 0, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 2 {
		t.Fatalf("cmdReadRange output line count = %d; want 2 (%q)", len(got), output)
	}
	want := formatTag(1, "first") + ":first"
	if got[0] != want {
		t.Fatalf("cmdReadRange first line = %q; want %q", got[0], want)
	}
	if got[1] != "-- truncated: use read-range --offset 2 --" {
		t.Fatalf("cmdReadRange truncation notice = %q; want offset 2", got[1])
	}
}

func TestCmdReadRangeOffsetBeyondFileLengthEmitsRangeError(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "range-error.txt", "one\ntwo\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 3, 1, "", 0, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	var got EditError
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if got.OK {
		t.Fatalf("cmdReadRange range ok = true; want false")
	}
	if got.Error != "range" {
		t.Fatalf("cmdReadRange range error = %q; want %q", got.Error, "range")
	}
}

func TestCmdReadTruncatesAt50KBByteLimit(t *testing.T) {
	dir := t.TempDir()
	// Create lines that are each ~100 bytes. 50 KB = 51200 bytes.
	// With ~100 bytes per line (including tag prefix), we should hit
	// the byte limit well before 2000 lines.
	var b strings.Builder
	for i := 0; i < 1000; i++ {
		b.WriteString("this is a deliberately long line to test byte-limit truncation behavior\n")
	}
	path := readTestWriteFile(t, dir, "big-lines.txt", b.String())

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	// Should have been truncated by byte limit, not line count
	if len(got) >= 2000 {
		t.Fatalf("cmdRead output line count = %d; expected < 2000 (byte-limit truncation)", len(got))
	}
	// Last line should be the truncation notice
	lastLine := got[len(got)-1]
	if !strings.HasPrefix(lastLine, "-- truncated: use read-range --offset") {
		t.Fatalf("cmdRead last line = %q; want truncation notice", lastLine)
	}
	// Verify the output byte size is near the 50 KB limit
	if len(output) > 50*1024+1024 {
		t.Fatalf("cmdRead output size = %d; expected near 50 KB", len(output))
	}
}

// five-line fixture used by grep/context tests.
const grepFixture = "alpha\nbeta\nmatch-me\ndelta\nepsilon\n"

func TestCmdReadGrep(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "grep.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "match", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 1 {
		t.Fatalf("cmdRead --grep output line count = %d; want 1 (%q)", len(got), output)
	}
	want := formatTag(3, "match-me") + ":match-me"
	if got[0] != want {
		t.Fatalf("cmdRead --grep line = %q; want %q", got[0], want)
	}
}

func TestCmdReadGrepNoMatch(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "grep-nomatch.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "zzz-no-match", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if got != nil {
		t.Fatalf("cmdRead --grep no-match expected empty output; got %q", output)
	}
}

func TestCmdReadGrepContext(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "ctx.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "match", 1, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	// match on line 3, context=1 → lines 2,3,4
	if len(got) != 3 {
		t.Fatalf("cmdRead --grep --context=1 line count = %d; want 3 (%q)", len(got), output)
	}
	wantLines := []struct {
		num  int
		text string
	}{
		{2, "beta"},
		{3, "match-me"},
		{4, "delta"},
	}
	for i, w := range wantLines {
		want := formatTag(w.num, w.text) + ":" + w.text
		if got[i] != want {
			t.Fatalf("cmdRead context line[%d] = %q; want %q", i, got[i], want)
		}
	}
}

func TestCmdReadGrepContextClampsToBounds(t *testing.T) {
	dir := t.TempDir()
	// match on line 1, context=5 should not go below line 1
	path := readTestWriteFile(t, dir, "clamp.txt", "match-me\nbeta\ngamma\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "match", 5, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	// all 3 lines should appear (context extends to end)
	if len(got) != 3 {
		t.Fatalf("cmdRead clamp line count = %d; want 3 (%q)", len(got), output)
	}
	if got[0] != formatTag(1, "match-me")+":match-me" {
		t.Fatalf("cmdRead clamp first line = %q; want line 1", got[0])
	}
}

func TestCmdReadRangeGrepContext(t *testing.T) {
	dir := t.TempDir()
	// 7-line file; match on line 5, context=1 → lines 4,5,6
	content := "one\ntwo\nthree\nfour\nmatch-me\nsix\nseven\n"
	path := readTestWriteFile(t, dir, "rr-ctx.txt", content)

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 2000, "match", 1, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	got := readTestLines(t, output)
	if len(got) != 3 {
		t.Fatalf("cmdReadRange --grep --context=1 line count = %d; want 3 (%q)", len(got), output)
	}
	wantLines := []struct {
		num  int
		text string
	}{
		{4, "four"},
		{5, "match-me"},
		{6, "six"},
	}
	for i, w := range wantLines {
		want := formatTag(w.num, w.text) + ":" + w.text
		if got[i] != want {
			t.Fatalf("cmdReadRange context line[%d] = %q; want %q", i, got[i], want)
		}
	}
}
func TestCmdReadRangeGrepOffsetAfterLastMatch(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "rr-offset-after.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 5, 2000, "match", 1, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	if output != "" {
		t.Fatalf("cmdReadRange --grep offset after last match output = %q; want empty", output)
	}
}
func TestApplyContextOverlappingWindows(t *testing.T) {
	// 10 lines; matches at 3 and 6, context=2
	// window for 3: lines 1-5; window for 6: lines 4-8 → merged: 1-8
	lines := []string{"L1", "L2", "L3hit", "L4", "L5", "L6hit", "L7", "L8", "L9", "L10"}
	matchIdxs := []int{3, 6}
	got := applyContext(lines, matchIdxs, 2)

	want := []int{1, 2, 3, 4, 5, 6, 7, 8}
	if len(got) != len(want) {
		t.Fatalf("applyContext overlap len = %d; want %d (%v)", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Fatalf("applyContext overlap[%d] = %d; want %d", i, got[i], w)
		}
	}
}

func TestApplyContextZeroIsNoop(t *testing.T) {
	lines := []string{"a", "b", "c"}
	matchIdxs := []int{2}
	got := applyContext(lines, matchIdxs, 0)
	if len(got) != 1 || got[0] != 2 {
		t.Fatalf("applyContext context=0 should be noop, got %v", got)
	}
}

// ─── JSON output tests ────────────────────────────────────────────────────────

func readTestParseJSON(t *testing.T, output string) ReadResult {
	t.Helper()
	var r ReadResult
	if err := json.Unmarshal([]byte(output), &r); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	return r
}

func TestCmdReadJSONSmallFile(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "small.txt", "alpha\nbeta\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, true); err != nil {
			t.Fatalf("cmdRead json returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if r.Truncated {
		t.Fatalf("truncated = true; want false")
	}
	if r.NextOffset != 0 {
		t.Fatalf("nextOffset = %d; want 0 (omitted)", r.NextOffset)
	}
	if len(r.Lines) != 2 {
		t.Fatalf("lines count = %d; want 2", len(r.Lines))
	}
	if r.Lines[0].Line != 1 || r.Lines[0].Text != "alpha" {
		t.Fatalf("lines[0] = %+v; want line=1 text=alpha", r.Lines[0])
	}
	if r.Lines[0].Anchor != formatTag(1, "alpha") {
		t.Fatalf("lines[0].anchor = %q; want %q", r.Lines[0].Anchor, formatTag(1, "alpha"))
	}
	if r.Lines[1].Line != 2 || r.Lines[1].Text != "beta" {
		t.Fatalf("lines[1] = %+v; want line=2 text=beta", r.Lines[1])
	}
}

func TestCmdReadJSONTruncation(t *testing.T) {
	dir := t.TempDir()
	var b strings.Builder
	for i := 0; i < 2001; i++ {
		b.WriteString("x\n")
	}
	path := readTestWriteFile(t, dir, "many.txt", b.String())

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, true); err != nil {
			t.Fatalf("cmdRead json truncation returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if !r.Truncated {
		t.Fatalf("truncated = false; want true")
	}
	if len(r.Lines) != 2000 {
		t.Fatalf("lines count = %d; want 2000", len(r.Lines))
	}
	if r.NextOffset != 2001 {
		t.Fatalf("nextOffset = %d; want 2001", r.NextOffset)
	}
	if r.Lines[0].Line != 1 {
		t.Fatalf("lines[0].line = %d; want 1", r.Lines[0].Line)
	}
	if r.Lines[1999].Line != 2000 {
		t.Fatalf("lines[1999].line = %d; want 2000", r.Lines[1999].Line)
	}
}

func TestCmdReadRangeJSONRange(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "range.txt", "one\ntwo\nthree\nfour\nfive\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 2, 2, "", 0, true); err != nil {
			t.Fatalf("cmdReadRange json returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if !r.Truncated {
		t.Fatalf("truncated = false; want true")
	}
	if r.NextOffset != 4 {
		t.Fatalf("nextOffset = %d; want 4", r.NextOffset)
	}
	if len(r.Lines) != 2 {
		t.Fatalf("lines count = %d; want 2", len(r.Lines))
	}
	if r.Lines[0].Line != 2 || r.Lines[0].Text != "two" {
		t.Fatalf("lines[0] = %+v; want line=2 text=two", r.Lines[0])
	}
	if r.Lines[1].Line != 3 || r.Lines[1].Text != "three" {
		t.Fatalf("lines[1] = %+v; want line=3 text=three", r.Lines[1])
	}
}

func TestCmdReadJSONGrepNoContext(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "grep.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "match", 0, true); err != nil {
			t.Fatalf("cmdRead json grep returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if r.Truncated {
		t.Fatalf("truncated = true; want false")
	}
	if len(r.Lines) != 1 {
		t.Fatalf("lines count = %d; want 1", len(r.Lines))
	}
	if r.Lines[0].Line != 3 || r.Lines[0].Text != "match-me" {
		t.Fatalf("lines[0] = %+v; want line=3 text=match-me", r.Lines[0])
	}
	if r.Lines[0].Anchor != formatTag(3, "match-me") {
		t.Fatalf("lines[0].anchor = %q; want %q", r.Lines[0].Anchor, formatTag(3, "match-me"))
	}
}

func TestCmdReadJSONGrepContext(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "ctx.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "match", 1, true); err != nil {
			t.Fatalf("cmdRead json grep context returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if r.Truncated {
		t.Fatalf("truncated = true; want false")
	}
	// match on line 3, context=1 → lines 2,3,4
	if len(r.Lines) != 3 {
		t.Fatalf("lines count = %d; want 3", len(r.Lines))
	}
	wantNums := []int{2, 3, 4}
	wantTexts := []string{"beta", "match-me", "delta"}
	for i, wn := range wantNums {
		if r.Lines[i].Line != wn || r.Lines[i].Text != wantTexts[i] {
			t.Fatalf("lines[%d] = %+v; want line=%d text=%s", i, r.Lines[i], wn, wantTexts[i])
		}
	}
}

func TestCmdReadJSONNoMatchReturnsEmptyArray(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "nomatch.txt", grepFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "zzz-no-match", 0, true); err != nil {
			t.Fatalf("cmdRead json no-match returned error: %v", err)
		}
	})

	r := readTestParseJSON(t, output)
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if r.Lines == nil {
		t.Fatalf("lines = null; want empty array []")
	}
	if len(r.Lines) != 0 {
		t.Fatalf("lines count = %d; want 0", len(r.Lines))
	}
	// Verify the raw JSON has "lines":[] not "lines":null
	if !strings.Contains(output, `"lines":[]`) {
		t.Fatalf("output missing \"lines\":[]; got %q", output)
	}
}

func TestCmdReadPrettyStylesAnchor(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "pretty.txt", "alpha\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadPretty(path, "", 0, false, true); err != nil {
			t.Fatalf("cmdReadPretty returned error: %v", err)
		}
	})

	if !strings.Contains(output, "\x1b[") {
		t.Fatalf("pretty output missing ANSI escapes: %q", output)
	}
	if !strings.Contains(output, prettyReadSeparator) {
		t.Fatalf("pretty output missing separator %q: %q", prettyReadSeparator, output)
	}
	if !strings.Contains(output, "alpha") {
		t.Fatalf("pretty output missing line text: %q", output)
	}
}

func TestCmdReadPrettyHighlightsContent(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "pretty-content.txt", "config := map[string]string{\"name\": \"hledit \\\"tool\\\"\"}\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadPretty(path, "", 0, false, true); err != nil {
			t.Fatalf("cmdReadPretty returned error: %v", err)
		}
	})

	if !strings.Contains(output, ansiYellow+"["+ansiReset) || !strings.Contains(output, ansiYellow+"{"+ansiReset) {
		t.Fatalf("pretty output missing bracket highlighting: %q", output)
	}
	if !strings.Contains(output, ansiGreen+"\"name\"") {
		t.Fatalf("pretty output missing quoted string highlighting: %q", output)
	}
	if !strings.Contains(output, `\"tool\""`+ansiReset) {
		t.Fatalf("pretty output did not keep escaped quote inside string: %q", output)
	}
}

func TestCmdReadPrettyRespectsNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "pretty-no-color.txt", "alpha\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadPretty(path, "", 0, false, true); err != nil {
			t.Fatalf("cmdReadPretty returned error: %v", err)
		}
	})

	want := formatTag(1, "alpha") + ":alpha\n"
	if output != want {
		t.Fatalf("NO_COLOR pretty output = %q; want %q", output, want)
	}
}

func TestCmdReadPrettyIgnoredForJSON(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "pretty-json.txt", "alpha\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadPretty(path, "", 0, true, true); err != nil {
			t.Fatalf("cmdReadPretty json returned error: %v", err)
		}
	})

	if strings.Contains(output, "\x1b[") {
		t.Fatalf("json output should not contain ANSI escapes: %q", output)
	}
	r := readTestParseJSON(t, output)
	if !r.OK || len(r.Lines) != 1 || r.Lines[0].Text != "alpha" {
		t.Fatalf("json result unexpected: %+v", r)
	}
}

func TestCmdReadRangeTruncatesSingleLongLineStrictly(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "long-line.txt", strings.Repeat("a", 70000)+"\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 1, "", 0, false); err != nil {
			t.Fatalf("cmdReadRange returned error: %v", err)
		}
	})

	if len(output) > readOutputMaxBytes {
		t.Fatalf("cmdReadRange output bytes = %d; want <= %d", len(output), readOutputMaxBytes)
	}
	if !strings.HasPrefix(output, "1#") {
		t.Fatalf("cmdReadRange output prefix = %.20q; want annotated line", output)
	}
}

func TestCmdReadGrepLongMatchTruncatesStrictly(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "long-grep.txt", "needle "+strings.Repeat("a", 70000)+"\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 1, "needle", 0, false); err != nil {
			t.Fatalf("cmdReadRange grep returned error: %v", err)
		}
	})

	if len(output) > readOutputMaxBytes {
		t.Fatalf("cmdReadRange grep output bytes = %d; want <= %d", len(output), readOutputMaxBytes)
	}
	if !strings.Contains(output, "needle") {
		t.Fatalf("cmdReadRange grep output missing match text prefix: %.80q", output)
	}
}

func TestCmdReadDropsCRFromCRLF(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "crlf.txt")
	if err := os.WriteFile(path, []byte("one\r\ntwo\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	output := readTestCaptureStdout(t, func() {
		if err := cmdRead(path, "", 0, false); err != nil {
			t.Fatalf("cmdRead returned error: %v", err)
		}
	})

	if strings.Contains(output, "\r") {
		t.Fatalf("cmdRead output contains carriage return: %q", output)
	}
	got := readTestLines(t, output)
	want := []string{formatTag(1, "one") + ":one", formatTag(2, "two") + ":two"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("cmdRead CRLF lines = %#v; want %#v", got, want)
	}
}

func TestCmdReadJSONLongLineTextTruncated(t *testing.T) {
	dir := t.TempDir()
	path := readTestWriteFile(t, dir, "long-json.txt", strings.Repeat("猫", 30000)+"\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRange(path, 1, 1, "", 0, true); err != nil {
			t.Fatalf("cmdReadRange json returned error: %v", err)
		}
	})

	var got ReadResult
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal output: %v", err)
	}
	if !got.Truncated || len(got.Lines) != 1 || !got.Lines[0].TextTruncated {
		t.Fatalf("json truncation result = %+v; want truncated line", got)
	}
	if !utf8.ValidString(got.Lines[0].Text) {
		t.Fatalf("truncated text is not valid utf8")
	}
}
