package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// anchorsFixture is a 5-line fixture shared by anchors tests.
const anchorsFixture = "alpha\nbeta\nmatch-me\ndelta\nepsilon\n"

func TestCmdAnchorsTextOutput(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	writeTestFile(t, path, "foo\nbar\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	got := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if len(got) != 2 {
		t.Fatalf("anchors output line count = %d; want 2 (%q)", len(got), output)
	}
	want0 := formatTag(1, "foo") + "\t" + "foo"
	want1 := formatTag(2, "bar") + "\t" + "bar"
	if got[0] != want0 {
		t.Fatalf("anchors line[0] = %q; want %q", got[0], want0)
	}
	if got[1] != want1 {
		t.Fatalf("anchors line[1] = %q; want %q", got[1], want1)
	}
}

func TestCmdAnchorsNoColon(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	writeTestFile(t, path, "hello\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	// Tag must be separated by tab, not colon.
	tag := formatTag(1, "hello")
	if !strings.Contains(output, tag+"\t") {
		t.Fatalf("anchors output missing tab separator; got %q", output)
	}
	if strings.Contains(output, tag+":") {
		t.Fatalf("anchors output unexpectedly contains colon separator; got %q", output)
	}
}

func TestCmdAnchorsGrep(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "g.txt")
	writeTestFile(t, path, anchorsFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "match", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("anchors --grep line count = %d; want 1 (%q)", len(lines), output)
	}
	want := formatTag(3, "match-me") + "\t" + "match-me"
	if lines[0] != want {
		t.Fatalf("anchors --grep line = %q; want %q", lines[0], want)
	}
}

func TestCmdAnchorsGrepContext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gc.txt")
	writeTestFile(t, path, anchorsFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "match", 1, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	// match on line 3, context=1 → lines 2,3,4
	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("anchors --grep --context=1 line count = %d; want 3 (%q)", len(lines), output)
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
		want := formatTag(w.num, w.text) + "\t" + w.text
		if lines[i] != want {
			t.Fatalf("anchors context line[%d] = %q; want %q", i, lines[i], want)
		}
	}
}

func TestCmdAnchorsOffsetLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ol.txt")
	writeTestFile(t, path, "one\ntwo\nthree\nfour\nfive\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 2, 2, "", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("anchors --offset 2 --limit 2 line count = %d; want 3 (%q)", len(lines), output)
	}
	if lines[0] != formatTag(2, "two")+"\ttwo" {
		t.Fatalf("anchors line[0] = %q; want line 2", lines[0])
	}
	if lines[1] != formatTag(3, "three")+"\tthree" {
		t.Fatalf("anchors line[1] = %q; want line 3", lines[1])
	}
	if !strings.HasPrefix(lines[2], "-- truncated: use anchors --offset 4 --") {
		t.Fatalf("anchors truncation notice = %q; want offset 4", lines[2])
	}
}

func TestCmdAnchorsOffsetBeyondFileEmitsRangeError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "oor.txt")
	writeTestFile(t, path, "one\ntwo\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 5, 2000, "", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	var got EditError
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if got.OK {
		t.Fatalf("anchors range ok = true; want false")
	}
	if got.Error != "range" {
		t.Fatalf("anchors range error = %q; want \"range\"", got.Error)
	}
}

func TestCmdAnchorsBinaryFileEmitsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bin.bin")
	writeTestFile(t, path, string([]byte{'a', 0x00, 'b', '\n'}))

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "", 0, false); err != nil {
			t.Fatalf("cmdAnchors returned error: %v", err)
		}
	})

	var got EditError
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if got.OK {
		t.Fatalf("anchors binary ok = true; want false")
	}
	if got.Error != "binary" {
		t.Fatalf("anchors binary error = %q; want \"binary\"", got.Error)
	}
}

func TestCmdAnchorsJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "j.txt")
	writeTestFile(t, path, "alpha\nbeta\n")

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "", 0, true); err != nil {
			t.Fatalf("cmdAnchors json returned error: %v", err)
		}
	})

	var r ReadResult
	if err := json.Unmarshal([]byte(output), &r); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	if r.TotalLines != 2 {
		t.Fatalf("totalLines = %d; want 2", r.TotalLines)
	}
	if r.Truncated {
		t.Fatalf("truncated = true; want false")
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

func TestCmdAnchorsJSONTruncation(t *testing.T) {
	dir := t.TempDir()
	var b strings.Builder
	for i := 0; i < 2001; i++ {
		b.WriteString("x\n")
	}
	path := filepath.Join(dir, "many.txt")
	writeTestFile(t, path, b.String())

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "", 0, true); err != nil {
			t.Fatalf("cmdAnchors json truncation returned error: %v", err)
		}
	})

	var r ReadResult
	if err := json.Unmarshal([]byte(output), &r); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if !r.Truncated {
		t.Fatalf("truncated = false; want true")
	}
	if r.TotalLines != 2001 {
		t.Fatalf("totalLines = %d; want 2001", r.TotalLines)
	}
	if len(r.Lines) != 2000 {
		t.Fatalf("lines count = %d; want 2000", len(r.Lines))
	}
	if r.NextOffset != 2001 {
		t.Fatalf("nextOffset = %d; want 2001", r.NextOffset)
	}
}

func TestCmdAnchorsJSONGrepContext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gc.txt")
	writeTestFile(t, path, anchorsFixture)

	output := readTestCaptureStdout(t, func() {
		if err := cmdAnchors(path, 1, 2000, "match", 1, true); err != nil {
			t.Fatalf("cmdAnchors json grep context returned error: %v", err)
		}
	})

	var r ReadResult
	if err := json.Unmarshal([]byte(output), &r); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
	if !r.OK {
		t.Fatalf("ok = false; want true")
	}
	// match on line 3, context=1 → lines 2,3,4
	if len(r.Lines) != 3 {
		t.Fatalf("lines count = %d; want 3", len(r.Lines))
	}
	wantNums := []int{2, 3, 4}
	wantTexts := []string{"beta", "match-me", "delta"}
	for i := range wantNums {
		if r.Lines[i].Line != wantNums[i] || r.Lines[i].Text != wantTexts[i] {
			t.Fatalf("lines[%d] = %+v; want line=%d text=%s", i, r.Lines[i], wantNums[i], wantTexts[i])
		}
	}
}

// writeTestFile is a helper that writes content to path, failing the test on error.
func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writeTestFile %s: %v", path, err)
	}
}
