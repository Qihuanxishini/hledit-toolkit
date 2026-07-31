package main

import "testing"

func TestBuildUpdatedAnchorContext(t *testing.T) {
	t.Run("returns bounded anchors around the changed range", func(t *testing.T) {
		lines := []string{"alpha", "BRAVO", "charlie"}
		got := buildUpdatedAnchorContext(lines, 2, 2, 1)
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
			lines[i] = intToStr(i + 1)
		}
		got := buildUpdatedAnchorContext(lines, 10, 10, 1)
		if got == nil || got.Offset != 8 || got.Limit != 5 || got.DesiredLimit != 5 || got.Truncated {
			t.Fatalf("context metadata = %#v", got)
		}
		for index, line := range got.Lines {
			lineNumber := index + got.Offset
			text := intToStr(lineNumber)
			if line.Anchor != formatTag(lineNumber, text) || line.Text != text {
				t.Fatalf("line %d = %#v, want %s", lineNumber, line, text)
			}
		}
	})

	t.Run("caps large changed spans", func(t *testing.T) {
		lines := make([]string, 100)
		for i := range lines {
			lines[i] = intToStr(i + 1)
		}
		got := buildUpdatedAnchorContext(lines, 20, 60, 41)
		if got == nil || got.Limit != updatedAnchorMaxLines || !got.Truncated {
			t.Fatalf("context = %#v", got)
		}
		if len(got.Lines) != updatedAnchorMaxLines {
			t.Fatalf("lines = %d, want %d", len(got.Lines), updatedAnchorMaxLines)
		}
	})

	t.Run("caps oversized line text by bytes", func(t *testing.T) {
		got := buildUpdatedAnchorContext([]string{string(make([]byte, updatedAnchorMaxBytes*2))}, 1, 1, 1)
		if got == nil || !got.Truncated || len(got.Lines) != 1 || !got.Lines[0].TextTruncated {
			t.Fatalf("context = %#v", got)
		}
	})

	t.Run("reports the actual count after byte truncation", func(t *testing.T) {
		lines := make([]string, 5)
		for i := range lines {
			lines[i] = string(make([]byte, 1500))
		}
		got := buildUpdatedAnchorContext(lines, 3, 3, 1)
		if got == nil || !got.Truncated || got.DesiredLimit != 5 || got.Limit != len(got.Lines) || len(got.Lines) >= 5 {
			t.Fatalf("context metadata = %#v; want actual limit equal to returned lines after byte truncation", got)
		}
	})

	t.Run("represents an empty file", func(t *testing.T) {
		got := buildUpdatedAnchorContext([]string{}, 1, 1, 0)
		if got == nil || got.Offset != 1 || got.Limit != 0 || len(got.Lines) != 0 || got.Truncated {
			t.Fatalf("context = %#v", got)
		}
	})
}

func TestCmdBatchReturnsUpdatedAnchors(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

	out := batchTestWriteReq(t, target, BatchEditOp{
		OP:    "replace",
		Pos:   formatTag(2, "bravo"),
		Lines: []string{"BRAVO"},
	})
	var got BatchEditResult
	batchTestMustUnmarshal(t, out, &got)
	if got.UpdatedAnchors == nil || len(got.UpdatedAnchors.Lines) != 3 {
		t.Fatalf("updated anchors = %#v", got.UpdatedAnchors)
	}
	if got.UpdatedAnchors.Lines[1].Anchor != formatTag(2, "BRAVO") {
		t.Fatalf("changed anchor = %#v", got.UpdatedAnchors.Lines[1])
	}

	checkOut := batchTestCheckReq(t, target, BatchEditOp{
		OP:    "replace",
		Pos:   formatTag(2, "BRAVO"),
		Lines: []string{"bravo"},
	})
	var checked BatchEditResult
	batchTestMustUnmarshal(t, checkOut, &checked)
	if checked.UpdatedAnchors != nil {
		t.Fatalf("check mode returned updated anchors: %#v", checked.UpdatedAnchors)
	}
}
