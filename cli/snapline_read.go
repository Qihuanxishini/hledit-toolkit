package main

import (
	"sort"
	"unicode/utf8"
)

const (
	snaplineReadLineLimit        = 2000
	snaplineReadContentByteLimit = 50 * 1024
	snaplineTruncatedPrefixLimit = 4096
)

type normalizedSnaplineWindow struct {
	start int
	end   int
}

func runSnaplineRead() error {
	input, failure, err := readBoundedStdin(snaplineReadInputLimit)
	if err != nil {
		return err
	}
	if failure != nil {
		return emitWireJSON(failure)
	}
	request, failure := parseSnaplineReadRequest(input)
	if failure != nil {
		return emitWireJSON(failure)
	}
	target, failure := readSnaplineTarget(request.Path)
	if failure != nil {
		return emitWireJSON(failure)
	}
	contexts, omitted := collectSnaplineReadContexts(target.File.Lines, request.Windows)
	return emitWireJSON(SnaplineReadResult{
		OK:              true,
		ProtocolVersion: snaplineProtocolVersion,
		Path:            target.CanonicalPath,
		Revision:        target.File.Revision,
		TotalLines:      len(target.File.Lines),
		BOM:             target.File.HasUTF8BOM,
		Contexts:        contexts,
		OmittedRanges:   omitted,
	})
}

func normalizeSnaplineWindows(windows []SnaplineReadWindow, totalLines int) []normalizedSnaplineWindow {
	normalized := make([]normalizedSnaplineWindow, 0, len(windows))
	for _, window := range windows {
		if totalLines == 0 {
			normalized = append(normalized, normalizedSnaplineWindow{start: 1, end: 0})
			continue
		}
		start := window.Offset
		end := totalLines
		if window.Offset > totalLines {
			start = totalLines
		} else {
			remaining := totalLines - window.Offset + 1
			if window.Limit < remaining {
				end = window.Offset + window.Limit - 1
			}
		}
		normalized = append(normalized, normalizedSnaplineWindow{start: start, end: end})
	}
	sort.Slice(normalized, func(i, j int) bool {
		if normalized[i].start != normalized[j].start {
			return normalized[i].start < normalized[j].start
		}
		return normalized[i].end < normalized[j].end
	})
	merged := make([]normalizedSnaplineWindow, 0, len(normalized))
	for _, window := range normalized {
		if len(merged) == 0 {
			merged = append(merged, window)
			continue
		}
		last := &merged[len(merged)-1]
		overlaps := window.start <= last.end
		adjacent := !overlaps && window.start-last.end == 1
		if overlaps || adjacent || last.end < last.start {
			if window.end > last.end {
				last.end = window.end
			}
			continue
		}
		merged = append(merged, window)
	}
	return merged
}

func collectSnaplineReadContexts(lines []string, requested []SnaplineReadWindow) ([]SnaplineReadContext, []SnaplineOmittedRange) {
	windows := normalizeSnaplineWindows(requested, len(lines))
	contexts := make([]SnaplineReadContext, 0, len(windows))
	omitted := make([]SnaplineOmittedRange, 0)
	remainingLines := snaplineReadLineLimit
	remainingBytes := snaplineReadContentByteLimit

	for _, window := range windows {
		limit := 0
		if window.end >= window.start {
			limit = window.end - window.start + 1
		}
		context := SnaplineReadContext{
			Offset:     window.start,
			Limit:      limit,
			Start:      window.start,
			End:        window.start - 1,
			Complete:   true,
			NextOffset: window.end + 1,
			Lines:      []string{},
		}
		if len(lines) == 0 {
			context.Offset = 1
			context.Start = 1
			context.End = 0
			context.NextOffset = 1
			contexts = append(contexts, context)
			continue
		}

		for lineNumber := window.start; lineNumber <= window.end; lineNumber++ {
			if remainingLines == 0 {
				context.Complete = false
				context.NextOffset = lineNumber
				omitted = append(omitted, SnaplineOmittedRange{Start: lineNumber, End: window.end, Reason: "line_limit"})
				break
			}
			line := lines[lineNumber-1]
			if len(line) > remainingBytes {
				reason := "byte_budget"
				if len(line) > snaplineReadContentByteLimit {
					reason = "line_too_long"
				}
				prefixBudget := remainingBytes
				if prefixBudget > snaplineTruncatedPrefixLimit {
					prefixBudget = snaplineTruncatedPrefixLimit
				}
				prefix := snaplineUTF8PrefixByBytes(line, prefixBudget)
				remainingBytes -= len(prefix)
				context.TruncatedLine = &SnaplineTruncatedLine{
					Line:              lineNumber,
					Prefix:            prefix,
					OriginalUTF8Bytes: len(line),
				}
				context.Complete = false
				context.NextOffset = lineNumber
				omitted = append(omitted, SnaplineOmittedRange{Start: lineNumber, End: window.end, Reason: reason})
				break
			}
			context.Lines = append(context.Lines, line)
			context.End = lineNumber
			remainingLines--
			remainingBytes -= len(line)
		}
		contexts = append(contexts, context)
	}
	return contexts, omitted
}

func snaplineReadContextForRange(lines []string, start, end int) ([]SnaplineReadContext, []SnaplineOmittedRange) {
	if len(lines) == 0 {
		return collectSnaplineReadContexts(lines, []SnaplineReadWindow{{Offset: 1, Limit: 1}})
	}
	if start < 1 {
		start = 1
	}
	if start > len(lines) {
		start = len(lines)
	}
	if end < start {
		end = start
	}
	if end > len(lines) {
		end = len(lines)
	}
	return collectSnaplineReadContexts(lines, []SnaplineReadWindow{{Offset: start, Limit: end - start + 1}})
}

func attachSnaplineCurrentContext(failure *SnaplineLogicalFailure, file LoadedTextFile, start, end int) {
	failure.CurrentRevision = file.Revision
	failure.RequiredRanges = []SnaplineSourceRange{{Start: start, End: end}}
	failure.Contexts, failure.OmittedRanges = snaplineReadContextForRange(file.Lines, start, end)
}

func snaplineUTF8PrefixByBytes(text string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(text) <= maxBytes {
		return text
	}
	prefix := text[:maxBytes]
	for !utf8.ValidString(prefix) {
		prefix = prefix[:len(prefix)-1]
	}
	return prefix
}
