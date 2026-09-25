package main

// stale 拒绝时 currentAnchors 快照的上下文半径与预算。
const currentAnchorContextRadius = 2
const currentAnchorMaxLines = 20
const currentAnchorMaxBytes = 4096

// 成功 batch 的产出 span共享一份预算。这里的行是模型刚写入、没有任何旧锚点可用的行，
// 因此不带上下文；预算决定单次 apply 结果最多回灌多少行到模型上下文。
const updatedAnchorSpansMaxLines = 80
const updatedAnchorSpansMaxBytes = 16 * 1024

// buildUpdatedAnchorSpans 按物理顺序为每个产出了行的编辑返回一个 span，span 精确覆盖
// 该编辑在新坐标下的产出区间；纯删除不产生 span。预算耗尽后仍为剩余编辑输出空 span并标记
// Truncated，让调用方能逐项核对 span 与 editDeltas 一一对应。
func buildUpdatedAnchorSpans(lines []string, deltas []EditDelta) []AnchorContext {
	spans := make([]AnchorContext, 0, len(deltas))
	remainingLines := updatedAnchorSpansMaxLines
	remainingBytes := updatedAnchorSpansMaxBytes
	shift := 0
	for _, delta := range deltas {
		start := delta.OldStart + shift
		produced := delta.OldEnd - delta.OldStart + 1 + delta.Delta
		shift += delta.Delta
		if produced <= 0 {
			continue
		}
		limit := produced
		if limit > remainingLines {
			limit = remainingLines
		}
		readLines := []ReadLine{}
		truncatedSourceLine := false
		if limit > 0 && remainingBytes > 0 && start-1 < len(lines) {
			var usedBytes int
			readLines, truncatedSourceLine, _, usedBytes = collectAnnotatedLines(lines, start-1, limit, remainingBytes)
			remainingLines -= len(readLines)
			remainingBytes -= usedBytes
		}
		spans = append(spans, AnchorContext{
			Lines:        readLines,
			Offset:       start,
			Limit:        len(readLines),
			DesiredLimit: produced,
			Truncated:    len(readLines) < produced || truncatedSourceLine,
		})
	}
	return spans
}

// buildCurrentAnchorContext 从拒绝 stale 编辑的同一快照返回请求区间及前后
// currentAnchorContextRadius 行上下文，受行数与字节预算约束。
func buildCurrentAnchorContext(lines []string, requestedStart, requestedEnd int) *AnchorContext {
	if requestedStart <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return &AnchorContext{Lines: []ReadLine{}, Offset: 1}
	}
	if requestedEnd <= 0 {
		requestedEnd = requestedStart
	}
	if requestedStart > requestedEnd {
		requestedStart, requestedEnd = requestedEnd, requestedStart
	}
	start := min(requestedStart, len(lines))
	end := min(requestedEnd, len(lines))

	offset := max(start-currentAnchorContextRadius, 1)
	desiredLimit := (start - offset) + (end - start + 1) + currentAnchorContextRadius
	limit := min(desiredLimit, currentAnchorMaxLines, len(lines)-offset+1)
	readLines, truncatedSourceLine, _, _ := collectAnnotatedLines(lines, offset-1, limit, currentAnchorMaxBytes)
	return &AnchorContext{
		Lines:        readLines,
		Offset:       offset,
		Limit:        len(readLines),
		DesiredLimit: desiredLimit,
		// [喵喵喵]: 只有窗口本身被行数/字节预算截短才算不完整；文件在窗口后还有内容不算，
		// 否则文件中部的 stale 快照永远标记 truncated，插件无法把它记为 proof。(2026-09-24)
		Truncated: desiredLimit > currentAnchorMaxLines || truncatedSourceLine || len(readLines) < limit,
	}
}
