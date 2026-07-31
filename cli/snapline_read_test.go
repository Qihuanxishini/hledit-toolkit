package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeSnaplineWindowsSortsMergesAndClamps(t *testing.T) {
	windows := normalizeSnaplineWindows([]SnaplineReadWindow{
		{Offset: 5, Limit: 20},
		{Offset: 1, Limit: 2},
		{Offset: 3, Limit: 2},
		{Offset: 100, Limit: 1},
	}, 6)
	if len(windows) != 1 || windows[0].start != 1 || windows[0].end != 6 {
		t.Fatalf("windows = %#v", windows)
	}
	empty := normalizeSnaplineWindows([]SnaplineReadWindow{{Offset: 99, Limit: 4}}, 0)
	if len(empty) != 1 || empty[0].start != 1 || empty[0].end != 0 {
		t.Fatalf("empty windows = %#v", empty)
	}
}

func TestNormalizeSnaplineWindowsAvoidsIntegerOverflow(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	windows := normalizeSnaplineWindows([]SnaplineReadWindow{{Offset: maxInt, Limit: maxInt}}, 10)
	if len(windows) != 1 || windows[0].start != 10 || windows[0].end != 10 {
		t.Fatalf("windows = %#v", windows)
	}
}

func TestCollectSnaplineReadContextsUsesCompleteLinesOnly(t *testing.T) {
	longLine := strings.Repeat("界", 20000)
	lines := []string{"alpha", longLine, "omega"}
	contexts, omitted := collectSnaplineReadContexts(lines, []SnaplineReadWindow{{Offset: 1, Limit: 3}})
	if len(contexts) != 1 || !equalSnaplineLines(contexts[0].Lines, []string{"alpha"}) {
		t.Fatalf("contexts = %#v", contexts)
	}
	context := contexts[0]
	if context.Complete || context.NextOffset != 2 || context.TruncatedLine == nil || context.TruncatedLine.Line != 2 || len(context.TruncatedLine.Prefix) > snaplineTruncatedPrefixLimit {
		t.Fatalf("long-line context = %#v", context)
	}
	if len(omitted) != 1 || omitted[0].Start != 2 || omitted[0].End != 3 || omitted[0].Reason != "line_too_long" {
		t.Fatalf("omitted = %#v", omitted)
	}
}

func TestCollectSnaplineReadContextsGlobalLineBudget(t *testing.T) {
	lines := make([]string, snaplineReadLineLimit+10)
	for index := range lines {
		lines[index] = "x"
	}
	contexts, omitted := collectSnaplineReadContexts(lines, []SnaplineReadWindow{{Offset: 1, Limit: len(lines)}})
	if len(contexts) != 1 || len(contexts[0].Lines) != snaplineReadLineLimit || contexts[0].Complete || contexts[0].NextOffset != snaplineReadLineLimit+1 {
		t.Fatalf("context = %#v", contexts[0])
	}
	if len(omitted) != 1 || omitted[0].Reason != "line_limit" {
		t.Fatalf("omitted = %#v", omitted)
	}
}

func TestCollectSnaplineReadContextsContinuesAtDistantWindow(t *testing.T) {
	large := strings.Repeat("x", 30*1024)
	lines := []string{large, large, "not requested", "omega"}
	contexts, omitted := collectSnaplineReadContexts(lines, []SnaplineReadWindow{{Offset: 1, Limit: 2}, {Offset: 4, Limit: 1}})
	if len(contexts) != 2 || len(contexts[0].Lines) != 1 || !equalSnaplineLines(contexts[1].Lines, []string{"omega"}) {
		t.Fatalf("contexts = %#v", contexts)
	}
	if len(omitted) != 1 || omitted[0].Start != 2 || omitted[0].End != 2 || omitted[0].Reason != "byte_budget" {
		t.Fatalf("omitted = %#v", omitted)
	}
}

func TestSnaplineReadContextForRangeReportsBudgetRemainder(t *testing.T) {
	lines := make([]string, snaplineReadLineLimit+10)
	for index := range lines {
		lines[index] = "x"
	}
	contexts, omitted := snaplineReadContextForRange(lines, 1, len(lines))
	if len(contexts) != 1 || contexts[0].Complete || contexts[0].NextOffset != snaplineReadLineLimit+1 {
		t.Fatalf("contexts = %#v", contexts)
	}
	if len(omitted) != 1 || omitted[0].Start != snaplineReadLineLimit+1 || omitted[0].End != len(lines) || omitted[0].Reason != "line_limit" {
		t.Fatalf("omitted = %#v", omitted)
	}
}

func TestCollectSnaplineReadContextsEmptyFile(t *testing.T) {
	contexts, omitted := collectSnaplineReadContexts(nil, []SnaplineReadWindow{{Offset: 1, Limit: 160}})
	if len(omitted) != 0 || len(contexts) != 1 || contexts[0].Start != 1 || contexts[0].End != 0 || !contexts[0].Complete || len(contexts[0].Lines) != 0 {
		t.Fatalf("contexts/omitted = %#v / %#v", contexts, omitted)
	}
}

func TestSupportedSnaplineImageCandidateMatchesNativeFamilies(t *testing.T) {
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0}
	jpegUnsupported := []byte{0xff, 0xd8, 0xff, 0xf7}
	png := make([]byte, 32)
	copy(png, []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	binary.BigEndian.PutUint32(png[8:12], 13)
	copy(png[12:16], "IHDR")
	animatedPNG := make([]byte, 45)
	copy(animatedPNG, png)
	copy(animatedPNG[37:41], "acTL")
	bmp := make([]byte, 64)
	copy(bmp, "BM")
	binary.LittleEndian.PutUint32(bmp[2:6], 64)
	binary.LittleEndian.PutUint32(bmp[10:14], 54)
	binary.LittleEndian.PutUint32(bmp[14:18], 40)
	binary.LittleEndian.PutUint16(bmp[26:28], 1)
	binary.LittleEndian.PutUint16(bmp[28:30], 24)
	for name, test := range map[string]struct {
		content []byte
		want    bool
	}{
		"jpeg":         {jpeg, true},
		"jpeg jpeg-ls": {jpegUnsupported, false},
		"png":          {png, true},
		"animated png": {animatedPNG, false},
		"gif":          {[]byte("GIF89a"), true},
		"webp":         {[]byte("RIFFxxxxWEBP"), true},
		"bmp":          {bmp, true},
		"text":         {[]byte("plain text"), false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := supportedSnaplineImageCandidate(test.content); got != test.want {
				t.Fatalf("candidate = %t, want %t", got, test.want)
			}
		})
	}
}

func TestParseTextFileRejectsNULBeyondPreflight(t *testing.T) {
	content := append([]byte(strings.Repeat("a", 9000)), 0)
	if _, err := parseTextFile(content); err != errBinaryFile {
		t.Fatalf("error = %v", err)
	}
}

func TestSnaplineReadJSONStaysWithinProcessOutputCap(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "escaped.txt")
	content := strings.Repeat(strings.Repeat("\x01", 25)+"\n", snaplineReadLineLimit)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(SnaplineReadRequest{
		ProtocolVersion: 1,
		Path:            path,
		Windows:         []SnaplineReadWindow{{Offset: 1, Limit: snaplineReadLineLimit}},
	})
	output := mainTestRun(t, string(request), "read")
	if len(output) > 1<<20 {
		t.Fatalf("read JSON bytes = %d; process cap is %d", len(output), 1<<20)
	}
	var result SnaplineReadResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || len(result.Contexts) != 1 || len(result.Contexts[0].Lines) != snaplineReadLineLimit {
		t.Fatalf("result = %#v", result)
	}
}
func TestSnaplineReadLogicalFileRejections(t *testing.T) {
	directory := t.TempDir()
	for name, content := range map[string][]byte{
		"image.gif":   []byte("GIF89a"),
		"binary.dat":  {0, 1, 2},
		"invalid.txt": {0xff, 0xfe},
	} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
		request, _ := json.Marshal(SnaplineReadRequest{ProtocolVersion: 1, Path: path, Windows: []SnaplineReadWindow{{Offset: 1, Limit: 1}}})
		output := mainTestRun(t, string(request), "read")
		var failure SnaplineLogicalFailure
		if err := json.Unmarshal([]byte(output), &failure); err != nil {
			t.Fatalf("decode %s result: %v", name, err)
		}
		wantCode := "unsupported_file"
		if strings.HasSuffix(name, ".gif") {
			wantCode = "image_candidate"
		} else if strings.HasPrefix(name, "invalid") {
			wantCode = "invalid_utf8"
		}
		if failure.OK || failure.Code != wantCode || failure.TargetCommitted {
			t.Fatalf("%s failure = %#v", name, failure)
		}
	}
}

func TestSnaplineReadPathRejections(t *testing.T) {
	directory := t.TempDir()
	assertCode := func(name, path, wantCode string) {
		t.Helper()
		request, _ := json.Marshal(SnaplineReadRequest{ProtocolVersion: 1, Path: path, Windows: []SnaplineReadWindow{{Offset: 1, Limit: 1}}})
		output := mainTestRun(t, string(request), "read")
		var failure SnaplineLogicalFailure
		if err := json.Unmarshal([]byte(output), &failure); err != nil {
			t.Fatalf("decode %s result: %v", name, err)
		}
		if failure.OK || failure.Code != wantCode || failure.TargetCommitted {
			t.Fatalf("%s failure = %#v", name, failure)
		}
	}

	missing := filepath.Join(directory, "missing.txt")
	assertCode("missing", missing, "target_not_found")
	assertCode("directory", directory, "target_not_regular")
	dangling := filepath.Join(directory, "dangling.txt")
	if err := os.Symlink(missing, dangling); err == nil {
		assertCode("dangling symlink", dangling, "target_not_found")
	}
}
