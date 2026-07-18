import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";
import { parseBatchUpdatedAnchorContext } from "./post-edit-context.ts";
import type { NormalizedReadRequest } from "./read-args.ts";

export type HleditToolKind = "read_anchors" | "apply_file_changes";
export type HleditDisposition = "succeeded" | "rejected" | "unavailable";

export type HleditReadLine = {
	line: number;
	anchor: string;
	text: string;
	textTruncated: boolean;
};

export type HleditReadMetadata = {
	path: string;
	requested: {
		offset: number;
		limit: number;
		grep?: string;
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

export type HleditErrorMetadata = {
	code: string;
	message: string;
	hint?: string;
	requestedOffset?: number;
	totalLines?: number;
};

type ApplyResultContext = {
	path?: string;
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
	read?: HleditReadMetadata;
	error?: HleditErrorMetadata;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
};

const READ_ANCHOR_PATTERN = new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
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
	if (parsed.ok !== true || !isIntegerAtLeast(parsed.totalLines, 0) || !Array.isArray(parsed.lines) || typeof parsed.truncated !== "boolean") {
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
		requested: {
			offset: request.offset,
			limit: request.limit,
			...(request.grep ? { grep: request.grep } : {}),
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

function parseReadErrorMetadata(parsed: Record<string, unknown>): HleditErrorMetadata | undefined {
	if (parsed.ok !== false || typeof parsed.error !== "string" || typeof parsed.message !== "string") return undefined;
	const requestedOffset = isIntegerAtLeast(parsed.requestedOffset, 1) ? parsed.requestedOffset : undefined;
	const totalLines = isIntegerAtLeast(parsed.totalLines, 0) ? parsed.totalLines : undefined;
	if (parsed.error === "range" && (requestedOffset === undefined || totalLines === undefined)) return undefined;

	let hint: string | undefined;
	if (parsed.error === "range" && totalLines !== undefined) {
		hint = totalLines === 0
			? "The file is empty; no positive line offset is valid."
			: `Use an offset between 1 and ${totalLines}.`;
	}
	return {
		code: parsed.error,
		message: parsed.message,
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
		notice = `-- source text truncated${lastLine !== undefined ? ` at line ${lastLine}` : ""} of ${totalLines}; no line-offset continuation is available --`;
	} else if (filter) {
		if (lineCount === 0) {
			notice = `-- no lines containing ${JSON.stringify(filter)} in ${totalLines} total lines --`;
		} else if (read.nextOffset !== undefined) {
			notice = `-- showing ${lineCount} filtered lines through line ${lastLine} of ${totalLines}; use offset ${read.nextOffset} to continue --`;
		} else {
			notice = `-- showing all ${lineCount} filtered lines from ${totalLines} total lines --`;
		}
	} else if (read.nextOffset !== undefined) {
		notice = `-- showing lines ${firstLine}-${lastLine} of ${totalLines}; use offset ${read.nextOffset} to continue --`;
	} else {
		notice = `-- showing lines ${firstLine}-${lastLine} of ${totalLines}; end of file --`;
	}

	return [...anchoredLines, notice].join("\n");
}

function formatReadError(error: HleditErrorMetadata): string {
	const lines = [error.message];
	if (error.hint) lines.push(`Hint: ${error.hint}`);
	lines.push(`Error: ${error.code}`);
	return lines.join("\n");
}

function invalidReadResponseText(): string {
	return `Anchor read failed: bundled hledit returned an incompatible response. Expected structured JSON with ok, totalLines, validated anchored lines, truncation state, and optional nextOffset.\n\n${HLEDIT_INSTALL_HINT}`;
}

export function readAnchorsResult(run: HleditRun, request: NormalizedReadRequest): TextResult {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return {
			content: [{ type: "text", text: text || HLEDIT_INSTALL_HINT }],
			details: { disposition: "unavailable" },
		};
	}

	const parsed = parseRunObject(run);
	if (!parsed) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable" },
		};
	}
	if (parsed.ok === false) {
		const error = parseReadErrorMetadata(parsed);
		if (!error) {
			return {
				content: [{ type: "text", text: invalidReadResponseText() }],
				details: { disposition: "unavailable" },
			};
		}
		return {
			content: [{ type: "text", text: formatReadError(error) }],
			details: { disposition: "rejected", error },
		};
	}

	const read = parseReadMetadata(parsed, request);
	if (!read) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable" },
		};
	}
	return {
		content: [{ type: "text", text: formatReadMetadata(read) }],
		details: { disposition: "succeeded", read },
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
	return `Lines: +${added} -${deleted}`;
}

function appendRemaps(lines: string[], result: Record<string, unknown>): void {
	if (!Array.isArray(result.remaps) || result.remaps.length === 0) {
		return;
	}

	lines.push("Current anchor hints:");
	for (const remap of result.remaps) {
		if (!isRecord(remap)) {
			continue;
		}
		const requested = typeof remap.requested === "string" ? remap.requested : undefined;
		const current = typeof remap.current === "string" ? remap.current : undefined;
		if (requested && current) {
			lines.push(`- ${requested} -> ${current}`);
		} else if (requested) {
			lines.push(`- ${requested}`);
		}
	}
}

function staleReadInstruction(result: Record<string, unknown>, path: string | undefined): string {
	const genericInstruction = "Read the affected range with hledit_read_anchors before retrying. Do not reuse pre-mutation anchors.";
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
	return `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: 12 }) before retrying. Do not reuse pre-mutation anchors.`;
}

function formatApplyFailureResult(result: Record<string, unknown>, context: ApplyResultContext): string {
	const lines = ["Atomic batch rejected; zero changes were applied."];
	if (typeof result.error === "string") {
		lines.push(`Error: ${result.error}`);
	}
	if (typeof result.message === "string" && result.message !== result.error) {
		lines.push(`Message: ${result.message}`);
	}
	if (typeof result.failed === "number") {
		lines.push(`Failed change: ${result.failed}`);
	}
	appendRemaps(lines, result);
	if (result.error === "stale") {
		lines.push(staleReadInstruction(result, context.path));
	}
	return lines.join("\n");
}

function formatApplyResult(result: Record<string, unknown>): string {
	const lines = ["Changes applied."];
	if (typeof result.editsApplied === "number") {
		lines.push(`Changes applied: ${result.editsApplied}`);
	}
	const changed = formatLineRange(
		typeof result.firstChangedLine === "number" ? result.firstChangedLine : undefined,
		typeof result.lastChangedLine === "number" ? result.lastChangedLine : undefined,
	);
	if (changed) {
		lines.push(`Changed lines: ${changed}`);
	}
	const lineDelta = lineDeltaSummary(result);
	if (lineDelta) {
		lines.push(lineDelta);
	}
	return lines.join("\n");
}

function isValidApplySuccess(parsed: Record<string, unknown> | null): boolean {
	return (
		parsed?.ok === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		parsed.editsApplied >= 0 &&
		parseBatchUpdatedAnchorContext(parsed) !== undefined
	);
}

function invalidApplySuccessText(): string {
	return `Bundled hledit returned an incompatible success response. The file may have changed; call hledit_read_anchors to inspect the current content before retrying. Expected JSON with ok:true, a non-negative integer editsApplied, and valid updatedAnchors.\n\n${HLEDIT_INSTALL_HINT}`;
}

function formatApplyRunText(
	run: HleditRun,
	context: ApplyResultContext,
	parsed: Record<string, unknown> | null,
	applySuccessValid: boolean,
): string {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return text || HLEDIT_INSTALL_HINT;
	}
	if (!text || !parsed) {
		return invalidApplySuccessText();
	}
	if (parsed.ok === false) {
		return formatApplyFailureResult(parsed, context);
	}
	return applySuccessValid ? formatApplyResult(parsed) : invalidApplySuccessText();
}

export function extractCliSummary(parsed: Record<string, unknown> | null): Record<string, unknown> {
	if (!parsed) {
		return {};
	}

	const summary: Record<string, unknown> = {};
	for (const key of ["firstChangedLine", "lastChangedLine", "linesAdded", "linesDeleted", "editsApplied", "checked"] as const) {
		const value = parsed[key];
		if (typeof value === "number" || typeof value === "boolean") {
			summary[key] = value;
		}
	}
	return summary;
}

export function applyFileChangesResult(run: HleditRun, context: ApplyResultContext = {}): TextResult {
	const parsed = parseRunObject(run);
	const applySuccessValid = isValidApplySuccess(parsed);
	const disposition: HleditDisposition =
		run.exitCode !== 0
			? "unavailable"
			: parsed?.ok === false
				? "rejected"
				: !applySuccessValid
					? "unavailable"
					: "succeeded";
	return {
		content: [{ type: "text", text: formatApplyRunText(run, context, parsed, applySuccessValid) }],
		details: { disposition, ...extractCliSummary(parsed) },
	};
}

export function toolFailureResult(text: string, disposition: Exclude<HleditDisposition, "succeeded"> = "unavailable"): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition },
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
		return { ok: true, content: await readFile(path, "utf8") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
