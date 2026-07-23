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
