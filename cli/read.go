package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"regexp/syntax"
	"unicode/utf8"
)

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

const jsonTextTruncationSuffix = "… [truncated]"

// [喵喵喵]: matcher 同时持有编译结果和静态宽匹配分类，策略不再依赖当前文件是否恰好全命中。
type searchMatcher struct {
	regexp       *regexp.Regexp
	broadPattern bool
}

func compileSearchMatcher(pattern string, literal, ignoreCase bool) (searchMatcher, error) {
	expression := pattern
	if literal {
		expression = regexp.QuoteMeta(pattern)
	}
	if ignoreCase {
		expression = "(?i)" + expression
	}
	compiled, err := regexp.Compile(expression)
	if err != nil {
		return searchMatcher{}, err
	}
	parsed, err := syntax.Parse(expression, syntax.Perl)
	if err != nil {
		return searchMatcher{}, err
	}
	return searchMatcher{regexp: compiled, broadPattern: regexpHasBroadWildcard(parsed.Simplify())}, nil
}

// [喵喵喵]: 只拦截带无界 dot 重复的无约束 wildcard；^、x? 与单个 . 仍是合法搜索。
func regexpHasBroadWildcard(expression *syntax.Regexp) bool {
	switch expression.Op {
	case syntax.OpCapture:
		return regexpHasBroadWildcard(expression.Sub[0])
	case syntax.OpStar, syntax.OpPlus:
		return regexpIsAnyChar(expression.Sub[0]) || regexpHasBroadWildcard(expression.Sub[0])
	case syntax.OpRepeat:
		return expression.Min <= 1 && expression.Max == -1 && (regexpIsAnyChar(expression.Sub[0]) || regexpHasBroadWildcard(expression.Sub[0]))
	case syntax.OpConcat:
		foundWildcard := false
		for _, subexpression := range expression.Sub {
			if regexpHasBroadWildcard(subexpression) {
				foundWildcard = true
				continue
			}
			if !regexpCanBeSkipped(subexpression) {
				return false
			}
		}
		return foundWildcard
	case syntax.OpAlternate:
		for _, subexpression := range expression.Sub {
			if regexpHasBroadWildcard(subexpression) {
				return true
			}
		}
	}
	return false
}

func regexpIsAnyChar(expression *syntax.Regexp) bool {
	if expression.Op == syntax.OpCapture {
		return regexpIsAnyChar(expression.Sub[0])
	}
	return expression.Op == syntax.OpAnyChar || expression.Op == syntax.OpAnyCharNotNL
}

func regexpCanBeSkipped(expression *syntax.Regexp) bool {
	switch expression.Op {
	case syntax.OpEmptyMatch, syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText:
		return true
	case syntax.OpCapture:
		return regexpCanBeSkipped(expression.Sub[0])
	case syntax.OpStar, syntax.OpQuest:
		return true
	case syntax.OpPlus:
		return regexpCanBeSkipped(expression.Sub[0])
	case syntax.OpRepeat:
		return expression.Min == 0 || regexpCanBeSkipped(expression.Sub[0])
	case syntax.OpConcat:
		for _, subexpression := range expression.Sub {
			if !regexpCanBeSkipped(subexpression) {
				return false
			}
		}
		return true
	case syntax.OpAlternate:
		for _, subexpression := range expression.Sub {
			if regexpCanBeSkipped(subexpression) {
				return true
			}
		}
	}
	return false
}

// filterLinesWithMode retains the small internal helper used by protocol tests.
// Production search uses searchMatcher so it can also enforce broad-pattern policy.
func filterLinesWithMode(lines []string, pattern string, literal, ignoreCase bool) ([]int, error) {
	if pattern == "" {
		return nil, nil
	}
	matcher, err := compileSearchMatcher(pattern, literal, ignoreCase)
	if err != nil {
		return nil, err
	}
	return filterLines(lines, matcher.regexp), nil
}

// filterLines returns 1-indexed line numbers of lines matching the compiled pattern.
func filterLines(lines []string, matcher *regexp.Regexp) []int {
	matches := make([]int, 0)
	for index, line := range lines {
		if matcher.MatchString(line) {
			matches = append(matches, index+1)
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

// utf8PrefixByBytes returns the longest valid UTF-8 prefix within maxBytes.
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
func appendJSONReadLine(result []ReadLine, byteCount int, lineNum int, line string, maxBytes int) ([]ReadLine, int, bool) {
	tag := formatTag(lineNum, line)
	separatorBytes := 0
	if len(result) > 0 {
		separatorBytes = 1
	}
	available := maxBytes - byteCount - separatorBytes
	if available <= 0 {
		return result, byteCount, false
	}

	full := ReadLine{Line: lineNum, Anchor: tag, Text: line}
	if size := jsonReadLineSize(full); size <= available {
		return append(result, full), byteCount + separatorBytes + size, true
	}
	if len(result) > 0 {
		// [喵喵喵]: 当前页放不下并不等于源代码行过长；留给下一页可保持 proof 完整。
		return result, byteCount, false
	}

	// [喵喵喵]: 只有单独占据整页仍放不下的行才允许内联截断，并明确排除其 proof。
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
		return result, byteCount, false
	}
	return append(result, best), byteCount + separatorBytes + bestSize, true
}

// collectAnnotatedLines gathers full lines unless a single source line exceeds
// the complete page budget. The final boolean reports only that true line case.
func collectAnnotatedLines(lines []string, startIdx, maxLines, maxBytes int) ([]ReadLine, bool, int) {
	result := make([]ReadLine, 0)
	byteCount := 0
	for i := startIdx; i < len(lines) && len(result) < maxLines && byteCount < maxBytes; i++ {
		lineNum := i + 1
		previousCount := len(result)
		var appended bool
		result, byteCount, appended = appendJSONReadLine(result, byteCount, lineNum, lines[i], maxBytes)
		if !appended {
			return result, false, lineNum
		}
		if result[len(result)-1].TextTruncated {
			return result, true, 0
		}
		if len(result) == previousCount {
			return result, false, lineNum
		}
		if byteCount >= maxBytes || len(result) >= maxLines {
			if i < len(lines)-1 {
				return result, false, i + 2
			}
			break
		}
	}
	return result, false, 0
}

// collectMatchLines gathers matching/context lines. The final boolean reports
// only a source line that cannot fit even on an otherwise empty page.
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
		var appended bool
		result, byteCount, appended = appendJSONReadLine(result, byteCount, ln, lines[ln-1], maxBytes)
		if !appended {
			if len(result) > 0 {
				return result, false, result[len(result)-1].Line + 1
			}
			return result, false, ln
		}
		if result[len(result)-1].TextTruncated {
			return result, true, 0
		}
		if byteCount >= maxBytes {
			if len(result) > 0 {
				return result, false, result[len(result)-1].Line + 1
			}
			return result, false, matchIdxs[i+1]
		}
	}
	remaining := len(matchIdxs) - startIdx - len(result)
	if remaining > 0 && len(result) > 0 {
		return result, false, result[len(result)-1].Line + 1
	}
	return result, false, 0
}

func searchJSONLineBudget(revision string, totalLines, maxBytes int) int {
	// [喵喵喵]: 搜索结果比连续读取多一个 totalMatches 字段，必须按自己的 JSON 外壳预留预算。
	empty := SearchResult{
		OK: true, Revision: revision, TotalLines: totalLines, TotalMatches: 0,
		Lines: []ReadLine{}, Truncated: true, NextOffset: totalLines + 1,
	}
	budget := maxBytes - jsonValueSize(empty) - 1
	if budget < 0 {
		return 0
	}
	return budget
}

func cmdSearch(path, pattern string, offset, limit int, literal bool, contextN int, ignoreCase bool) error {
	file, ok := loadCommandTextFile(path)
	if !ok {
		return nil
	}
	if pattern == "" {
		return emitError("pattern", "search pattern must not be empty")
	}
	if offset < 1 {
		offset = 1
	}
	if len(file.Lines) > 0 && offset > len(file.Lines) {
		return emitReadRangeError(offset, len(file.Lines))
	}
	if limit <= 0 {
		limit = 100
	}

	matcher, matchErr := compileSearchMatcher(pattern, literal, ignoreCase)
	if matchErr != nil {
		return emitError("pattern", fmt.Sprintf("invalid search pattern: %v", matchErr))
	}
	if matcher.broadPattern {
		return emitError("broad_pattern", "search pattern is an unconstrained wildcard; use a contiguous range read instead")
	}
	matches := filterLines(file.Lines, matcher.regexp)
	contextLines := applyContext(file.Lines, matches, contextN)
	jsonLineBytes := searchJSONLineBudget(file.Revision, len(file.Lines), readOutputMaxBytes)
	readLines, lineTruncated, nextOffset := collectMatchLines(file.Lines, contextLines, offset, limit, jsonLineBytes)
	return emitJSON(SearchResult{
		OK: true, Revision: file.Revision, TotalLines: len(file.Lines), TotalMatches: len(matches),
		Lines: readLines, Truncated: lineTruncated || nextOffset > 0, NextOffset: nextOffset,
	})
}

func cmdReadRange(path string, offset, limit int) error {
	file, ok := loadCommandTextFile(path)
	if !ok {
		return nil
	}
	if offset < 1 {
		offset = 1
	}
	if len(file.Lines) == 0 || offset > len(file.Lines) {
		return emitReadRangeError(offset, len(file.Lines))
	}
	if limit <= 0 {
		limit = 160
	}

	lineBudget := readJSONLineBudget(file.Revision, len(file.Lines), readOutputMaxBytes)
	lines, sourceLineTruncated, nextOffset := collectAnnotatedLines(file.Lines, offset-1, limit, lineBudget)
	return emitJSON(ReadResult{
		OK: true, Revision: file.Revision, TotalLines: len(file.Lines), Lines: lines,
		Truncated: sourceLineTruncated || nextOffset > 0, NextOffset: nextOffset,
	})
}
