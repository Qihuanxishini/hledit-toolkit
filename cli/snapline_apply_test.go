package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func snaplineTestFile(t *testing.T, content string) LoadedTextFile {
	t.Helper()
	file, err := parseTextFile([]byte(content))
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func snaplineApplyJSON(t *testing.T, request SnaplineApplyRequest) string {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return mainTestRun(t, string(encoded), "apply")
}

func TestPlanSnaplineChangesAndEffectCoordinates(t *testing.T) {
	file := snaplineTestFile(t, "one\ntwo\nthree\nfour\nfive\n")
	request := SnaplineApplyRequest{
		Replacements:     []SnaplineReplacement{{Start: 2, End: 3, Text: "TWO-THREE"}},
		Deletions:        []SnaplineDeletion{{Start: 4, End: 4}},
		InsertionsBefore: []SnaplineInsertion{{Line: 1, Text: "zero"}},
		InsertionsAfter:  []SnaplineInsertion{{Line: 5, Text: "six\nseven"}},
	}
	changes, failure := planSnaplineChanges(request, file)
	if failure != nil {
		t.Fatalf("failure = %#v", failure)
	}
	effective := effectiveSnaplineChanges(changes)
	stats := buildSnaplineStats(changes, effective, len(file.Lines))
	if stats.RequestedChanges != 4 || stats.EffectiveChanges != 4 || stats.InsertedLines != 4 || stats.DeletedLines != 3 || stats.NewLineCount != 6 {
		t.Fatalf("stats = %#v", stats)
	}
	rebuilt := rebuildSnaplineLines(file.Lines, effective, stats.NewLineCount)
	wantLines := []string{"zero", "one", "TWO-THREE", "five", "six", "seven"}
	if !equalSnaplineLines(rebuilt, wantLines) {
		t.Fatalf("rebuilt = %#v", rebuilt)
	}
	effects := buildSnaplineEffects(changes, effective)
	wantStarts := []int{3, 4, 1, 5}
	wantEnds := []int{3, 3, 1, 6}
	for index := range effects {
		if effects[index].NewStart != wantStarts[index] || effects[index].NewEnd != wantEnds[index] {
			t.Fatalf("effect %d = %#v", index, effects[index])
		}
	}
}

func TestPlanSnaplineChangesRejectsAllConflictShapes(t *testing.T) {
	file := snaplineTestFile(t, "a\nb\nc\nd\n")
	for name, request := range map[string]SnaplineApplyRequest{
		"overlapping ranges": {
			Replacements: []SnaplineReplacement{{Start: 1, End: 2, Text: "x"}},
			Deletions:    []SnaplineDeletion{{Start: 2, End: 3}},
		},
		"duplicate boundary": {
			InsertionsBefore: []SnaplineInsertion{{Line: 2, Text: "x"}},
			InsertionsAfter:  []SnaplineInsertion{{Line: 1, Text: "y"}},
		},
		"interior insertion": {
			Replacements:    []SnaplineReplacement{{Start: 2, End: 4, Text: "x"}},
			InsertionsAfter: []SnaplineInsertion{{Line: 2, Text: "y"}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, failure := planSnaplineChanges(request, file); failure == nil || failure.Group == "" || failure.GroupIndex == nil || failure.ConflictsWith == nil {
				t.Fatalf("failure = %#v", failure)
			}
		})
	}
}

func TestPlanSnaplineChangesAllowsConsumerOuterBoundaries(t *testing.T) {
	file := snaplineTestFile(t, "a\nb\nc\nd\n")
	request := SnaplineApplyRequest{
		Replacements:     []SnaplineReplacement{{Start: 2, End: 3, Text: "B-C"}},
		InsertionsBefore: []SnaplineInsertion{{Line: 2, Text: "before"}},
		InsertionsAfter:  []SnaplineInsertion{{Line: 3, Text: "after"}},
	}
	changes, failure := planSnaplineChanges(request, file)
	if failure != nil {
		t.Fatalf("failure = %#v", failure)
	}
	rebuilt := rebuildSnaplineLines(file.Lines, effectiveSnaplineChanges(changes), 5)
	if !equalSnaplineLines(rebuilt, []string{"a", "before", "B-C", "after", "d"}) {
		t.Fatalf("rebuilt = %#v", rebuilt)
	}
}

func TestSnaplineExpansionGuard(t *testing.T) {
	file := snaplineTestFile(t, "alpha\nbeta\n")
	request := SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "alpha\nnew"}}}
	if _, failure := planSnaplineChanges(request, file); failure == nil || failure.Code != "suspicious_range_expansion" {
		t.Fatalf("failure = %#v", failure)
	}
	request.InsertionsAfter = []SnaplineInsertion{{Line: 1, Text: "explicit"}}
	if _, failure := planSnaplineChanges(request, file); failure != nil {
		t.Fatalf("explicit adjacent insertion failed: %#v", failure)
	}
}

func TestValidateSnaplineProofRequiresEveryTargetLine(t *testing.T) {
	file := snaplineTestFile(t, "a\nb\nc\n")
	changes, failure := planSnaplineChanges(SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 1, End: 2, Text: "A\nB"}}}, file)
	if failure != nil {
		t.Fatal(failure.Message)
	}
	failure = validateSnaplineProof([]SnaplineProofRange{{Start: 1, Lines: []string{"a"}}}, file, changes)
	if failure == nil || failure.Code != "insufficient_read_proof" || failure.Group != "replacement" || failure.GroupIndex == nil || *failure.GroupIndex != 0 {
		t.Fatalf("proof gap failure = %#v", failure)
	}
	failure = validateSnaplineProof([]SnaplineProofRange{{Start: 1, Lines: []string{"wrong", "b"}}}, file, changes)
	if failure == nil || failure.Code != "proof_mismatch" || len(failure.Contexts) == 0 {
		t.Fatalf("proof mismatch failure = %#v", failure)
	}
	if failure = validateSnaplineProof([]SnaplineProofRange{{Start: 1, Lines: []string{"a", "b"}}}, file, changes); failure != nil {
		t.Fatalf("complete proof failure = %#v", failure)
	}
}

func TestSnaplineApplyNoOpDoesNotRewriteMixedEOL(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "mixed.txt")
	original := "a\r\nb\nc\r\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	file := snaplineTestFile(t, original)
	request := SnaplineApplyRequest{
		ProtocolVersion:  1,
		Path:             path,
		ExpectedRevision: file.Revision,
		Proof:            []SnaplineProofRange{{Start: 1, Lines: []string{"a", "b"}}},
		Replacements: []SnaplineReplacement{
			{Start: 1, End: 1, Text: "a"},
			{Start: 2, End: 2, Text: "B"},
		},
		Deletions:        []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var result SnaplineApplyResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "applied" || result.Stats.RequestedChanges != 2 || result.Stats.EffectiveChanges != 1 || result.Effects[0].Changed || !result.Effects[1].Changed {
		t.Fatalf("result = %#v", result)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "a\r\nB\nc\r\n" {
		t.Fatalf("content = %q", content)
	}
}

func TestSnaplineApplyPureNoOpWritesNothing(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("same\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	file := snaplineTestFile(t, "same\n")
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: file.Revision,
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"same"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "same"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var result SnaplineApplyResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "no_op" || result.ContentChanged || result.NewRevision != result.SourceRevision || result.Stats.EffectiveChanges != 0 {
		t.Fatalf("result = %#v", result)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if len(entry.Name()) >= len(".snapline-") && entry.Name()[:len(".snapline-")] == ".snapline-" {
			t.Fatalf("no-op left temporary file %q", entry.Name())
		}
	}
}

func TestSnaplineApplyZeroLineVirtualInsertion(t *testing.T) {
	for name, original := range map[string]string{"empty": "", "bom": utf8BOM} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, "target.txt")
			if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
				t.Fatal(err)
			}
			file := snaplineTestFile(t, original)
			request := SnaplineApplyRequest{
				ProtocolVersion: 1, Path: path, ExpectedRevision: file.Revision,
				Proof: []SnaplineProofRange{}, Replacements: []SnaplineReplacement{}, Deletions: []SnaplineDeletion{},
				InsertionsBefore: []SnaplineInsertion{{Line: 1, Text: "alpha\nbeta\n"}}, InsertionsAfter: []SnaplineInsertion{},
			}
			output := snaplineApplyJSON(t, request)
			var result SnaplineApplyResult
			if err := json.Unmarshal([]byte(output), &result); err != nil {
				t.Fatal(err)
			}
			if result.Outcome != "applied" || result.Stats.OldLineCount != 0 || result.Stats.NewLineCount != 2 {
				t.Fatalf("result = %#v", result)
			}
			content, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(content) != original+"alpha\nbeta\n" {
				t.Fatalf("content = %q", content)
			}
		})
	}
}

func TestSnaplineApplyPreCommitRaceWritesOnlyExternalContent(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	original := []byte("source\n")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: rawFileRevision(original),
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"source"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "planned"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	originalHook := beforeAtomicRevisionCheck
	defer func() { beforeAtomicRevisionCheck = originalHook }()
	beforeAtomicRevisionCheck = func(string) {
		if err := os.WriteFile(path, []byte("external\n"), 0o644); err != nil {
			t.Fatalf("external write: %v", err)
		}
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "source_changed_before_commit" || failure.TargetCommitted || failure.CurrentRevision != rawFileRevision([]byte("external\n")) {
		t.Fatalf("failure = %#v", failure)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "external\n" {
		t.Fatalf("target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestSnaplineApplyStaleRevisionWritesNothing(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("current\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: "sha256:" + string(make([]byte, 64)),
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"current"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "changed"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	// Use a well-formed but stale digest.
	request.ExpectedRevision = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "snapshot_stale" || failure.TargetCommitted || failure.CurrentRevision == "" || len(failure.Contexts) == 0 || !failure.Contexts[0].Approximate {
		t.Fatalf("failure = %#v", failure)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "current\n" {
		t.Fatalf("target changed: %q", content)
	}
}

func TestSnaplineApplyStaleRevisionReturnsDistantApproximateContexts(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte(strings.Repeat("x\n", 5000)), 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path,
		ExpectedRevision: "sha256:" + strings.Repeat("0", 64),
		Proof:            []SnaplineProofRange{},
		Replacements: []SnaplineReplacement{
			{Start: 1, End: 1, Text: "first"},
			{Start: 5000, End: 5000, Text: "last"},
		},
		Deletions: []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "snapshot_stale" || len(failure.Contexts) != 2 || len(failure.RequiredRanges) != 2 {
		t.Fatalf("failure = %#v", failure)
	}
	for index, wantStart := range []int{1, 5000} {
		if !failure.Contexts[index].Approximate || failure.Contexts[index].Start != wantStart || failure.Contexts[index].End != wantStart {
			t.Fatalf("context %d = %#v", index, failure.Contexts[index])
		}
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestPlanSnaplineChangesSizeLimits(t *testing.T) {
	file := snaplineTestFile(t, "source\n")
	t.Run("total changes", func(t *testing.T) {
		request := SnaplineApplyRequest{
			Replacements:     make([]SnaplineReplacement, 100),
			Deletions:        make([]SnaplineDeletion, 100),
			InsertionsBefore: make([]SnaplineInsertion, 1),
		}
		if _, failure := planSnaplineChanges(request, file); failure == nil || failure.Code != "size_limit" {
			t.Fatalf("failure = %#v", failure)
		}
	})
	t.Run("text bytes", func(t *testing.T) {
		request := SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: strings.Repeat("x", snaplineTextByteLimit+1)}}}
		if _, failure := planSnaplineChanges(request, file); failure == nil || failure.Code != "size_limit" {
			t.Fatalf("failure = %#v", failure)
		}
	})
	t.Run("produced lines", func(t *testing.T) {
		text := strings.Repeat("x\n", snaplineProducedLineLimit) + "x"
		request := SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: text}}}
		if _, failure := planSnaplineChanges(request, file); failure == nil || failure.Code != "size_limit" {
			t.Fatalf("failure = %#v", failure)
		}
	})
}

func TestPrepareSnaplineApplyPayloadProofSizeLimits(t *testing.T) {
	t.Run("logical lines", func(t *testing.T) {
		lines := make([]string, snaplineProofLineLimit+1)
		request := SnaplineApplyRequest{
			Proof:        []SnaplineProofRange{{Start: 1, Lines: lines}},
			Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "y"}},
		}
		if _, failure := prepareSnaplineApplyPayload(request); failure == nil || failure.Code != "size_limit" {
			t.Fatalf("failure = %#v", failure)
		}
	})
	t.Run("text bytes", func(t *testing.T) {
		line := strings.Repeat("x", snaplineProofTextByteLimit+1)
		request := SnaplineApplyRequest{
			Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{line}}},
			Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "y"}},
		}
		if _, failure := prepareSnaplineApplyPayload(request); failure == nil || failure.Code != "size_limit" {
			t.Fatalf("failure = %#v", failure)
		}
	})
}

func TestSnaplineApplyPlanningRejectionWritesNothing(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	original := "a\nb\nc\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	file := snaplineTestFile(t, original)
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: file.Revision,
		Proof:            []SnaplineProofRange{{Start: 1, Lines: []string{"a", "b", "c"}}},
		Replacements:     []SnaplineReplacement{{Start: 1, End: 2, Text: "x"}},
		Deletions:        []SnaplineDeletion{{Start: 2, End: 3}},
		InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "overlapping_changes" || failure.TargetCommitted {
		t.Fatalf("failure = %#v", failure)
	}
	content, _ := os.ReadFile(path)
	if string(content) != original {
		t.Fatalf("content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestSnaplineApplyRejectsHardlinkTarget(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	alias := filepath.Join(directory, "alias.txt")
	content := []byte("source\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, alias); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: rawFileRevision(content),
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"source"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "planned"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "hardlink_target" || failure.TargetCommitted {
		t.Fatalf("failure = %#v", failure)
	}
	for _, currentPath := range []string{path, alias} {
		actual, err := os.ReadFile(currentPath)
		if err != nil || !equalSnaplineLines([]string{string(actual)}, []string{string(content)}) {
			t.Fatalf("%s content/error = %q / %v", currentPath, actual, err)
		}
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestSnaplineApplyRejectsImageTarget(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "image.gif")
	content := []byte("GIF89a")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: rawFileRevision(content),
		Proof: []SnaplineProofRange{}, Replacements: []SnaplineReplacement{}, Deletions: []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{{Line: 1, Text: "not an image"}}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "unsupported_file" || failure.TargetCommitted {
		t.Fatalf("failure = %#v", failure)
	}
	actual, _ := os.ReadFile(path)
	if !equalSnaplineLines([]string{string(actual)}, []string{string(content)}) {
		t.Fatalf("image content changed: %q", actual)
	}
}

func TestSnaplineApplyInvalidRevisionDoesNotInspectTarget(t *testing.T) {
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: filepath.Join(t.TempDir(), "missing.txt"), ExpectedRevision: "invalid",
		Proof: []SnaplineProofRange{}, Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "x"}},
		Deletions: []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "invalid_request" || failure.Path != "" || failure.TargetCommitted {
		t.Fatalf("failure = %#v", failure)
	}
}

func TestSnaplineApplyPayloadLimitDoesNotInspectTarget(t *testing.T) {
	directory := t.TempDir()
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: filepath.Join(directory, "missing.txt"),
		ExpectedRevision: "sha256:" + strings.Repeat("0", 64),
		Proof:            []SnaplineProofRange{},
		Replacements:     []SnaplineReplacement{{Start: 1, End: 1, Text: strings.Repeat("x", snaplineTextByteLimit+1)}},
		Deletions:        []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := snaplineApplyJSON(t, request)
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "size_limit" || failure.Path != "" || failure.TargetCommitted {
		t.Fatalf("failure = %#v", failure)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestSnaplineApplyUncertainReplaceExitsNonzero(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	original := []byte("source\n")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: rawFileRevision(original),
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"source"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "planned"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	encodedRequest, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	originalReplace := replaceSnaplineFile
	defer func() { replaceSnaplineFile = originalReplace }()
	replaceSnaplineFile = func(tempPath, targetPath string) error {
		if err := replaceFile(tempPath, targetPath); err != nil {
			return err
		}
		return errors.New("injected uncertain replacement result")
	}
	stdout, stderr, code := mainTestRunForCode(t, string(encodedRequest), "apply")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "injected uncertain replacement result") {
		t.Fatalf("code/stdout/stderr = %d / %q / %q", code, stdout, stderr)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "planned\n" {
		t.Fatalf("target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}

func TestSnaplineApplyPostCommitDurabilityWarningRemainsSuccess(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	original := []byte("source\n")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	request := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: path, ExpectedRevision: rawFileRevision(original),
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"source"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "planned"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	originalReplace := replaceSnaplineFile
	defer func() { replaceSnaplineFile = originalReplace }()
	replaceSnaplineFile = func(tempPath, targetPath string) error {
		if err := replaceFile(tempPath, targetPath); err != nil {
			return err
		}
		return &postCommitDurabilityError{err: errors.New("injected directory sync failure")}
	}
	output := snaplineApplyJSON(t, request)
	var result SnaplineApplyResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Outcome != "applied" || !result.ContentChanged || len(result.Warnings) != 1 || result.Warnings[0].Code != "post_commit_durability" {
		t.Fatalf("result = %#v", result)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "planned\n" {
		t.Fatalf("target content = %q", content)
	}
	assertNoSnaplineTempFiles(t, directory)
}
