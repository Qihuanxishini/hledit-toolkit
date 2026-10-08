import { anchorTokenLine, lineFromAnchor } from "./anchor.ts";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { formatUpdatedAnchorSpans, parseAnchorContext, parseUpdatedAnchorSpans, type BatchAnchorContext } from "./post-edit-context.ts";
import { suggestedReadWindow } from "./read-args.ts";
import {
	isIntegerAtLeast,
	isRawRevision,
	isRecord,
	parseEditDeltas,
	parseRunObject,
	producedLineRangesFromEditDeltas,
	unavailableToolResult,
	type FileChangeAnchorField,
	type HleditDisposition,
	type HleditEditDelta,
	type HleditErrorMetadata,
	type HleditStaleAnchor,
	type TextResult,
} from "./result.ts";
import type { FileChangeParams } from "./schema.ts";

// batch apply/--check 响应的严格校验、错误本地化与模型正文排版。

export type ApplyResultContext = {
	path?: string;
	changes?: FileChangeParams["changes"];
};

function lineDeltaSummary(parsed: Record<string, unknown>): string {
	return `+${parsed.linesAdded as number} -${parsed.linesDeleted as number}`;
}

function appendRemaps(
	lines: string[],
	result: Record<string, unknown>,
	staleAnchors: HleditStaleAnchor[] | undefined,
): void {
	if (!Array.isArray(result.remaps) || result.remaps.length === 0) {
		return;
	}

	const represented = new Set(
		staleAnchors?.map((anchor) => `${anchor.requestedAnchor}\0${anchor.currentAnchor ?? ""}`) ?? [],
	);
	const rendered = new Set<string>();
	for (const remap of result.remaps) {
		if (!isRecord(remap)) {
			continue;
		}
		const requested = typeof remap.requested === "string" ? remap.requested : undefined;
		const current = typeof remap.current === "string" ? remap.current : undefined;
		if (requested && represented.has(`${requested}\0${current ?? ""}`)) {
			continue;
		}
		const text = requested && current ? `- ${requested} -> ${current}` : requested ? `- ${requested}` : undefined;
		if (text) {
			rendered.add(text);
		}
	}
	if (rendered.size > 0) {
		lines.push("Other stale anchors:", ...rendered);
	}
}

function changeAnchorFields(change: FileChangeParams["changes"][number]): Array<[FileChangeAnchorField, string]> {
	switch (change.operation) {
		case "replace_range":
		case "delete_range":
			return [
				["start_anchor", change.start_anchor],
				["end_anchor", change.end_anchor],
			];
		case "insert_before":
		case "insert_after":
			return [["anchor", change.anchor]];
	}
}

function parseStaleAnchors(
	result: Record<string, unknown>,
	currentAnchors: BatchAnchorContext | undefined,
	context: ApplyResultContext,
): HleditStaleAnchor[] | undefined {
	if (!isIntegerAtLeast(result.failed, 0) || !Array.isArray(result.remaps)) {
		return undefined;
	}
	const change = context.changes?.[result.failed];
	if (!change) {
		return undefined;
	}

	const staleAnchors: HleditStaleAnchor[] = [];
	for (const [field, requestedAnchor] of changeAnchorFields(change)) {
		const remap = result.remaps.find(
			(candidate) => isRecord(candidate) && candidate.requested === requestedAnchor,
		);
		if (!isRecord(remap)) {
			continue;
		}
		const currentAnchor =
			anchorTokenLine(remap.current) !== undefined ? remap.current as string : undefined;
		const existing = staleAnchors.find(
			(candidate) => candidate.requestedAnchor === requestedAnchor && candidate.currentAnchor === currentAnchor,
		);
		if (existing) {
			existing.fields.push(field);
			continue;
		}
		const currentLine = currentAnchor
			? currentAnchors?.lines.find((line) => line.anchor === currentAnchor)
			: undefined;
		staleAnchors.push({
			changeNumber: result.failed + 1,
			fields: [field],
			requestedAnchor,
			...(currentAnchor ? { currentAnchor } : {}),
			...(currentLine ? { currentText: currentLine.text } : {}),
			...(currentLine?.textTruncated ? { currentTextTruncated: true as const } : {}),
		});
	}
	return staleAnchors.length > 0 ? staleAnchors : undefined;
}

function appendStaleAnchorDetails(lines: string[], staleAnchors: HleditStaleAnchor[] | undefined): void {
	if (!staleAnchors) {
		return;
	}

	lines.push(`Anchor verification for change ${staleAnchors[0]!.changeNumber}:`);
	for (const staleAnchor of staleAnchors) {
		const fields = staleAnchor.fields.join("/");
		lines.push(`- Field: ${fields}`, `  Submitted anchor: ${staleAnchor.requestedAnchor}`);
		if (staleAnchor.currentAnchor) {
			const annotatedAnchor =
				staleAnchor.currentText === undefined
					? staleAnchor.currentAnchor
					: `${staleAnchor.currentAnchor}:${staleAnchor.currentText}${staleAnchor.currentTextTruncated ? " (text truncated)" : ""}`;
			lines.push(
				`  Current line at the same number: ${annotatedAnchor}`,
				`  After verifying the intended target, explicitly replace ${fields} with ${staleAnchor.currentAnchor} in a new request.`,
			);
		} else {
			lines.push("  The current line no longer exists; reread the affected range.");
		}
	}
	lines.push("This information is for verification only. The tool never repairs anchors or retries a batch automatically.");
}

function appendCurrentAnchorContext(lines: string[], context: BatchAnchorContext | undefined): void {
	if (!context) {
		return;
	}
	const lastLine = context.limit === 0 ? undefined : context.offset + context.limit - 1;
	lines.push(lastLine === undefined
		? "Current anchor snapshot at submission time (the file is empty):"
		: `Current anchor snapshot at submission time (local span: lines ${context.offset}-${lastLine}):`);
	lines.push(context.lines.map((line) => `${line.anchor}:${line.text}`).join("\n") || "(file is empty)");
	if (context.truncated || context.lines.some((line) => line.textTruncated)) {
		lines.push("The current snapshot is truncated and cannot establish complete read proof.");
	}
}

function staleReadInstruction(result: Record<string, unknown>, context: ApplyResultContext): string {
	const genericInstruction = "Before retrying, call hledit_read_anchors to reread the affected range. Do not reuse anchors from before the change.";
	if (!context.path) return genericInstruction;
	const failed = isIntegerAtLeast(result.failed, 0) ? result.failed : 0;
	const change = context.changes?.[failed];
	const targetLines = change ? changeAnchorFields(change).flatMap(([, anchor]) => {
		const line = lineFromAnchor(anchor);
		return line === undefined ? [] : [line];
	}) : [];
	if (targetLines.length === 0 && Array.isArray(result.remaps)) {
		for (const remap of result.remaps) {
			if (!isRecord(remap)) continue;
			const line = anchorTokenLine(remap.current ?? remap.requested);
			if (line !== undefined) targetLines.push(line);
		}
	}
	if (targetLines.length === 0) return genericInstruction;
	const end = Math.max(...targetLines);
	const { offset, limit, lastLine } = suggestedReadWindow(Math.min(...targetLines), end);
	return `Before retrying, call hledit_read_anchors({ path: ${JSON.stringify(context.path)}, offset: ${offset}, limit: ${limit} })${lastLine < end ? `, then continue with nextOffset through line ${end}` : ""}. Reconfirm the intended target; prior line numbers may have shifted. Do not reuse anchors from before the change.`;
}

function localizeInvalidApplyMessage(rawMessage: string, failedChange: number | undefined): string {
	const prefix = failedChange === undefined ? "The batch request" : `Change ${failedChange}`;
	const unknownField = /unknown field "([^"]+)"/.exec(rawMessage);
	if (unknownField) return `The batch JSON contains unsupported field ${JSON.stringify(unknownField[1])}. Check the field spelling.`;
	if (rawMessage.includes("batch request contains no edits")) return "The batch contains no changes.";
	if (rawMessage.includes("contains NUL")) return `${prefix} contains a NUL character. Remove the actual NUL from lines; literal source-code escape sequences are allowed.`;
	if (rawMessage.includes("contains LF")) return `${prefix} contains LF inside a CLI line-array element. Each element must contain exactly one logical line.`;
	if (rawMessage.includes("reinterpret leading U+FEFF")) return "The batch would reinterpret leading U+FEFF text as a UTF-8 BOM. Keep that character out of the first text position; existing file BOM metadata is preserved.";
	if (rawMessage.includes("invalid batch request")) return "The batch JSON shape is invalid and could not be parsed.";
	if (rawMessage.includes("invalid end anchor")) return `${prefix} has an invalid end_anchor format.`;
	if (rawMessage.includes("invalid anchor")) return `${prefix} has an invalid anchor format.`;
	if (rawMessage.includes("start line") && rawMessage.includes("> end line")) return `${prefix} starts after its end line.`;
	if (rawMessage.includes("insert does not accept end_pos")) return `${prefix} is an insert and cannot include end_anchor.`;
	if (rawMessage.includes("insert requires non-empty content")) return `${prefix} is an insert and lines must contain at least one line.`;
	if (rawMessage.includes("unknown op")) return `${prefix} uses an unsupported operation.`;
	if (rawMessage.includes("overlaps") || rawMessage.includes("conflicts") || rawMessage.includes("already consumed range")) {
		return `${prefix} overlaps another change in the same batch. Merge them or make the changes non-overlapping.`;
	}
	return `${prefix} is invalid. Check operation, anchors, range order, and lines.`;
}

function localizeIOApplyMessage(rawMessage: string): string {
	const hardLinks = /file has (\d+) hard links/.exec(rawMessage);
	if (hardLinks) {
		return `The target has ${hardLinks[1]} hard links. The write was rejected because preserving link identity would require a non-atomic update.`;
	}
	if (rawMessage.includes("non-regular file")) return "The target is not a regular file, so the write was rejected.";
	if (rawMessage.includes("could not be read")) return "The target could not be read. Check its path, permissions, and whether it still exists.";
	if (rawMessage.includes("resolve target")) return "The target could not be resolved; its symlink may be broken or inaccessible.";
	if (rawMessage.includes("resolve parent")) return "The target directory could not be resolved.";
	if (rawMessage.includes("inspect hard links")) return "The target hard-link state could not be verified, so the write was rejected.";
	if (rawMessage.includes("create temporary sibling")) return "The temporary sibling required for an atomic write could not be created.";
	if (rawMessage.includes("preserve permissions")) return "The original file permissions could not be copied to the temporary file.";
	if (rawMessage.includes("write temporary file")) return "Writing the temporary file failed; the target was left unchanged.";
	if (rawMessage.includes("synchronize temporary file")) return "Synchronizing the temporary file failed; the target was left unchanged.";
	if (rawMessage.includes("close temporary file")) return "Closing the temporary file failed; the target was left unchanged.";
	if (rawMessage.includes("original file was restored unchanged")) return "The atomic target replacement failed partway, and the original file was restored unchanged.";
	if (rawMessage.includes("replace target")) return "The atomic target replacement failed.";
	return "The file operation failed. Check the path, permissions, file type, and link state.";
}

function parseApplyErrorMetadata(result: Record<string, unknown>, context: ApplyResultContext): HleditErrorMetadata | undefined {
	if (result.ok !== false || typeof result.error !== "string" || typeof result.message !== "string") return undefined;
	const failedChange = isIntegerAtLeast(result.failed, 0) ? result.failed + 1 : undefined;
	const currentAnchors = result.error === "stale" ? parseAnchorContext(result.currentAnchors) : undefined;
	const staleAnchors = result.error === "stale" ? parseStaleAnchors(result, currentAnchors, context) : undefined;
	const currentRevision = isRawRevision(result.currentRevision) ? result.currentRevision : undefined;
	let message: string;
	switch (result.error) {
		case "stale":
			message = result.message === "read proof revision does not match the current file"
				? "The file revision changed since the read; the whole batch needs verification, even if its endpoint anchors still match."
				: failedChange === undefined ? "One or more anchors are stale." : `Change ${failedChange} uses a stale anchor.`;
			break;
		case "insufficient_read_proof":
			message = "Read proof does not cover every original source line required by this change.";
			break;
		case "source_changed_before_commit":
			message = "The target changed before atomic commit. No content was written.";
			break;
		case "invalid":
			message = localizeInvalidApplyMessage(result.message, failedChange);
			break;
		case "binary":
			message = "The target appears to be binary and cannot be modified as text.";
			break;
		case "encoding":
			message = "The target is not valid UTF-8 text; the edit was rejected to protect the original bytes.";
			break;
		case "directory":
			message = "The provided path is a directory, but hledit edits one concrete text file at a time.";
			break;
		case "io":
			message = localizeIOApplyMessage(result.message);
			break;
		default:
			message = `hledit rejected this edit (error code: ${result.error}).`;
	}
	return {
		code: result.error,
		message,
		rawMessage: result.message,
		...(staleAnchors ? { staleAnchors } : {}),
		...(currentAnchors ? { currentAnchors } : {}),
		...(currentRevision ? { currentRevision } : {}),
	};
}

// 模型可见正文统一英文；details 中保留 rawWarnings 原文供诊断。
function localizeApplyWarning(warning: string): string {
	if (warning.startsWith("file was replaced, but directory metadata could not be synchronized:")) {
		return "The file content was replaced, but directory metadata could not be synchronized; durability may be reduced in extreme scenarios such as power loss.";
	}
	if (warning.startsWith("file was replaced, but original recovery file ")) return warning;
	return "The file was modified successfully, but the write carries a durability warning; technical details are preserved in the tool result.";
}

// [喵喵喵]: CLI proof 拒绝在本地 evidence 选择之后理论上不可达，但既然仍被定义为
// 可恢复结果，兜底正文也必须给出具体补读动作。(2026-07-28)
function appendInsufficientReadProofRecovery(
	lines: string[],
	result: Record<string, unknown>,
	context: ApplyResultContext,
	error: HleditErrorMetadata,
): void {
	if (error.code !== "insufficient_read_proof") return;
	const failedIndex = isIntegerAtLeast(result.failed, 0) ? result.failed : undefined;
	const change = failedIndex === undefined ? undefined : context.changes?.[failedIndex];
	const resubmitInstruction = "use proof_id from the latest successful read page and current anchors, then resubmit the hledit_apply_file_changes batch.";
	const genericInstruction = context.path
		? `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)} }) to reread every source line required by the failed change, then ${resubmitInstruction}`
		: `Call hledit_read_anchors to reread every source line required by the failed change, then ${resubmitInstruction}`;
	if (failedIndex === undefined || !context.path || !change) {
		lines.push(genericInstruction);
		return;
	}

	let start: number | undefined;
	let end: number | undefined;
	if (change.operation === "insert_before" || change.operation === "insert_after") {
		start = lineFromAnchor(change.anchor);
		end = start;
	} else {
		start = lineFromAnchor(change.start_anchor);
		end = lineFromAnchor(change.end_anchor);
	}
	if (start === undefined || end === undefined || end < start) {
		lines.push(genericInstruction);
		return;
	}

	const changeNumber = failedIndex + 1;
	const { offset, limit, lastLine: lastSuggestedLine } = suggestedReadWindow(start, end);
	lines.push(lastSuggestedLine < end
		? `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)}, offset: ${offset}, limit: ${limit} }) first, continue with nextOffset until line ${end} is covered, then ${resubmitInstruction}`
		: `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)}, offset: ${offset}, limit: ${limit} }) to reread every source line required by change ${changeNumber}, then ${resubmitInstruction}`);
}
function formatApplyFailureResult(
	result: Record<string, unknown>,
	context: ApplyResultContext,
	error: HleditErrorMetadata,
): string {
	const lines = [
		"The atomic batch was rejected; no content was written.",
		`Reason: ${error.message}`,
		`Error code: ${error.code}`,
	];
	// [喵喵喵]: I/O 原文含操作阶段与系统错误码，不能只存 details 或被通用摘要替代。
	if (error.code === "io" && error.rawMessage) {
		lines.push(`Diagnostic: ${error.rawMessage}`);
	}
	if (isIntegerAtLeast(result.failed, 0)) {
		lines.push(`Failed change: ${result.failed + 1}`);
	}
	appendStaleAnchorDetails(lines, error.staleAnchors);
	appendRemaps(lines, result, error.staleAnchors);
	if (error.code === "stale") {
		appendCurrentAnchorContext(lines, error.currentAnchors);
		if (error.currentRevision && error.currentAnchors && !error.currentAnchors.truncated && !error.currentAnchors.lines.some((line) => line.textTruncated)) {
			lines.push("Review this current snapshot before submitting a new batch. It covers only the displayed span; reread any other required ranges and use the returned proof_id and current anchors. The tool does not retry automatically.");
		} else {
			lines.push(staleReadInstruction(result, context));
		}
	}
	if (error.code === "source_changed_before_commit") {
		lines.push(staleReadInstruction(result, context));
	}
	appendInsufficientReadProofRecovery(lines, result, context, error);
	return lines.join("\n");
}

function appendApplyWarnings(lines: string[], result: Record<string, unknown>): void {
	if (!Array.isArray(result.warnings)) {
		return;
	}
	const warnings = result.warnings.filter((warning): warning is string => typeof warning === "string");
	if (warnings.length === 0) {
		return;
	}
	lines.push("Warnings:", ...warnings.map((warning) => `- ${localizeApplyWarning(warning)}`));
}

function formatApplyResult(result: Record<string, unknown>): string {
	if (result.contentChanged === false) {
		const lines = ["No changes were needed; the original anchors are still valid."];
		appendApplyWarnings(lines, result);
		return lines.join("\n");
	}
	const editsApplied = result.editsApplied as number;
	const changeLabel = editsApplied === 1 ? "change" : "changes";
	const lines = [`Applied ${editsApplied} ${changeLabel}; line delta: ${lineDeltaSummary(result)}.`];
	appendApplyWarnings(lines, result);
	return lines.join("\n");
}

// 从公开 changes 复算 CLI 必须返回的 editDeltas。物理输出顺序 = boundary（恒等于
// oldStart-1）升序；同一 boundary 上 insert 的空区间 oldEnd 更小，因此 (oldStart, oldEnd)
// 双键升序即可精确复现 CLI sortEditsForRebuild 的顺序。改动 CLI 排序或 delta 语义
// 属于协议升级，必须两侧同步。
function expectedBatchEditDeltas(changes: FileChangeParams["changes"]): HleditEditDelta[] | undefined {
	const deltas: HleditEditDelta[] = [];
	for (const change of changes) {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			const line = lineFromAnchor(change.anchor);
			if (line === undefined) return undefined;
			const oldStart = change.operation === "insert_before" ? line : line + 1;
			deltas.push({ oldStart, oldEnd: oldStart - 1, delta: change.lines.length });
			continue;
		}
		const start = lineFromAnchor(change.start_anchor);
		const end = lineFromAnchor(change.end_anchor);
		if (start === undefined || end === undefined || end < start) return undefined;
		const replacementCount = change.operation === "replace_range" ? change.lines.length : 0;
		deltas.push({ oldStart: start, oldEnd: end, delta: replacementCount - (end - start + 1) });
	}
	return deltas.sort((left, right) => left.oldStart - right.oldStart || left.oldEnd - right.oldEnd);
}

// editDeltas 驱动证据重映射与锚点更名，必须与请求可精确互推；对不上时按不兼容
// 成功响应处理（outcome_unknown），宁可多一轮重读也不用可疑数据平移证据。
function editDeltasMatchRequest(deltas: HleditEditDelta[], context: ApplyResultContext): boolean {
	if (!context.changes) return true;
	const expected = expectedBatchEditDeltas(context.changes);
	if (!expected || expected.length !== deltas.length) return false;
	return expected.every((delta, index) =>
		deltas[index]!.oldStart === delta.oldStart &&
		deltas[index]!.oldEnd === delta.oldEnd &&
		deltas[index]!.delta === delta.delta,
	);
}

function parseApplySuccess(
	parsed: Record<string, unknown> | null,
	context: ApplyResultContext,
): { editDeltas: HleditEditDelta[]; updatedAnchorSpans: BatchAnchorContext[] } | undefined {
	if (parsed?.ok !== true || !isRawRevision(parsed.revision)) return undefined;
	if (typeof parsed.editsApplied !== "number" || !Number.isSafeInteger(parsed.editsApplied) || parsed.editsApplied < 0) return undefined;
	if (context.changes && parsed.editsApplied !== context.changes.length) return undefined;
	if (parsed.contentChanged !== undefined && typeof parsed.contentChanged !== "boolean") return undefined;
	if (parsed.warnings !== undefined && (!Array.isArray(parsed.warnings) || !parsed.warnings.every((warning) => typeof warning === "string"))) return undefined;
	// bundled CLI 恒输出 linesAdded/linesDeleted（无 omitempty）；delta 总和是同一份
	// 统计的另一投影，二者不一致即内部矛盾。
	if (!isIntegerAtLeast(parsed.linesAdded, 0) || !isIntegerAtLeast(parsed.linesDeleted, 0)) return undefined;
	const editDeltas = parseEditDeltas(parsed.editDeltas);
	if (!editDeltas || editDeltas.length !== parsed.editsApplied) return undefined;
	if (editDeltas.reduce((sum, delta) => sum + delta.delta, 0) !== parsed.linesAdded - parsed.linesDeleted) return undefined;
	if (!editDeltasMatchRequest(editDeltas, context)) return undefined;
	// 产出 span必须与 editDeltas 换算出的非空产出区间逐项对应：窗口是 evidence 合并与
	// 模型正文的直接来源，对不上就不能当成功结果消费。
	const spans = parseUpdatedAnchorSpans(parsed.updatedAnchorSpans);
	if (!spans) return undefined;
	const producedRanges = producedLineRangesFromEditDeltas(editDeltas).filter((range) => range.end >= range.start);
	if (spans.length !== producedRanges.length) return undefined;
	if (!spans.every((span, index) =>
		span.offset === producedRanges[index]!.start &&
		span.desiredLimit === producedRanges[index]!.end - producedRanges[index]!.start + 1,
	)) return undefined;
	return { editDeltas, updatedAnchorSpans: spans };
}

function isValidFileChangeCheckSuccess(parsed: Record<string, unknown> | null): boolean {
	return (
		parsed?.ok === true &&
		parsed.checked === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		parsed.editsApplied >= 0 &&
		typeof parsed.contentChanged === "boolean"
		&& isRawRevision(parsed.revision)
	);
}

function invalidFileChangeCheckText(): string {
	return "hledit returned an incompatible --check response, so no write was attempted. Call hledit_read_anchors to inspect the target before retrying.";
}

function invalidApplySuccessText(): string {
	return `The bundled hledit returned an incompatible success response. The file may have changed; call hledit_read_anchors before retrying. Expected ok:true, a valid revision, editsApplied and editDeltas consistent with the request, line-count statistics, and updatedAnchorSpans matching the produced ranges.\n\n${HLEDIT_INSTALL_HINT}`;
}

function outcomeUnknownText(run: HleditRun): string {
	const rawDiagnostic = run.stdout.trimEnd() || run.stderr.trimEnd();
	const recoveryFilesRetained = rawDiagnostic.includes("recovery files were retained");
	// [喵喵喵]: 恢复路径是人工找回数据的依据，不能按普通错误预算截断；子进程输出已有总上限。(2026-09-24)
	const diagnostic = recoveryFilesRetained ? rawDiagnostic : rawDiagnostic.slice(0, 800);
	const lines = [
		"The hledit write outcome is unknown; the file may already have changed. Do not retry the original request.",
		// [喵喵喵]: 保留恢复文件时目标可能已不存在，重读会失败并诱导模型凭记忆重建文件。(2026-09-24)
		recoveryFilesRetained
			? "The target may be missing or replaced: the original content is in the recovery file and the new content is in the replacement candidate listed below. Do not recreate or overwrite the target; report these paths to the user and let them decide how to restore it."
			: "Call hledit_read_anchors to reread the target file first.",
	];
	if (diagnostic) {
		lines.push(`Diagnostic: ${diagnostic}${diagnostic.length < rawDiagnostic.length ? "…" : ""}`);
	}
	return lines.join("\n");
}

function formatApplyRunText(
	run: HleditRun,
	context: ApplyResultContext,
	parsed: Record<string, unknown> | null,
	applySuccessValid: boolean,
	applyError: HleditErrorMetadata | undefined,
): string {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return run.started === false ? text || HLEDIT_INSTALL_HINT : outcomeUnknownText(run);
	}
	if (!text || !parsed) {
		return invalidApplySuccessText();
	}
	if (parsed.ok === false) {
		return applyError ? formatApplyFailureResult(parsed, context, applyError) : invalidApplySuccessText();
	}
	return applySuccessValid ? formatApplyResult(parsed) : invalidApplySuccessText();
}

export function extractCliSummary(parsed: Record<string, unknown> | null): Record<string, unknown> {
	if (!parsed) {
		return {};
	}

	const summary: Record<string, unknown> = {};
	for (const key of ["firstChangedLine", "lastChangedLine", "linesAdded", "linesDeleted", "editsApplied", "checked", "contentChanged"] as const) {
		const value = parsed[key];
		if (typeof value === "number" || typeof value === "boolean") {
			summary[key] = value;
		}
	}
	if (Array.isArray(parsed.warnings) && parsed.warnings.every((warning) => typeof warning === "string")) {
		summary.warnings = parsed.warnings.map(localizeApplyWarning);
		summary.rawWarnings = parsed.warnings;
	}
	if (isRawRevision(parsed.revision)) summary.revision = parsed.revision;
	if (isRawRevision(parsed.currentRevision)) summary.currentRevision = parsed.currentRevision;
	return summary;
}

export function applyFileChangesResult(run: HleditRun, context: ApplyResultContext = {}): TextResult {
	const parsed = parseRunObject(run);
	const success = run.exitCode === 0 ? parseApplySuccess(parsed, context) : undefined;
	const applyError = parsed ? parseApplyErrorMetadata(parsed, context) : undefined;
	const disposition: HleditDisposition =
		run.exitCode !== 0
			? run.started === false
				? "unavailable"
				: "outcome_unknown"
			: parsed?.ok === false
				? applyError
					? "rejected"
					: "unavailable"
				: !success
					? "outcome_unknown"
					: "succeeded";
	// [喵喵喵]: 已验证的 span 同时生成正文和持久化 details；入口无需重新解析 CLI 输出。
	const postEditContext = success ? formatUpdatedAnchorSpans(success.updatedAnchorSpans) : undefined;
	const text = formatApplyRunText(run, context, parsed, success !== undefined, applyError);
	const anchorText = parsed?.contentChanged === false ? undefined : postEditContext?.text;
	return {
		content: [{ type: "text", text: anchorText ? `${text}\n\n${anchorText}` : text }],
		details: {
			disposition,
			...(context.path ? { path: context.path } : {}),
			...extractCliSummary(parsed),
			...success,
			...(postEditContext ? { postEditContext: { truncated: postEditContext.truncated } } : {}),
			...(applyError ? { error: applyError } : {}),
		},
	};
}

export function fileChangeCheckFailure(run: HleditRun, context: ApplyResultContext = {}): TextResult | undefined {
	const parsed = parseRunObject(run);
	if (run.exitCode === 0 && isValidFileChangeCheckSuccess(parsed)) {
		return undefined;
	}
	if (run.exitCode !== 0) {
		const text = run.stdout.trimEnd() || run.stderr.trimEnd() || HLEDIT_INSTALL_HINT;
		return unavailableToolResult(text);
	}
	if (parsed?.ok === true) {
		return unavailableToolResult(invalidFileChangeCheckText());
	}
	return applyFileChangesResult(run, context);
}
