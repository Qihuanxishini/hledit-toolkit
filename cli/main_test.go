package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mainTestRunForCode(t *testing.T, stdin string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	oldIn, oldOut, oldErr := os.Stdin, os.Stdout, os.Stderr
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	type pipeResult struct {
		content []byte
		err     error
	}
	readPipe := func(file *os.File, result chan<- pipeResult) {
		content, readErr := io.ReadAll(file)
		result <- pipeResult{content: content, err: readErr}
	}
	outResult := make(chan pipeResult, 1)
	errResult := make(chan pipeResult, 1)
	go readPipe(outR, outResult)
	go readPipe(errR, errResult)
	inputDone := make(chan struct{})
	go func() {
		_, _ = inW.WriteString(stdin)
		_ = inW.Close()
		close(inputDone)
	}()

	os.Stdin, os.Stdout, os.Stderr = inR, outW, errW
	code = run(args)
	_ = inR.Close()
	_ = outW.Close()
	_ = errW.Close()
	os.Stdin, os.Stdout, os.Stderr = oldIn, oldOut, oldErr
	<-inputDone
	capturedOut := <-outResult
	capturedErr := <-errResult
	_ = outR.Close()
	_ = errR.Close()
	if capturedOut.err != nil {
		t.Fatal(capturedOut.err)
	}
	if capturedErr.err != nil {
		t.Fatal(capturedErr.err)
	}
	return string(capturedOut.content), string(capturedErr.content), code
}

func mainTestRun(t *testing.T, stdin string, args ...string) string {
	t.Helper()
	stdout, stderr, code := mainTestRunForCode(t, stdin, args...)
	if code != 0 || stderr != "" {
		t.Fatalf("run(%v) = code %d, stderr %q", args, code, stderr)
	}
	return stdout
}

func TestMainVersionGolden(t *testing.T) {
	stdout, stderr, code := mainTestRunForCode(t, "", "--version")
	if code != 0 || stderr != "" || stdout != "Snapline 1.0.0\n" {
		t.Fatalf("version = code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestMainCapabilitiesGolden(t *testing.T) {
	output := mainTestRun(t, "", "capabilities")
	var capabilities SnaplineCapabilities
	if err := json.Unmarshal([]byte(output), &capabilities); err != nil {
		t.Fatalf("decode capabilities: %v (output=%q)", err, output)
	}
	if !capabilities.OK || capabilities.Product != "snapline" || capabilities.Version != version || capabilities.WireProtocol != 1 || capabilities.RawRevision != "sha256" || !capabilities.MultiWindowRead || !capabilities.BoundedBinaryPreflight || !capabilities.GroupedAtomicApply || !capabilities.CompleteReadProof || !capabilities.PreCommitRevisionCheck || !capabilities.StructuredEditEffects || !capabilities.StructuredRecoveryContexts {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if strings.Contains(output, "anchorProtocol") || strings.Contains(output, "batchWire") {
		t.Fatalf("capabilities leaked a removed protocol: %s", output)
	}
}

func TestMainReadAndApplyWire(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "target.txt")
	if err := os.WriteFile(path, []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	readRequest, _ := json.Marshal(SnaplineReadRequest{
		ProtocolVersion: 1,
		Path:            path,
		Windows:         []SnaplineReadWindow{{Offset: 1, Limit: 3}},
	})
	readOutput := mainTestRun(t, string(readRequest), "read")
	var readResult SnaplineReadResult
	if err := json.Unmarshal([]byte(readOutput), &readResult); err != nil {
		t.Fatalf("decode read result: %v (output=%q)", err, readOutput)
	}
	if !readResult.OK || readResult.TotalLines != 3 || len(readResult.Contexts) != 1 || len(readResult.Contexts[0].Lines) != 3 {
		t.Fatalf("read result = %#v", readResult)
	}

	applyRequest, _ := json.Marshal(SnaplineApplyRequest{
		ProtocolVersion:  1,
		Path:             path,
		ExpectedRevision: readResult.Revision,
		Proof:            []SnaplineProofRange{{Start: 2, Lines: []string{"beta"}}},
		Replacements:     []SnaplineReplacement{{Start: 2, End: 2, Text: "BETA"}},
		Deletions:        []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{},
	})
	applyOutput := mainTestRun(t, string(applyRequest), "apply")
	var applyResult SnaplineApplyResult
	if err := json.Unmarshal([]byte(applyOutput), &applyResult); err != nil {
		t.Fatalf("decode apply result: %v (output=%q)", err, applyOutput)
	}
	if !applyResult.OK || applyResult.Outcome != "applied" || !applyResult.ContentChanged || len(applyResult.Effects) != 1 {
		t.Fatalf("apply result = %#v", applyResult)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "alpha\nBETA\ngamma\n" {
		t.Fatalf("target = %q", content)
	}
}

func TestMainLogicalRequestErrorUsesExitZero(t *testing.T) {
	stdout, stderr, code := mainTestRunForCode(t, `{ "protocolVersion": 1, "path": null, "windows": [] }`, "read")
	if code != 0 || stderr != "" {
		t.Fatalf("logical error = code %d, stderr %q", code, stderr)
	}
	var failure SnaplineLogicalFailure
	if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
		t.Fatalf("decode logical error: %v", err)
	}
	if failure.OK || failure.Code != "invalid_request" || failure.TargetCommitted {
		t.Fatalf("logical error = %#v", failure)
	}
}

func TestMainReadRejectsOversizedAndInvalidUTF8Input(t *testing.T) {
	for name, test := range map[string]struct {
		input string
		code  string
	}{
		"oversized":     {input: strings.Repeat("x", snaplineReadInputLimit+1), code: "size_limit"},
		"invalid UTF-8": {input: string([]byte{0xff}), code: "invalid_request"},
	} {
		t.Run(name, func(t *testing.T) {
			stdout, stderr, exitCode := mainTestRunForCode(t, test.input, "read")
			if exitCode != 0 || stderr != "" {
				t.Fatalf("exit/stderr = %d / %q", exitCode, stderr)
			}
			var failure SnaplineLogicalFailure
			if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
				t.Fatal(err)
			}
			if failure.Code != test.code || failure.TargetCommitted {
				t.Fatalf("failure = %#v", failure)
			}
		})
	}
}

func TestMainHelpMisuseAndRemovedCommands(t *testing.T) {
	for _, args := range [][]string{{}, {"help"}, {"--help"}} {
		stdout, stderr, code := mainTestRunForCode(t, "", args...)
		if code != 0 || stderr != "" || !strings.Contains(stdout, "snapline read") {
			t.Fatalf("help %v = code %d, stdout %q, stderr %q", args, code, stdout, stderr)
		}
	}
	removed := []string{"version", "read-range", "anchors", "replace", "replace-range", "insert", "batch"}
	for _, command := range removed {
		stdout, stderr, code := mainTestRunForCode(t, "", command)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "unknown command") {
			t.Fatalf("removed command %q = code %d, stdout %q, stderr %q", command, code, stdout, stderr)
		}
	}
	for _, args := range [][]string{{"--version", "extra"}, {"read", "path"}, {"apply", "path"}, {"capabilities", "extra"}} {
		stdout, stderr, code := mainTestRunForCode(t, "", args...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "Snapline") {
			t.Fatalf("misuse %v = code %d, stdout %q, stderr %q", args, code, stdout, stderr)
		}
	}
}

func TestMustRun(t *testing.T) {
	if code := mustRun(nil); code != 0 {
		t.Fatalf("mustRun(nil) = %d", code)
	}
	_, stderr, code := mainTestRunForCode(t, "", "help")
	if code != 0 || stderr != "" {
		t.Fatalf("help = code %d, stderr %q", code, stderr)
	}
}
