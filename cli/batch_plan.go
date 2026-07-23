package main

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"sort"
	"strings"
)

// BatchPlan 是基于同一原始文件快照生成的不可变批次执行计划。
type BatchPlan struct {
	Edits          []PlannedBatchEdit
	RebuiltLines   []string
	FirstChanged   int
	LastChanged    int
	LinesAdded     int
	LinesDeleted   int
	ContentChanged bool
}

// PlannedBatchEdit 保留协议中的原始锚点，供冲突诊断准确指向调用参数。
type PlannedBatchEdit struct {
	operation      string
	position       Anchor
	endPosition    *Anchor
	insertAfter    bool
	replacement    []string
	requestIndex   int
	requestedPos   string
	requestedEnd   string
	insertBoundary int
}

// BatchPlanFailure 表示 planner 可确认未写入时的协议拒绝。
type BatchPlanFailure struct {
	Code            string
	Message         string
	Remaps          []Remap
	FailedEdit      int
	CurrentAnchors  *AnchorContext
	CurrentRevision string
}

func invalidBatchPlanFailure(message string, failedEdit int) *BatchPlanFailure {
	return &BatchPlanFailure{Code: "invalid", Message: message, FailedEdit: failedEdit}
}

func plannedBatchEdit(index int, request BatchEditOp) (PlannedBatchEdit, *BatchPlanFailure) {
	position, err := parseAnchor(request.Pos)
	if err != nil {
		return PlannedBatchEdit{}, invalidBatchPlanFailure(
			fmt.Sprintf("edit %d: invalid anchor %q: %s", index, request.Pos, err.Error()),
			index,
		)
	}

	var endPosition *Anchor
	if request.endPosPresent {
		parsedEnd, endErr := parseAnchor(request.EndPos)
		if endErr != nil {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(
				fmt.Sprintf("edit %d: invalid end anchor %q: %s", index, request.EndPos, endErr.Error()),
				index,
			)
		}
		endPosition = &parsedEnd
	}

	switch request.OP {
	case "replace":
		if !request.linesPresent {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: replace requires lines", index), index)
		}
		if request.afterPresent {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: replace does not accept after", index), index)
		}
		if endPosition != nil && position.Line > endPosition.Line {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(
				fmt.Sprintf("edit %d: start line %d > end line %d", index, position.Line, endPosition.Line),
				index,
			)
		}
	case "delete":
		if request.linesPresent {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: delete does not accept lines", index), index)
		}
		if request.afterPresent {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: delete does not accept after", index), index)
		}
		if endPosition != nil && position.Line > endPosition.Line {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(
				fmt.Sprintf("edit %d: start line %d > end line %d", index, position.Line, endPosition.Line),
				index,
			)
		}
	case "insert":
		if endPosition != nil {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: insert does not accept end_pos", index), index)
		}
		if !request.linesPresent || len(request.Lines) == 0 {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: insert requires non-empty content", index), index)
		}
		if request.afterPresent && !request.After {
			return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: insert after must be true when provided", index), index)
		}
	default:
		return PlannedBatchEdit{}, invalidBatchPlanFailure(fmt.Sprintf("edit %d: unknown op %q", index, request.OP), index)
	}

	requestedEnd := request.EndPos
	if requestedEnd == "" {
		requestedEnd = request.Pos
	}
	boundary := position.Line - 1
	if request.OP == "insert" && request.After {
		boundary = position.Line
	}
	return PlannedBatchEdit{
		operation:      request.OP,
		position:       position,
		endPosition:    endPosition,
		insertAfter:    request.After,
		replacement:    request.Lines,
		requestIndex:   index,
		requestedPos:   request.Pos,
		requestedEnd:   requestedEnd,
		insertBoundary: boundary,
	}, nil
}

func batchAnchorRemap(lines []string, anchor Anchor) (Remap, bool) {
	requested := intToStr(anchor.Line) + "#" + anchor.Hash
	if anchor.Line < 1 || anchor.Line > len(lines) {
		return Remap{Requested: requested}, true
	}
	current := formatTag(anchor.Line, lines[anchor.Line-1])
	if current != requested {
		return Remap{Requested: requested, Current: current}, true
	}
	return Remap{}, false
}

func plannedEditEndLine(edit PlannedBatchEdit) int {
	if edit.endPosition != nil {
		return edit.endPosition.Line
	}
	return edit.position.Line
}

func batchPhysicalConflict(edits []PlannedBatchEdit) *BatchPlanFailure {
	for i := 0; i < len(edits); i++ {
		for j := i + 1; j < len(edits); j++ {
			first := edits[i]
			second := edits[j]

			if first.operation == "insert" && second.operation == "insert" {
				if first.insertBoundary == second.insertBoundary {
					return invalidBatchPlanFailure(
						fmt.Sprintf(
							"edit %d overlaps edit %d: insert anchors %q and %q share physical boundary %d",
							second.requestIndex,
							first.requestIndex,
							second.requestedPos,
							first.requestedPos,
							second.insertBoundary,
						),
						second.requestIndex,
					)
				}
				continue
			}

			if first.operation == "insert" {
				if failure := batchInsertRangeConflict(first, second, second.requestIndex); failure != nil {
					return failure
				}
				continue
			}
			if second.operation == "insert" {
				if failure := batchInsertRangeConflict(second, first, second.requestIndex); failure != nil {
					return failure
				}
				continue
			}

			firstEnd := plannedEditEndLine(first)
			secondEnd := plannedEditEndLine(second)
			if first.position.Line <= secondEnd && second.position.Line <= firstEnd {
				return invalidBatchPlanFailure(
					fmt.Sprintf(
						"edit %d overlaps edit %d: ranges %q-%q and %q-%q consume overlapping lines",
						second.requestIndex,
						first.requestIndex,
						second.requestedPos,
						second.requestedEnd,
						first.requestedPos,
						first.requestedEnd,
					),
					second.requestIndex,
				)
			}
		}
	}
	return nil
}

func batchInsertRangeConflict(insert PlannedBatchEdit, lineRange PlannedBatchEdit, failedEdit int) *BatchPlanFailure {
	consumedBoundaryStart := lineRange.position.Line - 1
	consumedBoundaryEnd := plannedEditEndLine(lineRange)
	if insert.insertBoundary < consumedBoundaryStart || insert.insertBoundary > consumedBoundaryEnd {
		return nil
	}
	return invalidBatchPlanFailure(
		fmt.Sprintf(
			"edit %d overlaps edit %d: insert anchor %q maps to physical boundary %d consumed by range %q-%q",
			insert.requestIndex,
			lineRange.requestIndex,
			insert.requestedPos,
			insert.insertBoundary,
			lineRange.requestedPos,
			lineRange.requestedEnd,
		),
		failedEdit,
	)
}

func batchPlanStatistics(edits []PlannedBatchEdit) (firstChanged, lastChanged, linesAdded, linesDeleted int) {
	ordered := append([]PlannedBatchEdit(nil), edits...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].position.Line < ordered[j].position.Line
	})

	lineShift := 0
	for _, edit := range ordered {
		deleted := 0
		if edit.operation != "insert" {
			deleted = plannedEditEndLine(edit) - edit.position.Line + 1
		}
		changeStart := edit.position.Line + lineShift
		changeEnd := changeStart
		if edit.operation == "insert" {
			if edit.insertAfter {
				changeStart++
			}
			changeEnd = changeStart + len(edit.replacement) - 1
		} else {
			changedLineCount := max(deleted, len(edit.replacement))
			changeEnd = changeStart + changedLineCount - 1
		}
		if firstChanged == 0 || changeStart < firstChanged {
			firstChanged = changeStart
		}
		if changeEnd > lastChanged {
			lastChanged = changeEnd
		}
		linesAdded += len(edit.replacement)
		linesDeleted += deleted
		lineShift += len(edit.replacement) - deleted
	}
	return firstChanged, lastChanged, linesAdded, linesDeleted
}

func rebuildBatchLines(originalLines []string, edits []PlannedBatchEdit, finalLineCount int) []string {
	ordered := append([]PlannedBatchEdit(nil), edits...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].insertBoundary != ordered[j].insertBoundary {
			return ordered[i].insertBoundary < ordered[j].insertBoundary
		}
		return ordered[i].requestIndex < ordered[j].requestIndex
	})

	rebuilt := make([]string, 0, finalLineCount)
	cursor := 0
	for _, edit := range ordered {
		rebuilt = append(rebuilt, originalLines[cursor:edit.insertBoundary]...)
		rebuilt = append(rebuilt, edit.replacement...)
		if edit.operation == "insert" {
			cursor = edit.insertBoundary
		} else {
			cursor = plannedEditEndLine(edit)
		}
	}
	return append(rebuilt, originalLines[cursor:]...)
}

func validRawFileRevision(revision string) bool {
	if len(revision) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(revision, "sha256:") {
		return false
	}
	for _, digit := range revision[len("sha256:"):] {
		if (digit < '0' || digit > '9') && (digit < 'a' || digit > 'f') {
			return false
		}
	}
	return true
}

func batchProofFailedEdit(edits []PlannedBatchEdit, line int) int {
	for _, edit := range edits {
		if edit.operation == "insert" && edit.position.Line == line {
			return edit.requestIndex
		}
		if edit.operation != "insert" && line >= edit.position.Line && line <= plannedEditEndLine(edit) {
			return edit.requestIndex
		}
	}
	return -1
}

func validateBatchProofRevision(proof *BatchReadProof, currentRevision string) *BatchPlanFailure {
	if proof == nil {
		return nil
	}
	if !validRawFileRevision(proof.Revision) {
		return invalidBatchPlanFailure("read proof revision must be sha256:<64 lowercase hexadecimal digits>", -1)
	}
	if proof.Revision != currentRevision {
		return &BatchPlanFailure{Code: "stale", Message: "read proof revision does not match the current file", FailedEdit: 0, CurrentRevision: currentRevision}
	}
	return nil
}

func validateBatchReadProof(proof *BatchReadProof, currentRevision string, originalLines []string, edits []PlannedBatchEdit) *BatchPlanFailure {
	if proof == nil {
		return nil
	}
	if len(proof.Anchors) == 0 {
		return &BatchPlanFailure{Code: "insufficient_read_proof", Message: "read proof contains no anchors", FailedEdit: 0, CurrentRevision: currentRevision}
	}

	proofLines := make(map[int]struct{}, len(proof.Anchors))
	remaps := make([]Remap, 0)
	firstStaleLine := 0
	previousLine := 0
	for proofIndex, requestedAnchor := range proof.Anchors {
		anchor, err := parseAnchor(requestedAnchor)
		if err != nil {
			return invalidBatchPlanFailure(fmt.Sprintf("read proof anchor %d %q is invalid: %s", proofIndex, requestedAnchor, err.Error()), -1)
		}
		if anchor.Line <= previousLine {
			return invalidBatchPlanFailure(fmt.Sprintf("read proof anchors must be unique and strictly increasing; line %d follows line %d", anchor.Line, previousLine), -1)
		}
		previousLine = anchor.Line
		proofLines[anchor.Line] = struct{}{}
		if remap, stale := batchAnchorRemap(originalLines, anchor); stale {
			if firstStaleLine == 0 {
				firstStaleLine = anchor.Line
			}
			remaps = append(remaps, remap)
		}
	}
	if firstStaleLine > 0 {
		failedEdit := batchProofFailedEdit(edits, firstStaleLine)
		return &BatchPlanFailure{Code: "stale", Message: fmt.Sprintf("read proof anchor at line %d is stale", firstStaleLine), Remaps: remaps, FailedEdit: failedEdit, CurrentAnchors: buildCurrentAnchorContext(originalLines, firstStaleLine, firstStaleLine), CurrentRevision: currentRevision}
	}

	for _, edit := range edits {
		for line := edit.position.Line; line <= plannedEditEndLine(edit); line++ {
			if _, covered := proofLines[line]; covered {
				continue
			}
			return &BatchPlanFailure{Code: "insufficient_read_proof", Message: fmt.Sprintf("edit %d requires read proof for line %d", edit.requestIndex, line), FailedEdit: edit.requestIndex, CurrentRevision: currentRevision}
		}
	}
	return nil
}

func planBatchEdits(request BatchEditRequest, originalLines []string, currentRevision string) (BatchPlan, *BatchPlanFailure) {
	if len(request.Edits) == 0 {
		return BatchPlan{}, invalidBatchPlanFailure("batch request contains no edits", -1)
	}
	if failure := validateBatchProofRevision(request.Proof, currentRevision); failure != nil {
		return BatchPlan{}, failure
	}

	edits := make([]PlannedBatchEdit, len(request.Edits))
	remaps := make([]Remap, 0)
	firstStale := -1
	for index, requestedEdit := range request.Edits {
		planned, failure := plannedBatchEdit(index, requestedEdit)
		if failure != nil {
			return BatchPlan{}, failure
		}
		edits[index] = planned

		if remap, stale := batchAnchorRemap(originalLines, planned.position); stale {
			if firstStale == -1 {
				firstStale = index
			}
			remaps = append(remaps, remap)
		}
		if planned.endPosition != nil {
			if remap, stale := batchAnchorRemap(originalLines, *planned.endPosition); stale {
				if firstStale == -1 {
					firstStale = index
				}
				remaps = append(remaps, remap)
			}
		}
	}
	if failure := validateBatchReadProof(request.Proof, currentRevision, originalLines, edits); failure != nil {
		return BatchPlan{}, failure
	}

	if firstStale >= 0 {
		failed := edits[firstStale]
		return BatchPlan{}, &BatchPlanFailure{
			Code:            "stale",
			Message:         fmt.Sprintf("edit %d: anchor stale", firstStale),
			Remaps:          remaps,
			FailedEdit:      firstStale,
			CurrentAnchors:  buildCurrentAnchorContext(originalLines, failed.position.Line, plannedEditEndLine(failed)),
			CurrentRevision: currentRevision,
		}
	}
	if conflict := batchPhysicalConflict(edits); conflict != nil {
		return BatchPlan{}, conflict
	}

	firstChanged, lastChanged, linesAdded, linesDeleted := batchPlanStatistics(edits)
	rebuilt := rebuildBatchLines(originalLines, edits, len(originalLines)+linesAdded-linesDeleted)
	return BatchPlan{
		Edits:          edits,
		RebuiltLines:   rebuilt,
		FirstChanged:   firstChanged,
		LastChanged:    lastChanged,
		LinesAdded:     linesAdded,
		LinesDeleted:   linesDeleted,
		ContentChanged: !slices.Equal(originalLines, rebuilt),
	}, nil
}
