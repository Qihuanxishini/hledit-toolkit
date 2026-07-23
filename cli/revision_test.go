package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestReadRangeJSONIncludesRawRevision(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.txt")
	content := []byte{0xEF, 0xBB, 0xBF, 'a', '\r', '\n', 'b', '\r', '\n'}
	writeTestFile(t, target, string(content))

	output := readTestCaptureStdout(t, func() {
		if err := cmdReadRangePretty(target, 1, 10, "", 0, true, false); err != nil {
			t.Fatal(err)
		}
	})
	var result ReadResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("read output = %q: %v", output, err)
	}
	if result.Revision != rawFileRevision(content) {
		t.Fatalf("revision = %q, want %q", result.Revision, rawFileRevision(content))
	}
}
