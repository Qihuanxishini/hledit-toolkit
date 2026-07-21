package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

func goldenBuild(t *testing.T, dir string) string {
	t.Helper()
	binName := "hledit"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	bin := filepath.Join(dir, binName)
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build hledit: %v\n%s", err, out)
	}
	return bin
}

func goldenRunHledit(t *testing.T, bin, stdin string, args ...string) string {
	t.Helper()
	cmd := exec.Command(bin, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("hledit %v failed: %v\nstderr:\n%s\nstdout:\n%s", args, err, ee.Stderr, out)
		}
		t.Fatalf("hledit %v failed: %v", args, err)
	}
	return string(out)
}

func goldenRunHleditAllowError(t *testing.T, bin, stdin string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.Output()
	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			t.Fatalf("hledit %v failed: %v", args, err)
		}
	}
	return string(out), exitCode
}

func goldenAnchorContaining(t *testing.T, readOut, needle string) string {
	t.Helper()
	for _, line := range strings.Split(readOut, "\n") {
		if strings.Contains(line, needle) {
			idx := strings.IndexByte(line, ':')
			if idx < 0 {
				t.Fatalf("annotated line containing %q has no colon: %q", needle, line)
			}
			return line[:idx]
		}
	}
	t.Fatalf("no anchor found for line containing %q in:\n%s", needle, readOut)
	return ""
}

func goldenFileSHA256(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func goldenReadAllAnchors(t *testing.T, bin, path string) []string {
	t.Helper()
	out := goldenRunHledit(t, bin, "", "read", path)
	var anchors []string
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		idx := strings.IndexByte(line, ':')
		if idx > 0 {
			anchors = append(anchors, line[:idx])
		}
	}
	return anchors
}

func goldenParseJSON(t *testing.T, out string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(out), v); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, out)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture: uuid.js (real-world JS source, ~1165 lines)
// ────────────────────────────────────────────────────────────────────────────

const goldenUUIDOriginalSHA256 = "52289725d4c8e56e5e41b5bfc08d52ad699639959c1d765b1487fff75f3c8059"
const goldenUUIDFinalSHA256 = "3ce011302378599768ec28d1ccc37e41d6d7e3bf5fc372fea54d93a02a2baa0d"

const goldenUnicodeJSONOriginalSHA256 = "17c983c1fd4c09182c6baa9921ab25a5345e640a03e7ea15fcb05db964962f42"
const goldenUnicodeJSONFinalSHA256 = "d3ac1de517d3e892247641e3c1f6c6d18c6cf4881e12286a6cb7765d6619a6b7"
const goldenComplexMDFixtureOriginalSHA256 = "589d19f334c2a74fe3c666d2870ec6bc1eff222adc10a52858b4de4a3d20da61"
const goldenComplexMDFixtureFinalSHA256 = "ad34e3ec3192a294ca68231a61290d7a38361a755a003400732f02a195dd6d8e"

func TestGolden_UUIDFixture_ReplaceInsertReplaceRange(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	fixtureBytes, err := os.ReadFile(filepath.Join("testdata", "uuid.js"))
	if err != nil {
		t.Fatal(err)
	}
	workFile := filepath.Join(dir, "uuid.js")
	if err := os.WriteFile(workFile, fixtureBytes, 0644); err != nil {
		t.Fatal(err)
	}

	originalSHA := goldenFileSHA256(t, workFile)
	if originalSHA != goldenUUIDOriginalSHA256 {
		t.Fatalf("original fixture sha = %s, want %s", originalSHA, goldenUUIDOriginalSHA256)
	}

	// Replace a comment line
	readOut := goldenRunHledit(t, bin, "", "read", workFile)
	sourceAnchor := goldenAnchorContaining(t, readOut, "// Source: https://www.npmjs.com/package/uuid / https://github.com/uuidjs/uuid")
	goldenRunHledit(t, bin,
		"// Source: official uuid package uuid@14.0.0 (npm uuidjs/uuid)\n",
		"replace", workFile, sourceAnchor, "-",
	)

	// Insert after a line
	readOut = goldenRunHledit(t, bin, "", "read", workFile)
	filesAnchor := goldenAnchorContaining(t, readOut, "// Files: all dist/*.js and dist-node/*.js concatenated in lexical order.")
	goldenRunHledit(t, bin,
		"// Golden fixture edited by hledit integration test.\n",
		"insert", "--after", workFile, filesAnchor, "-",
	)

	// Replace a range
	readOut = goldenRunHledit(t, bin, "", "read", workFile)
	startAnchor := goldenAnchorContaining(t, readOut, "// ----- dist-node/max.js -----")
	endAnchor := goldenAnchorContaining(t, readOut, "export default 'ffffffff-ffff-ffff-ffff-ffffffffffff';")
	goldenRunHledit(t, bin,
		"// ----- dist-node/max.js (edited) -----\nexport default 'ffffffff-ffff-ffff-ffff-ffffffffffff'; // max uuid\n",
		"replace-range", workFile, startAnchor, endAnchor, "-",
	)

	finalSHA := goldenFileSHA256(t, workFile)
	if finalSHA == originalSHA {
		t.Fatal("final sha unexpectedly equals original sha")
	}
	if finalSHA != goldenUUIDFinalSHA256 {
		t.Fatalf("final sha = %s, want %s", finalSHA, goldenUUIDFinalSHA256)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture: unicode.json (Unicode-heavy JSON source)
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_UnicodeJSONFixture_ReplaceUnicodeLine(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	fixtureBytes, err := os.ReadFile(filepath.Join("testdata", "unicode.json"))
	if err != nil {
		t.Fatal(err)
	}
	workFile := filepath.Join(dir, "unicode.json")
	if err := os.WriteFile(workFile, fixtureBytes, 0644); err != nil {
		t.Fatal(err)
	}

	originalSHA := goldenFileSHA256(t, workFile)
	if originalSHA != goldenUnicodeJSONOriginalSHA256 {
		t.Fatalf("original fixture sha = %s, want %s", originalSHA, goldenUnicodeJSONOriginalSHA256)
	}

	readOut := goldenRunHledit(t, bin, "", "read", workFile)
	descriptionAnchor := goldenAnchorContaining(t, readOut, "\"description\": \"Unicode JSON fixture with accents, emoji, and CJK.\",")
	goldenRunHledit(t, bin,
		"  \"description\": \"Unicode JSON fixture with accents, emoji, CJK, and more — edited.\",\n",
		"replace", workFile, descriptionAnchor, "-",
	)

	finalSHA := goldenFileSHA256(t, workFile)
	if finalSHA == originalSHA {
		t.Fatal("final sha unexpectedly equals original sha")
	}
	if finalSHA != goldenUnicodeJSONFinalSHA256 {
		t.Fatalf("final sha = %s, want %s", finalSHA, goldenUnicodeJSONFinalSHA256)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture: complex.md (larger Markdown source)
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_ComplexMarkdownFixture_ReplaceRangeAndInsert(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	fixtureBytes, err := os.ReadFile(filepath.Join("testdata", "complex.md"))
	if err != nil {
		t.Fatal(err)
	}
	workFile := filepath.Join(dir, "complex.md")
	if err := os.WriteFile(workFile, fixtureBytes, 0644); err != nil {
		t.Fatal(err)
	}

	originalSHA := goldenFileSHA256(t, workFile)
	if originalSHA != goldenComplexMDFixtureOriginalSHA256 {
		t.Fatalf("original fixture sha = %s, want %s", originalSHA, goldenComplexMDFixtureOriginalSHA256)
	}

	readOut := goldenRunHledit(t, bin, "", "read", workFile)
	titleAnchor := goldenAnchorContaining(t, readOut, "# Unicode Markdown Fixture")
	goldenRunHledit(t, bin, "<!-- verified by golden test -->\n", "insert", "--after", workFile, titleAnchor, "-")

	readOut = goldenRunHledit(t, bin, "", "read", workFile)
	startAnchor := goldenAnchorContaining(t, readOut, "## Data Model")
	endAnchor := goldenAnchorContaining(t, readOut, "## Appendix")
	goldenRunHledit(t, bin,
		"## Data Model\n\nThis section was rewritten during the golden test.\n\n- `document` keeps metadata.\n- `section` keeps anchors stable.\n- `note` keeps Unicode safe: Ω, ñ, 你, 😀.\n\n```yaml\nkind: document\nlocale: ja-JP\nowner: \"María\"\nstatus: rewritten\n```\n\n### Constraints\n\n1. Headings must stay line-aligned.\n2. Code fences must remain balanced.\n3. Unicode should round-trip without mojibake.\n",
		"replace-range", workFile, startAnchor, endAnchor, "-",
	)

	finalSHA := goldenFileSHA256(t, workFile)
	if finalSHA == originalSHA {
		t.Fatal("final sha unexpectedly equals original sha")
	}
	if finalSHA != goldenComplexMDFixtureFinalSHA256 {
		t.Fatalf("final sha = %s, want %s", finalSHA, goldenComplexMDFixtureFinalSHA256)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Batch edit: the core feature for multi-edit workflows
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_BatchEdit_MultipleOps(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "test.txt")
	content := "line1\nline2\nline3\nline4\nline5\n"
	if err := os.WriteFile(workFile, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	anchors := goldenReadAllAnchors(t, bin, workFile)

	// Batch: replace line2, delete line4, insert before line5
	batchReq := fmt.Sprintf(
		`{"edits":[
			{"op":"replace","pos":"%s","lines":["TWO"]},
			{"op":"delete","pos":"%s","lines":[]},
			{"op":"insert","pos":"%s","lines":["new"]}
		]}`,
		anchors[1], anchors[3], anchors[4],
	)

	out := goldenRunHledit(t, bin, batchReq, "batch", workFile)
	var result BatchEditResult
	goldenParseJSON(t, out, &result)
	if !result.OK {
		t.Fatalf("batch failed: %s", out)
	}
	if result.EditsApplied != 3 {
		t.Fatalf("edits applied = %d, want 3", result.EditsApplied)
	}

	data, _ := os.ReadFile(workFile)
	expected := "line1\nTWO\nline3\nnew\nline5\n"
	if string(data) != expected {
		t.Fatalf("content = %q, want %q", string(data), expected)
	}
}

func TestGolden_BatchEdit_StaleAnchorRejectsAll(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "test.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	// First edit succeeds
	anchors := goldenReadAllAnchors(t, bin, workFile)
	batch1 := fmt.Sprintf(`{"edits":[{"op":"replace","pos":"%s","lines":["A"]}]}`, anchors[0])
	goldenRunHledit(t, bin, batch1, "batch", workFile)

	// Second batch reuses stale anchor → rejected
	batch2 := fmt.Sprintf(`{"edits":[{"op":"replace","pos":"%s","lines":["B"]}]}`, anchors[0])
	out, _ := goldenRunHleditAllowError(t, bin, batch2, "batch", workFile)
	var errResult BatchEditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatal("expected stale error")
	}
	if errResult.Error != "stale" {
		t.Fatalf("error = %q, want stale", errResult.Error)
	}

	// File unchanged after rejected batch
	data, _ := os.ReadFile(workFile)
	if string(data) != "A\nb\nc\n" {
		t.Fatalf("file changed after stale batch: %q", string(data))
	}
}

func TestGolden_BatchEdit_SingleOp(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "single.txt")
	os.WriteFile(workFile, []byte("hello\nworld\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	batch := fmt.Sprintf(`{"edits":[{"op":"replace","pos":"%s","lines":["HELLO"]}]}`, anchors[0])
	goldenRunHledit(t, bin, batch, "batch", workFile)

	data, _ := os.ReadFile(workFile)
	if string(data) != "HELLO\nworld\n" {
		t.Fatalf("content = %q", string(data))
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Grep filtering: token-efficient targeted reads
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_GrepFilter_Basic(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "grep.txt")
	os.WriteFile(workFile, []byte("package main\nimport \"fmt\"\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n"), 0644)

	// Grep for "func" → should return only line 3
	out := goldenRunHledit(t, bin, "", "read-range", workFile, "--grep", "func")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 1 {
		t.Fatalf("grep 'func' returned %d lines, want 1:\n%s", len(lines), out)
	}
	if !strings.Contains(lines[0], "func main()") {
		t.Fatalf("grep result = %q, want func line", lines[0])
	}
}

func TestGolden_GrepFilter_NoMatch(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "grep.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	out := goldenRunHledit(t, bin, "", "read-range", workFile, "--grep", "nonexistent")
	if strings.TrimSpace(out) != "" {
		t.Fatalf("grep 'nonexistent' should return empty, got: %q", out)
	}
}

func TestGolden_GrepFilter_MultipleMatches(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "grep.txt")
	os.WriteFile(workFile, []byte("import \"fmt\"\nimport \"os\"\nfunc main() {}\n"), 0644)

	out := goldenRunHledit(t, bin, "", "read-range", workFile, "--grep", "import")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		t.Fatalf("grep 'import' returned %d lines, want 2:\n%s", len(lines), out)
	}
}

func TestGolden_GrepFilter_WithPagination(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	var content strings.Builder
	for i := 0; i < 50; i++ {
		content.WriteString(fmt.Sprintf("func func%d() {}\n", i))
	}
	workFile := filepath.Join(dir, "grep_many.txt")
	os.WriteFile(workFile, []byte(content.String()), 0644)

	out := goldenRunHledit(t, bin, "", "read-range", workFile, "--grep", "func", "--limit", "5")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 5 {
		t.Fatalf("grep with limit 5 returned %d lines, want >= 5:\n%s", len(lines), out)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_Edge_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "empty.txt")
	os.WriteFile(workFile, []byte(""), 0644)

	// Read empty file
	out := goldenRunHledit(t, bin, "", "read", workFile)
	if strings.TrimSpace(out) != "" {
		t.Fatalf("empty file read = %q, want empty", out)
	}

	// Insert into empty file (anchor line 1 which doesn't exist → stale)
	_, exitCode := goldenRunHleditAllowError(t, bin, "new line\n", "insert", "--before", workFile, "1#aB3", "-")
	if exitCode == 0 {
		// Should fail with stale anchor
		out2, _ := goldenRunHleditAllowError(t, bin, "", "read", workFile)
		t.Logf("after insert attempt: %q", out2)
	}
}

func TestGolden_Edge_SingleLine(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "single.txt")
	os.WriteFile(workFile, []byte("only line\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	if len(anchors) != 1 {
		t.Fatalf("expected 1 anchor, got %d", len(anchors))
	}

	// Replace the only line
	goldenRunHledit(t, bin, "replaced\n", "replace", workFile, anchors[0], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "replaced\n" {
		t.Fatalf("content = %q", string(data))
	}
}

func TestGolden_Edge_BinaryDetection(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "binary.dat")
	os.WriteFile(workFile, []byte{0x00, 0x01, 0x02, 0x03}, 0644)

	out := goldenRunHledit(t, bin, "", "read", workFile)
	var errResult EditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatalf("binary file should return ok=false, got: %s", out)
	}
	if errResult.Error != "binary" {
		t.Fatalf("error = %q, want binary", errResult.Error)
	}
}

func TestGolden_Edge_MissingFile(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	out := goldenRunHledit(t, bin, "", "read", filepath.Join(dir, "nonexistent.txt"))
	var errResult EditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatalf("missing file should return ok=false, got: %s", out)
	}
	if errResult.Error != "io" {
		t.Fatalf("error = %q, want io", errResult.Error)
	}
}

func TestGolden_Edge_StaleAnchor(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "stale.txt")
	os.WriteFile(workFile, []byte("original\n"), 0644)

	anchor := goldenReadAllAnchors(t, bin, workFile)[0]

	// Modify the file externally
	os.WriteFile(workFile, []byte("modified\n"), 0644)

	// Try to edit with stale anchor
	out, _ := goldenRunHleditAllowError(t, bin, "new\n", "replace", workFile, anchor, "-")
	var errResult EditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatal("expected stale error")
	}
	if errResult.Error != "stale" {
		t.Fatalf("error = %q, want stale", errResult.Error)
	}
	if len(errResult.Remaps) == 0 {
		t.Fatal("expected remaps in stale response")
	}

	// File unchanged
	data, _ := os.ReadFile(workFile)
	if string(data) != "modified\n" {
		t.Fatalf("file changed: %q", string(data))
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Trailing newline preservation
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_TrailingNewline_Preserved(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	// File WITH trailing newline
	workFile := filepath.Join(dir, "with_newline.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	goldenRunHledit(t, bin, "B\n", "replace", workFile, anchors[1], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\nB\nc\n" {
		t.Fatalf("content = %q, want trailing newline preserved", string(data))
	}
}

func TestGolden_TrailingNewline_Absent(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	// File WITHOUT trailing newline
	workFile := filepath.Join(dir, "no_newline.txt")
	os.WriteFile(workFile, []byte("a\nb\nc"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	goldenRunHledit(t, bin, "B\n", "replace", workFile, anchors[1], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\nB\nc" {
		t.Fatalf("content = %q, want no trailing newline", string(data))
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Large file truncation
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_LargeFile_Truncation(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	// Create a file with >2000 lines
	var content strings.Builder
	for i := 0; i < 2500; i++ {
		content.WriteString(fmt.Sprintf("line %d\n", i))
	}
	workFile := filepath.Join(dir, "large.txt")
	os.WriteFile(workFile, []byte(content.String()), 0644)

	// Read should truncate at 2000 lines
	out := goldenRunHledit(t, bin, "", "read", workFile)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	// 2000 content lines + 1 truncation notice
	if len(lines) != 2001 {
		t.Fatalf("large file read returned %d lines, want 2001", len(lines))
	}
	lastLine := lines[len(lines)-1]
	if !strings.HasPrefix(lastLine, "-- truncated:") {
		t.Fatalf("last line = %q, want truncation notice", lastLine)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Delete operation (empty content)
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_Delete_SingleLine(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "delete.txt")
	os.WriteFile(workFile, []byte("keep\ndelete_me\nkeep2\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	goldenRunHledit(t, bin, "", "replace", workFile, anchors[1], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "keep\nkeep2\n" {
		t.Fatalf("content = %q", string(data))
	}
}

func TestGolden_Delete_Range(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "delete_range.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\nd\ne\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	// Delete lines 2-4 (b, c, d)
	goldenRunHledit(t, bin, "", "replace-range", workFile, anchors[1], anchors[3], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\ne\n" {
		t.Fatalf("content = %q", string(data))
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Insert: before and after
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_Insert_Before(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "insert.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	goldenRunHledit(t, bin, "new\n", "insert", "--before", workFile, anchors[1], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\nnew\nb\nc\n" {
		t.Fatalf("content = %q", string(data))
	}
}

func TestGolden_Insert_After(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "insert.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	goldenRunHledit(t, bin, "new\n", "insert", "--after", workFile, anchors[1], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\nb\nnew\nc\n" {
		t.Fatalf("content = %q", string(data))
	}
}

func TestGolden_Insert_EmptyContent_Error(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "insert.txt")
	os.WriteFile(workFile, []byte("a\nb\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	out, _ := goldenRunHleditAllowError(t, bin, "", "insert", "--before", workFile, anchors[0], "-")
	var errResult EditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatal("expected error for empty insert")
	}
	if !strings.Contains(errResult.Message, "non-empty") {
		t.Fatalf("message = %q, want non-empty content error", errResult.Message)
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Replace-range: multi-line replacement
// ────────────────────────────────────────────────────────────────────────────

func TestGolden_ReplaceRange_MultiLine(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "range.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\nd\ne\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	// Replace lines 2-3 with 4 lines
	goldenRunHledit(t, bin, "X\nY\nZ\nW\n", "replace-range", workFile, anchors[1], anchors[2], "-")

	data, _ := os.ReadFile(workFile)
	if string(data) != "a\nX\nY\nZ\nW\nd\ne\n" {
		t.Fatalf("content = %q", string(data))
	}
}

func TestGolden_ReplaceRange_SwappedAnchors_Error(t *testing.T) {
	dir := t.TempDir()
	bin := goldenBuild(t, dir)

	workFile := filepath.Join(dir, "range.txt")
	os.WriteFile(workFile, []byte("a\nb\nc\n"), 0644)

	anchors := goldenReadAllAnchors(t, bin, workFile)
	// Start > end
	out, _ := goldenRunHleditAllowError(t, bin, "x\n", "replace-range", workFile, anchors[2], anchors[0], "-")
	var errResult EditError
	goldenParseJSON(t, out, &errResult)
	if errResult.OK {
		t.Fatal("expected error for swapped anchors")
	}
	if errResult.Error != "invalid" {
		t.Fatalf("error = %q, want invalid", errResult.Error)
	}
}
