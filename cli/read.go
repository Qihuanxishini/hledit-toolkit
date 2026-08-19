package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

func emitError(errType, message string) error {
	return emitJSON(EditError{
		OK:      false,
		Error:   errType,
		Message: message,
	})
}

func emitReadRangeError(offset, totalLines int) error {
	return emitJSON(ReadRangeError{
		OK:              false,
		Error:           "range",
		Message:         fmt.Sprintf("offset %d exceeds file length %d", offset, totalLines),
		RequestedOffset: offset,
		TotalLines:      totalLines,
	})
}

const readOutputMaxBytes = 50 * 1024

func jsonValueSize(value any) int {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	// [喵喵喵]: 与 emitJSON 保持相同的转义设置，并扣除 Encode 追加的换行。
	return encoded.Len() - 1
}

func jsonReadLineSize(line ReadLine) int {
	return jsonValueSize(line)
}

func readJSONLineBudget(revision string, totalLines, maxBytes int) int {
	// [喵喵喵]: 先预留完整结果壳，避免 lines 数组安全但最终 JSON 超过预算。
	empty := ReadResult{
		OK: true, Revision: revision, TotalLines: totalLines,
		Lines: []ReadLine{}, Truncated: true, NextOffset: totalLines + 1,
	}
	// [喵喵喵]: byteCount 只统计 lines 数组内容；结果壳已包含 []，emitJSON 还会追加一个换行。
	budget := maxBytes - jsonValueSize(empty) - 1
	if budget < 0 {
		return 0
	}
	return budget
}

const lineTruncationSuffix = "… [line truncated]"
const jsonTextTruncationSuffix = "… [truncated]"

// readCommandFile loads one validated text snapshot for read output and revision metadata.
func readCommandFile(path string) (LoadedTextFile, bool) {
	file, err := loadTextFile(path)
	if err == nil {
		return file, false
	}
	if errors.Is(err, errBinaryFile) {
		emitError("binary", "file appears to be binary")
		return LoadedTextFile{}, true
	}
	if errors.Is(err, errInvalidUTF8) {
		emitError("encoding", "file is not valid UTF-8")
		return LoadedTextFile{}, true
	}
	emitError("io", err.Error())
	return LoadedTextFile{}, true
}

// readFileLines preserves the line-only boundary used by focused read error tests.
func readFileLines(path string) ([]string, bool) {
	file, errored := readCommandFile(path)
	return file.Lines, errored
}

// filterLines returns 1-indexed line numbers of lines matching the pattern.
// If pattern is empty, nil is returned (meaning no filtering).
func filterLines(lines []string, pattern string, ignoreCase bool) []int {
	if pattern == "" {
		return nil
	}
	if ignoreCase {
		pattern = strings.ToLower(pattern)
	}
	matches := make([]int, 0)
	for i, line := range lines {
		if ignoreCase {
			line = strings.ToLower(line)
		}
		if strings.Contains(line, pattern) {
			matches = append(matches, i+1) // 1-indexed
		}
	}
	return matches
}

// applyContext expands matchIdxs by including up to contextN lines before and
// after each match. Overlapping windows are merged. Returns a sorted,
// deduplicated slice of 1-indexed line numbers. If contextN <= 0 or matchIdxs
// is empty the original slice is returned unchanged.
func applyContext(lines []string, matchIdxs []int, contextN int) []int {
	if contextN <= 0 || len(matchIdxs) == 0 {
		return matchIdxs
	}

	total := len(lines)
	// [喵喵喵]: context 来自 CLI 数值参数，先压到文件长度以避免 ln+contextN 整数溢出。
	if contextN > total {
		contextN = total
	}
	result := make([]int, 0, len(matchIdxs))
	start := 0
	end := 0
	for _, ln := range matchIdxs {
		windowStart := ln - contextN
		if windowStart < 1 {
			windowStart = 1
		}
		windowEnd := ln + contextN
		if windowEnd > total {
			windowEnd = total
		}
		if start == 0 {
			start, end = windowStart, windowEnd
			continue
		}
		if windowStart <= end {
			if windowEnd > end {
				end = windowEnd
			}
			continue
		}
		for line := start; line <= end; line++ {
			result = append(result, line)
		}
		start, end = windowStart, windowEnd
	}
	for line := start; line <= end; line++ {
		result = append(result, line)
	}
	return result
}

// emitAnnotatedLines writes LN#HASH:content lines to a buffer with truncation.
// Returns the number of content lines emitted.
func utf8PrefixByBytes(text string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(text) <= maxBytes {
		return text
	}
	prefix := text[:maxBytes]
	for !utf8.ValidString(prefix) && len(prefix) > 0 {
		prefix = prefix[:len(prefix)-1]
	}
	return prefix
}

func appendLimitedString(buf *bytes.Buffer, text string, maxBytes int) (int, bool) {
	remaining := maxBytes - buf.Len()
	if remaining <= 0 {
		return 0, false
	}
	if len(text) <= remaining {
		buf.WriteString(text)
		return len(text), true
	}
	prefix := utf8PrefixByBytes(text, remaining)
	buf.WriteString(prefix)
	return len(prefix), false
}

func appendLimitedNotice(buf *bytes.Buffer, notice string, maxBytes int, pretty bool) {
	if pretty {
		notice = formatPrettyNotice(notice)
	}
	appendLimitedString(buf, notice+"\n", maxBytes)
}

func appendLimitedLine(buf *bytes.Buffer, line string, maxBytes int) (int, bool) {
	remaining := maxBytes - buf.Len()
	if remaining <= 0 {
		return 0, false
	}
	if len(line) <= remaining {
		buf.WriteString(line)
		return len(line), true
	}

	suffix := lineTruncationSuffix
	if strings.HasSuffix(line, "\n") {
		suffix += "\n"
		line = strings.TrimSuffix(line, "\n")
	}
	if remaining <= len(suffix) {
		prefix := utf8PrefixByBytes(line, remaining)
		buf.WriteString(prefix)
		return len(prefix), false
	}

	prefix := utf8PrefixByBytes(line, remaining-len(suffix))
	buf.WriteString(prefix + suffix)
	return len(prefix) + len(suffix), false
}

// emitAnnotatedLines writes LN#HASH:content lines to a buffer with strict byte truncation.
// Returns the number of content lines emitted.
func emitAnnotatedLines(buf *bytes.Buffer, lines []string, startIdx, maxLines, maxBytes int, pretty bool) int {
	emittedCount := 0
	usePretty := prettyEnabled(pretty)
	for i := startIdx; i < len(lines) && emittedCount < maxLines && buf.Len() < maxBytes; i++ {
		lineNum := i + 1
		line := lines[i]
		lineStr := formatPlainReadLine(lineNum, line) + "\n"
		if usePretty {
			lineStr = formatPrettyReadLine(lineNum, line) + "\n"
		}
		if i < len(lines)-1 && emittedCount > 0 {
			notice := fmt.Sprintf("-- truncated: use read-range --offset %d --", i+1)
			if usePretty {
				notice = formatPrettyNotice(notice)
			}
			if buf.Len()+len(lineStr)+len(notice)+1 > maxBytes {
				appendLimitedString(buf, notice+"\n", maxBytes)
				break
			}
		}

		written, full := appendLimitedLine(buf, lineStr, maxBytes)
		if written > 0 {
			emittedCount++
		}
		if !full {
			break
		}

		if emittedCount >= maxLines && i < len(lines)-1 {
			appendLimitedNotice(buf, fmt.Sprintf("-- truncated: use read-range --offset %d --", i+2), maxBytes, usePretty)
			break
		}
	}
	return emittedCount
}

func appendJSONReadLine(result []ReadLine, byteCount int, lineNum int, line string, maxBytes int) ([]ReadLine, int, bool) {
	tag := formatTag(lineNum, line)
	separatorBytes := 0
	if len(result) > 0 {
		separatorBytes = 1
	}
	available := maxBytes - byteCount - separatorBytes
	if available <= 0 {
		return result, byteCount, true
	}

	// [喵喵喵]: 编码后的 JSON 文本不会短于原始 UTF-8 文本；超预算的长行无需先完整序列化。
	if len(line) <= available {
		full := ReadLine{Line: lineNum, Anchor: tag, Text: line}
		if size := jsonReadLineSize(full); size <= available {
			return append(result, full), byteCount + separatorBytes + size, false
		}
	}

	truncatedText := jsonTextTruncationSuffix
	withSuffix := func(text string) ReadLine {
		return ReadLine{Line: lineNum, Anchor: tag, Text: text + truncatedText, TextTruncated: true}
	}
	withoutSuffix := func(text string) ReadLine {
		return ReadLine{Line: lineNum, Anchor: tag, Text: text, TextTruncated: true}
	}
	maxPrefixBytes := len(line)
	if maxPrefixBytes > available {
		maxPrefixBytes = available
	}
	candidate := withSuffix("")
	if jsonReadLineSize(candidate) <= available {
		low, high := 0, maxPrefixBytes
		best := candidate
		for low <= high {
			middle := low + (high-low)/2
			candidateText := utf8PrefixByBytes(line, middle)
			candidate = withSuffix(candidateText)
			if jsonReadLineSize(candidate) <= available {
				best = candidate
				low = middle + 1
			} else {
				high = middle - 1
			}
		}
		itemBytes := jsonReadLineSize(best)
		return append(result, best), byteCount + separatorBytes + itemBytes, true
	}

	low, high := 0, maxPrefixBytes
	var best ReadLine
	bestSize := 0
	for low <= high {
		middle := low + (high-low)/2
		candidate = withoutSuffix(utf8PrefixByBytes(line, middle))
		if size := jsonReadLineSize(candidate); size <= available {
			best, bestSize = candidate, size
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	if bestSize == 0 {
		return result, byteCount, true
	}
	return append(result, best), byteCount + separatorBytes + bestSize, true
}

// collectAnnotatedLines gathers lines into ReadLine structs with truncation metadata.
func collectAnnotatedLines(lines []string, startIdx, maxLines, maxBytes int) ([]ReadLine, bool, int) {
	result := make([]ReadLine, 0)
	byteCount := 0
	for i := startIdx; i < len(lines) && len(result) < maxLines && byteCount < maxBytes; i++ {
		lineNum := i + 1
		previousCount := len(result)
		var textTruncated bool
		result, byteCount, textTruncated = appendJSONReadLine(result, byteCount, lineNum, lines[i], maxBytes)
		if textTruncated {
			if len(result) == previousCount {
				return result, true, lineNum
			}
			return result, true, 0
		}
		if byteCount >= maxBytes || len(result) >= maxLines {
			if i < len(lines)-1 {
				return result, true, i + 2
			}
			break
		}
	}
	return result, false, 0
}

// collectMatchLines gathers matching lines into ReadLine structs with truncation metadata.
// matchIdxs are 1-indexed line numbers into lines.
func collectMatchLines(lines []string, matchIdxs []int, offset, maxLines, maxBytes int) ([]ReadLine, bool, int) {
	startIdx := len(matchIdxs)
	for i, ln := range matchIdxs {
		if ln >= offset {
			startIdx = i
			break
		}
	}
	result := make([]ReadLine, 0)
	byteCount := 0
	for i := startIdx; i < len(matchIdxs) && len(result) < maxLines && byteCount < maxBytes; i++ {
		ln := matchIdxs[i]
		previousCount := len(result)
		var textTruncated bool
		result, byteCount, textTruncated = appendJSONReadLine(result, byteCount, ln, lines[ln-1], maxBytes)
		if textTruncated {
			if len(result) == previousCount {
				return result, true, ln
			}
			return result, true, 0
		}
		if byteCount >= maxBytes {
			if i < len(matchIdxs)-1 {
				return result, true, ln + 1
			}
			return result, false, 0
		}
	}
	remaining := len(matchIdxs) - startIdx - len(result)
	if remaining > 0 && len(result) > 0 {
		lastLn := matchIdxs[startIdx+len(result)-1]
		return result, true, lastLn + 1
	}
	return result, false, 0
}

// emitMatchLines writes only matching LN#HASH:content lines with pagination info.
// matchIdxs are 1-indexed line numbers into lines.
func emitMatchLines(buf *bytes.Buffer, lines []string, matchIdxs []int, offset, maxLines, maxBytes int, pretty bool) {
	startIdx := len(matchIdxs)
	for i, ln := range matchIdxs {
		if ln >= offset {
			startIdx = i
			break
		}
	}

	usePretty := prettyEnabled(pretty)
	count := 0
	lastLn := 0
	for i := startIdx; i < len(matchIdxs) && count < maxLines && buf.Len() < maxBytes; i++ {
		ln := matchIdxs[i]
		line := lines[ln-1]
		lineStr := formatPlainReadLine(ln, line) + "\n"
		if usePretty {
			lineStr = formatPrettyReadLine(ln, line) + "\n"
		}
		if i < len(matchIdxs)-1 && count > 0 {
			notice := fmt.Sprintf("-- %d more matches, use offset %d --", len(matchIdxs)-i, ln)
			if usePretty {
				notice = formatPrettyNotice(notice)
			}
			if buf.Len()+len(lineStr)+len(notice)+1 > maxBytes {
				appendLimitedString(buf, notice+"\n", maxBytes)
				break
			}
		}

		written, full := appendLimitedLine(buf, lineStr, maxBytes)
		if written > 0 {
			count++
			lastLn = ln
		}
		if !full {
			break
		}
	}

	remaining := len(matchIdxs) - startIdx - count
	if remaining > 0 && lastLn > 0 {
		appendLimitedNotice(buf, fmt.Sprintf("-- %d more matches, use offset %d --", remaining, lastLn+1), maxBytes, usePretty)
	}
}

func cmdReadPretty(path, grep string, contextN int, ignoreCase bool, jsonOut bool, pretty bool) error {
	file, errored := readCommandFile(path)
	lines := file.Lines
	if errored {
		return nil
	}

	matchIdxs := filterLines(lines, grep, ignoreCase)

	if jsonOut {
		jsonLineBytes := readJSONLineBudget(file.Revision, len(lines), readOutputMaxBytes)
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, 1, 2000, jsonLineBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, 0, 2000, jsonLineBytes)
		}
		return emitJSON(ReadResult{OK: true, Revision: file.Revision, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
	}

	var buf bytes.Buffer
	if matchIdxs != nil {
		matchIdxs = applyContext(lines, matchIdxs, contextN)
		emitMatchLines(&buf, lines, matchIdxs, 1, 2000, readOutputMaxBytes, pretty)
	} else {
		emitAnnotatedLines(&buf, lines, 0, 2000, readOutputMaxBytes, pretty)
	}
	fmt.Print(buf.String())
	return nil
}

// emitAnchorLines writes ANCHOR\tTEXT lines (completion-friendly) with truncation.
func emitAnchorLines(buf *bytes.Buffer, lines []string, startIdx, maxLines, maxBytes int, pretty bool) {
	emittedCount := 0
	usePretty := prettyEnabled(pretty)
	for i := startIdx; i < len(lines) && emittedCount < maxLines && buf.Len() < maxBytes; i++ {
		lineNum := i + 1
		line := lines[i]
		lineStr := formatPlainAnchorLine(lineNum, line) + "\n"
		if usePretty {
			lineStr = formatPrettyAnchorLine(lineNum, line) + "\n"
		}
		if i < len(lines)-1 && emittedCount > 0 {
			notice := fmt.Sprintf("-- truncated: use anchors --offset %d --", i+1)
			if usePretty {
				notice = formatPrettyNotice(notice)
			}
			if buf.Len()+len(lineStr)+len(notice)+1 > maxBytes {
				appendLimitedString(buf, notice+"\n", maxBytes)
				break
			}
		}

		written, full := appendLimitedLine(buf, lineStr, maxBytes)
		if written > 0 {
			emittedCount++
		}
		if !full {
			break
		}

		if emittedCount >= maxLines && i < len(lines)-1 {
			appendLimitedNotice(buf, fmt.Sprintf("-- truncated: use anchors --offset %d --", i+2), maxBytes, usePretty)
			break
		}
	}
}

// emitAnchorMatchLines writes matching ANCHOR\tTEXT lines with pagination notice.
func emitAnchorMatchLines(buf *bytes.Buffer, lines []string, matchIdxs []int, offset, maxLines, maxBytes int, pretty bool) {
	startIdx := len(matchIdxs)
	for i, ln := range matchIdxs {
		if ln >= offset {
			startIdx = i
			break
		}
	}

	usePretty := prettyEnabled(pretty)
	count := 0
	lastLn := 0
	for i := startIdx; i < len(matchIdxs) && count < maxLines && buf.Len() < maxBytes; i++ {
		ln := matchIdxs[i]
		line := lines[ln-1]
		lineStr := formatPlainAnchorLine(ln, line) + "\n"
		if usePretty {
			lineStr = formatPrettyAnchorLine(ln, line) + "\n"
		}
		if i < len(matchIdxs)-1 && count > 0 {
			notice := fmt.Sprintf("-- %d more matches, use offset %d --", len(matchIdxs)-i, ln)
			if usePretty {
				notice = formatPrettyNotice(notice)
			}
			if buf.Len()+len(lineStr)+len(notice)+1 > maxBytes {
				appendLimitedString(buf, notice+"\n", maxBytes)
				break
			}
		}

		written, full := appendLimitedLine(buf, lineStr, maxBytes)
		if written > 0 {
			count++
			lastLn = ln
		}
		if !full {
			break
		}
	}

	remaining := len(matchIdxs) - startIdx - count
	if remaining > 0 && lastLn > 0 {
		appendLimitedNotice(buf, fmt.Sprintf("-- %d more matches, use offset %d --", remaining, lastLn+1), maxBytes, usePretty)
	}
}

func cmdAnchorsPretty(path string, offset, limit int, grep string, contextN int, ignoreCase bool, jsonOut bool, pretty bool) error {
	file, errored := readCommandFile(path)
	lines := file.Lines
	if errored {
		return nil
	}

	if offset < 1 {
		offset = 1
	}
	if offset > len(lines) {
		return emitReadRangeError(offset, len(lines))
	}

	maxLines := limit
	if maxLines <= 0 {
		maxLines = 2000
	}

	matchIdxs := filterLines(lines, grep, ignoreCase)

	if jsonOut {
		jsonLineBytes := readJSONLineBudget(file.Revision, len(lines), readOutputMaxBytes)
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, offset, maxLines, jsonLineBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, offset-1, maxLines, jsonLineBytes)
		}
		return emitJSON(ReadResult{OK: true, Revision: file.Revision, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
	}

	var buf bytes.Buffer
	if matchIdxs != nil {
		matchIdxs = applyContext(lines, matchIdxs, contextN)
		emitAnchorMatchLines(&buf, lines, matchIdxs, offset, maxLines, readOutputMaxBytes, pretty)
	} else {
		emitAnchorLines(&buf, lines, offset-1, maxLines, readOutputMaxBytes, pretty)
	}

	fmt.Print(buf.String())
	return nil
}

func cmdReadRangePretty(path string, offset, limit int, grep string, contextN int, ignoreCase bool, jsonOut bool, pretty bool) error {
	file, errored := readCommandFile(path)
	lines := file.Lines
	if errored {
		return nil
	}

	if offset < 1 {
		offset = 1
	}
	if offset > len(lines) {
		return emitReadRangeError(offset, len(lines))
	}

	maxLines := limit
	if maxLines <= 0 {
		maxLines = 2000
	}

	matchIdxs := filterLines(lines, grep, ignoreCase)

	if jsonOut {
		jsonLineBytes := readJSONLineBudget(file.Revision, len(lines), readOutputMaxBytes)
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, offset, maxLines, jsonLineBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, offset-1, maxLines, jsonLineBytes)
		}
		return emitJSON(ReadResult{OK: true, Revision: file.Revision, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
	}

	var buf bytes.Buffer
	if matchIdxs != nil {
		matchIdxs = applyContext(lines, matchIdxs, contextN)
		emitMatchLines(&buf, lines, matchIdxs, offset, maxLines, readOutputMaxBytes, pretty)
	} else {
		emitAnnotatedLines(&buf, lines, offset-1, maxLines, readOutputMaxBytes, pretty)
	}

	fmt.Print(buf.String())
	return nil
}
