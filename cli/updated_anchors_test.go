package main

import (
	"strconv"
	"testing"
)

func TestBuildCurrentAnchorContext(t *testing.T) {
	t.Run("returns bounded anchors around the changed range", func(t *testing.T) {
		lines := []string{"alpha", "BRAVO", "charlie"}
		got := buildCurrentAnchorContext(lines, 2, 2)
		if got == nil {
			t.Fatal("context is nil")
		}
		if got.Offset != 1 || got.Limit != 3 || got.DesiredLimit != 4 || got.Truncated {
			t.Fatalf("context metadata = %#v", got)
		}
		if len(got.Lines) != 3 {
			t.Fatalf("lines = %d, want 3", len(got.Lines))
		}
		if got.Lines[1].Anchor != formatTag(2, "BRAVO") || got.Lines[1].Text != "BRAVO" {
			t.Fatalf("changed anchor = %#v", got.Lines[1])
		}
	})

	t.Run("returns source lines from the local offset", func(t *testing.T) {
		lines := make([]string, 12)
		for i := range lines {
			lines[i] = strconv.Itoa(i + 1)
		}
		got := buildCurrentAnchorContext(lines, 10, 10)
		if got == nil || got.Offset != 8 || got.Limit != 5 || got.DesiredLimit != 5 || got.Truncated {
			t.Fatalf("context metadata = %#v", got)
		}
		for index, line := range got.Lines {
			lineNumber := index + got.Offset
			text := strconv.Itoa(lineNumber)
			if line.Anchor != formatTag(lineNumber, text) || line.Text != text {
				t.Fatalf("line %d = %#v, want %s", lineNumber, line, text)
			}
		}
	})

	t.Run("a complete window in the middle of a file is not truncated", func(t *testing.T) {
		lines := make([]string, 50)
		for i := range lines {
			lines[i] = strconv.Itoa(i + 1)
		}
		got := buildCurrentAnchorContext(lines, 10, 10)
		if got == nil || got.Offset != 8 || got.Limit != 5 || got.DesiredLimit != 5 || got.Truncated {
			t.Fatalf("context metadata = %#v; want complete lines 8-12", got)
		}
	})

	t.Run("caps large changed spans", func(t *testing.T) {
		lines := make([]string, 100)
		for i := range lines {
			lines[i] = strconv.Itoa(i + 1)
		}
		got := buildCurrentAnchorContext(lines, 20, 60)
		if got == nil || got.Limit != currentAnchorMaxLines || !got.Truncated {
			t.Fatalf("context = %#v", got)
		}
		if len(got.Lines) != currentAnchorMaxLines {
			t.Fatalf("lines = %d, want %d", len(got.Lines), currentAnchorMaxLines)
		}
	})

	t.Run("caps oversized line text by bytes", func(t *testing.T) {
		got := buildCurrentAnchorContext([]string{string(make([]byte, currentAnchorMaxBytes*2))}, 1, 1)
		if got == nil || !got.Truncated || len(got.Lines) != 1 || !got.Lines[0].TextTruncated {
			t.Fatalf("context = %#v", got)
		}
	})

	t.Run("reports the actual count after byte truncation", func(t *testing.T) {
		lines := make([]string, 5)
		for i := range lines {
			lines[i] = string(make([]byte, 1500))
		}
		got := buildCurrentAnchorContext(lines, 3, 3)
		if got == nil || !got.Truncated || got.DesiredLimit != 5 || got.Limit != len(got.Lines) || len(got.Lines) >= 5 {
			t.Fatalf("context metadata = %#v; want actual limit equal to returned lines after byte truncation", got)
		}
	})

	t.Run("represents an empty file", func(t *testing.T) {
		got := buildCurrentAnchorContext([]string{}, 1, 1)
		if got == nil || got.Offset != 1 || got.Limit != 0 || len(got.Lines) != 0 || got.Truncated {
			t.Fatalf("context = %#v", got)
		}
	})
}

func TestBuildUpdatedAnchorSpans(t *testing.T) {
	numbered := func(count int) []string {
		lines := make([]string, count)
		for i := range lines {
			lines[i] = strconv.Itoa(i + 1)
		}
		return lines
	}

	t.Run("returns one context-free span per producing edit in new coordinates", func(t *testing.T) {
		// 原始 1..10：在第 2 行后插入 2 行，替换原 5..6 为 1 行，删除原 9 行。
		lines := numbered(10)
		rebuilt := append([]string{}, lines[:2]...)
		rebuilt = append(rebuilt, "ins-a", "ins-b", lines[2], lines[3], "REPL", lines[6], lines[7], lines[9])
		got := buildUpdatedAnchorSpans(rebuilt, []EditDelta{
			{OldStart: 3, OldEnd: 2, Delta: 2},
			{OldStart: 5, OldEnd: 6, Delta: -1},
			{OldStart: 9, OldEnd: 9, Delta: -1},
		})
		if len(got) != 2 {
			t.Fatalf("spans = %#v, want 2 (pure deletion produces none)", got)
		}
		if got[0].Offset != 3 || got[0].Limit != 2 || got[0].DesiredLimit != 2 || got[0].Truncated {
			t.Fatalf("insert span = %#v", got[0])
		}
		if got[0].Lines[0].Anchor != formatTag(3, "ins-a") || got[0].Lines[1].Text != "ins-b" {
			t.Fatalf("insert span lines = %#v", got[0].Lines)
		}
		if got[1].Offset != 7 || got[1].Limit != 1 || got[1].DesiredLimit != 1 || got[1].Truncated {
			t.Fatalf("replace span = %#v", got[1])
		}
		if got[1].Lines[0].Anchor != formatTag(7, "REPL") {
			t.Fatalf("replace span line = %#v", got[1].Lines[0])
		}
	})

	t.Run("shares the line budget across spans and keeps exhausted spans countable", func(t *testing.T) {
		lines := numbered(200)
		got := buildUpdatedAnchorSpans(lines, []EditDelta{
			{OldStart: 1, OldEnd: 70, Delta: 0},
			{OldStart: 100, OldEnd: 119, Delta: 0},
			{OldStart: 150, OldEnd: 150, Delta: 0},
		})
		if len(got) != 3 {
			t.Fatalf("spans = %d, want 3", len(got))
		}
		if got[0].Limit != 70 || got[0].Truncated {
			t.Fatalf("first span = %#v", got[0])
		}
		if got[1].Offset != 100 || got[1].Limit != updatedAnchorSpansMaxLines-70 || got[1].DesiredLimit != 20 || !got[1].Truncated {
			t.Fatalf("second span = %#v", got[1])
		}
		if got[2].Offset != 150 || got[2].Limit != 0 || len(got[2].Lines) != 0 || got[2].DesiredLimit != 1 || !got[2].Truncated {
			t.Fatalf("exhausted span = %#v", got[2])
		}
	})

	t.Run("caps by bytes and marks an oversized produced line", func(t *testing.T) {
		got := buildUpdatedAnchorSpans([]string{string(make([]byte, updatedAnchorSpansMaxBytes*2))}, []EditDelta{{OldStart: 1, OldEnd: 1, Delta: 0}})
		if len(got) != 1 || !got[0].Truncated || len(got[0].Lines) != 1 || !got[0].Lines[0].TextTruncated {
			t.Fatalf("spans = %#v", got)
		}
	})

	t.Run("returns no spans for a batch that only deletes", func(t *testing.T) {
		got := buildUpdatedAnchorSpans([]string{"keep"}, []EditDelta{{OldStart: 2, OldEnd: 3, Delta: -2}})
		if len(got) != 0 {
			t.Fatalf("spans = %#v, want none", got)
		}
	})
}

func TestCmdBatchReturnsUpdatedAnchorSpans(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

	out := batchTestWriteReq(t, target, BatchEditOp{
		OP:    "replace",
		Pos:   formatTag(2, "bravo"),
		Lines: []string{"BRAVO"},
	})
	var got BatchEditResult
	batchTestMustUnmarshal(t, out, &got)
	if len(got.UpdatedAnchorSpans) != 1 || len(got.UpdatedAnchorSpans[0].Lines) != 1 {
		t.Fatalf("updated anchor spans = %#v", got.UpdatedAnchorSpans)
	}
	if got.UpdatedAnchorSpans[0].Offset != 2 || got.UpdatedAnchorSpans[0].Lines[0].Anchor != formatTag(2, "BRAVO") {
		t.Fatalf("changed span = %#v", got.UpdatedAnchorSpans[0])
	}

	checkOut := batchTestCheckReq(t, target, BatchEditOp{
		OP:    "replace",
		Pos:   formatTag(2, "BRAVO"),
		Lines: []string{"bravo"},
	})
	var checked BatchEditResult
	batchTestMustUnmarshal(t, checkOut, &checked)
	if checked.UpdatedAnchorSpans != nil {
		t.Fatalf("check mode returned updated anchor spans: %#v", checked.UpdatedAnchorSpans)
	}
}
