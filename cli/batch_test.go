package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func batchTestRun(t *testing.T, target string, req BatchEditRequest, checkOnly bool) string {
	t.Helper()

	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return batchTestRunPayload(t, target, payload, checkOnly)
}

func batchTestRunPayload(t *testing.T, target string, payload []byte, checkOnly bool) string {
	t.Helper()

	oldStdin := os.Stdin
	oldStdout := os.Stdout
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = inR
	os.Stdout = outW
	defer func() {
		os.Stdin = oldStdin
		os.Stdout = oldStdout
	}()

	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&out, outR)
		close(done)
	}()

	go func() {
		_, _ = inW.Write(payload)
		_ = inW.Close()
	}()

	var commandErr error
	if checkOnly {
		commandErr = runBatchCheck(target)
	} else {
		commandErr = runBatchApply(target)
	}
	if commandErr != nil {
		t.Fatalf("batch command returned error: %v", commandErr)
	}

	_ = outW.Close()
	_ = inR.Close()
	<-done
	_ = outR.Close()

	return strings.TrimSpace(out.String())
}

func batchTestMustUnmarshal[T any](t *testing.T, out string, target *T) {
	t.Helper()
	if err := json.Unmarshal([]byte(out), target); err != nil {
		t.Fatalf("unmarshal batch output %q: %v", out, err)
	}
}

func batchTestReadLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" {
		return []string{}
	}
	return strings.Split(text, "\n")
}

func batchTestWriteReq(t *testing.T, target string, edits ...BatchEditOp) string {
	t.Helper()
	out := batchTestRun(t, target, BatchEditRequest{Edits: edits}, false)
	if out == "" {
		t.Fatal("batch produced empty output")
	}
	return out
}

func batchTestCheckReq(t *testing.T, target string, edits ...BatchEditOp) string {
	t.Helper()
	out := batchTestRun(t, target, BatchEditRequest{Edits: edits}, true)
	if out == "" {
		t.Fatal("batch --check produced empty output")
	}
	return out
}

func TestCmdBatchRejectsUnknownJSONFields(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
	payload, err := json.Marshal(map[string]any{
		"edits": []map[string]any{{
			"op":    "replace",
			"pos":   formatTag(1, "alpha"),
			"linez": []string{"beta"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	out := batchTestRunPayload(t, target, payload, false)
	var result BatchEditError
	batchTestMustUnmarshal(t, out, &result)
	if result.OK || result.Error != "invalid" || !strings.Contains(result.Message, `unknown field "linez"`) {
		t.Fatalf("result = %+v; want invalid unknown-field error", result)
	}
	if got := batchTestReadLines(t, target); len(got) != 1 || got[0] != "alpha" {
		t.Fatalf("file changed to %#v; want unchanged", got)
	}
}

func TestCmdBatchRejectsTrailingJSON(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
	payload := []byte(`{"edits":[{"op":"replace","pos":"` + formatTag(1, "alpha") + `","lines":["beta"]}]} {}`)

	out := batchTestRunPayload(t, target, payload, false)
	var result BatchEditError
	batchTestMustUnmarshal(t, out, &result)
	if result.OK || result.Error != "invalid" || !strings.Contains(result.Message, "exactly one JSON object") {
		t.Fatalf("result = %+v; want trailing-JSON rejection", result)
	}
	if got := batchTestReadLines(t, target); len(got) != 1 || got[0] != "alpha" {
		t.Fatalf("file changed to %#v; want unchanged", got)
	}
}

func TestCmdBatchRejectsInvalidWireFields(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
	anchor := formatTag(1, "alpha")
	tests := []struct {
		name string
		edit map[string]any
		want string
	}{
		{name: "delete lines", edit: map[string]any{"op": "delete", "pos": anchor, "lines": []string{}}, want: "delete does not accept lines"},
		{name: "delete non-empty lines", edit: map[string]any{"op": "delete", "pos": anchor, "lines": []string{"beta"}}, want: "delete does not accept lines"},
		{name: "delete after", edit: map[string]any{"op": "delete", "pos": anchor, "after": false}, want: "delete does not accept after"},
		{name: "replace missing lines", edit: map[string]any{"op": "replace", "pos": anchor}, want: "replace requires lines"},
		{name: "replace after", edit: map[string]any{"op": "replace", "pos": anchor, "after": false, "lines": []string{"beta"}}, want: "replace does not accept after"},
		{name: "insert false after", edit: map[string]any{"op": "insert", "pos": anchor, "after": false, "lines": []string{"beta"}}, want: "insert after must be true"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{"edits": []map[string]any{tc.edit}})
			if err != nil {
				t.Fatal(err)
			}
			out := batchTestRunPayload(t, target, payload, false)
			var result BatchEditError
			batchTestMustUnmarshal(t, out, &result)
			if result.OK || result.Error != "invalid" || !strings.Contains(result.Message, tc.want) {
				t.Fatalf("result = %+v; want invalid error containing %q", result, tc.want)
			}
			if got := batchTestReadLines(t, target); len(got) != 1 || got[0] != "alpha" {
				t.Fatalf("file changed to %#v; want unchanged", got)
			}
		})
	}
}

func TestCmdBatch(t *testing.T) {
	t.Run("replace range uses end_pos", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:     "replace",
			Pos:    formatTag(2, "bravo"),
			EndPos: formatTag(3, "charlie"),
			Lines:  []string{"delta"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if !got.ContentChanged {
			t.Fatal("changed batch reported contentChanged=false")
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.EditsApplied != 1 || got.LinesAdded != 1 || got.LinesDeleted != 2 {
			t.Fatalf("batch metadata = %#v; want editsApplied 1 lines +1 -2", got)
		}
		if got.UpdatedAnchors == nil {
			t.Fatal("batch result did not include updated anchors")
		}
		if want := []string{"alpha", "delta", "delta"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("same replacement is a no-op", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		fixedTime := time.Unix(1_600_000_000, 0)
		if err := os.Chtimes(target, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
		before, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"bravo"},
		})
		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK || got.ContentChanged || got.EditsApplied != 1 {
			t.Fatalf("batch output = %#v; want successful one-operation no-op", got)
		}
		if got.UpdatedAnchors == nil {
			t.Fatal("no-op batch result did not include updated anchors")
		}
		after, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("no-op changed modification time: before %v, after %v", before.ModTime(), after.ModTime())
		}
	})

	t.Run("delete range uses end_pos", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:     "delete",
			Pos:    formatTag(2, "bravo"),
			EndPos: formatTag(4, "delta"),
			Lines:  nil,
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LinesAdded != 0 || got.LinesDeleted != 3 {
			t.Fatalf("batch line deltas = +%d -%d; want +0 -3", got.LinesAdded, got.LinesDeleted)
		}
		if want := []string{"alpha"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("firstChangedLine is the minimum across edits", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "replace", Pos: formatTag(3, "charlie"), Lines: []string{"CHARLIE"}},
			BatchEditOp{OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"BRAVO"}},
		)

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if want := []string{"alpha", "BRAVO", "CHARLIE"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("range with end_pos before pos is invalid", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:     "replace",
			Pos:    formatTag(3, "charlie"),
			EndPos: formatTag(2, "bravo"),
			Lines:  []string{"delta"},
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" {
			t.Fatalf("batch output = %#v; want invalid error", got)
		}
		if !strings.Contains(got.Message, "start line 3 > end line 2") {
			t.Fatalf("message = %q, want start/end detail", got.Message)
		}
		if want := []string{"alpha", "bravo", "charlie"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("insert with empty lines is invalid", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:    "insert",
			Pos:   formatTag(1, "alpha"),
			Lines: nil,
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" {
			t.Fatalf("batch output = %#v; want invalid error", got)
		}
		if !strings.Contains(got.Message, "insert requires non-empty content") {
			t.Fatalf("message = %q, want empty insert detail", got.Message)
		}
		if want := []string{"alpha", "bravo"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})
	t.Run("stale anchor returns remaps", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		if err := os.WriteFile(target, []byte("alpha\nmodified\ncharlie\n"), 0o600); err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:    "replace",
			Pos:   formatTag(2, "bravo"),
			Lines: []string{"NEW"},
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK {
			t.Fatalf("batch succeeded unexpectedly: %#v", got)
		}
		if got.Error != "stale" {
			t.Fatalf("error = %q, want stale", got.Error)
		}
		if len(got.Remaps) == 0 {
			t.Fatalf("expected remaps, got %#v", got)
		}
		if got.CurrentAnchors == nil || len(got.CurrentAnchors.Lines) != 3 {
			t.Fatalf("current anchors = %#v; want bounded stale snapshot", got.CurrentAnchors)
		}
		current := got.CurrentAnchors.Lines[1]
		if current.Anchor != formatTag(2, "modified") || current.Text != "modified" || current.TextTruncated {
			t.Fatalf("current stale line = %#v; want complete modified line", current)
		}
	})
}

func equalLines(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestCmdBatchLastChangedLine(t *testing.T) {
	t.Run("single replace includes lastChangedLine", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:    "replace",
			Pos:   formatTag(2, "bravo"),
			Lines: []string{"BRAVO"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 2 {
			t.Fatalf("lastChangedLine = %d, want 2", got.LastChangedLine)
		}
	})

	t.Run("replace range lastChangedLine reflects end_pos", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:     "replace",
			Pos:    formatTag(2, "bravo"),
			EndPos: formatTag(4, "delta"),
			Lines:  []string{"BRAVO"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 4 {
			t.Fatalf("lastChangedLine = %d, want 4", got.LastChangedLine)
		}
	})

	t.Run("insert lastChangedLine covers inserted block", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:    "insert",
			Pos:   formatTag(2, "bravo"),
			Lines: []string{"one", "two"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 3 {
			t.Fatalf("lastChangedLine = %d, want 3", got.LastChangedLine)
		}
	})

	t.Run("multi-edit lastChangedLine is max across edits", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "replace", Pos: formatTag(1, "alpha"), Lines: []string{"ALPHA"}},
			BatchEditOp{OP: "replace", Pos: formatTag(4, "delta"), Lines: []string{"DELTA"}},
		)

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 1 {
			t.Fatalf("firstChangedLine = %d, want 1", got.FirstChangedLine)
		}
		if got.LastChangedLine != 4 {
			t.Fatalf("lastChangedLine = %d, want 4", got.LastChangedLine)
		}
	})
}

func TestCmdBatchCheck(t *testing.T) {
	t.Run("check mode succeeds and does not write", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		originalContent, _ := os.ReadFile(target)

		out := batchTestCheckReq(t, target, BatchEditOp{
			OP:    "replace",
			Pos:   formatTag(2, "bravo"),
			Lines: []string{"BRAVO"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("check mode failed: %#v", got)
		}
		if !got.Checked {
			t.Fatalf("checked = false; want true")
		}
		if got.EditsApplied != 1 {
			t.Fatalf("editsApplied = %d, want 1", got.EditsApplied)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 2 {
			t.Fatalf("lastChangedLine = %d, want 2", got.LastChangedLine)
		}
		if got.LinesAdded != 1 || got.LinesDeleted != 1 {
			t.Fatalf("check mode line deltas = +%d -%d; want +1 -1", got.LinesAdded, got.LinesDeleted)
		}

		// File must be unchanged
		afterContent, _ := os.ReadFile(target)
		if string(afterContent) != string(originalContent) {
			t.Fatalf("check mode wrote to file: got %q, want %q", string(afterContent), string(originalContent))
		}
	})

	t.Run("check mode with range op reports lastChangedLine", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		out := batchTestCheckReq(t, target, BatchEditOp{
			OP:     "replace",
			Pos:    formatTag(2, "bravo"),
			EndPos: formatTag(3, "charlie"),
			Lines:  []string{"MIDDLE"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK || !got.Checked {
			t.Fatalf("check result = %#v; want ok+checked", got)
		}
		if got.FirstChangedLine != 2 {
			t.Fatalf("firstChangedLine = %d, want 2", got.FirstChangedLine)
		}
		if got.LastChangedLine != 3 {
			t.Fatalf("lastChangedLine = %d, want 3", got.LastChangedLine)
		}
		if got.LinesAdded != 1 || got.LinesDeleted != 2 {
			t.Fatalf("check range line deltas = +%d -%d; want +1 -2", got.LinesAdded, got.LinesDeleted)
		}
	})

	t.Run("check mode stale anchor does not write and reports stale", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		if err := os.WriteFile(target, []byte("alpha\nmodified\ncharlie\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		originalContent, _ := os.ReadFile(target)

		out := batchTestCheckReq(t, target, BatchEditOp{
			OP:    "replace",
			Pos:   formatTag(2, "bravo"),
			Lines: []string{"NEW"},
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "stale" {
			t.Fatalf("check mode stale: got %#v; want stale error", got)
		}
		if len(got.Remaps) == 0 {
			t.Fatalf("expected remaps, got none")
		}

		afterContent, _ := os.ReadFile(target)
		if string(afterContent) != string(originalContent) {
			t.Fatalf("check mode stale wrote to file unexpectedly")
		}
	})

	t.Run("check mode invalid op does not write", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		originalContent, _ := os.ReadFile(target)

		out := batchTestCheckReq(t, target, BatchEditOp{
			OP:    "bogus",
			Pos:   formatTag(1, "alpha"),
			Lines: []string{"X"},
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" {
			t.Fatalf("check mode invalid: got %#v; want invalid error", got)
		}

		afterContent, _ := os.ReadFile(target)
		if string(afterContent) != string(originalContent) {
			t.Fatalf("check mode invalid wrote to file unexpectedly")
		}
	})
}

func TestBatchCheckAndApplyRejectSamePlan(t *testing.T) {
	tests := []struct {
		name    string
		lines   []string
		request BatchEditRequest
		code    string
	}{
		{
			name:  "stale",
			lines: []string{"alpha", "modified"},
			request: BatchEditRequest{Edits: []BatchEditOp{{
				OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"new"},
			}}},
			code: "stale",
		},
		{
			name:  "physical conflict",
			lines: []string{"alpha", "bravo", "charlie"},
			request: BatchEditRequest{Edits: []BatchEditOp{
				{OP: "insert", Pos: formatTag(1, "alpha"), After: true, Lines: []string{"between"}},
				{OP: "delete", Pos: formatTag(2, "bravo")},
			}},
			code: "invalid",
		},
		{
			name:  "invalid operation",
			lines: []string{"alpha"},
			request: BatchEditRequest{Edits: []BatchEditOp{{
				OP: "bogus", Pos: formatTag(1, "alpha"), Lines: []string{"new"},
			}}},
			code: "invalid",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			checkTarget := editTestWriteLinesFile(t, dir, "check.txt", testCase.lines...)
			applyTarget := editTestWriteLinesFile(t, dir, "apply.txt", testCase.lines...)
			payload, err := json.Marshal(testCase.request)
			if err != nil {
				t.Fatal(err)
			}

			checkOutput := batchTestRunPayload(t, checkTarget, payload, true)
			applyOutput := batchTestRunPayload(t, applyTarget, payload, false)
			if checkOutput != applyOutput {
				t.Fatalf("check/apply rejection differs:\ncheck: %s\napply: %s", checkOutput, applyOutput)
			}
			var rejection BatchEditError
			batchTestMustUnmarshal(t, checkOutput, &rejection)
			if rejection.OK || rejection.Error != testCase.code {
				t.Fatalf("rejection = %#v; want %s", rejection, testCase.code)
			}
			if got := batchTestReadLines(t, checkTarget); !equalLines(got, testCase.lines) {
				t.Fatalf("check changed file to %#v", got)
			}
			if got := batchTestReadLines(t, applyTarget); !equalLines(got, testCase.lines) {
				t.Fatalf("rejected apply changed file to %#v", got)
			}
		})
	}
}

func TestCmdBatchRejectsOverlappingRanges(t *testing.T) {
	dir := t.TempDir()
	target := editTestWriteLinesFile(t, dir, "target.txt", "one", "two", "three", "four")
	originalContent, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}

	out := batchTestWriteReq(t, target,
		BatchEditOp{OP: "replace", Pos: formatTag(2, "two"), Lines: []string{"TWO"}},
		BatchEditOp{OP: "replace", Pos: formatTag(2, "two"), EndPos: formatTag(3, "three"), Lines: []string{"BLOCK"}},
	)

	var got BatchEditError
	batchTestMustUnmarshal(t, out, &got)
	if got.OK || got.Error != "invalid" || !strings.Contains(got.Message, "overlaps") {
		t.Fatalf("batch overlap output = %#v; want invalid overlap error", got)
	}
	afterContent, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterContent) != string(originalContent) {
		t.Fatalf("overlapping batch modified target; got %q want %q", string(afterContent), string(originalContent))
	}
}

func TestCmdBatchInsertAfter(t *testing.T) {
	t.Run("inserts after the anchor and reports inserted lines", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:    "insert",
			Pos:   formatTag(2, "bravo"),
			After: true,
			Lines: []string{"one", "two"},
		})

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 3 || got.LastChangedLine != 4 {
			t.Fatalf("changed lines = %d-%d, want 3-4", got.FirstChangedLine, got.LastChangedLine)
		}
		if want := []string{"alpha", "bravo", "one", "two", "charlie"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("reports final changed range after an earlier insert shifts a replacement", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "insert", Pos: formatTag(2, "bravo"), Lines: []string{"one", "two"}},
			BatchEditOp{OP: "replace", Pos: formatTag(3, "charlie"), Lines: []string{"CHARLIE"}},
		)

		var got BatchEditResult
		batchTestMustUnmarshal(t, out, &got)
		if !got.OK {
			t.Fatalf("batch failed: %#v", got)
		}
		if got.FirstChangedLine != 2 || got.LastChangedLine != 5 {
			t.Fatalf("changed lines = %d-%d, want 2-5", got.FirstChangedLine, got.LastChangedLine)
		}
		if want := []string{"alpha", "one", "two", "bravo", "CHARLIE"}; !equalLines(batchTestReadLines(t, target), want) {
			t.Fatalf("target lines = %#v, want %#v", batchTestReadLines(t, target), want)
		}
	})

	t.Run("rejects insert end_pos without writing", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		originalContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target, BatchEditOp{
			OP:     "insert",
			Pos:    formatTag(1, "alpha"),
			EndPos: formatTag(2, "bravo"),
			Lines:  []string{"one"},
		})

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" || !strings.Contains(got.Message, "does not accept end_pos") {
			t.Fatalf("batch output = %#v; want invalid insert end_pos error", got)
		}
		afterContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(afterContent) != string(originalContent) {
			t.Fatalf("invalid insert modified target; got %q want %q", string(afterContent), string(originalContent))
		}
	})

	t.Run("rejects an after insert that conflicts with a replace", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		originalContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "insert", Pos: formatTag(2, "bravo"), After: true, Lines: []string{"one"}},
			BatchEditOp{OP: "replace", Pos: formatTag(2, "bravo"), Lines: []string{"BRAVO"}},
		)

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" || !strings.Contains(got.Message, "overlaps") {
			t.Fatalf("batch output = %#v; want invalid overlap error", got)
		}
		afterContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(afterContent) != string(originalContent) {
			t.Fatalf("overlapping insert modified target; got %q want %q", string(afterContent), string(originalContent))
		}
	})
}

func TestCmdBatchSinglePassBoundaries(t *testing.T) {
	t.Run("rejects inserts sharing a physical boundary", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		originalContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "insert", Pos: formatTag(1, "alpha"), After: true, Lines: []string{"after-alpha"}},
			BatchEditOp{OP: "insert", Pos: formatTag(2, "bravo"), Lines: []string{"before-bravo"}},
		)

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" || !strings.Contains(got.Message, "physical boundary") {
			t.Fatalf("batch output = %#v; want physical-boundary rejection", got)
		}
		if afterContent, err := os.ReadFile(target); err != nil || string(afterContent) != string(originalContent) {
			t.Fatalf("physical-boundary conflict modified target: %q", afterContent)
		}
	})

	t.Run("rejects an insert at a range boundary", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")
		originalContent, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}

		out := batchTestWriteReq(t, target,
			BatchEditOp{OP: "insert", Pos: formatTag(1, "alpha"), After: true, Lines: []string{"before-range"}},
			BatchEditOp{OP: "delete", Pos: formatTag(2, "bravo")},
		)

		var got BatchEditError
		batchTestMustUnmarshal(t, out, &got)
		if got.OK || got.Error != "invalid" || !strings.Contains(got.Message, "physical boundary") {
			t.Fatalf("batch output = %#v; want range-boundary rejection", got)
		}
		if afterContent, err := os.ReadFile(target); err != nil || string(afterContent) != string(originalContent) {
			t.Fatalf("range-boundary conflict modified target: %q", afterContent)
		}
	})

	t.Run("rebuilds adjacent replacement ranges", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie", "delta")

		batchTestWriteReq(t, target,
			BatchEditOp{OP: "replace", Pos: formatTag(1, "alpha"), Lines: []string{"ALPHA"}},
			BatchEditOp{OP: "replace", Pos: formatTag(2, "bravo"), EndPos: formatTag(3, "charlie"), Lines: []string{"MIDDLE"}},
		)

		want := []string{"ALPHA", "MIDDLE", "delta"}
		if got := batchTestReadLines(t, target); !equalLines(got, want) {
			t.Fatalf("target lines = %#v, want %#v", got, want)
		}
	})

	t.Run("inserts at the beginning and end", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo", "charlie")

		batchTestWriteReq(t, target,
			BatchEditOp{OP: "insert", Pos: formatTag(1, "alpha"), Lines: []string{"first"}},
			BatchEditOp{OP: "insert", Pos: formatTag(3, "charlie"), After: true, Lines: []string{"last"}},
		)

		want := []string{"first", "alpha", "bravo", "charlie", "last"}
		if got := batchTestReadLines(t, target); !equalLines(got, want) {
			t.Fatalf("target lines = %#v, want %#v", got, want)
		}
	})
}
