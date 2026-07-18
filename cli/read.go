package main

import (
	"bytes"
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

const lineTruncationSuffix = "… [line truncated]"
const jsonTextTruncationSuffix = "… [truncated]"

// readFileLines reads a file, checks for binary content, and returns logical text lines.
// CRLF files are exposed without trailing carriage returns in line text.
func readFileLines(path string) ([]string, bool) {
	file, err := loadTextFile(path)
	if err == nil {
		return file.Lines, false
	}
	if errors.Is(err, errBinaryFile) {
		emitError("binary", "file appears to be binary")
		return nil, true
	}
	emitError("io", err.Error())
	return nil, true
}

// filterLines returns 1-indexed line numbers of lines matching the pattern.
// If pattern is empty, nil is returned (meaning no filtering).
func filterLines(lines []string, pattern string) []int {
	if pattern == "" {
		return nil
	}
	matches := make([]int, 0)
	for i, line := range lines {
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
	included := make([]bool, total+1) // 1-indexed; index 0 unused
	for _, ln := range matchIdxs {
		start := ln - contextN
		if start < 1 {
			start = 1
		}
		end := ln + contextN
		if end > total {
			end = total
		}
		for i := start; i <= end; i++ {
			included[i] = true
		}
	}
	result := make([]int, 0, len(matchIdxs))
	for i := 1; i <= total; i++ {
		if included[i] {
			result = append(result, i)
		}
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
	overhead := len(tag) + 2 // tag + ':' + '\n'
	remaining := maxBytes - byteCount - overhead
	if remaining < 0 {
		remaining = 0
	}
	text := line
	truncated := false
	if len(text) > remaining {
		if remaining > len(jsonTextTruncationSuffix) {
			text = utf8PrefixByBytes(text, remaining-len(jsonTextTruncationSuffix)) + jsonTextTruncationSuffix
		} else {
			text = utf8PrefixByBytes(text, remaining)
		}
		truncated = true
	}
	byteCount += overhead + len(text)
	return append(result, ReadLine{Line: lineNum, Anchor: tag, Text: text, TextTruncated: truncated}), byteCount, truncated
}

// collectAnnotatedLines gathers lines into ReadLine structs with truncation metadata.
func collectAnnotatedLines(lines []string, startIdx, maxLines, maxBytes int) ([]ReadLine, bool, int) {
	result := make([]ReadLine, 0)
	byteCount := 0
	for i := startIdx; i < len(lines) && len(result) < maxLines && byteCount < maxBytes; i++ {
		lineNum := i + 1
		var textTruncated bool
		result, byteCount, textTruncated = appendJSONReadLine(result, byteCount, lineNum, lines[i], maxBytes)
		if textTruncated {
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
		var textTruncated bool
		result, byteCount, textTruncated = appendJSONReadLine(result, byteCount, ln, lines[ln-1], maxBytes)
		if textTruncated {
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

func cmdRead(path, grep string, contextN int, jsonOut bool) error {
	return cmdReadPretty(path, grep, contextN, jsonOut, false)
}

func cmdReadPretty(path, grep string, contextN int, jsonOut bool, pretty bool) error {
	lines, errored := readFileLines(path)
	if errored {
		return nil
	}

	matchIdxs := filterLines(lines, grep)

	if jsonOut {
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, 1, 2000, readOutputMaxBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, 0, 2000, readOutputMaxBytes)
		}
		return emitJSON(ReadResult{OK: true, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
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

func cmdAnchors(path string, offset, limit int, grep string, contextN int, jsonOut bool) error {
	return cmdAnchorsPretty(path, offset, limit, grep, contextN, jsonOut, false)
}

func cmdAnchorsPretty(path string, offset, limit int, grep string, contextN int, jsonOut bool, pretty bool) error {
	lines, errored := readFileLines(path)
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

	matchIdxs := filterLines(lines, grep)

	if jsonOut {
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, offset, maxLines, readOutputMaxBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, offset-1, maxLines, readOutputMaxBytes)
		}
		return emitJSON(ReadResult{OK: true, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
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

func cmdReadRange(path string, offset, limit int, grep string, contextN int, jsonOut bool) error {
	return cmdReadRangePretty(path, offset, limit, grep, contextN, jsonOut, false)
}

func cmdReadRangePretty(path string, offset, limit int, grep string, contextN int, jsonOut bool, pretty bool) error {
	lines, errored := readFileLines(path)
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

	matchIdxs := filterLines(lines, grep)

	if jsonOut {
		var readLines []ReadLine
		var truncated bool
		var nextOffset int
		if matchIdxs != nil {
			matchIdxs = applyContext(lines, matchIdxs, contextN)
			readLines, truncated, nextOffset = collectMatchLines(lines, matchIdxs, offset, maxLines, readOutputMaxBytes)
		} else {
			readLines, truncated, nextOffset = collectAnnotatedLines(lines, offset-1, maxLines, readOutputMaxBytes)
		}
		return emitJSON(ReadResult{OK: true, TotalLines: len(lines), Lines: readLines, Truncated: truncated, NextOffset: nextOffset})
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
