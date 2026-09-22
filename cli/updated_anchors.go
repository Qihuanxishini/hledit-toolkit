package main

// 单窗口参数只服务 stale 拒绝时的 currentAnchors 快照。
const updatedAnchorContextRadius = 2
const updatedAnchorMaxLines = 20
const updatedAnchorMaxBytes = 4096

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

func buildUpdatedAnchorContext(lines []string, firstChanged, lastChanged, linesAdded int) *AnchorContext {
	if firstChanged <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return &AnchorContext{
			Lines:        []ReadLine{},
			Offset:       1,
			Limit:        0,
			DesiredLimit: 0,
			Truncated:    false,
		}
	}

	start := firstChanged
	end := lastChanged
	if end <= 0 {
		end = start
	}
	if start > end {
		start, end = end, start
	}
	changedSpan := end - start + 1
	if linesAdded > changedSpan {
		changedSpan = linesAdded
	}
	if changedSpan < 1 {
		changedSpan = 1
	}

	offset := start - updatedAnchorContextRadius
	if offset < 1 {
		offset = 1
	}
	if offset > len(lines) {
		offset = len(lines)
	}
	leadingContextLines := start - offset
	if leadingContextLines < 0 {
		leadingContextLines = 0
	}
	desiredLimit := leadingContextLines + changedSpan + updatedAnchorContextRadius
	limit := desiredLimit
	if limit > updatedAnchorMaxLines {
		limit = updatedAnchorMaxLines
	}
	available := len(lines) - offset + 1
	if limit > available {
		limit = available
	}
	if limit < 0 {
		limit = 0
	}

	readLines, truncatedSourceLine, nextOffset, _ := collectAnnotatedLines(
		lines,
		offset-1,
		limit,
		updatedAnchorMaxBytes,
	)

	return &AnchorContext{
		Lines:        readLines,
		Offset:       offset,
		Limit:        len(readLines),
		DesiredLimit: desiredLimit,
		Truncated:    desiredLimit > updatedAnchorMaxLines || truncatedSourceLine || nextOffset > 0,
	}
}

// buildCurrentAnchorContext returns a bounded span from the same snapshot that rejected a stale edit.
func buildCurrentAnchorContext(lines []string, requestedStart, requestedEnd int) *AnchorContext {
	if requestedStart <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return buildUpdatedAnchorContext(lines, 1, 1, 0)
	}
	if requestedEnd <= 0 {
		requestedEnd = requestedStart
	}
	if requestedStart > requestedEnd {
		requestedStart, requestedEnd = requestedEnd, requestedStart
	}
	if requestedStart > len(lines) {
		requestedStart = len(lines)
	}
	if requestedEnd > len(lines) {
		requestedEnd = len(lines)
	}
	if requestedStart < 1 {
		requestedStart = 1
	}
	if requestedEnd < requestedStart {
		requestedEnd = requestedStart
	}
	return buildUpdatedAnchorContext(lines, requestedStart, requestedEnd, requestedEnd-requestedStart+1)
}
