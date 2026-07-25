package main

import (
	"slices"
	"strings"
	"testing"
)

func TestPlanBatchEditsRebuildsWithoutMutatingOriginalSnapshot(t *testing.T) {
	original := []string{"alpha", "bravo", "charlie"}
	request := BatchEditRequest{Edits: []BatchEditOp{
		{
			OP: "insert", Pos: formatTag(2, "bravo"), Lines: []string{"new"},
			linesPresent: true,
		},
		{
			OP: "replace", Pos: formatTag(3, "charlie"), Lines: []string{"CHARLIE"},
			linesPresent: true,
		},
	}}

	plan, failure := planBatchEdits(request, original, "")
	if failure != nil {
		t.Fatalf("plan failed: %#v", failure)
	}
	if want := []string{"alpha", "new", "bravo", "CHARLIE"}; !slices.Equal(plan.RebuiltLines, want) {
		t.Fatalf("rebuilt lines = %#v, want %#v", plan.RebuiltLines, want)
	}
	if plan.FirstChanged != 2 || plan.LastChanged != 4 || plan.LinesAdded != 2 || plan.LinesDeleted != 1 {
		t.Fatalf("plan statistics = %#v", plan)
	}
	if !slices.Equal(original, []string{"alpha", "bravo", "charlie"}) {
		t.Fatalf("planner mutated original snapshot: %#v", original)
	}
}

func TestPlanBatchEditsReportsOriginalAnchorsForBoundaryConflict(t *testing.T) {
	original := []string{"alpha", "bravo"}
	firstAnchor := formatTag(1, "alpha")
	secondAnchor := formatTag(2, "bravo")
	request := BatchEditRequest{Edits: []BatchEditOp{
		{
			OP: "insert", Pos: firstAnchor, After: true, Lines: []string{"after-alpha"},
			afterPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: secondAnchor, Lines: []string{"before-bravo"},
			linesPresent: true,
		},
	}}

	_, failure := planBatchEdits(request, original, "")
	if failure == nil || failure.Code != "invalid" || failure.FailedEdit != 1 {
		t.Fatalf("failure = %#v; want edit 1 invalid", failure)
	}
	for _, expected := range []string{"edit 1 overlaps edit 0", firstAnchor, secondAnchor, "physical boundary 1"} {
		if !strings.Contains(failure.Message, expected) {
			t.Fatalf("message %q does not contain %q", failure.Message, expected)
		}
	}
}

func TestBatchEditDeltasCoverInsertAndRangeShapes(t *testing.T) {
	original := []string{"alpha", "bravo", "charlie", "delta", "echo"}
	request := BatchEditRequest{Edits: []BatchEditOp{
		{
			OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(3, "charlie"),
			Lines: []string{"BRAVO"}, endPosPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: formatTag(5, "echo"), After: true,
			Lines: []string{"foxtrot", "golf"}, afterPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: formatTag(1, "alpha"), Lines: []string{"zero"},
			linesPresent: true,
		},
	}}

	plan, failure := planBatchEdits(request, original, "")
	if failure != nil {
		t.Fatalf("plan failed: %#v", failure)
	}
	want := []EditDelta{
		{OldStart: 1, OldEnd: 0, Delta: 1},  // insert_before 1
		{OldStart: 2, OldEnd: 3, Delta: -1}, // replace 2 lines with 1
		{OldStart: 6, OldEnd: 5, Delta: 2},  // insert_after 5
	}
	if !slices.Equal(plan.EditDeltas, want) {
		t.Fatalf("edit deltas = %#v, want %#v", plan.EditDeltas, want)
	}

	// 统一平移规则复算行号：旧行 4 前面有 insert(+1) 和 replace(-1)，新行号应为 4。
	shift := 0
	for _, delta := range plan.EditDeltas {
		if 4 >= delta.OldStart && 4 <= delta.OldEnd {
			t.Fatalf("line 4 must not be consumed by %#v", delta)
		}
		if 4 > delta.OldEnd {
			shift += delta.Delta
		}
	}
	if got := 4 + shift; got != 4 {
		t.Fatalf("remapped line = %d, want 4", got)
	}
	if plan.RebuiltLines[3] != "delta" {
		t.Fatalf("rebuilt line 4 = %q, want %q", plan.RebuiltLines[3], "delta")
	}
}

func TestPlanBatchEditsAllowsDeterministicEdgeInserts(t *testing.T) {
	original := []string{"alpha", "bravo", "charlie", "delta", "echo"}

	// insert_after 4（range [2..4] 的后边界）与 insert_before 2（前边界）都位置确定。
	request := BatchEditRequest{Edits: []BatchEditOp{
		{
			OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(4, "delta"),
			Lines: []string{"REPLACED"}, endPosPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: formatTag(4, "delta"), After: true, Lines: []string{"tail"},
			afterPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: formatTag(2, "bravo"), Lines: []string{"head"},
			linesPresent: true,
		},
	}}

	plan, failure := planBatchEdits(request, original, "")
	if failure != nil {
		t.Fatalf("edge inserts must be accepted: %#v", failure)
	}
	want := []string{"alpha", "head", "REPLACED", "tail", "echo"}
	if !slices.Equal(plan.RebuiltLines, want) {
		t.Fatalf("rebuilt lines = %#v, want %#v", plan.RebuiltLines, want)
	}
	// lastChanged 采用 max(deleted, replacement) 的保守语义：净删除会把后续行上移，
	// 新文件坐标 3..5（REPLACED、tail、echo）都在受影响窗口内。
	if plan.FirstChanged != 2 || plan.LastChanged != 5 {
		t.Fatalf("statistics = first %d last %d, want 2..5", plan.FirstChanged, plan.LastChanged)
	}
}

func TestPlanBatchEditsStillRejectsInteriorInserts(t *testing.T) {
	original := []string{"alpha", "bravo", "charlie", "delta", "echo"}
	request := BatchEditRequest{Edits: []BatchEditOp{
		{
			OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(4, "delta"),
			Lines: []string{"REPLACED"}, endPosPresent: true, linesPresent: true,
		},
		{
			OP: "insert", Pos: formatTag(3, "charlie"), Lines: []string{"interior"},
			linesPresent: true,
		},
	}}

	_, failure := planBatchEdits(request, original, "")
	if failure == nil || failure.Code != "invalid" {
		t.Fatalf("interior insert must stay rejected, got %#v", failure)
	}
	if !strings.Contains(failure.Message, "interior physical boundary") {
		t.Fatalf("message %q must mention the interior boundary", failure.Message)
	}
}

func TestPlanBatchEditsEdgeInsertAgainstDeleteKeepsOrder(t *testing.T) {
	original := []string{"alpha", "bravo", "charlie"}
	request := BatchEditRequest{Edits: []BatchEditOp{
		{OP: "delete", Pos: formatTag(2, "bravo")},
		{
			OP: "insert", Pos: formatTag(2, "bravo"), After: true, Lines: []string{"replacement-tail"},
			afterPresent: true, linesPresent: true,
		},
	}}

	plan, failure := planBatchEdits(request, original, "")
	if failure != nil {
		t.Fatalf("edge insert next to delete must be accepted: %#v", failure)
	}
	want := []string{"alpha", "replacement-tail", "charlie"}
	if !slices.Equal(plan.RebuiltLines, want) {
		t.Fatalf("rebuilt lines = %#v, want %#v", plan.RebuiltLines, want)
	}
}
