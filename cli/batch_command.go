package main

import (
	"errors"
	"fmt"
)

func loadRequestedBatchPlan(path string) (LoadedTextFile, BatchPlan, bool) {
	request, err := parseBatchRequest()
	if err != nil {
		emitBatchInvalidError(fmt.Sprintf("invalid batch request: %s", err.Error()), -1)
		return LoadedTextFile{}, BatchPlan{}, false
	}
	if len(request.Edits) == 0 {
		emitBatchInvalidError("batch request contains no edits", -1)
		return LoadedTextFile{}, BatchPlan{}, false
	}

	file, loadErr := loadEditableFile(path)
	if loadErr != nil {
		return LoadedTextFile{}, BatchPlan{}, false
	}
	plan, failure := planBatchEdits(request, file.Lines, file.Revision)
	if failure != nil {
		emitBatchErrorType(
			failure.Code,
			failure.Message,
			failure.Remaps,
			failure.FailedEdit,
			failure.CurrentAnchors,
			failure.CurrentRevision,
		)
		return LoadedTextFile{}, BatchPlan{}, false
	}
	return file, plan, true
}

func batchEditResultFromPlan(plan BatchPlan, revision string) BatchEditResult {
	return BatchEditResult{
		OK:               true,
		FirstChangedLine: plan.FirstChanged,
		LastChangedLine:  plan.LastChanged,
		LinesAdded:       plan.LinesAdded,
		LinesDeleted:     plan.LinesDeleted,
		EditsApplied:     len(plan.Edits),
		ContentChanged:   plan.ContentChanged,
		Revision:         revision,
	}
}

func runBatchCheck(path string) error {
	file, plan, ok := loadRequestedBatchPlan(path)
	if !ok {
		return nil
	}
	result := batchEditResultFromPlan(plan, file.Revision)
	result.Checked = true
	return emitJSON(result)
}

func runBatchApply(path string) error {
	file, plan, ok := loadRequestedBatchPlan(path)
	if !ok {
		return nil
	}

	joined := ""
	revision := file.Revision
	if plan.ContentChanged {
		joined = file.JoinLines(plan.RebuiltLines)
		revision = rawFileRevision([]byte(joined))
	}
	result := batchEditResultFromPlan(plan, revision)
	result.UpdatedAnchors = buildUpdatedAnchorContext(
		plan.RebuiltLines,
		plan.FirstChanged,
		plan.LastChanged,
		plan.LinesAdded,
	)
	if !plan.ContentChanged {
		return emitJSON(result)
	}
	writeWarning, err := atomicWriteIfRevision(path, []byte(joined), file.Revision)
	if err != nil {
		var changedErr *sourceChangedBeforeCommitError
		if errors.As(err, &changedErr) {
			emitBatchErrorType("source_changed_before_commit", changedErr.Error(), nil, -1, nil, changedErr.CurrentRevision)
			return nil
		}
		emitError("io", err.Error())
		return nil
	}
	if writeWarning != "" {
		result.Warnings = []string{writeWarning}
	}
	return emitJSON(result)
}

func emitBatchInvalidError(msg string, failed int) error {
	return emitBatchErrorType("invalid", msg, nil, failed, nil, "")
}

func emitBatchErrorType(errType, msg string, remaps []Remap, failed int, currentAnchors *AnchorContext, currentRevision string) error {
	return emitJSON(BatchEditError{
		OK:              false,
		Error:           errType,
		Message:         msg,
		Remaps:          remaps,
		Failed:          failed,
		CurrentAnchors:  currentAnchors,
		CurrentRevision: currentRevision,
	})
}
