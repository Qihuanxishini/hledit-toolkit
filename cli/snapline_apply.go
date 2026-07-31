package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	snaplineTotalChangeLimit   = 200
	snaplineTextByteLimit      = 1 << 20
	snaplineProducedLineLimit  = 20000
	snaplineProofLineLimit     = 10000
	snaplineProofTextByteLimit = 4 << 20
)

type decodedSnaplineText struct {
	lines      []string
	endsWithLF bool
}

type plannedSnaplineChange struct {
	group      string
	groupIndex int
	oldStart   int
	oldEnd     int
	boundary   int
	produced   []string
	endsWithLF bool
	changed    bool
}

func (change plannedSnaplineChange) consumedLines() int {
	if change.oldEnd < change.oldStart {
		return 0
	}
	return change.oldEnd - change.oldStart + 1
}

func (change plannedSnaplineChange) lineDelta() int {
	if !change.changed {
		return 0
	}
	return len(change.produced) - change.consumedLines()
}

func runSnaplineApply() error {
	input, failure, err := readBoundedStdin(snaplineApplyInputLimit)
	if err != nil {
		return err
	}
	if failure != nil {
		return emitWireJSON(failure)
	}
	request, failure := parseSnaplineApplyRequest(input)
	if failure != nil {
		return emitWireJSON(failure)
	}
	if !validSnaplineRevision(request.ExpectedRevision) {
		failure = snaplineFailure("invalid_request", "expectedRevision must be sha256:<64 lowercase hexadecimal digits>")
		return emitWireJSON(failure)
	}
	prepared, failure := prepareSnaplineApplyPayload(request)
	if failure != nil {
		return emitWireJSON(failure)
	}
	target, failure := readSnaplineTarget(request.Path)
	if failure != nil {
		if failure.Code == "image_candidate" {
			failure.Code = "unsupported_file"
			failure.Message = "image targets cannot be edited as text"
		}
		return emitWireJSON(failure)
	}
	if request.ExpectedRevision != target.File.Revision {
		failure = snaplineFailure("snapshot_stale", "expectedRevision does not match the current target")
		failure.Path = target.CanonicalPath
		attachApproximateSnaplineRequestedContext(failure, target.File, request)
		return emitWireJSON(failure)
	}
	linkCount, linkErr := fileLinkCount(target.CanonicalPath, target.Info)
	if linkErr != nil {
		failure = snaplineFailure("write_failed_before_replace", fmt.Sprintf("inspect target hard links: %v", linkErr))
		failure.Path = target.CanonicalPath
		return emitWireJSON(failure)
	}
	if linkCount > 1 {
		failure = snaplineFailure("hardlink_target", fmt.Sprintf("target has %d hard links", linkCount))
		failure.Path = target.CanonicalPath
		return emitWireJSON(failure)
	}

	changes, failure := planPreparedSnaplineChanges(request, prepared, target.File)
	if failure != nil {
		failure.Path = target.CanonicalPath
		failure.CurrentRevision = target.File.Revision
		return emitWireJSON(failure)
	}
	if failure = validateSnaplineProof(request.Proof, target.File, changes); failure != nil {
		failure.Path = target.CanonicalPath
		failure.CurrentRevision = target.File.Revision
		return emitWireJSON(failure)
	}

	effective := effectiveSnaplineChanges(changes)
	effects := buildSnaplineEffects(changes, effective)
	stats := buildSnaplineStats(changes, effective, len(target.File.Lines))
	if len(effective) == 0 {
		return emitWireJSON(SnaplineApplyResult{
			OK:              true,
			ProtocolVersion: snaplineProtocolVersion,
			Path:            target.CanonicalPath,
			Outcome:         "no_op",
			SourceRevision:  target.File.Revision,
			NewRevision:     target.File.Revision,
			ContentChanged:  false,
			Stats:           stats,
			Effects:         effects,
			Warnings:        []SnaplineWarning{},
		})
	}

	rebuiltLines := rebuildSnaplineLines(target.File.Lines, effective, stats.NewLineCount)
	var rebuiltEndings []LineEnding
	if len(target.File.Lines) == 0 {
		rebuiltEndings = zeroLineSnaplineEndings(len(rebuiltLines), effective[0].endsWithLF)
	} else {
		rebuiltEndings = rebuildLineEndings(target.File, snaplineLineSplices(effective), len(rebuiltLines))
	}
	encoded := target.File.EncodeContent(rebuiltLines, rebuiltEndings)
	newRevision := rawFileRevision(encoded)
	if newRevision == target.File.Revision {
		return fmt.Errorf("internal apply invariant failed: effective changes produced the source revision")
	}

	warningMessage, writeErr := replaceSnaplineTarget(target, encoded)
	if writeErr != nil {
		var changedErr *sourceChangedBeforeCommitError
		if errors.As(writeErr, &changedErr) {
			failure = snaplineFailure("source_changed_before_commit", changedErr.Error())
			failure.Path = target.CanonicalPath
			failure.CurrentRevision = changedErr.CurrentRevision
			return emitWireJSON(failure)
		}
		var beforeReplaceErr *writeFailedBeforeReplaceError
		if errors.As(writeErr, &beforeReplaceErr) {
			failure = snaplineFailure("write_failed_before_replace", beforeReplaceErr.Error())
			failure.Path = target.CanonicalPath
			return emitWireJSON(failure)
		}
		// replaceFile 已被调用却无法证明提交状态时，必须以非零退出交给插件归类 outcome_unknown。
		return writeErr
	}
	warnings := []SnaplineWarning{}
	if warningMessage != "" {
		warnings = append(warnings, SnaplineWarning{Code: "post_commit_durability", Message: boundedSnaplineMessage(warningMessage)})
	}
	return emitWireJSON(SnaplineApplyResult{
		OK:              true,
		ProtocolVersion: snaplineProtocolVersion,
		Path:            target.CanonicalPath,
		Outcome:         "applied",
		SourceRevision:  target.File.Revision,
		NewRevision:     newRevision,
		ContentChanged:  true,
		Stats:           stats,
		Effects:         effects,
		Warnings:        warnings,
	})
}

func validSnaplineRevision(revision string) bool {
	if len(revision) != len("sha256:")+64 || !strings.HasPrefix(revision, "sha256:") {
		return false
	}
	for _, digit := range revision[len("sha256:"):] {
		if (digit < '0' || digit > '9') && (digit < 'a' || digit > 'f') {
			return false
		}
	}
	return true
}

type preparedSnaplineApplyPayload struct {
	replacements     []decodedSnaplineText
	insertionsBefore []decodedSnaplineText
	insertionsAfter  []decodedSnaplineText
}

func decodeSnaplineText(text string) (decodedSnaplineText, error) {
	if strings.ContainsRune(text, '\r') {
		return decodedSnaplineText{}, errors.New("text must not contain carriage returns")
	}
	if strings.ContainsRune(text, '\x00') {
		return decodedSnaplineText{}, errors.New("text must not contain NUL bytes")
	}
	endsWithLF := strings.HasSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	if endsWithLF {
		lines = lines[:len(lines)-1]
	}
	return decodedSnaplineText{lines: lines, endsWithLF: endsWithLF}, nil
}

// prepareSnaplineApplyPayload 在文件 I/O 前完成所有与目标内容无关的请求约束，
// 并保留唯一一次 text 解码结果供 planner 使用。
func prepareSnaplineApplyPayload(request SnaplineApplyRequest) (preparedSnaplineApplyPayload, *SnaplineLogicalFailure) {
	var prepared preparedSnaplineApplyPayload
	groupLengths := []int{len(request.Replacements), len(request.Deletions), len(request.InsertionsBefore), len(request.InsertionsAfter)}
	totalChanges := 0
	for _, length := range groupLengths {
		if length > 100 {
			return prepared, snaplineFailure("invalid_request", "each change group accepts at most 100 items")
		}
		totalChanges += length
	}
	if totalChanges == 0 {
		return prepared, snaplineFailure("invalid_request", "apply request contains no changes")
	}
	if totalChanges > snaplineTotalChangeLimit {
		return prepared, snaplineFailure("size_limit", fmt.Sprintf("apply request exceeds %d total changes", snaplineTotalChangeLimit))
	}

	proofLines := 0
	proofBytes := 0
	for _, proofRange := range request.Proof {
		if len(proofRange.Lines) > snaplineProofLineLimit-proofLines {
			return prepared, snaplineFailure("size_limit", "proof exceeds line or text byte limit")
		}
		proofLines += len(proofRange.Lines)
		for _, line := range proofRange.Lines {
			if len(line) > snaplineProofTextByteLimit-proofBytes {
				return prepared, snaplineFailure("size_limit", "proof exceeds line or text byte limit")
			}
			proofBytes += len(line)
		}
	}

	textBytes := 0
	producedLines := 0
	decodeGroup := func(texts []string, group string) ([]decodedSnaplineText, *SnaplineLogicalFailure) {
		decodedTexts := make([]decodedSnaplineText, len(texts))
		for index, text := range texts {
			if len(text) > snaplineTextByteLimit-textBytes {
				return nil, snaplineFailure("size_limit", fmt.Sprintf("change text exceeds %d-byte limit", snaplineTextByteLimit))
			}
			decoded, err := decodeSnaplineText(text)
			if err != nil {
				return nil, snaplineChangeFailure("invalid_request", err.Error(), group, index)
			}
			if len(decoded.lines) > snaplineProducedLineLimit-producedLines {
				return nil, snaplineFailure("size_limit", fmt.Sprintf("changes produce more than %d logical lines", snaplineProducedLineLimit))
			}
			textBytes += len(text)
			producedLines += len(decoded.lines)
			decodedTexts[index] = decoded
		}
		return decodedTexts, nil
	}

	replacementTexts := make([]string, len(request.Replacements))
	for index := range request.Replacements {
		replacementTexts[index] = request.Replacements[index].Text
	}
	var failure *SnaplineLogicalFailure
	prepared.replacements, failure = decodeGroup(replacementTexts, "replacement")
	if failure != nil {
		return prepared, failure
	}
	beforeTexts := make([]string, len(request.InsertionsBefore))
	for index := range request.InsertionsBefore {
		beforeTexts[index] = request.InsertionsBefore[index].Text
	}
	prepared.insertionsBefore, failure = decodeGroup(beforeTexts, "insertion_before")
	if failure != nil {
		return prepared, failure
	}
	afterTexts := make([]string, len(request.InsertionsAfter))
	for index := range request.InsertionsAfter {
		afterTexts[index] = request.InsertionsAfter[index].Text
	}
	prepared.insertionsAfter, failure = decodeGroup(afterTexts, "insertion_after")
	if failure != nil {
		return prepared, failure
	}
	return prepared, nil
}

func planSnaplineChanges(request SnaplineApplyRequest, file LoadedTextFile) ([]plannedSnaplineChange, *SnaplineLogicalFailure) {
	prepared, failure := prepareSnaplineApplyPayload(request)
	if failure != nil {
		return nil, failure
	}
	return planPreparedSnaplineChanges(request, prepared, file)
}

func planPreparedSnaplineChanges(request SnaplineApplyRequest, prepared preparedSnaplineApplyPayload, file LoadedTextFile) ([]plannedSnaplineChange, *SnaplineLogicalFailure) {
	totalChanges := len(request.Replacements) + len(request.Deletions) + len(request.InsertionsBefore) + len(request.InsertionsAfter)
	if len(file.Lines) == 0 {
		if len(request.Replacements) != 0 || len(request.Deletions) != 0 || len(request.InsertionsAfter) != 0 || len(request.InsertionsBefore) != 1 || request.InsertionsBefore[0].Line != 1 {
			return nil, snaplineFailure("range_out_of_bounds", "a zero-line target only accepts one insertionBefore at line 1")
		}
	}

	changes := make([]plannedSnaplineChange, 0, totalChanges)
	for index, replacement := range request.Replacements {
		if failure := validateSnaplineSourceRange("replacement", index, replacement.Start, replacement.End, len(file.Lines)); failure != nil {
			return nil, failure
		}
		decoded := prepared.replacements[index]
		changed := !equalSnaplineLines(file.Lines[replacement.Start-1:replacement.End], decoded.lines)
		changes = append(changes, plannedSnaplineChange{
			group: "replacement", groupIndex: index,
			oldStart: replacement.Start, oldEnd: replacement.End, boundary: replacement.Start - 1,
			produced: decoded.lines, endsWithLF: decoded.endsWithLF, changed: changed,
		})
	}
	for index, deletion := range request.Deletions {
		if failure := validateSnaplineSourceRange("deletion", index, deletion.Start, deletion.End, len(file.Lines)); failure != nil {
			return nil, failure
		}
		changes = append(changes, plannedSnaplineChange{
			group: "deletion", groupIndex: index,
			oldStart: deletion.Start, oldEnd: deletion.End, boundary: deletion.Start - 1,
			produced: []string{}, changed: true,
		})
	}
	for index, insertion := range request.InsertionsBefore {
		if len(file.Lines) != 0 && (insertion.Line < 1 || insertion.Line > len(file.Lines)) {
			return nil, snaplineChangeFailure("range_out_of_bounds", fmt.Sprintf("insertion_before %d line is outside 1-%d", index, len(file.Lines)), "insertion_before", index)
		}
		if len(file.Lines) == 0 && insertion.Text == "" {
			return nil, snaplineChangeFailure("invalid_request", "zero-line insertion text must not be empty", "insertion_before", index)
		}
		decoded := prepared.insertionsBefore[index]
		changes = append(changes, plannedSnaplineChange{
			group: "insertion_before", groupIndex: index,
			oldStart: insertion.Line, oldEnd: insertion.Line - 1, boundary: insertion.Line - 1,
			produced: decoded.lines, endsWithLF: decoded.endsWithLF, changed: true,
		})
	}
	for index, insertion := range request.InsertionsAfter {
		if insertion.Line < 1 || insertion.Line > len(file.Lines) {
			return nil, snaplineChangeFailure("range_out_of_bounds", fmt.Sprintf("insertion_after %d line is outside 1-%d", index, len(file.Lines)), "insertion_after", index)
		}
		decoded := prepared.insertionsAfter[index]
		changes = append(changes, plannedSnaplineChange{
			group: "insertion_after", groupIndex: index,
			oldStart: insertion.Line + 1, oldEnd: insertion.Line, boundary: insertion.Line,
			produced: decoded.lines, endsWithLF: decoded.endsWithLF, changed: true,
		})
	}
	if failure := validateSnaplineChangeConflicts(changes); failure != nil {
		return nil, failure
	}
	if failure := validateSnaplineExpansionGuard(changes, file.Lines); failure != nil {
		return nil, failure
	}
	return changes, nil
}

func validateSnaplineSourceRange(group string, index, start, end, totalLines int) *SnaplineLogicalFailure {
	if start < 1 || end < start || end > totalLines {
		return snaplineChangeFailure(
			"range_out_of_bounds",
			fmt.Sprintf("%s %d range %d-%d is outside 1-%d", group, index, start, end, totalLines),
			group, index,
		)
	}
	return nil
}

func equalSnaplineLines(first, second []string) bool {
	if len(first) != len(second) {
		return false
	}
	for index := range first {
		if first[index] != second[index] {
			return false
		}
	}
	return true
}

func validateSnaplineChangeConflicts(changes []plannedSnaplineChange) *SnaplineLogicalFailure {
	for firstIndex := 0; firstIndex < len(changes); firstIndex++ {
		first := changes[firstIndex]
		for secondIndex := firstIndex + 1; secondIndex < len(changes); secondIndex++ {
			second := changes[secondIndex]
			firstInsertion := first.consumedLines() == 0
			secondInsertion := second.consumedLines() == 0
			code := "overlapping_changes"
			conflict := false
			switch {
			case firstInsertion && secondInsertion:
				conflict = first.boundary == second.boundary
				code = "duplicate_insertion_boundary"
			case firstInsertion:
				conflict = first.boundary >= second.oldStart && first.boundary < second.oldEnd
			case secondInsertion:
				conflict = second.boundary >= first.oldStart && second.boundary < first.oldEnd
			default:
				conflict = first.oldStart <= second.oldEnd && second.oldStart <= first.oldEnd
			}
			if !conflict {
				continue
			}
			failure := snaplineChangeFailure(
				code,
				fmt.Sprintf("%s %d conflicts with %s %d", second.group, second.groupIndex, first.group, first.groupIndex),
				second.group,
				second.groupIndex,
			)
			failure.ConflictsWith = &SnaplineConflictReference{Group: first.group, GroupIndex: first.groupIndex}
			return failure
		}
	}
	return nil
}

func validateSnaplineExpansionGuard(changes []plannedSnaplineChange, source []string) *SnaplineLogicalFailure {
	for _, change := range changes {
		if change.group != "replacement" || change.consumedLines() != 1 || len(change.produced) <= 1 || change.produced[0] != source[change.oldStart-1] {
			continue
		}
		hasAdjacentInsertion := false
		for _, candidate := range changes {
			if candidate.consumedLines() == 0 && (candidate.boundary == change.oldStart-1 || candidate.boundary == change.oldEnd) {
				hasAdjacentInsertion = true
				break
			}
		}
		if !hasAdjacentInsertion {
			return snaplineChangeFailure(
				"suspicious_range_expansion",
				"single-line replacement repeats the source line and appends lines; use insertion_after or a wider replacement range",
				change.group,
				change.groupIndex,
			)
		}
	}
	return nil
}

func validateSnaplineProof(proof []SnaplineProofRange, file LoadedTextFile, changes []plannedSnaplineChange) *SnaplineLogicalFailure {
	if len(file.Lines) == 0 {
		if len(proof) != 0 {
			return snaplineFailure("invalid_request", "zero-line targets require an empty proof array")
		}
		return nil
	}
	proofLines := make(map[int]string)
	for proofIndex, proofRange := range proof {
		if len(proofRange.Lines) == 0 || proofRange.Start < 1 || proofRange.Start > len(file.Lines) || len(proofRange.Lines) > len(file.Lines)-proofRange.Start+1 {
			return snaplineFailure("invalid_request", fmt.Sprintf("proof range %d is outside the source file", proofIndex))
		}
		for offset, text := range proofRange.Lines {
			line := proofRange.Start + offset
			if _, duplicate := proofLines[line]; duplicate {
				return snaplineFailure("invalid_request", fmt.Sprintf("proof ranges overlap at line %d", line))
			}
			proofLines[line] = text
			if text != file.Lines[line-1] {
				failure := snaplineFailure("proof_mismatch", fmt.Sprintf("proof text does not match source line %d", line))
				attachSnaplineCurrentContext(failure, file, line, line)
				if change := snaplineChangeUsingLine(changes, line); change != nil {
					failure.Group = change.group
					failure.GroupIndex = new(int)
					*failure.GroupIndex = change.groupIndex
				}
				return failure
			}
		}
	}
	for _, change := range changes {
		if change.consumedLines() == 0 {
			boundaryProofLine := change.oldEnd
			if change.group == "insertion_before" {
				boundaryProofLine = change.oldStart
			}
			if _, ok := proofLines[boundaryProofLine]; !ok {
				failure := snaplineChangeFailure("insufficient_read_proof", fmt.Sprintf("%s %d requires proof for boundary line %d", change.group, change.groupIndex, boundaryProofLine), change.group, change.groupIndex)
				attachSnaplineCurrentContext(failure, file, boundaryProofLine, boundaryProofLine)
				return failure
			}
			continue
		}
		for line := change.oldStart; line <= change.oldEnd; line++ {
			if _, ok := proofLines[line]; ok {
				continue
			}
			failure := snaplineChangeFailure("insufficient_read_proof", fmt.Sprintf("%s %d requires proof for line %d", change.group, change.groupIndex, line), change.group, change.groupIndex)
			attachSnaplineCurrentContext(failure, file, change.oldStart, change.oldEnd)
			return failure
		}
	}
	return nil
}

func changeUsesSnaplineLine(change plannedSnaplineChange, line int) bool {
	if change.consumedLines() == 0 {
		if change.group == "insertion_before" {
			return change.oldStart == line
		}
		return change.oldEnd == line
	}
	return line >= change.oldStart && line <= change.oldEnd
}

func snaplineChangeUsingLine(changes []plannedSnaplineChange, line int) *plannedSnaplineChange {
	for index := range changes {
		if changeUsesSnaplineLine(changes[index], line) {
			return &changes[index]
		}
	}
	return nil
}

func effectiveSnaplineChanges(changes []plannedSnaplineChange) []plannedSnaplineChange {
	effective := make([]plannedSnaplineChange, 0, len(changes))
	for _, change := range changes {
		if change.changed {
			effective = append(effective, change)
		}
	}
	return effective
}

func sortSnaplineChanges(changes []plannedSnaplineChange) []plannedSnaplineChange {
	ordered := append([]plannedSnaplineChange(nil), changes...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].boundary != ordered[j].boundary {
			return ordered[i].boundary < ordered[j].boundary
		}
		firstInsertion := ordered[i].consumedLines() == 0
		secondInsertion := ordered[j].consumedLines() == 0
		if firstInsertion != secondInsertion {
			return firstInsertion
		}
		if ordered[i].group != ordered[j].group {
			return snaplineGroupOrder(ordered[i].group) < snaplineGroupOrder(ordered[j].group)
		}
		return ordered[i].groupIndex < ordered[j].groupIndex
	})
	return ordered
}

func snaplineGroupOrder(group string) int {
	switch group {
	case "replacement":
		return 0
	case "deletion":
		return 1
	case "insertion_before":
		return 2
	case "insertion_after":
		return 3
	default:
		return 4
	}
}

func rebuildSnaplineLines(source []string, effective []plannedSnaplineChange, finalCount int) []string {
	ordered := sortSnaplineChanges(effective)
	rebuilt := make([]string, 0, finalCount)
	cursor := 0
	for _, change := range ordered {
		rebuilt = append(rebuilt, source[cursor:change.boundary]...)
		rebuilt = append(rebuilt, change.produced...)
		if change.consumedLines() == 0 {
			cursor = change.boundary
		} else {
			cursor = change.oldEnd
		}
	}
	return append(rebuilt, source[cursor:]...)
}

func snaplineLineSplices(effective []plannedSnaplineChange) []LineSplice {
	ordered := sortSnaplineChanges(effective)
	splices := make([]LineSplice, 0, len(ordered))
	for _, change := range ordered {
		splices = append(splices, LineSplice{
			SourceStart: change.oldStart,
			SourceEnd:   change.oldEnd,
			LineDelta:   change.lineDelta(),
		})
	}
	return splices
}

func zeroLineSnaplineEndings(lineCount int, endsWithLF bool) []LineEnding {
	endings := make([]LineEnding, lineCount)
	for index := 0; index < lineCount-1; index++ {
		endings[index] = LFLineEnding
	}
	if lineCount > 0 && endsWithLF {
		endings[lineCount-1] = LFLineEnding
	}
	return endings
}

func buildSnaplineStats(all, effective []plannedSnaplineChange, oldLineCount int) SnaplineApplyStats {
	stats := SnaplineApplyStats{RequestedChanges: len(all), EffectiveChanges: len(effective), OldLineCount: oldLineCount}
	for _, change := range effective {
		stats.InsertedLines += len(change.produced)
		stats.DeletedLines += change.consumedLines()
	}
	stats.NewLineCount = oldLineCount + stats.InsertedLines - stats.DeletedLines
	return stats
}

func buildSnaplineEffects(all, effective []plannedSnaplineChange) []SnaplineEditEffect {
	effects := make([]SnaplineEditEffect, 0, len(all))
	for _, change := range all {
		newStart := change.oldStart
		if change.consumedLines() == 0 {
			newStart = change.boundary + 1
			for _, prior := range effective {
				if prior.group == change.group && prior.groupIndex == change.groupIndex {
					continue
				}
				if prior.consumedLines() > 0 {
					if prior.oldEnd <= change.boundary {
						newStart += prior.lineDelta()
					}
				} else if prior.boundary < change.boundary {
					newStart += prior.lineDelta()
				}
			}
		} else {
			for _, prior := range effective {
				if prior.group == change.group && prior.groupIndex == change.groupIndex {
					continue
				}
				if prior.consumedLines() > 0 {
					if prior.oldEnd < change.oldStart {
						newStart += prior.lineDelta()
					}
				} else if prior.boundary < change.oldStart {
					newStart += prior.lineDelta()
				}
			}
		}
		effects = append(effects, SnaplineEditEffect{
			Group:        change.group,
			GroupIndex:   change.groupIndex,
			Changed:      change.changed,
			OldStart:     change.oldStart,
			OldEnd:       change.oldEnd,
			NewLineCount: len(change.produced),
			LineDelta:    change.lineDelta(),
			NewStart:     newStart,
			NewEnd:       newStart + len(change.produced) - 1,
		})
	}
	return effects
}

func attachApproximateSnaplineRequestedContext(failure *SnaplineLogicalFailure, file LoadedTextFile, request SnaplineApplyRequest) {
	windows := make([]SnaplineReadWindow, 0, len(request.Replacements)+len(request.Deletions)+len(request.InsertionsBefore)+len(request.InsertionsAfter))
	include := func(start, end int) {
		if len(file.Lines) == 0 {
			windows = append(windows, SnaplineReadWindow{Offset: 1, Limit: 1})
			return
		}
		if start < 1 {
			start = 1
		}
		if start > len(file.Lines) {
			start = len(file.Lines)
		}
		if end < start {
			end = start
		}
		if end > len(file.Lines) {
			end = len(file.Lines)
		}
		windows = append(windows, SnaplineReadWindow{Offset: start, Limit: end - start + 1})
	}
	for _, replacement := range request.Replacements {
		include(replacement.Start, replacement.End)
	}
	for _, deletion := range request.Deletions {
		include(deletion.Start, deletion.End)
	}
	for _, insertion := range request.InsertionsBefore {
		include(insertion.Line, insertion.Line)
	}
	for _, insertion := range request.InsertionsAfter {
		include(insertion.Line, insertion.Line)
	}

	failure.CurrentRevision = file.Revision
	normalized := normalizeSnaplineWindows(windows, len(file.Lines))
	failure.RequiredRanges = make([]SnaplineSourceRange, len(normalized))
	for index, window := range normalized {
		failure.RequiredRanges[index] = SnaplineSourceRange{Start: window.start, End: window.end}
	}
	failure.Contexts, failure.OmittedRanges = collectSnaplineReadContexts(file.Lines, windows)
	for index := range failure.Contexts {
		failure.Contexts[index].Approximate = true
	}
	for index := range failure.OmittedRanges {
		failure.OmittedRanges[index].Approximate = true
	}
}
