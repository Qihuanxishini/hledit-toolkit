package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func goldenBuild(t *testing.T, directory string) string {
	t.Helper()
	binaryName := "snapline"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	binaryPath := filepath.Join(directory, binaryName)
	command := exec.Command("go", "build", "-o", binaryPath, ".")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build snapline: %v\n%s", err, output)
	}
	return binaryPath
}

func goldenRunSnapline(t *testing.T, binaryPath, stdin string, args ...string) string {
	t.Helper()
	command := exec.Command(binaryPath, args...)
	command.Stdin = strings.NewReader(stdin)
	output, err := command.Output()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			t.Fatalf("snapline %v failed: %v\nstderr:\n%s\nstdout:\n%s", args, err, exitError.Stderr, output)
		}
		t.Fatalf("snapline %v failed: %v", args, err)
	}
	return string(output)
}

func goldenMarshal(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func goldenRead(t *testing.T, binaryPath, path string, windows ...SnaplineReadWindow) SnaplineReadResult {
	t.Helper()
	output := goldenRunSnapline(t, binaryPath, goldenMarshal(t, SnaplineReadRequest{
		ProtocolVersion: 1,
		Path:            path,
		Windows:         windows,
	}), "read")
	var result SnaplineReadResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("decode read result: %v (output=%q)", err, output)
	}
	if !result.OK {
		t.Fatalf("read failed: %s", output)
	}
	return result
}

func goldenApply(t *testing.T, binaryPath string, request SnaplineApplyRequest) SnaplineApplyResult {
	t.Helper()
	output := goldenRunSnapline(t, binaryPath, goldenMarshal(t, request), "apply")
	var result SnaplineApplyResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("decode apply result: %v (output=%q)", err, output)
	}
	if !result.OK {
		t.Fatalf("apply failed: %s", output)
	}
	return result
}

func goldenFindLine(t *testing.T, lines []string, needle string) int {
	t.Helper()
	for index, line := range lines {
		if strings.Contains(line, needle) {
			return index + 1
		}
	}
	t.Fatalf("line containing %q was not found", needle)
	return 0
}

func goldenContextLines(result SnaplineReadResult) map[int]string {
	lines := make(map[int]string)
	for _, context := range result.Contexts {
		for index, text := range context.Lines {
			lines[context.Start+index] = text
		}
	}
	return lines
}

func TestGoldenSnaplineBinarySurface(t *testing.T) {
	binaryPath := goldenBuild(t, t.TempDir())
	if output := goldenRunSnapline(t, binaryPath, "", "--version"); output != "Snapline 1.0.0\n" {
		t.Fatalf("version = %q", output)
	}
	output := goldenRunSnapline(t, binaryPath, "", "capabilities")
	var capabilities SnaplineCapabilities
	if err := json.Unmarshal([]byte(output), &capabilities); err != nil {
		t.Fatal(err)
	}
	if capabilities.Product != "snapline" || capabilities.WireProtocol != 1 || !capabilities.GroupedAtomicApply {
		t.Fatalf("capabilities = %#v", capabilities)
	}
}

func TestGoldenSnaplineRealFixtureMultiWindowBatch(t *testing.T) {
	directory := t.TempDir()
	binaryPath := goldenBuild(t, directory)
	fixtureBytes, err := os.ReadFile(filepath.Join("testdata", "uuid.js"))
	if err != nil {
		t.Fatal(err)
	}
	workPath := filepath.Join(directory, "uuid.js")
	if err := os.WriteFile(workPath, fixtureBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	fixture, err := parseTextFile(fixtureBytes)
	if err != nil {
		t.Fatal(err)
	}
	sourceLine := goldenFindLine(t, fixture.Lines, "// Source: https://www.npmjs.com/package/uuid")
	filesLine := goldenFindLine(t, fixture.Lines, "// Files: all dist/*.js")
	maxStart := goldenFindLine(t, fixture.Lines, "// ----- dist-node/max.js -----")
	maxEnd := goldenFindLine(t, fixture.Lines, "export default 'ffffffff-ffff-ffff-ffff-ffffffffffff';")
	readResult := goldenRead(t, binaryPath, workPath,
		SnaplineReadWindow{Offset: sourceLine, Limit: 1},
		SnaplineReadWindow{Offset: filesLine, Limit: 1},
		SnaplineReadWindow{Offset: maxStart, Limit: maxEnd - maxStart + 1},
	)
	observed := goldenContextLines(readResult)
	proof := []SnaplineProofRange{
		{Start: sourceLine, Lines: []string{observed[sourceLine]}},
		{Start: filesLine, Lines: []string{observed[filesLine]}},
		{Start: maxStart, Lines: append([]string(nil), fixture.Lines[maxStart-1:maxEnd]...)},
	}
	result := goldenApply(t, binaryPath, SnaplineApplyRequest{
		ProtocolVersion:  1,
		Path:             workPath,
		ExpectedRevision: readResult.Revision,
		Proof:            proof,
		Replacements: []SnaplineReplacement{
			{Start: sourceLine, End: sourceLine, Text: "// Source: official uuid package uuid@14.0.0"},
			{Start: maxStart, End: maxEnd, Text: "// ----- dist-node/max.js (edited) -----\nexport default 'ffffffff-ffff-ffff-ffff-ffffffffffff'; // max uuid"},
		},
		Deletions:        []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{{Line: filesLine, Text: "// Golden fixture edited by Snapline."}},
	})
	if result.Stats.RequestedChanges != 3 || result.Stats.EffectiveChanges != 3 || len(result.Effects) != 3 {
		t.Fatalf("result = %#v", result)
	}
	content, err := os.ReadFile(workPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"// Source: official uuid package uuid@14.0.0",
		"// Golden fixture edited by Snapline.",
		"// ----- dist-node/max.js (edited) -----",
	} {
		if !strings.Contains(string(content), expected) {
			t.Fatalf("edited fixture missing %q", expected)
		}
	}
}

func TestGoldenSnaplineAtomicBatchAndStaleRejection(t *testing.T) {
	directory := t.TempDir()
	binaryPath := goldenBuild(t, directory)
	workPath := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(workPath, []byte("one\ntwo\nthree\nfour\nfive\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	readResult := goldenRead(t, binaryPath, workPath, SnaplineReadWindow{Offset: 1, Limit: 5})
	result := goldenApply(t, binaryPath, SnaplineApplyRequest{
		ProtocolVersion: 1, Path: workPath, ExpectedRevision: readResult.Revision,
		Proof:            []SnaplineProofRange{{Start: 1, Lines: []string{"one", "two", "three", "four", "five"}}},
		Replacements:     []SnaplineReplacement{{Start: 2, End: 2, Text: "TWO"}},
		Deletions:        []SnaplineDeletion{{Start: 4, End: 4}},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{{Line: 5, Text: "six"}},
	})
	if result.Stats.NewLineCount != 5 || result.Stats.EffectiveChanges != 3 {
		t.Fatalf("result = %#v", result)
	}
	content, _ := os.ReadFile(workPath)
	if string(content) != "one\nTWO\nthree\nfive\nsix\n" {
		t.Fatalf("content = %q", content)
	}

	staleRequest := SnaplineApplyRequest{
		ProtocolVersion: 1, Path: workPath, ExpectedRevision: readResult.Revision,
		Proof:        []SnaplineProofRange{{Start: 1, Lines: []string{"one"}}},
		Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "ONE"}},
		Deletions:    []SnaplineDeletion{}, InsertionsBefore: []SnaplineInsertion{}, InsertionsAfter: []SnaplineInsertion{},
	}
	output := goldenRunSnapline(t, binaryPath, goldenMarshal(t, staleRequest), "apply")
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(output), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "snapshot_stale" || failure.TargetCommitted || len(failure.Contexts) == 0 {
		t.Fatalf("failure = %#v", failure)
	}
	content, _ = os.ReadFile(workPath)
	if string(content) != "one\nTWO\nthree\nfive\nsix\n" {
		t.Fatalf("stale request changed target: %q", content)
	}
}

func TestGoldenSnaplineEmptySnapshotCreatesContent(t *testing.T) {
	directory := t.TempDir()
	binaryPath := goldenBuild(t, directory)
	workPath := filepath.Join(directory, "empty.txt")
	if err := os.WriteFile(workPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	readResult := goldenRead(t, binaryPath, workPath, SnaplineReadWindow{Offset: 1, Limit: 160})
	if readResult.TotalLines != 0 || len(readResult.Contexts) != 1 || readResult.Contexts[0].End != 0 {
		t.Fatalf("empty read = %#v", readResult)
	}
	result := goldenApply(t, binaryPath, SnaplineApplyRequest{
		ProtocolVersion: 1, Path: workPath, ExpectedRevision: readResult.Revision,
		Proof: []SnaplineProofRange{}, Replacements: []SnaplineReplacement{}, Deletions: []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{{Line: 1, Text: "created\nwith snapshot\n"}}, InsertionsAfter: []SnaplineInsertion{},
	})
	if result.Stats.OldLineCount != 0 || result.Stats.NewLineCount != 2 {
		t.Fatalf("result = %#v", result)
	}
	content, _ := os.ReadFile(workPath)
	if string(content) != "created\nwith snapshot\n" {
		t.Fatalf("content = %q", content)
	}
}
