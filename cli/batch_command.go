package main

import (
	"errors"
	"fmt"
	"strings"
)

// loadRequestedBatchPlan 在 check/apply 共同入口完成请求解析、加载与规划；ok 为 false 时
// 失败响应已写出，err 只报告写出本身失败。
func loadRequestedBatchPlan(path string) (file LoadedTextFile, plan BatchPlan, ok bool, err error) {
	request, parseErr := parseBatchRequest()
	if parseErr != nil {
		return file, plan, false, emitBatchInvalidError(fmt.Sprintf("invalid batch request: %s", parseErr.Error()), -1)
	}

	file, loaded := loadCommandTextFile(path)
	if !loaded {
		return file, plan, false, nil
	}
	plan, failure := planBatchEdits(request, file.Lines, file.Revision)
	if failure != nil {
		return file, plan, false, emitBatchErrorType(
			failure.Code,
			failure.Message,
			failure.Remaps,
			failure.FailedEdit,
			failure.CurrentAnchors,
			failure.CurrentRevision,
		)
	}
	if !file.HasUTF8BOM && len(plan.RebuiltLines) > 0 && strings.HasPrefix(plan.RebuiltLines[0], utf8BOM) {
		// [喵喵喵]: 无 BOM 文件的首字符 FEFF 会被读取器当元数据吞掉；包括删除前行造成的位移。(2026-09-24)
		return file, plan, false, emitBatchInvalidError("result would reinterpret leading U+FEFF text as a UTF-8 BOM; keep it out of the first text position", -1)
	}
	return file, plan, true, nil
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
		EditDeltas:       plan.EditDeltas,
	}
}

func runBatchCheck(path string) error {
	file, plan, ok, err := loadRequestedBatchPlan(path)
	if !ok {
		return err
	}
	result := batchEditResultFromPlan(plan, file.Revision)
	result.Checked = true
	return emitJSON(result)
}

func runBatchApply(path string) error {
	file, plan, ok, err := loadRequestedBatchPlan(path)
	if !ok {
		return err
	}

	var encoded []byte
	revision := file.Revision
	if plan.ContentChanged {
		encoded = file.EncodeContent(plan.RebuiltLines, rebuiltLineEndings(file, plan.EditDeltas, plan.RebuiltLines))
		revision = rawFileRevision(encoded)
	}
	result := batchEditResultFromPlan(plan, revision)
	result.UpdatedAnchorSpans = buildUpdatedAnchorSpans(plan.RebuiltLines, plan.EditDeltas)
	if !plan.ContentChanged {
		return emitJSON(result)
	}
	writeWarning, err := atomicWriteIfRevision(path, encoded, file.Revision)
	if err != nil {
		var changedErr *sourceChangedBeforeCommitError
		if errors.As(err, &changedErr) {
			return emitBatchErrorType("source_changed_before_commit", changedErr.Error(), nil, -1, nil, changedErr.CurrentRevision)
		}
		var unknownErr *writeOutcomeUnknownError
		if errors.As(err, &unknownErr) {
			// [喵喵喵]: 非零退出沿用插件的 outcome_unknown 路径，防止被当作确定零写入并继续复用 proof。(2026-09-24)
			return err
		}
		return emitError("io", err.Error())
	}
	if writeWarning != "" {
		result.Warnings = append(result.Warnings, writeWarning)
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
