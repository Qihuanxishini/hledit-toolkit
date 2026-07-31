package main

// [喵喵喵]: 10 MiB Snapline 编辑路径的永久分配基线 benchmark (2026-07-31)。
// 契约：只报告 allocs，不设置受 Go 版本影响的硬阈值；B/op 是累计分配。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const benchAllocLineBytes = 81
const benchAllocLineCount = 10 * 1024 * 1024 / benchAllocLineBytes

var (
	benchAllocOnce    sync.Once
	benchAllocContent []byte
	benchAllocFile    LoadedTextFile

	benchSinkFile     LoadedTextFile
	benchSinkChanges  []plannedSnaplineChange
	benchSinkBytes    []byte
	benchSinkRevision string
)

func benchAllocFixture(b *testing.B) ([]byte, LoadedTextFile) {
	b.Helper()
	benchAllocOnce.Do(func() {
		filler := strings.Repeat("x", 71)
		var builder strings.Builder
		builder.Grow(benchAllocLineCount * benchAllocLineBytes)
		for i := 1; i <= benchAllocLineCount; i++ {
			fmt.Fprintf(&builder, "%08d:%s\n", i, filler)
		}
		benchAllocContent = []byte(builder.String())
		file, err := parseTextFile(benchAllocContent)
		if err != nil {
			panic(err)
		}
		benchAllocFile = file
	})
	return benchAllocContent, benchAllocFile
}

func benchAllocSingleReplaceRequest(file LoadedTextFile) SnaplineApplyRequest {
	targetLine := benchAllocLineCount / 2
	return SnaplineApplyRequest{
		ProtocolVersion:  snaplineProtocolVersion,
		ExpectedRevision: file.Revision,
		Proof:            []SnaplineProofRange{{Start: targetLine, Lines: []string{file.Lines[targetLine-1]}}},
		Replacements:     []SnaplineReplacement{{Start: targetLine, End: targetLine, Text: "replaced line"}},
		Deletions:        []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{},
	}
}

func BenchmarkParseTextFile10MiB(b *testing.B) {
	content, _ := benchAllocFixture(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		file, err := parseTextFile(content)
		if err != nil {
			b.Fatal(err)
		}
		benchSinkFile = file
	}
}

func BenchmarkPlanSnaplineSingleReplace10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	request := benchAllocSingleReplaceRequest(file)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		changes, failure := planSnaplineChanges(request, file)
		if failure != nil {
			b.Fatalf("planSnaplineChanges failed: %s", failure.Message)
		}
		benchSinkChanges = changes
	}
}

func BenchmarkEncodeContent10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchSinkBytes = file.EncodeContent(file.Lines, file.LineEndings)
	}
}

func BenchmarkEncodeContentWithRevision10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		encoded := file.EncodeContent(file.Lines, file.LineEndings)
		benchSinkRevision = rawFileRevision(encoded)
	}
}

func BenchmarkSnaplineOutputMaterialization10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	request := benchAllocSingleReplaceRequest(file)
	changes, failure := planSnaplineChanges(request, file)
	if failure != nil {
		b.Fatalf("planSnaplineChanges failed: %s", failure.Message)
	}
	effective := effectiveSnaplineChanges(changes)
	stats := buildSnaplineStats(changes, effective, len(file.Lines))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rebuilt := rebuildSnaplineLines(file.Lines, effective, stats.NewLineCount)
		encoded := file.EncodeContent(rebuilt, rebuildLineEndings(file, snaplineLineSplices(effective), len(rebuilt)))
		benchSinkRevision = rawFileRevision(encoded)
		benchSinkBytes = encoded
	}
}

func BenchmarkPreCommitRevisionRecheck10MiB(b *testing.B) {
	content, _ := benchAllocFixture(b)
	path := filepath.Join(b.TempDir(), "recheck-target.txt")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		revision, err := rawFileRevisionFromPath(path)
		if err != nil {
			b.Fatal(err)
		}
		benchSinkRevision = revision
	}
}
