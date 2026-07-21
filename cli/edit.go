package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"sort"
	"strings"
)

func readContentLines(contentSrc string) ([]string, error) {
	var raw []byte
	var err error
	if contentSrc == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(contentSrc)
	}
	if err != nil {
		return nil, err
	}

	s := strings.ReplaceAll(string(raw), "\r\n", "\n")
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return []string{}, nil
	}
	return strings.Split(s, "\n"), nil
}

func contentSourceErrorMessage(contentSrc string, err error) string {
	if contentSrc == "" {
		return "content-source argument is empty; replace/replace-range/insert expect <content-source> to be '-' for stdin or a file path. To delete, pipe empty stdin and use '-' as the content-source, e.g. printf '' | hledit replace <file> <anchor> -"
	}
	return fmt.Sprintf("content-source argument %q could not be read: %v. If you intended literal replacement text, pipe it on stdin and use '-' as the content-source", contentSrc, err)
}

func targetFileErrorMessage(path string, err error) string {
	return fmt.Sprintf("file argument %q could not be read: %v", path, err)
}

func loadEditableFile(path string) (LoadedTextFile, error) {
	file, err := loadTextFile(path)
	if err == nil {
		return file, nil
	}
	if errors.Is(err, errBinaryFile) {
		emitError("binary", "file appears to be binary")
		return LoadedTextFile{}, err
	}
	if errors.Is(err, errInvalidUTF8) {
		emitError("encoding", "file is not valid UTF-8")
		return LoadedTextFile{}, err
	}
	emitError("io", targetFileErrorMessage(path, err))
	return LoadedTextFile{}, err
}

func emitJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func emitResult(firstChanged, lastChanged, linesAdded, linesDeleted int, contentChanged bool, warning string) error {
	result := EditResult{
		OK: true, FirstChangedLine: firstChanged, LastChangedLine: lastChanged,
		LinesAdded: linesAdded, LinesDeleted: linesDeleted, ContentChanged: contentChanged,
	}
	if warning != "" {
		result.Warnings = []string{warning}
	}
	return emitJSON(result)
}

func emitStaleError(remaps []Remap, msg string) error {
	return emitJSON(EditError{OK: false, Error: "stale", Remaps: remaps, Message: msg})
}

func emitInvalidError(msg string) error {
	return emitJSON(EditError{OK: false, Error: "invalid", Message: msg})
}

// editOp applies a validated edit operation to the file.
// It handles: loading, anchor validation, content reading, applying the edit,
// atomic write with trailing newline preservation, and result emission.
// apply is a callback that receives the current lines and new content lines,
// and returns the resulting lines plus edit metadata.
func editOp(
	path string,
	anchors []Anchor,
	contentSrc string,
	apply func(lines []string, newLines []string) (result []string, firstChanged int, lastChanged int, linesAdded int, linesDeleted int, err error),
) error {
	file, err := loadEditableFile(path)
	if err != nil {
		return nil
	}
	lines := file.Lines

	for _, a := range anchors {
		if a.Line < 1 || a.Line > len(lines) {
			emitStaleError([]Remap{}, fmt.Sprintf("anchor %d#%s: stale", a.Line, a.Hash))
			return nil
		}
	}

	remaps, firstBad := validateAnchors(lines, anchors)
	if firstBad >= 0 {
		emitStaleError(remaps, fmt.Sprintf("anchor %d#%s: stale", anchors[firstBad].Line, anchors[firstBad].Hash))
		return nil
	}

	newLines, cerr := readContentLines(contentSrc)
	if cerr != nil {
		emitError("io", contentSourceErrorMessage(contentSrc, cerr))
		return nil
	}

	result, firstChanged, lastChanged, linesAdded, linesDeleted, aerr := apply(lines, newLines)
	if aerr != nil {
		emitInvalidError(aerr.Error())
		return nil
	}

	contentChanged := !slices.Equal(lines, result)
	writeWarning := ""
	if contentChanged {
		joined := file.JoinLines(result)
		var werr error
		writeWarning, werr = atomicWrite(path, []byte(joined))
		if werr != nil {
			emitError("io", werr.Error())
			return nil
		}
	}

	emitResult(firstChanged, lastChanged, linesAdded, linesDeleted, contentChanged, writeWarning)
	return nil
}

func cmdReplace(path, anchorStr, contentSrc string) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}

	return editOp(path, []Anchor{a}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		before := append([]string{}, lines[:a.Line-1]...)
		result := append(before, newLines...)
		result = append(result, lines[a.Line:]...)
		return result, a.Line, a.Line, len(newLines), 1, nil
	})
}

func cmdReplaceRange(path, anchorStr, endAnchorStr, contentSrc string) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}
	e, perr2 := parseAnchor(endAnchorStr)
	if perr2 != nil {
		emitInvalidError(perr2.Error())
		return nil
	}
	if a.Line > e.Line {
		emitInvalidError(fmt.Sprintf("start line %d > end line %d", a.Line, e.Line))
		return nil
	}

	return editOp(path, []Anchor{a, e}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		before := lines[:a.Line-1]
		after := lines[e.Line:]
		result := append(append([]string{}, before...), newLines...)
		result = append(result, after...)
		return result, a.Line, e.Line, len(newLines), e.Line - a.Line + 1, nil
	})
}

func cmdInsert(path, anchorStr, contentSrc string, after bool) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}

	return editOp(path, []Anchor{a}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		if len(newLines) == 0 {
			return nil, 0, 0, 0, 0, fmt.Errorf("insert requires non-empty content")
		}
		cutIdx := a.Line - 1
		firstChanged := a.Line
		if after {
			cutIdx = a.Line
			firstChanged = a.Line + 1
		}
		result := append([]string{}, lines[:cutIdx]...)
		result = append(result, newLines...)
		result = append(result, lines[cutIdx:]...)
		return result, firstChanged, firstChanged + len(newLines) - 1, len(newLines), 0, nil
	})
}

// cmdBatch applies multiple edit operations in a single pass.
// All anchors are validated against the same file state, then non-overlapping
// edits rebuild the file once from their original boundaries.
// Input is a JSON BatchEditRequest on stdin.
// When checkOnly is true, all validation runs but the file is not written.
func cmdBatch(path string, checkOnly bool) error {
	req, err := parseBatchRequest()
	if err != nil {
		emitBatchInvalidError(fmt.Sprintf("invalid batch request: %s", err.Error()), -1)
		return nil
	}

	if len(req.Edits) == 0 {
		emitBatchInvalidError("batch request contains no edits", -1)
		return nil
	}

	file, loadErr := loadEditableFile(path)
	if loadErr != nil {
		return nil
	}
	lines := file.Lines

	// Parse all anchors first, before any edits are applied.
	type parsedEdit struct {
		op     string
		pos    Anchor
		endPos *Anchor
		after  bool
		lines  []string
		index  int
	}

	parsed := make([]parsedEdit, len(req.Edits))
	var allRemaps []Remap
	firstBad := -1

	for i, e := range req.Edits {
		pos, perr := parseAnchor(e.Pos)
		if perr != nil {
			emitBatchInvalidError(fmt.Sprintf("edit %d: invalid anchor %q: %s", i, e.Pos, perr.Error()), i)
			return nil
		}

		var endPos *Anchor
		if e.EndPos != "" {
			ep, eerr := parseAnchor(e.EndPos)
			if eerr != nil {
				emitBatchInvalidError(fmt.Sprintf("edit %d: invalid end anchor %q: %s", i, e.EndPos, eerr.Error()), i)
				return nil
			}
			endPos = &ep
		}

		newLines := e.Lines

		switch e.OP {
		case "replace", "delete":
			if endPos != nil && pos.Line > endPos.Line {
				emitBatchInvalidError(fmt.Sprintf("edit %d: start line %d > end line %d", i, pos.Line, endPos.Line), i)
				return nil
			}
		case "insert":
			if endPos != nil {
				emitBatchInvalidError(fmt.Sprintf("edit %d: insert does not accept end_pos", i), i)
				return nil
			}
			if len(newLines) == 0 {
				emitBatchInvalidError(fmt.Sprintf("edit %d: insert requires non-empty content", i), i)
				return nil
			}
		default:
			emitBatchInvalidError(fmt.Sprintf("edit %d: unknown op %q", i, e.OP), i)
			return nil
		}
		// Validate anchor against current file state
		if pos.Line < 1 || pos.Line > len(lines) {
			if firstBad == -1 {
				firstBad = i
			}
			allRemaps = append(allRemaps, Remap{
				Requested: intToStr(pos.Line) + "#" + pos.Hash,
			})
		} else {
			currentTag := formatTag(pos.Line, lines[pos.Line-1])
			requestedTag := intToStr(pos.Line) + "#" + pos.Hash
			if currentTag != requestedTag {
				if firstBad == -1 {
					firstBad = i
				}
				allRemaps = append(allRemaps, Remap{
					Requested: requestedTag,
					Current:   currentTag,
				})
			}
		}

		if endPos != nil {
			if endPos.Line < 1 || endPos.Line > len(lines) {
				if firstBad == -1 {
					firstBad = i
				}
				allRemaps = append(allRemaps, Remap{
					Requested: intToStr(endPos.Line) + "#" + endPos.Hash,
				})
			} else {
				currentTag := formatTag(endPos.Line, lines[endPos.Line-1])
				requestedTag := intToStr(endPos.Line) + "#" + endPos.Hash
				if currentTag != requestedTag {
					if firstBad == -1 {
						firstBad = i
					}
					allRemaps = append(allRemaps, Remap{
						Requested: requestedTag,
						Current:   currentTag,
					})
				}
			}
		}

		parsed[i] = parsedEdit{
			op:     e.OP,
			pos:    pos,
			endPos: endPos,
			after:  e.After,
			lines:  newLines,
			index:  i,
		}
	}

	// If any anchor is stale, reject the entire batch and return context from this validated snapshot.
	if firstBad >= 0 {
		failedEdit := parsed[firstBad]
		requestedEnd := failedEdit.pos.Line
		if failedEdit.endPos != nil {
			requestedEnd = failedEdit.endPos.Line
		}
		emitBatchError(
			fmt.Sprintf("edit %d: anchor stale", firstBad),
			allRemaps,
			firstBad,
			buildCurrentAnchorContext(lines, failedEdit.pos.Line, requestedEnd),
		)
		return nil
	}

	editStart := func(e parsedEdit) int { return e.pos.Line }
	editEnd := func(e parsedEdit) int {
		if e.endPos != nil {
			return e.endPos.Line
		}
		return e.pos.Line
	}
	for i := 0; i < len(parsed); i++ {
		for j := i + 1; j < len(parsed); j++ {
			a := parsed[i]
			b := parsed[j]
			aStart, aEnd := editStart(a), editEnd(a)
			bStart, bEnd := editStart(b), editEnd(b)

			if a.op == "insert" && b.op == "insert" {
				if aStart == bStart {
					emitBatchInvalidError(fmt.Sprintf("edit %d overlaps edit %d: duplicate insert at line %d", b.index, a.index, bStart), b.index)
					return nil
				}
				continue
			}

			if a.op == "insert" {
				if aStart >= bStart && aStart <= bEnd {
					emitBatchInvalidError(fmt.Sprintf("edit %d overlaps edit %d: insert at line %d conflicts with line range %d-%d", a.index, b.index, aStart, bStart, bEnd), a.index)
					return nil
				}
				continue
			}

			if b.op == "insert" {
				if bStart >= aStart && bStart <= aEnd {
					emitBatchInvalidError(fmt.Sprintf("edit %d overlaps edit %d: insert at line %d conflicts with line range %d-%d", b.index, a.index, bStart, aStart, aEnd), b.index)
					return nil
				}
				continue
			}

			if aStart <= bEnd && bStart <= aEnd {
				emitBatchInvalidError(fmt.Sprintf("edit %d overlaps edit %d: line ranges %d-%d and %d-%d conflict", b.index, a.index, bStart, bEnd, aStart, aEnd), b.index)
				return nil
			}
		}
	}
	// 按原始行号从上至下模拟净行数位移，汇总写入后文件中的受影响范围。
	firstChanged := 0
	lastChanged := 0
	linesAdded := 0
	linesDeleted := 0
	summaryEdits := append([]parsedEdit(nil), parsed...)
	sort.SliceStable(summaryEdits, func(i, j int) bool {
		return summaryEdits[i].pos.Line < summaryEdits[j].pos.Line
	})
	lineShift := 0
	for _, e := range summaryEdits {
		deleted := 0
		if e.op == "replace" || e.op == "delete" {
			deleted = 1
			if e.endPos != nil {
				deleted = e.endPos.Line - e.pos.Line + 1
			}
		}
		changeStart := e.pos.Line + lineShift
		changeEnd := changeStart
		switch e.op {
		case "insert":
			if e.after {
				changeStart++
			}
			changeEnd = changeStart + len(e.lines) - 1
		case "replace", "delete":
			changedLineCount := len(e.lines)
			if deleted > changedLineCount {
				changedLineCount = deleted
			}
			changeEnd = changeStart + changedLineCount - 1
		}
		if firstChanged == 0 || changeStart < firstChanged {
			firstChanged = changeStart
		}
		if changeEnd > lastChanged {
			lastChanged = changeEnd
		}
		linesAdded += len(e.lines)
		linesDeleted += deleted
		lineShift += len(e.lines) - deleted
	}

	// 所有锚点都基于原文件且修改互不重叠，因此按原始边界一次重建即可，避免每个 edit 复制整份文件。
	editBoundary := func(e parsedEdit) int {
		if e.op == "insert" && e.after {
			return e.pos.Line
		}
		return e.pos.Line - 1
	}
	sort.SliceStable(parsed, func(i, j int) bool {
		iBoundary := editBoundary(parsed[i])
		jBoundary := editBoundary(parsed[j])
		if iBoundary != jBoundary {
			return iBoundary < jBoundary
		}
		return parsed[i].pos.Line < parsed[j].pos.Line
	})

	finalLineCount := len(lines) + linesAdded - linesDeleted
	rebuilt := make([]string, 0, finalLineCount)
	cursor := 0
	for _, e := range parsed {
		boundary := editBoundary(e)
		if boundary < cursor {
			emitBatchInvalidError(fmt.Sprintf("edit %d crosses an already consumed range", e.index), e.index)
			return nil
		}
		rebuilt = append(rebuilt, lines[cursor:boundary]...)
		rebuilt = append(rebuilt, e.lines...)

		switch e.op {
		case "replace", "delete":
			if e.endPos != nil {
				cursor = e.endPos.Line
			} else {
				cursor = e.pos.Line
			}
		case "insert":
			cursor = boundary
		default:
			emitBatchInvalidError(fmt.Sprintf("unknown op %q", e.op), e.index)
			return nil
		}
	}
	lines = append(rebuilt, lines[cursor:]...)

	contentChanged := !slices.Equal(file.Lines, lines)
	result := BatchEditResult{
		OK:               true,
		FirstChangedLine: firstChanged,
		LastChangedLine:  lastChanged,
		LinesAdded:       linesAdded,
		LinesDeleted:     linesDeleted,
		EditsApplied:     len(parsed),
		ContentChanged:   contentChanged,
	}
	if checkOnly {
		result.Checked = true
		return emitJSON(result)
	}

	result.UpdatedAnchors = buildUpdatedAnchorContext(lines, firstChanged, lastChanged, linesAdded)
	if !contentChanged {
		return emitJSON(result)
	}

	joined := file.JoinLines(lines)
	writeWarning, werr := atomicWrite(path, []byte(joined))
	if werr != nil {
		emitError("io", werr.Error())
		return nil
	}
	if writeWarning != "" {
		result.Warnings = []string{writeWarning}
	}
	return emitJSON(result)
}

func emitBatchError(msg string, remaps []Remap, failed int, currentAnchors *AnchorContext) error {
	return emitBatchErrorType("stale", msg, remaps, failed, currentAnchors)
}

func emitBatchInvalidError(msg string, failed int) error {
	return emitBatchErrorType("invalid", msg, nil, failed, nil)
}

func emitBatchErrorType(errType, msg string, remaps []Remap, failed int, currentAnchors *AnchorContext) error {
	return emitJSON(BatchEditError{
		OK:             false,
		Error:          errType,
		Message:        msg,
		Remaps:         remaps,
		Failed:         failed,
		CurrentAnchors: currentAnchors,
	})
}
