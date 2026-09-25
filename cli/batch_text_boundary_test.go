package main

import (
	"slices"
	"strings"
	"testing"
)

func TestBatchTextBoundariesRoundTrip(t *testing.T) {
	cases := []struct {
		name, source, want string
		edit               BatchEditOp
		lines              []string
	}{
		{"blank replacement", "old", "\n", BatchEditOp{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{""}}, []string{""}},
		{"blank appended at EOF", "a", "a\n\n", BatchEditOp{OP: "insert", Pos: formatTag(1, "a"), After: true, Lines: []string{""}}, []string{"a", ""}},
		{"deletion exposes blank EOF", "a\n\nlast", "a\n\n", BatchEditOp{OP: "delete", Pos: formatTag(3, "last")}, []string{"a", ""}},
		{"blank EOF uses local CRLF", "a\r\nb", "a\r\n\r\n", BatchEditOp{OP: "replace", Pos: formatTag(2, "b"), Lines: []string{""}}, []string{"a", ""}},
		{"trailing CR remains text", "a\nb\n", "a\r\r\nb\n", BatchEditOp{OP: "replace", Pos: formatTag(1, "a"), Lines: []string{"a\r"}}, []string{"a\r", "b"}},
		{"former EOF CR remains text", "a\r", "a\r\r\nb", BatchEditOp{OP: "insert", Pos: formatTag(1, "a\r"), After: true, Lines: []string{"b"}}, []string{"a\r", "b"}},
		{"BOM and leading literal FEFF", utf8BOM + "old", utf8BOM + utf8BOM + "new", BatchEditOp{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{utf8BOM + "new"}}, []string{utf8BOM + "new"}},
		{"literal escape sequences", "old", `new\u0000text\0`, BatchEditOp{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{`new\u0000text\0`}}, []string{`new\u0000text\0`}},
		{"FEFF on later line", "a\nb", "a\n" + utf8BOM + "b", BatchEditOp{OP: "replace", Pos: formatTag(2, "b"), Lines: []string{utf8BOM + "b"}}, []string{"a", utf8BOM + "b"}},
		{"delete all lines", "old", "", BatchEditOp{OP: "delete", Pos: formatTag(1, "old")}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := commandTestWriteFile(t, t.TempDir(), "target.txt", tc.source)
			request := BatchEditRequest{Edits: []BatchEditOp{tc.edit}}
			var checked BatchEditResult
			batchTestMustUnmarshal(t, batchTestRun(t, path, request, true), &checked)
			if !checked.OK || !checked.Checked {
				t.Fatalf("check = %+v; want success", checked)
			}
			protocolTestAssertFile(t, path, tc.source)

			var applied BatchEditResult
			batchTestMustUnmarshal(t, batchTestRun(t, path, request, false), &applied)
			if !applied.OK {
				t.Fatalf("apply = %+v; want success", applied)
			}
			protocolTestAssertFile(t, path, tc.want)
			actual, err := loadTextFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(actual.Lines, tc.lines) || applied.Revision != actual.Revision {
				t.Fatalf("read lines=%q revision=%s; want lines=%q revision=%s", actual.Lines, actual.Revision, tc.lines, applied.Revision)
			}
			before, err := parseTextFile([]byte(tc.source))
			if err != nil {
				t.Fatal(err)
			}
			if len(actual.Lines) != len(before.Lines)+applied.LinesAdded-applied.LinesDeleted {
				t.Fatalf("line counts disagree with actual file: %+v", applied)
			}
			for _, span := range applied.UpdatedAnchorSpans {
				for _, line := range span.Lines {
					if line.Line < 1 || line.Line > len(actual.Lines) || line.Text != actual.Lines[line.Line-1] || line.Anchor != formatTag(line.Line, line.Text) {
						t.Fatalf("returned anchor does not describe the file: %+v, lines=%q", line, actual.Lines)
					}
				}
			}
			if len(applied.UpdatedAnchorSpans) > 0 {
				line := applied.UpdatedAnchorSpans[0].Lines[0]
				var next BatchEditResult
				batchTestMustUnmarshal(t, batchTestRun(t, path, BatchEditRequest{
					Proof: &BatchReadProof{Revision: applied.Revision, Anchors: []string{line.Anchor}},
					Edits: []BatchEditOp{{OP: "replace", Pos: line.Anchor, Lines: []string{"verified"}}},
				}, false), &next)
				if !next.OK {
					t.Fatalf("returned anchor cannot be reused: %+v", next)
				}
			}
		})
	}
}

func TestBatchRejectsUnrepresentableTextBeforeWriting(t *testing.T) {
	for _, tc := range []struct {
		name, source, reason string
		edits                []BatchEditOp
		failed               int
	}{
		{"NUL", "old\nkeep\n", "NUL", []BatchEditOp{
			{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{"changed"}},
			{OP: "replace", Pos: formatTag(2, "keep"), Lines: []string{"new\x00text"}},
		}, 1},
		{"LF in wire line", "old\nkeep\n", "LF", []BatchEditOp{
			{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{"changed"}},
			{OP: "replace", Pos: formatTag(2, "keep"), Lines: []string{"new\ntext"}},
		}, 1},
		{"replacement changes BOM meaning", "old", "BOM", []BatchEditOp{
			{OP: "replace", Pos: formatTag(1, "old"), Lines: []string{utf8BOM + "new"}},
		}, -1},
		{"insertion changes BOM meaning", "old", "BOM", []BatchEditOp{
			{OP: "insert", Pos: formatTag(1, "old"), Lines: []string{utf8BOM + "new"}},
		}, -1},
		{"deletion changes BOM meaning", "old\n" + utf8BOM + "keep", "BOM", []BatchEditOp{
			{OP: "delete", Pos: formatTag(1, "old")},
		}, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := commandTestWriteFile(t, dir, "target.txt", tc.source)
			for _, checkOnly := range []bool{true, false} {
				var result BatchEditError
				batchTestMustUnmarshal(t, batchTestRun(t, path, BatchEditRequest{Edits: tc.edits}, checkOnly), &result)
				if result.OK || result.Error != "invalid" || result.Failed != tc.failed || !strings.Contains(result.Message, tc.reason) {
					t.Fatalf("checkOnly=%v result=%+v; want invalid %s at edit %d", checkOnly, result, tc.reason, tc.failed)
				}
				protocolTestAssertFile(t, path, tc.source)
				assertNoAtomicTempFiles(t, dir)
			}
		})
	}
}
