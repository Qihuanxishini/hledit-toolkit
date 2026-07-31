package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func batchTestReadProof(t *testing.T, target string, anchors ...string) *BatchReadProof {
	t.Helper()
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	return &BatchReadProof{Revision: rawFileRevision(content), Anchors: anchors}
}

func TestBatchReadProofCoversCompleteRange(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
	request := BatchEditRequest{
		Proof: batchTestReadProof(t, target, formatTag(2, "bravo"), formatTag(3, "charlie")),
		Edits: []BatchEditOp{{
			OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(3, "charlie"), Lines: []string{"middle"},
		}},
	}

	output := batchTestRun(t, target, request, false)
	var result BatchEditResult
	batchTestMustUnmarshal(t, output, &result)
	if !result.OK || result.Revision == "" {
		t.Fatalf("result = %#v; want success with revision", result)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != rawFileRevision(content) {
		t.Fatalf("revision = %q, want raw file revision %q", result.Revision, rawFileRevision(content))
	}
}

func TestBatchReadProofRejectsMissingInteriorLine(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
	original, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	request := BatchEditRequest{
		Proof: batchTestReadProof(t, target, formatTag(2, "bravo"), formatTag(4, "delta")),
		Edits: []BatchEditOp{{
			OP: "delete", Pos: formatTag(2, "bravo"), EndPos: formatTag(4, "delta"),
		}},
	}

	output := batchTestRun(t, target, request, false)
	var rejection BatchEditError
	batchTestMustUnmarshal(t, output, &rejection)
	if rejection.OK || rejection.Error != "insufficient_read_proof" || rejection.Failed != 0 || !strings.Contains(rejection.Message, "line 3") {
		t.Fatalf("rejection = %#v; want missing line 3 proof", rejection)
	}
	if current, err := os.ReadFile(target); err != nil || string(current) != string(original) {
		t.Fatalf("insufficient proof modified target: %q", current)
	}
}

func TestBatchReadProofRejectsInteriorChangeWithStableEndpoints(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")
	proof := batchTestReadProof(t, target, formatTag(2, "bravo"), formatTag(3, "charlie"), formatTag(4, "delta"))
	changed := "alpha\nbravo\nchanged-inside\ndelta\n"
	if err := os.WriteFile(target, []byte(changed), 0o600); err != nil {
		t.Fatal(err)
	}
	request := BatchEditRequest{
		Proof: proof,
		Edits: []BatchEditOp{{
			OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(4, "delta"), Lines: []string{"new"},
		}},
	}

	output := batchTestRun(t, target, request, false)
	var rejection BatchEditError
	batchTestMustUnmarshal(t, output, &rejection)
	if rejection.OK || rejection.Error != "stale" || rejection.CurrentRevision != rawFileRevision([]byte(changed)) {
		t.Fatalf("rejection = %#v; want revision stale", rejection)
	}
	if current, err := os.ReadFile(target); err != nil || string(current) != changed {
		t.Fatalf("revision rejection modified target: %q", current)
	}
}

func TestBatchReadProofRejectsUnorderedAnchors(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
	request := BatchEditRequest{
		Proof: batchTestReadProof(t, target, formatTag(2, "bravo"), formatTag(1, "alpha")),
		Edits: []BatchEditOp{{OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"BRAVO"}}},
	}

	output := batchTestRun(t, target, request, false)
	var rejection BatchEditError
	batchTestMustUnmarshal(t, output, &rejection)
	if rejection.OK || rejection.Error != "invalid" || !strings.Contains(rejection.Message, "strictly increasing") {
		t.Fatalf("rejection = %#v; want ordered-proof error", rejection)
	}
}

func TestBatchApplyRejectsSourceChangedBeforeCommit(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
	request := BatchEditRequest{
		Proof: batchTestReadProof(t, target, formatTag(2, "bravo")),
		Edits: []BatchEditOp{{OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"BRAVO"}}},
	}

	previousSeam := beforeAtomicRevisionCheck
	beforeAtomicRevisionCheck = func(targetPath string) {
		if err := os.WriteFile(targetPath, []byte("alpha\nexternal\n"), 0o600); err != nil {
			panic(err)
		}
	}
	t.Cleanup(func() { beforeAtomicRevisionCheck = previousSeam })

	output := batchTestRun(t, target, request, false)
	var rejection BatchEditError
	batchTestMustUnmarshal(t, output, &rejection)
	if rejection.OK || rejection.Error != "source_changed_before_commit" || rejection.CurrentRevision != rawFileRevision([]byte("alpha\nexternal\n")) {
		t.Fatalf("rejection = %#v; want changed-before-commit", rejection)
	}
	if current, err := os.ReadFile(target); err != nil || string(current) != "alpha\nexternal\n" {
		t.Fatalf("changed-before-commit overwrote external content: %q", current)
	}
	assertNoAtomicTempFiles(t, dir)
}

func TestBatchRequestRejectsNullProof(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
	payload, err := json.Marshal(map[string]any{
		"proof": nil,
		"edits": []map[string]any{{"op": "delete", "pos": formatTag(1, "alpha")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := batchTestRunPayload(t, target, payload, false)
	var rejection BatchEditError
	batchTestMustUnmarshal(t, output, &rejection)
	if rejection.OK || rejection.Error != "invalid" || !strings.Contains(rejection.Message, "proof must be an object") {
		t.Fatalf("rejection = %#v; want null proof rejection", rejection)
	}
}

func TestBatchNoOpReportsOriginalMixedNewlineRevision(t *testing.T) {
	dir := t.TempDir()
	target := dir + string(os.PathSeparator) + "target.txt"
	original := []byte("alpha\r\nbravo\n")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	request := BatchEditRequest{
		Proof: batchTestReadProof(t, target, formatTag(2, "bravo")),
		Edits: []BatchEditOp{{OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"bravo"}}},
	}

	output := batchTestRun(t, target, request, false)
	var result BatchEditResult
	batchTestMustUnmarshal(t, output, &result)
	if !result.OK || result.ContentChanged || result.Revision != rawFileRevision(original) {
		t.Fatalf("result = %#v; want no-op with original raw revision", result)
	}
	current, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(original) {
		t.Fatalf("no-op changed mixed newline bytes: %q", current)
	}
}

func TestBatchRequestRejectsMalformedProofFields(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
	validRevision := rawFileRevision([]byte("alpha\n"))
	anchor := formatTag(1, "alpha")
	tests := []struct {
		name  string
		proof any
		want  string
	}{
		{name: "null revision", proof: map[string]any{"revision": nil, "anchors": []string{anchor}}, want: "proof revision must be a string"},
		{name: "missing revision", proof: map[string]any{"anchors": []string{anchor}}, want: "proof revision is required"},
		{name: "null anchors", proof: map[string]any{"revision": validRevision, "anchors": nil}, want: "proof anchors must be an array of strings"},
		{name: "missing anchors", proof: map[string]any{"revision": validRevision}, want: "proof anchors are required"},
		{name: "uppercase revision", proof: map[string]any{"revision": "sha256:" + strings.Repeat("A", 64), "anchors": []string{anchor}}, want: "lowercase hexadecimal digits"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"proof": testCase.proof,
				"edits": []map[string]any{{"op": "delete", "pos": anchor}},
			})
			if err != nil {
				t.Fatal(err)
			}
			output := batchTestRunPayload(t, target, payload, false)
			var rejection BatchEditError
			batchTestMustUnmarshal(t, output, &rejection)
			if rejection.OK || rejection.Error != "invalid" || !strings.Contains(rejection.Message, testCase.want) {
				t.Fatalf("rejection = %#v; want %q", rejection, testCase.want)
			}
		})
	}
}
