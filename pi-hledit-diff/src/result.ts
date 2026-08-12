import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { ANCHOR_HASH_PATTERN, lineFromAnchor } from "./file-changes.ts";
import { parseAnchorContext, parseBatchUpdatedAnchorContext, type BatchAnchorContext, type ProducedLineRange } from "./post-edit-context.ts";
import { MAX_READ_LIMIT, suggestedReadWindow, type NormalizedReadRequest } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

export type HleditToolKind = "read_anchors" | "apply_file_changes";
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
		ignoreCase?: boolean;
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


// 与 CLI EditDelta 对应：oldStart/oldEnd 是原始行坐标中被消费的区间（纯插入时
// oldEnd === oldStart-1 的空区间），delta 是该编辑造成的行数变化。
export type HleditEditDelta = {
	oldStart: number;
	oldEnd: number;
	delta: number;
};

export function parseEditDeltas(value: unknown): HleditEditDelta[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const deltas: HleditEditDelta[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const { oldStart, oldEnd, delta } = item;
		if (
			typeof oldStart !== "number" || !Number.isSafeInteger(oldStart) || oldStart < 1 ||
			typeof oldEnd !== "number" || !Number.isSafeInteger(oldEnd) || oldEnd < oldStart - 1 ||
			typeof delta !== "number" || !Number.isSafeInteger(delta)
		) {
			return undefined;
		}
		// 空消费区间只能是纯插入；非空区间的净变化不能低于整段删除。
		if (oldEnd === oldStart - 1 && delta <= 0) return undefined;
		if (oldEnd >= oldStart && delta < -(oldEnd - oldStart + 1)) return undefined;
		// CLI 按物理边界升序输出，消费区间互不重叠；乱序或重叠说明响应不可信，
		// 直接用于证据重映射会平移出错误行号。
		const previous = deltas.at(-1);
		if (previous && oldStart <= previous.oldEnd) return undefined;
		deltas.push({ oldStart, oldEnd, delta });
	}
	return deltas;
}

// 把 editDeltas 换算成新文件坐标下的产出区间：区间内的行是本次编辑新写入的，
// 模型没有任何旧锚点可用；纯删除产出空区间。parseEditDeltas 已保证升序不重叠。
export function producedLineRangesFromEditDeltas(deltas: HleditEditDelta[]): ProducedLineRange[] {
	let shift = 0;
	return deltas.map((delta) => {
		const start = delta.oldStart + shift;
		const producedCount = delta.oldEnd - delta.oldStart + 1 + delta.delta;
		shift += delta.delta;
		return { start, end: start + producedCount - 1 };
	});
}

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
	renamedAnchors?: Array<{ requested: string; current: string }>;
};

type ApplyResultContext = {
	path?: string;
	changes?: FileChangeParams["changes"];
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
	path?: string;
	evidencePath?: string;
	revision?: string;
	updatedAnchors?: BatchAnchorContext;
	read?: HleditReadMetadata;
	recoveredRead?: HleditReadMetadata;
	recoveryReadError?: { disposition: HleditDisposition; error?: HleditErrorMetadata };
	error?: HleditErrorMetadata;
	resolvedAnchors?: Array<{ requested: string; current: string }>;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
};

const READ_ANCHOR_PATTERN = new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`);
const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;


export function parseHleditReadMetadata(value: unknown): HleditReadMetadata | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || !isRecord(value.requested) || !isRecord(value.actual) || !Array.isArray(value.lines)) return undefined;
	const requested = value.requested;
	if (!isIntegerAtLeast(requested.offset, 1) || !isIntegerAtLeast(requested.limit, 1)) return undefined;
	if (requested.grep !== undefined && (typeof requested.grep !== "string" || requested.grep.length === 0)) return undefined;
	if (requested.context !== undefined && !isIntegerAtLeast(requested.context, 0)) return undefined;
	if (requested.ignoreCase !== undefined && requested.ignoreCase !== true) return undefined;
	if (!value.lines.every((line) => isRecord(line) && typeof line.textTruncated === "boolean")) return undefined;
	const actual = value.actual;
	if (!isIntegerAtLeast(actual.lineCount, 0) || !isIntegerAtLeast(actual.totalLines, 0)) return undefined;
	if (actual.firstLine !== undefined && !isIntegerAtLeast(actual.firstLine, 1)) return undefined;
	if (actual.lastLine !== undefined && !isIntegerAtLeast(actual.lastLine, 1)) return undefined;
	if (typeof value.truncated !== "boolean" || typeof value.textTruncated !== "boolean" || typeof value.eof !== "boolean") return undefined;

	const request: NormalizedReadRequest = {
		path: value.path,
		offset: requested.offset,
		limit: requested.limit,
		...(requested.grep !== undefined ? { grep: requested.grep } : {}),
		...(requested.context !== undefined ? { context: requested.context } : {}),
		...(requested.ignoreCase === true ? { ignoreCase: true } : {}),
	};
	const parsed = parseReadMetadata({
		ok: true,
		revision: value.revision,
		totalLines: actual.totalLines,
		lines: value.lines,
		truncated: value.truncated,
		...(value.nextOffset !== undefined ? { nextOffset: value.nextOffset } : {}),
	}, request);
	if (!parsed) return undefined;
	if (
		parsed.actual.firstLine !== actual.firstLine ||
		parsed.actual.lastLine !== actual.lastLine ||
		parsed.actual.lineCount !== actual.lineCount ||
		parsed.textTruncated !== value.textTruncated ||
		parsed.eof !== value.eof
	) return undefined;
	return parsed;
}

export function parseUsableHleditReadMetadata(value: unknown): HleditReadMetadata | undefined {
	const read = parseHleditReadMetadata(value);
	return read && !read.textTruncated && read.requested.limit <= MAX_READ_LIMIT ? read : undefined;
}

export function parseRecoveredRead(value: unknown): HleditReadMetadata | undefined {
	if (!isRecord(value) || value.disposition !== "rejected" || typeof value.path !== "string" || !isRecord(value.error) || value.error.code !== "insufficient_read_proof") return undefined;
	const read = parseUsableHleditReadMetadata(value.recoveredRead);
	return read?.path === value.path ? read : undefined;
}
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
			...(request.ignoreCase ? { ignoreCase: true } : {}),
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
			? "The file is empty, so no anchors exist. To add content to an empty file, use write."
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
		notice = `-- Source line text was truncated${lastLine !== undefined ? `; the last returned line is ${lastLine}` : ""} (${totalLines} lines total); rereading line ranges cannot recover the omitted in-line text. Truncated lines cannot establish edit proof; if the edit target includes such a line, rewrite the file with write instead --`;
	} else if (filter) {
		if (lineCount === 0) {
			notice = `-- No lines containing ${JSON.stringify(filter)} were found (${totalLines} lines total) --`;
		} else if (read.nextOffset !== undefined) {
			notice = `-- Returned ${lineCount} matching lines with context, ending at line ${lastLine} (${totalLines} lines total); continue with offset ${read.nextOffset} --`;
		} else {
			notice = `-- Returned all ${lineCount} matching lines with context (${totalLines} lines total) --`;
		}
	} else if (read.nextOffset !== undefined) {
		notice = `-- Showing lines ${firstLine}-${lastLine} of ${totalLines}; continue with offset ${read.nextOffset} --`;
	} else {
		notice = `-- Showing lines ${firstLine}-${lastLine} of ${totalLines}; end of file --`;
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
		const match = anchor ? READ_ANCHOR_PATTERN.exec(anchor) : undefined;
		return match ? [Number(match[1])] : [];
	});
	if (remappedLineNumbers.length === 0) {
		return genericInstruction;
	}
	const firstRemappedLine = Math.min(...remappedLineNumbers);
	const { offset, limit } = suggestedReadWindow(firstRemappedLine, firstRemappedLine);
	return `Before retrying, call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }). Do not reuse anchors from before the change.`;
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


function parseApplyErrorMetadata(result: Record<string, unknown>, context: ApplyResultContext): HleditErrorMetadata | undefined {
	if (result.ok !== false || typeof result.error !== "string" || typeof result.message !== "string") return undefined;
	const failedChange = isIntegerAtLeast(result.failed, 0) ? result.failed + 1 : undefined;
	const currentAnchors = result.error === "stale" ? parseAnchorContext(result.currentAnchors) : undefined;
	const staleAnchors = result.error === "stale" ? parseStaleAnchors(result, currentAnchors, context) : undefined;
	const currentRevision = isRawRevision(result.currentRevision) ? result.currentRevision : undefined;
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
	};
}

// 模型可见正文统一英文；details 中保留 rawWarnings 原文供诊断。
function localizeApplyWarning(warning: string): string {
	if (warning.startsWith("file was replaced, but directory metadata could not be synchronized:")) {
		return "The file content was replaced, but directory metadata could not be synchronized; durability may be reduced in extreme scenarios such as power loss.";
	}
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
	const resubmitTool = "hledit_apply_file_changes";
	const genericInstruction = context.path
		? `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)} }) to reread every source line required by the failed change, then resubmit the original ${resubmitTool} call.`
		: `Call hledit_read_anchors to reread every source line required by the failed change, then resubmit the original ${resubmitTool} call.`;
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
		? `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)}, offset: ${offset}, limit: ${limit} }) first, continue with nextOffset until line ${end} is covered, then resubmit the original ${resubmitTool} call.`
		: `Call hledit_read_anchors({ path: ${JSON.stringify(context.path)}, offset: ${offset}, limit: ${limit} }) to reread every source line required by change ${changeNumber}, then resubmit the original ${resubmitTool} call.`);
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

function isValidApplySuccess(parsed: Record<string, unknown> | null, context: ApplyResultContext): boolean {
	if (parsed?.ok !== true || !isRawRevision(parsed.revision)) return false;
	if (typeof parsed.editsApplied !== "number" || !Number.isSafeInteger(parsed.editsApplied) || parsed.editsApplied < 0) return false;
	if (context.changes && parsed.editsApplied !== context.changes.length) return false;
	if (parsed.contentChanged !== undefined && typeof parsed.contentChanged !== "boolean") return false;
	if (parsed.warnings !== undefined && (!Array.isArray(parsed.warnings) || !parsed.warnings.every((warning) => typeof warning === "string"))) return false;
	// bundled CLI 恒输出 linesAdded/linesDeleted（无 omitempty）；delta 总和是同一份
	// 统计的另一投影，二者不一致即内部矛盾。
	if (!isIntegerAtLeast(parsed.linesAdded, 0) || !isIntegerAtLeast(parsed.linesDeleted, 0)) return false;
	const editDeltas = parseEditDeltas(parsed.editDeltas);
	if (!editDeltas || editDeltas.length !== parsed.editsApplied) return false;
	if (editDeltas.reduce((sum, delta) => sum + delta.delta, 0) !== parsed.linesAdded - parsed.linesDeleted) return false;
	if (!editDeltasMatchRequest(editDeltas, context)) return false;
	return parseBatchUpdatedAnchorContext(parsed) !== undefined;
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
	return `The bundled hledit returned an incompatible success response. The file may have changed; call hledit_read_anchors before retrying. Expected ok:true, a valid revision, editsApplied and editDeltas consistent with the request, line-count statistics, and valid updatedAnchors.\n\n${HLEDIT_INSTALL_HINT}`;
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
	const editDeltas = parseEditDeltas(parsed.editDeltas);
	if (editDeltas) summary.editDeltas = editDeltas;
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

export function shouldMarkHleditResultAsError(details: unknown): boolean {
	if (!isFailedHleditResult(details)) return false;
	if (!isRecord(details) || details.disposition !== "rejected" || !isRecord(details.error)) return true;
	return details.error.code !== "insufficient_read_proof";
}
