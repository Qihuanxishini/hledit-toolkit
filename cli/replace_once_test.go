package main

import (
	"bytes"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
)

func replaceOnceTestRun(t *testing.T, path string, payload string) string {
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

	var output bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&output, outR)
		close(done)
	}()
	go func() {
		_, _ = io.WriteString(inW, payload)
		_ = inW.Close()
	}()

	if err := cmdReplaceOnce(path); err != nil {
		t.Fatalf("cmdReplaceOnce returned error: %v", err)
	}
	_ = outW.Close()
	_ = inR.Close()
	<-done
	_ = outR.Close()
	return strings.TrimSpace(output.String())
}

func TestCmdReplaceOnce(t *testing.T) {
	t.Run("replaces one unique multiline block atomically", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteTextFile(t, dir, "target.txt", "alpha\nbravo\ncharlie\ndelta\n")

		output := replaceOnceTestRun(t, target, `{"old_lines":["bravo","charlie"],"new_lines":["BRAVO","CHARLIE","echo"]}`)
		var result BatchEditResult
		editTestMustUnmarshal(t, output, &result)
		if !result.OK || !result.ContentChanged || result.EditsApplied != 1 || result.FirstChangedLine != 2 || result.LastChangedLine != 3 || result.LinesAdded != 3 || result.LinesDeleted != 2 {
			t.Fatalf("result = %#v; want changed unique replacement metadata", result)
		}
		if result.UpdatedAnchors == nil || len(result.UpdatedAnchors.Lines) == 0 {
			t.Fatalf("result = %#v; want updated anchor context", result)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "alpha\nBRAVO\nCHARLIE\necho\ndelta\n" {
			t.Fatalf("target = %q", content)
		}
	})

	t.Run("accepts an empty string line as the exact blank-line precondition", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteTextFile(t, dir, "target.txt", "alpha\n\nbravo\n")

		output := replaceOnceTestRun(t, target, `{"old_lines":[""],"new_lines":["between"]}`)
		var result BatchEditResult
		editTestMustUnmarshal(t, output, &result)
		if !result.OK || result.FirstChangedLine != 2 || result.LastChangedLine != 2 {
			t.Fatalf("result = %#v; want blank line replacement", result)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "alpha\nbetween\nbravo\n" {
			t.Fatalf("target = %q", content)
		}
	})

	t.Run("rejects a missing block without writing", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")

		output := replaceOnceTestRun(t, target, `{"old_lines":["missing"],"new_lines":["next"]}`)
		var result ContentReplaceOnceError
		editTestMustUnmarshal(t, output, &result)
		if result.OK || result.Error != "content_not_found" || result.CurrentRevision == "" {
			t.Fatalf("result = %#v; want content_not_found with revision", result)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "alpha\nbravo\n" {
			t.Fatalf("target changed to %q", content)
		}
	})

	t.Run("rejects an ambiguous block with candidate ranges", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "needle", "bravo", "needle")

		output := replaceOnceTestRun(t, target, `{"old_lines":["needle"],"new_lines":["next"]}`)
		var result ContentReplaceOnceError
		editTestMustUnmarshal(t, output, &result)
		if result.OK || result.Error != "content_ambiguous" || result.MatchCount != 2 {
			t.Fatalf("result = %#v; want content_ambiguous with two matches", result)
		}
		if want := []ContentMatchCandidate{{StartLine: 2, EndLine: 2}, {StartLine: 4, EndLine: 4}}; !slices.Equal(result.Candidates, want) {
			t.Fatalf("candidates = %#v; want %#v", result.Candidates, want)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "alpha\nneedle\nbravo\nneedle\n" {
			t.Fatalf("target changed to %q", content)
		}
	})

	t.Run("rejects a concurrent source change before commit", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha", "bravo")
		previousSeam := beforeAtomicRevisionCheck
		beforeAtomicRevisionCheck = func(targetPath string) {
			if err := os.WriteFile(targetPath, []byte("alpha\nexternal\n"), 0o600); err != nil {
				panic(err)
			}
		}
		t.Cleanup(func() { beforeAtomicRevisionCheck = previousSeam })

		output := replaceOnceTestRun(t, target, `{"old_lines":["bravo"],"new_lines":["BRAVO"]}`)
		var result ContentReplaceOnceError
		editTestMustUnmarshal(t, output, &result)
		if result.OK || result.Error != "source_changed_before_commit" || result.CurrentRevision == "" {
			t.Fatalf("result = %#v; want pre-commit source change rejection", result)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "alpha\nexternal\n" {
			t.Fatalf("target = %q; want external content preserved", content)
		}
	})

	t.Run("rejects unknown, trailing, and empty request fields", func(t *testing.T) {
		dir := t.TempDir()
		target := editTestWriteLinesFile(t, dir, "target.txt", "alpha")
		for _, payload := range []string{
			`{"old_lines":["alpha"],"new_lines":["next"],"extra":true}`,
			`{"old_lines":["alpha"],"new_lines":["next"]} {}`,
			`{"old_lines":[],"new_lines":["next"]}`,
			`{"old_lines":["alpha"],"new_lines":[]}`,
		} {
			output := replaceOnceTestRun(t, target, payload)
			var result ContentReplaceOnceError
			editTestMustUnmarshal(t, output, &result)
			if result.OK || result.Error != "invalid" {
				t.Fatalf("payload %s result = %#v; want invalid", payload, result)
			}
		}
	})
}
