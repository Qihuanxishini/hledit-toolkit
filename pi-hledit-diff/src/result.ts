import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";
import { parseAnchorContext, parseBatchUpdatedAnchorContext, type BatchAnchorContext } from "./post-edit-context.ts";
import type { NormalizedReadRequest } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

export type HleditToolKind = "read_anchors" | "apply_file_changes" | "replace_once";
export type HleditDisposition = "succeeded" | "rejected" | "unavailable" | "outcome_unknown";

export type HleditReadLine = {
	line: number;
	anchor: string;
	text: string;
	textTruncated: boolean;
};

export type HleditReadMetadata = {
	path: string;
	revision: string;
	requested: {
		offset: number;
		limit: number;
		grep?: string;
		context?: number;
	};
	actual: {
		firstLine?: number;
		lastLine?: number;
		lineCount: number;
		totalLines: number;
	};
	lines: HleditReadLine[];
	truncated: boolean;
	nextOffset?: number;
	textTruncated: boolean;
	eof: boolean;
};

export type FileChangeAnchorField = "anchor" | "start_anchor" | "end_anchor";

export type HleditStaleAnchor = {
	changeNumber: number;
	fields: FileChangeAnchorField[];
	requestedAnchor: string;
	currentAnchor?: string;
	currentText?: string;
	currentTextTruncated?: true;
};

export type ContentMatchCandidate = {
	startLine: number;
	endLine: number;
};

export type HleditErrorMetadata = {
	code: string;
	message: string;
	rawMessage?: string;
	hint?: string;
	requestedOffset?: number;
	totalLines?: number;
	changeNumber?: number;
	operation?: "replace_range" | "delete_range" | "insert_before" | "insert_after";
	anchor?: string;
	outputLineCount?: number;
	relatedChangeNumber?: number;
	candidateEndAnchor?: string;
	staleAnchors?: HleditStaleAnchor[];
	currentAnchors?: BatchAnchorContext;
	currentRevision?: string;
	matchCount?: number;
	candidates?: ContentMatchCandidate[];
	candidatesTruncated?: true;
};

type ApplyResultContext = {
	path?: string;
	changes?: FileChangeParams["changes"];
	operation?: "anchored_batch" | "content_replace_once";
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
	path?: string;
	evidencePath?: string;
	revision?: string;
	updatedAnchors?: BatchAnchorContext;
	read?: HleditReadMetadata;
	error?: HleditErrorMetadata;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
};

const READ_ANCHOR_PATTERN = new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`);
const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isRawRevision(value: unknown): value is string {
	return typeof value === "string" && RAW_REVISION_PATTERN.test(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function parseRunObject(run: HleditRun): Record<string, unknown> | null {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	return parseJsonObject(text);
}

function parseReadLine(value: unknown, totalLines: number): HleditReadLine | undefined {
	if (!isRecord(value)) return undefined;
	const { line, anchor, text, textTruncated } = value;
	if (!isIntegerAtLeast(line, 1) || line > totalLines || typeof anchor !== "string" || typeof text !== "string") {
		return undefined;
	}
	if (textTruncated !== undefined && typeof textTruncated !== "boolean") return undefined;
	const anchorMatch = READ_ANCHOR_PATTERN.exec(anchor);
	if (!anchorMatch || Number(anchorMatch[1]) !== line) return undefined;
	return { line, anchor, text, textTruncated: textTruncated === true };
}

function parseReadMetadata(parsed: Record<string, unknown>, request: NormalizedReadRequest): HleditReadMetadata | undefined {
	if (
		parsed.ok !== true ||
		!isRawRevision(parsed.revision) ||
		!isIntegerAtLeast(parsed.totalLines, 0) ||
		!Array.isArray(parsed.lines) ||
		typeof parsed.truncated !== "boolean"
	) {
		return undefined;
	}

	const totalLines = parsed.totalLines;
	const lines: HleditReadLine[] = [];
	let previousLine: number | undefined;
	for (const value of parsed.lines) {
		const line = parseReadLine(value, totalLines);
		if (!line || line.line < request.offset || (previousLine !== undefined && line.line <= previousLine)) return undefined;
		if (!request.grep && previousLine !== undefined && line.line !== previousLine + 1) return undefined;
		lines.push(line);
		previousLine = line.line;
	}
	if (lines.length > request.limit) return undefined;
	if (!request.grep && (lines.length === 0 || lines[0]?.line !== request.offset)) return undefined;

	let nextOffset: number | undefined;
	if (parsed.nextOffset !== undefined) {
		if (!isIntegerAtLeast(parsed.nextOffset, 1)) return undefined;
		nextOffset = parsed.nextOffset;
	}

	const firstLine = lines[0]?.line;
	const lastLine = lines[lines.length - 1]?.line;
	const textTruncated = lines.some((line) => line.textTruncated);
	if (textTruncated && !parsed.truncated) return undefined;
	if (nextOffset !== undefined) {
		if (!parsed.truncated || lastLine === undefined || nextOffset !== lastLine + 1 || nextOffset > totalLines) return undefined;
	}
	if (parsed.truncated && nextOffset === undefined && !textTruncated) return undefined;
	if (!parsed.truncated && nextOffset !== undefined) return undefined;
	if (!request.grep && !parsed.truncated && lastLine !== totalLines) return undefined;

	return {
		path: request.path,
		revision: parsed.revision,
		requested: {
			offset: request.offset,
			limit: request.limit,
			...(request.grep ? { grep: request.grep } : {}),
			...(request.context !== undefined ? { context: request.context } : {}),
		},
		actual: {
			...(firstLine !== undefined ? { firstLine } : {}),
			...(lastLine !== undefined ? { lastLine } : {}),
			lineCount: lines.length,
			totalLines,
		},
		lines,
		truncated: parsed.truncated,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		textTruncated,
		eof: !request.grep && !parsed.truncated && lastLine === totalLines,
	};
}

function localizeReadErrorMessage(
	code: string,
	requestedOffset: number | undefined,
	totalLines: number | undefined,
): string {
	if (code === "range" && requestedOffset !== undefined && totalLines !== undefined) {
		return `Starting line ${requestedOffset} is outside the file range (${totalLines} total lines).`;
	}
	if (code === "binary") {
		return "The target appears to be binary and cannot be read as text.";
	}
	if (code === "encoding") {
		return "The target is not valid UTF-8 text; reading was rejected to protect the original bytes.";
	}
	if (code === "io") {
		return "The file could not be read. Check its path, permissions, and whether it still exists.";
	}
	return `hledit rejected this read (error code: ${code}).`;
}

function parseReadErrorMetadata(parsed: Record<string, unknown>): HleditErrorMetadata | undefined {
	if (parsed.ok !== false || typeof parsed.error !== "string" || typeof parsed.message !== "string") return undefined;
	const requestedOffset = isIntegerAtLeast(parsed.requestedOffset, 1) ? parsed.requestedOffset : undefined;
	const totalLines = isIntegerAtLeast(parsed.totalLines, 0) ? parsed.totalLines : undefined;
	if (parsed.error === "range" && (requestedOffset === undefined || totalLines === undefined)) return undefined;

	let hint: string | undefined;
	if (parsed.error === "range" && totalLines !== undefined) {
		hint = totalLines === 0
			? "The file is empty, so no positive line number can be read."
			: `Set offset to an integer from 1 through ${totalLines}.`;
	}
	return {
		code: parsed.error,
		message: localizeReadErrorMessage(parsed.error, requestedOffset, totalLines),
		rawMessage: parsed.message,
		...(hint ? { hint } : {}),
		...(requestedOffset !== undefined ? { requestedOffset } : {}),
		...(totalLines !== undefined ? { totalLines } : {}),
	};
}

function formatReadMetadata(read: HleditReadMetadata): string {
	const anchoredLines = read.lines.map((line) => `${line.anchor}:${line.text}`);
	const { firstLine, lastLine, lineCount, totalLines } = read.actual;
	const filter = read.requested.grep;
	let notice: string;

	if (read.textTruncated) {
		notice = `-- 源文件内容已截断${lastLine !== undefined ? `，最后返回第 ${lastLine} 行` : ""}（文件共 ${totalLines} 行）；按行续读无法恢复被省略的行内文本 --`;
	} else if (filter) {
		if (lineCount === 0) {
			notice = `-- 文件共 ${totalLines} 行，未找到包含 ${JSON.stringify(filter)} 的内容 --`;
		} else if (read.nextOffset !== undefined) {
			notice = `-- 已返回 ${lineCount} 行匹配结果及上下文，最后到第 ${lastLine} 行（文件共 ${totalLines} 行）；继续读取请使用 offset ${read.nextOffset} --`;
		} else {
			notice = `-- 已返回全部 ${lineCount} 行匹配结果及上下文（文件共 ${totalLines} 行） --`;
		}
	} else if (read.nextOffset !== undefined) {
		notice = `-- 已显示第 ${firstLine}-${lastLine} 行（文件共 ${totalLines} 行）；继续读取请使用 offset ${read.nextOffset} --`;
	} else {
		notice = `-- 已显示第 ${firstLine}-${lastLine} 行（文件共 ${totalLines} 行）；已到文件末尾 --`;
	}

	return [...anchoredLines, notice].join("\n");
}

function formatReadError(error: HleditErrorMetadata): string {
	const lines = [error.message];
	if (error.hint) lines.push(`Suggestion: ${error.hint}`);
	lines.push(`Error code: ${error.code}`);
	return lines.join("\n");
}

function invalidReadResponseText(): string {
	return `Anchor read failed because the bundled hledit returned an incompatible response. Expected structured JSON with ok, totalLines, valid anchor lines, truncation state, and optional nextOffset.\n\n${HLEDIT_INSTALL_HINT}`;
}

export function readAnchorsResult(run: HleditRun, request: NormalizedReadRequest): TextResult {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return {
			content: [{ type: "text", text: text || HLEDIT_INSTALL_HINT }],
			details: { disposition: "unavailable", path: request.path },
		};
	}

	const parsed = parseRunObject(run);
	if (!parsed) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable", path: request.path },
		};
	}
	if (parsed.ok === false) {
		const error = parseReadErrorMetadata(parsed);
		if (!error) {
			return {
				content: [{ type: "text", text: invalidReadResponseText() }],
				details: { disposition: "unavailable", path: request.path },
			};
		}
		return {
			content: [{ type: "text", text: formatReadError(error) }],
			details: { disposition: "rejected", path: request.path, error },
		};
	}

	const read = parseReadMetadata(parsed, request);
	if (!read) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable", path: request.path },
		};
	}
	return {
		content: [{ type: "text", text: formatReadMetadata(read) }],
		details: { disposition: "succeeded", path: request.path, revision: read.revision, read },
	};
}

function formatLineRange(first: number | undefined, last: number | undefined): string | undefined {
	if (first === undefined && last === undefined) {
		return undefined;
	}
	const start = first ?? last;
	const end = last ?? first;
	return start === end ? String(start) : `${start}-${end}`;
}

function lineDeltaSummary(parsed: Record<string, unknown>): string | undefined {
	const linesAdded = parsed.linesAdded;
	const linesDeleted = parsed.linesDeleted;
	if (typeof linesAdded !== "number" && typeof linesDeleted !== "number") {
		return undefined;
	}
	const added = typeof linesAdded === "number" ? linesAdded : 0;
	const deleted = typeof linesDeleted === "number" ? linesDeleted : 0;
	return `行数变化：+${added} -${deleted}`;
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
			typeof remap.current === "string" && READ_ANCHOR_PATTERN.test(remap.current) ? remap.current : undefined;
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
		: `Current anchor snapshot at submission time (local window: lines ${context.offset}-${lastLine}):`);
	lines.push(context.lines.map((line) => `${line.anchor}:${line.text}`).join("\n") || "(file is empty)");
	lines.push("This snapshot never retries or overwrites concurrent changes. Reuse its anchors only after confirming that this complete window still covers the intended target and range; otherwise reread the affected range.");
	if (context.truncated || context.lines.some((line) => line.textTruncated)) {
		lines.push(`The current snapshot is truncated. Call hledit_read_anchors with offset:${context.offset} and limit:${context.desiredLimit} to obtain the complete range.`);
	}
}

function staleReadInstruction(result: Record<string, unknown>, path: string | undefined): string {
	const genericInstruction = "Before retrying, call hledit_read_anchors to reread the affected range. Do not reuse anchors from before the change.";
	if (!path || !Array.isArray(result.remaps)) {
		return genericInstruction;
	}
	const remappedLineNumbers = result.remaps.flatMap((remap) => {
		if (!isRecord(remap)) {
			return [];
		}
		let anchor: string | undefined;
		if (typeof remap.current === "string") {
			anchor = remap.current;
		} else if (typeof remap.requested === "string") {
			anchor = remap.requested;
		}
		const match = anchor ? new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`).exec(anchor) : undefined;
		return match ? [Number(match[1])] : [];
	});
	if (remappedLineNumbers.length === 0) {
		return genericInstruction;
	}
	const offset = Math.max(1, Math.min(...remappedLineNumbers) - 2);
	return `Before retrying, call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: 12 }). Do not reuse anchors from before the change.`;
}

function localizeInvalidApplyMessage(rawMessage: string, failedChange: number | undefined): string {
	const prefix = failedChange === undefined ? "The batch request" : `Change ${failedChange}`;
	const unknownField = /unknown field "([^"]+)"/.exec(rawMessage);
	if (unknownField) return `The batch JSON contains unsupported field ${JSON.stringify(unknownField[1])}. Check the field spelling.`;
	if (rawMessage.includes("batch request contains no edits")) return "The batch contains no changes.";
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
	if (rawMessage.includes("replace target")) return "The atomic target replacement failed.";
	return "The file operation failed. Check the path, permissions, file type, and link state.";
}

function parseContentMatchCandidates(result: Record<string, unknown>): ContentMatchCandidate[] | undefined {
	if (!Array.isArray(result.candidates)) {
		return undefined;
	}
	const candidates: ContentMatchCandidate[] = [];
	for (const candidate of result.candidates) {
		if (!isRecord(candidate) || !isIntegerAtLeast(candidate.startLine, 1) || !isIntegerAtLeast(candidate.endLine, candidate.startLine)) {
			return undefined;
		}
		candidates.push({ startLine: candidate.startLine, endLine: candidate.endLine });
	}
	return candidates;
}

function parseApplyErrorMetadata(result: Record<string, unknown>, context: ApplyResultContext): HleditErrorMetadata | undefined {
	if (result.ok !== false || typeof result.error !== "string" || typeof result.message !== "string") return undefined;
	const failedChange = isIntegerAtLeast(result.failed, 0) ? result.failed + 1 : undefined;
	const currentAnchors = result.error === "stale" ? parseAnchorContext(result.currentAnchors) : undefined;
	const staleAnchors = result.error === "stale" ? parseStaleAnchors(result, currentAnchors, context) : undefined;
	const currentRevision = isRawRevision(result.currentRevision) ? result.currentRevision : undefined;
	const matchCount = isIntegerAtLeast(result.matchCount, 2) ? result.matchCount : undefined;
	const candidates = result.error === "content_ambiguous" ? parseContentMatchCandidates(result) : undefined;
	const candidatesTruncated = result.candidatesTruncated === true ? true : undefined;
	let message: string;
	switch (result.error) {
		case "stale":
			message = failedChange === undefined ? "One or more anchors are stale." : `Change ${failedChange} uses a stale anchor.`;
			break;
		case "insufficient_read_proof":
			message = "Read proof does not cover every original source line required by this change.";
			break;
		case "source_changed_before_commit":
			message = "The target changed before atomic commit. No content was written.";
			break;
		case "content_not_found":
			message = "old_lines do not match any contiguous block in the current file.";
			break;
		case "content_ambiguous":
			message = matchCount === undefined
				? "old_lines match more than one contiguous block in the current file."
				: `old_lines match ${matchCount} contiguous blocks in the current file.`;
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
		...(matchCount !== undefined ? { matchCount } : {}),
		...(candidates ? { candidates } : {}),
		...(candidatesTruncated ? { candidatesTruncated } : {}),
	};
}

function localizeApplyWarning(warning: string): string {
	if (warning.startsWith("file was replaced, but directory metadata could not be synchronized:")) {
		return "文件内容已成功替换，但目录元数据未能同步；断电等极端场景下，持久性保证可能降低。";
	}
	return "文件已成功修改，但写入持久性存在警告；详细技术信息已保留在工具结果中。";
}

function appendContentMatchRecovery(lines: string[], error: HleditErrorMetadata, path: string | undefined): void {
	if (error.code === "content_not_found") {
		lines.push("The exact old_lines precondition is no longer present. Do not weaken or approximate the match.");
		if (path) lines.push(`Call hledit_read_anchors({ path: ${JSON.stringify(path)} }) to inspect the intended target before submitting an anchored edit.`);
		return;
	}
	if (error.code !== "content_ambiguous") {
		return;
	}
	if (error.candidates && error.candidates.length > 0) {
		lines.push("Candidate ranges:", ...error.candidates.map((candidate) => `- lines ${candidate.startLine}-${candidate.endLine}`));
		if (error.candidatesTruncated) lines.push("Only the first candidate ranges are shown.");
		const first = error.candidates[0]!;
		const offset = Math.max(1, first.startLine - 2);
		if (path) lines.push(`Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: 12 }) and choose the intended block before submitting an anchored edit.`);
		return;
	}
	lines.push("old_lines are ambiguous. Call hledit_read_anchors to inspect and choose the intended block before submitting an anchored edit.");
}

function formatApplyFailureResult(
	result: Record<string, unknown>,
	context: ApplyResultContext,
	error: HleditErrorMetadata,
): string {
	const contentMatch = context.operation === "content_replace_once";
	const lines = [
		contentMatch ? "Content-match replacement was rejected; no content was written." : "The atomic batch was rejected; no content was written.",
		`Reason: ${error.message}`,
		`Error code: ${error.code}`,
	];
	if (isIntegerAtLeast(result.failed, 0)) {
		lines.push(`Failed change: ${result.failed + 1}`);
	}
	appendStaleAnchorDetails(lines, error.staleAnchors);
	appendRemaps(lines, result, error.staleAnchors);
	if (error.code === "stale") {
		appendCurrentAnchorContext(lines, error.currentAnchors);
		if (error.currentAnchors) {
			lines.push("Only reuse these anchors after confirming that the window still covers the intended target and complete range; otherwise call hledit_read_anchors again.");
		} else {
			lines.push(staleReadInstruction(result, context.path));
		}
	}
	if (error.code === "source_changed_before_commit") {
		lines.push(context.path
			? `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)} }) before retrying; do not reuse the prior request.`
			: "Call hledit_read_anchors before retrying; do not reuse the prior request.");
	}
	appendContentMatchRecovery(lines, error, context.path);
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
	lines.push("警告：", ...warnings.map((warning) => `- ${localizeApplyWarning(warning)}`));
}

function formatApplyResult(result: Record<string, unknown>, context: ApplyResultContext): string {
	if (result.contentChanged === false) {
		const lines = [context.operation === "content_replace_once" ? "无需修改；精确内容前置条件仍成立。" : "无需修改；原锚点仍有效。"];
		appendApplyWarnings(lines, result);
		return lines.join("\n");
	}
	const lines = ["修改已应用。"];
	if (typeof result.editsApplied === "number") {
		lines.push(`已应用操作：${result.editsApplied} 项`);
	}
	const changed = formatLineRange(
		typeof result.firstChangedLine === "number" ? result.firstChangedLine : undefined,
		typeof result.lastChangedLine === "number" ? result.lastChangedLine : undefined,
	);
	if (changed) {
		lines.push(`影响行：${changed}`);
	}
	const lineDelta = lineDeltaSummary(result);
	if (lineDelta) {
		lines.push(lineDelta);
	}
	appendApplyWarnings(lines, result);
	return lines.join("\n");
}

function isValidApplySuccess(parsed: Record<string, unknown> | null, context: ApplyResultContext): boolean {
	return (
		parsed?.ok === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		(context.operation === "content_replace_once" ? parsed.editsApplied === 1 : parsed.editsApplied >= 0) &&
		(parsed.contentChanged === undefined || typeof parsed.contentChanged === "boolean") &&
		(parsed.warnings === undefined || (Array.isArray(parsed.warnings) && parsed.warnings.every((warning) => typeof warning === "string"))) &&
		isRawRevision(parsed.revision) &&
		parseBatchUpdatedAnchorContext(parsed) !== undefined
	);
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
	return `The bundled hledit returned an incompatible success response. The file may have changed; call hledit_read_anchors before retrying. Expected ok:true, a valid revision, non-negative editsApplied, and valid updatedAnchors.\n\n${HLEDIT_INSTALL_HINT}`;
}

function outcomeUnknownText(run: HleditRun): string {
	const diagnostic = (run.stdout.trimEnd() || run.stderr.trimEnd()).slice(0, 800);
	const lines = [
		"The hledit write outcome is unknown; the file may already have changed. Do not retry the original request.",
		"Call hledit_read_anchors to reread the target file first.",
	];
	if (diagnostic) {
		lines.push(`Diagnostic: ${diagnostic}${diagnostic.length === 800 ? "…" : ""}`);
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
	return applySuccessValid ? formatApplyResult(parsed, context) : invalidApplySuccessText();
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
	const applySuccessValid = isValidApplySuccess(parsed, context);
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
				: !applySuccessValid
					? "outcome_unknown"
					: "succeeded";
	return {
		content: [{ type: "text", text: formatApplyRunText(run, context, parsed, applySuccessValid, applyError) }],
		details: {
			disposition,
			...(context.path ? { path: context.path } : {}),
			...extractCliSummary(parsed),
			...(applyError ? { error: applyError } : {}),
		},
	};
}

export function replaceOnceResult(run: HleditRun, path: string | undefined): TextResult {
	return applyFileChangesResult(run, { path, operation: "content_replace_once" });
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

export function unavailableToolResult(text: string): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition: "unavailable" },
	};
}

export function rejectedToolResult(text: string, error: HleditErrorMetadata): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition: "rejected", error },
	};
}

export function isFailedHleditResult(details: unknown): boolean {
	return isRecord(details) && details.disposition !== "succeeded";
}

export function buildDiffDetails(
	path: string,
	beforeContent: string,
	afterContent: string,
	parsed: Record<string, unknown> | null,
): Record<string, unknown> {
	const diffResult = generateDiffString(beforeContent, afterContent);
	const patch = generateUnifiedPatch(path, beforeContent, afterContent);
	const cliFirstChangedLine = parsed?.firstChangedLine;
	return {
		...extractCliSummary(parsed),
		diff: diffResult.diff,
		patch,
		firstChangedLine: typeof cliFirstChangedLine === "number" ? cliFirstChangedLine : diffResult.firstChangedLine,
	};
}

export async function readUtf8File(path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
	try {
		const bytes = await readFile(path);
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { ok: true, content };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
