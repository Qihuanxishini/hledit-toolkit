package main

// [喵喵喵]: OPTIMIZATION-ROADMAP Phase 0 的永久分配基线 benchmark (2026-07-25)。
// 覆盖 10 MiB 编辑路径的当前 materialization 链路，供 Phase 5 收敛前后对比。
// 契约：只报告 allocs（b.ReportAllocs），不设受 Go 版本影响的硬阈值断言；
// B/op 是累计分配，不等于同时驻留内存。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// 10 MiB 基线语料：每行 80 字符 + LF，行首含行号保证逐行 hash 不同。
const benchAllocLineBytes = 81
const benchAllocLineCount = 10 * 1024 * 1024 / benchAllocLineBytes

var (
	benchAllocOnce    sync.Once
	benchAllocContent []byte
	benchAllocFile    LoadedTextFile

	benchSinkFile     LoadedTextFile
	benchSinkPlan     BatchPlan
	benchSinkString   string
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

// benchAllocSingleReplaceRequest 构造带完整 proof 的单行 replace，与插件正常写入路径同形。
func benchAllocSingleReplaceRequest(b *testing.B, file LoadedTextFile) BatchEditRequest {
	b.Helper()
	targetLine := benchAllocLineCount / 2
	tag := formatTag(targetLine, file.Lines[targetLine-1])
	requestJSON := fmt.Sprintf(
		`{"edits":[{"op":"replace","pos":%q,"lines":["replaced line"]}],"proof":{"revision":%q,"anchors":[%q]}}`,
		tag, file.Revision, tag,
	)
	var request BatchEditRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		b.Fatalf("unmarshal benchmark batch request: %v", err)
	}
	return request
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

func BenchmarkPlanBatchEditsSingleReplace10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	request := benchAllocSingleReplaceRequest(b, file)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		plan, failure := planBatchEdits(request, file.Lines, file.Revision)
		if failure != nil {
			b.Fatalf("planBatchEdits failed: %s", failure.Message)
		}
		benchSinkPlan = plan
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

// BenchmarkBatchOutputMaterialization10MiB 复现 runBatchApply 成功路径的输出
// materialization：单次编码，revision 与写入直接消费同一切片（Phase 5 已收敛）。
func BenchmarkBatchOutputMaterialization10MiB(b *testing.B) {
	_, file := benchAllocFixture(b)
	request := benchAllocSingleReplaceRequest(b, file)
	plan, failure := planBatchEdits(request, file.Lines, file.Revision)
	if failure != nil {
		b.Fatalf("planBatchEdits failed: %s", failure.Message)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		encoded := file.EncodeContent(plan.RebuiltLines, rebuiltLineEndings(file, plan.EditDeltas, len(plan.RebuiltLines)))
		benchSinkRevision = rawFileRevision(encoded)
		benchSinkBytes = encoded
	}
}

// BenchmarkPreCommitRevisionRecheck10MiB 复现 atomicWriteIfRevision 提交前的
// 流式 revision 复检（Phase 5 已收敛为 rawFileRevisionFromPath）。
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
