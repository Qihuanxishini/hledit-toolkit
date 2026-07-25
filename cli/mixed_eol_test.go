package main

// [喵喵喵]: OPTIMIZATION-ROADMAP Phase 3 回归矩阵 (2026-07-25)。
// 目标行为：逐行保留 terminator——未修改行的行尾字节保持原样，replacement 最后
// 一行继承被替换范围末行的 terminator，新行使用编辑位置附近的局部行尾，原文件
// trailing newline 的存在性保持，不再整文件归一化，也不再返回 mixed warning。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mixedEOLWriteFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func mixedEOLAssertFile(t *testing.T, path, want string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != want {
		t.Fatalf("file content = %q; want %q", string(content), want)
	}
}

// 成功输出既不得含 mixed 警告，revision 也必须等于最终文件真实字节的 SHA-256。
func mixedEOLAssertBatchSuccess(t *testing.T, output, path string) {
	t.Helper()
	if strings.Contains(output, "line endings") {
		t.Fatalf("output = %q; must not warn about line endings", output)
	}
	var result BatchEditResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("json.Unmarshal: %v (output=%q)", err, output)
	}
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

func TestMixedEOLBatchReplacePreservesUntouchedTerminators(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nB\nc\r\nd\n")
}

func TestMixedEOLBatchReplaceFirstLineKeepsCRLF(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(1, "a"), Lines: []string{"A"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "A\r\nb\nc\r\nd\n")
}

func TestMixedEOLBatchExpansionUsesLocalStyleAndInheritsLast(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	// 被替换范围末行是 LF：中间新行使用局部 LF，最后一行继承 LF。
	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"X", "Y"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nX\nY\nc\r\nd\n")
}

func TestMixedEOLBatchRangeReplaceInheritsRangeEndTerminator(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	// 范围 [2,3] 末行是 CRLF：替换后唯一新行继承 CRLF。
	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(2, "b"), EndPos: formatTag(3, "c"), Lines: []string{"BC"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nBC\r\nd\n")
}

func TestMixedEOLBatchInsertBeforeFirstLineUsesForwardLocalStyle(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "insert", Pos: formatTag(1, "a"), Lines: []string{"N"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "N\r\na\r\nb\nc\r\nd\n")
}

func TestMixedEOLBatchInsertAfterUsesAnchorLocalStyle(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "mixed.txt", "a\r\nb\nc\r\nd\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "insert", Pos: formatTag(2, "b"), After: true, Lines: []string{"N"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nb\nN\nc\r\nd\n")
}

func TestMixedEOLInsertAfterUnterminatedLastLine(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "tail.txt", "a\r\nb")

	// 原末行无 terminator：追加后原末行获得局部 CRLF，新末行继续无 terminator。
	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "insert", Pos: formatTag(2, "b"), After: true, Lines: []string{"N"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nb\r\nN")
}

func TestMixedEOLDeleteToEOFPreservesMissingTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "tail.txt", "a\r\nb\nc")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "delete", Pos: formatTag(2, "b"), EndPos: formatTag(3, "c"),
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a")
}

func TestMixedEOLDeleteLastLineKeepsTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "tail.txt", "a\r\nb\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "delete", Pos: formatTag(2, "b"),
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\n")
}

func TestMixedEOLDeleteAllLinesLeavesEmptyFile(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "all.txt", "a\r\nb\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "delete", Pos: formatTag(1, "a"), EndPos: formatTag(2, "b"),
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "")
}

func TestMixedEOLBatchMultipleEditsPreserveEachRegion(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "multi.txt", "a\r\nb\nc\r\nd\ne\r\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{
		{OP: "replace", Pos: formatTag(1, "a"), Lines: []string{"A"}},
		{OP: "insert", Pos: formatTag(3, "c"), After: true, Lines: []string{"N"}},
		{OP: "delete", Pos: formatTag(4, "d")},
	}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	// A 继承 CRLF；N 依附 c（CRLF）；d（LF）删除；b、c、e 行尾原样。
	mixedEOLAssertFile(t, target, "A\r\nb\nc\r\nN\r\ne\r\n")
}

func TestMixedEOLBOMPreservedWithPerLineTerminators(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "bom.txt", utf8BOM+"a\r\nb\n")

	output := batchTestRun(t, target, BatchEditRequest{Edits: []BatchEditOp{{
		OP: "replace", Pos: formatTag(2, "b"), Lines: []string{"B"},
	}}}, false)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, utf8BOM+"a\r\nB\n")
}

func TestMixedEOLReplaceOncePreservesUntouchedTerminators(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "once.txt", "a\r\nb\nc\r\n")

	output := replaceOnceTestRun(t, target, `{"old_lines":["b"],"new_lines":["B1","B2"]}`)

	mixedEOLAssertBatchSuccess(t, output, target)
	mixedEOLAssertFile(t, target, "a\r\nB1\nB2\nc\r\n")
}

func TestMixedEOLSingleVerbReplacePreservesTerminators(t *testing.T) {
	dir := t.TempDir()
	target := mixedEOLWriteFile(t, dir, "verb.txt", "a\r\nb\nc\r\n")
	contentSrc := editTestWriteLinesFile(t, dir, "content.txt", "B")

	output := editTestCaptureStdout(t, func() {
		_ = cmdReplace(target, formatTag(2, "b"), contentSrc)
	})

	if strings.Contains(output, "line endings") {
		t.Fatalf("output = %q; must not warn about line endings", output)
	}
	mixedEOLAssertFile(t, target, "a\r\nB\nc\r\n")
}
