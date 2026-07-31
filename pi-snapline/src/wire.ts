import type { SnaplineRun } from "./cli.ts";

export const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const MAX_WIRE_MESSAGE_BYTES = 4096;
const MAX_READ_WINDOWS = 64;
const MAX_READ_LINES = 2000;
const MAX_READ_CONTENT_BYTES = 50 * 1024;
const MAX_TRUNCATED_PREFIX_BYTES = 4096;

export type SnaplineReadWindow = { offset: number; limit: number };
export type SnaplineReadRequest = {
	protocolVersion: 1;
	path: string;
	windows: SnaplineReadWindow[];
};

export type SnaplineTruncatedLine = {
	line: number;
	prefix: string;
	originalUtf8Bytes: number;
};

export type SnaplineReadContext = {
	offset: number;
	limit: number;
	start: number;
	end: number;
	complete: boolean;
	nextOffset: number;
	lines: string[];
	truncatedLine?: SnaplineTruncatedLine;
	approximate?: true;
};

export type SnaplineOmittedRange = {
	start: number;
	end: number;
	reason: "line_limit" | "byte_budget" | "line_too_long";
	approximate?: true;
};

export type SnaplineReadSuccess = {
	ok: true;
	protocolVersion: 1;
	path: string;
	revision: string;
	totalLines: number;
	bom: boolean;
	contexts: SnaplineReadContext[];
	omittedRanges: SnaplineOmittedRange[];
};

export type SnaplineSourceRange = { start: number; end: number };
export type SnaplineConflictReference = { group: SnaplineChangeGroup; groupIndex: number };

export type SnaplineLogicalFailure = {
	ok: false;
	protocolVersion: 1;
	path?: string;
	code: string;
	message: string;
	targetCommitted: false;
	currentRevision?: string;
	requiredRanges?: SnaplineSourceRange[];
	contexts?: SnaplineReadContext[];
	omittedRanges?: SnaplineOmittedRange[];
	group?: SnaplineChangeGroup;
	groupIndex?: number;
	conflictsWith?: SnaplineConflictReference;
};

export type SnaplineProofRange = { start: number; lines: string[] };
export type SnaplineWireReplacement = { start: number; end: number; text: string };
export type SnaplineWireDeletion = { start: number; end: number };
export type SnaplineWireInsertion = { line: number; text: string };
export type SnaplineApplyRequest = {
	protocolVersion: 1;
	path: string;
	expectedRevision: string;
	proof: SnaplineProofRange[];
	replacements: SnaplineWireReplacement[];
	deletions: SnaplineWireDeletion[];
	insertionsBefore: SnaplineWireInsertion[];
	insertionsAfter: SnaplineWireInsertion[];
};

export type SnaplineChangeGroup = "replacement" | "deletion" | "insertion_before" | "insertion_after";
export type SnaplineEditEffect = {
	group: SnaplineChangeGroup;
	groupIndex: number;
	changed: boolean;
	oldStart: number;
	oldEnd: number;
	newLineCount: number;
	lineDelta: number;
	newStart: number;
	newEnd: number;
};

export type SnaplineApplyStats = {
	requestedChanges: number;
	effectiveChanges: number;
	oldLineCount: number;
	newLineCount: number;
	insertedLines: number;
	deletedLines: number;
};

export type SnaplineWarning = { code: "post_commit_durability"; message: string };
export type SnaplineApplySuccess = {
	ok: true;
	protocolVersion: 1;
	path: string;
	outcome: "applied" | "no_op";
	sourceRevision: string;
	newRevision: string;
	contentChanged: boolean;
	stats: SnaplineApplyStats;
	effects: SnaplineEditEffect[];
	warnings: SnaplineWarning[];
};

export type ParsedReadRun =
	| { disposition: "success"; result: SnaplineReadSuccess }
	| { disposition: "rejected"; failure: SnaplineLogicalFailure }
	| { disposition: "unavailable"; message: string }
	| { disposition: "invalid_response"; message: string };

export type ParsedApplyRun =
	| { disposition: "success"; result: SnaplineApplySuccess }
	| { disposition: "rejected"; failure: SnaplineLogicalFailure }
	| { disposition: "unavailable"; message: string }
	| { disposition: "outcome_unknown"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
		Object.keys(record).every((key) => allowed.has(key));
}

function isSafeInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isRawRevision(value: unknown): value is string {
	return typeof value === "string" && RAW_REVISION_PATTERN.test(value);
}

function parseJSON(stdout: string): unknown | undefined {
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
}

function processMessage(run: SnaplineRun): string {
	return [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join("\n") || "Snapline returned no diagnostic output.";
}

function parseTruncatedLine(value: unknown): SnaplineTruncatedLine | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["line", "prefix", "originalUtf8Bytes"])) return undefined;
	if (!isSafeInteger(value.line, 1) || typeof value.prefix !== "string" || /[\n\0]/.test(value.prefix) || !isSafeInteger(value.originalUtf8Bytes, 1)) return undefined;
	const prefixBytes = Buffer.byteLength(value.prefix, "utf8");
	if (prefixBytes > value.originalUtf8Bytes || prefixBytes > MAX_TRUNCATED_PREFIX_BYTES) return undefined;
	return { line: value.line, prefix: value.prefix, originalUtf8Bytes: value.originalUtf8Bytes };
}

function parseReadContext(value: unknown, totalLines: number | undefined): SnaplineReadContext | undefined {
	if (!isRecord(value) || !hasOnlyKeys(
		value,
		["offset", "limit", "start", "end", "complete", "nextOffset", "lines"],
		["truncatedLine", "approximate"],
	)) return undefined;
	if (
		!isSafeInteger(value.offset, 1) ||
		!isSafeInteger(value.limit, 0) ||
		!isSafeInteger(value.start, 1) ||
		!isSafeInteger(value.end, 0) ||
		typeof value.complete !== "boolean" ||
		!isSafeInteger(value.nextOffset, 1) ||
		!Array.isArray(value.lines) ||
		!value.lines.every((line): line is string => typeof line === "string" && !/[\n\0]/.test(line)) ||
		(value.approximate !== undefined && value.approximate !== true)
	) return undefined;
	if (value.end !== value.start + value.lines.length - 1 || value.nextOffset !== value.end + 1) return undefined;
	if (totalLines !== undefined) {
		if (totalLines === 0) {
			if (value.start !== 1 || value.end !== 0 || value.lines.length !== 0 || value.nextOffset !== 1) return undefined;
		} else if (value.end > totalLines || value.start > totalLines) return undefined;
	}
	const truncatedLine = value.truncatedLine === undefined ? undefined : parseTruncatedLine(value.truncatedLine);
	if (value.truncatedLine !== undefined && truncatedLine === undefined) return undefined;
	if (truncatedLine && (value.complete || truncatedLine.line !== value.nextOffset)) return undefined;
	return {
		offset: value.offset,
		limit: value.limit,
		start: value.start,
		end: value.end,
		complete: value.complete,
		nextOffset: value.nextOffset,
		lines: value.lines,
		...(truncatedLine ? { truncatedLine } : {}),
		...(value.approximate === true ? { approximate: true as const } : {}),
	};
}

function parseOmittedRange(value: unknown): SnaplineOmittedRange | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["start", "end", "reason"], ["approximate"])) return undefined;
	if (
		!isSafeInteger(value.start, 1) ||
		!isSafeInteger(value.end, value.start) ||
		(value.reason !== "line_limit" && value.reason !== "byte_budget" && value.reason !== "line_too_long") ||
		(value.approximate !== undefined && value.approximate !== true)
	) return undefined;
	return {
		start: value.start,
		end: value.end,
		reason: value.reason,
		...(value.approximate === true ? { approximate: true as const } : {}),
	};
}

type NormalizedReadWindow = { start: number; end: number };

function normalizeReadWindowsForResponse(request: SnaplineReadRequest, totalLines: number): NormalizedReadWindow[] | undefined {
	if (
		request.protocolVersion !== 1 || request.path.length === 0 ||
		request.windows.length === 0 || request.windows.length > MAX_READ_WINDOWS
	) return undefined;
	const normalized: NormalizedReadWindow[] = [];
	for (const window of request.windows) {
		if (!isSafeInteger(window.offset, 1) || !isSafeInteger(window.limit, 1)) return undefined;
		if (totalLines === 0) {
			normalized.push({ start: 1, end: 0 });
			continue;
		}
		if (window.offset > totalLines) {
			normalized.push({ start: totalLines, end: totalLines });
			continue;
		}
		const remaining = totalLines - window.offset + 1;
		normalized.push({
			start: window.offset,
			end: window.limit < remaining ? window.offset + window.limit - 1 : totalLines,
		});
	}
	normalized.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: NormalizedReadWindow[] = [];
	for (const window of normalized) {
		const prior = merged.at(-1);
		if (prior && (prior.end < prior.start || window.start <= prior.end || window.start - prior.end === 1)) {
			prior.end = Math.max(prior.end, window.end);
		} else {
			merged.push({ ...window });
		}
	}
	return merged;
}

// [喵喵喵]: success 只有与原始窗口及 budget omission 一一对应时才可信，防止自洽但答非所问的 CLI 响应进入 ledger (2026-07-31)。
function readSuccessMatchesRequest(result: SnaplineReadSuccess, request: SnaplineReadRequest): boolean {
	const expectedWindows = normalizeReadWindowsForResponse(request, result.totalLines);
	if (!expectedWindows || result.contexts.length !== expectedWindows.length) return false;
	let omittedIndex = 0;
	for (const [index, expected] of expectedWindows.entries()) {
		const context = result.contexts[index]!;
		const expectedLimit = Math.max(0, expected.end - expected.start + 1);
		if (
			context.approximate || context.offset !== expected.start || context.limit !== expectedLimit ||
			context.start !== expected.start
		) return false;
		if (context.complete) {
			if (
				context.lines.length !== expectedLimit || context.end !== expected.end ||
				context.nextOffset !== expected.end + 1 || context.truncatedLine
			) return false;
			continue;
		}
		if (expectedLimit === 0 || context.lines.length >= expectedLimit || context.nextOffset > expected.end) return false;
		const omitted = result.omittedRanges[omittedIndex++];
		if (!omitted || omitted.approximate || omitted.start !== context.nextOffset || omitted.end !== expected.end) return false;
		if ((omitted.reason === "line_limit") !== (context.truncatedLine === undefined)) return false;
	}
	return omittedIndex === result.omittedRanges.length;
}

function parseReadSuccess(value: unknown, request: SnaplineReadRequest): SnaplineReadSuccess | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["ok", "protocolVersion", "path", "revision", "totalLines", "bom", "contexts", "omittedRanges"])) return undefined;
	if (
		value.ok !== true || value.protocolVersion !== 1 || typeof value.path !== "string" || value.path.length === 0 ||
		!isRawRevision(value.revision) || !isSafeInteger(value.totalLines, 0) || typeof value.bom !== "boolean" ||
		!Array.isArray(value.contexts) || !Array.isArray(value.omittedRanges)
	) return undefined;
	const contexts: SnaplineReadContext[] = [];
	let previousEnd = -1;
	let lineCount = 0;
	let textBytes = 0;
	for (const entry of value.contexts) {
		const context = parseReadContext(entry, value.totalLines);
		if (!context || (previousEnd >= 0 && context.start <= previousEnd)) return undefined;
		previousEnd = Math.max(previousEnd, context.end);
		lineCount += context.lines.length;
		for (const line of context.lines) textBytes += Buffer.byteLength(line, "utf8");
		if (context.truncatedLine) textBytes += Buffer.byteLength(context.truncatedLine.prefix, "utf8");
		contexts.push(context);
	}
	if (lineCount > MAX_READ_LINES || textBytes > MAX_READ_CONTENT_BYTES) return undefined;
	const omittedRanges = value.omittedRanges.map(parseOmittedRange);
	if (omittedRanges.some((range) => range === undefined)) return undefined;
	const result: SnaplineReadSuccess = {
		ok: true,
		protocolVersion: 1,
		path: value.path,
		revision: value.revision,
		totalLines: value.totalLines,
		bom: value.bom,
		contexts,
		omittedRanges: omittedRanges as SnaplineOmittedRange[],
	};
	return readSuccessMatchesRequest(result, request) ? result : undefined;
}

function parseSourceRange(value: unknown): SnaplineSourceRange | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["start", "end"]) || !isSafeInteger(value.start, 1) || !isSafeInteger(value.end, 0)) return undefined;
	if (value.end < value.start - 1) return undefined;
	return { start: value.start, end: value.end };
}

const CHANGE_GROUPS = new Set<SnaplineChangeGroup>(["replacement", "deletion", "insertion_before", "insertion_after"]);
function isChangeGroup(value: unknown): value is SnaplineChangeGroup {
	return typeof value === "string" && CHANGE_GROUPS.has(value as SnaplineChangeGroup);
}

function parseConflictReference(value: unknown): SnaplineConflictReference | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["group", "groupIndex"]) || !isChangeGroup(value.group) || !isSafeInteger(value.groupIndex, 0)) return undefined;
	return { group: value.group, groupIndex: value.groupIndex };
}

function parseLogicalFailure(value: unknown): SnaplineLogicalFailure | undefined {
	if (!isRecord(value) || !hasOnlyKeys(
		value,
		["ok", "protocolVersion", "code", "message", "targetCommitted"],
		["path", "currentRevision", "requiredRanges", "contexts", "omittedRanges", "group", "groupIndex", "conflictsWith"],
	)) return undefined;
	if (
		value.ok !== false || value.protocolVersion !== 1 || typeof value.code !== "string" || value.code.length === 0 ||
		typeof value.message !== "string" || Buffer.byteLength(value.message, "utf8") > MAX_WIRE_MESSAGE_BYTES ||
		value.targetCommitted !== false || (value.path !== undefined && typeof value.path !== "string") ||
		(value.currentRevision !== undefined && !isRawRevision(value.currentRevision)) ||
		(value.group !== undefined && !isChangeGroup(value.group)) ||
		(value.groupIndex !== undefined && !isSafeInteger(value.groupIndex, 0))
	) return undefined;
	if ((value.group === undefined) !== (value.groupIndex === undefined)) return undefined;
	if (
		(value.requiredRanges !== undefined && !Array.isArray(value.requiredRanges)) ||
		(value.contexts !== undefined && !Array.isArray(value.contexts)) ||
		(value.omittedRanges !== undefined && !Array.isArray(value.omittedRanges))
	) return undefined;
	const requiredRanges = value.requiredRanges === undefined ? undefined : value.requiredRanges.map(parseSourceRange);
	const contexts = value.contexts === undefined ? undefined : value.contexts.map((entry) => parseReadContext(entry, undefined));
	const omittedRanges = value.omittedRanges === undefined ? undefined : value.omittedRanges.map(parseOmittedRange);
	if (requiredRanges?.some((entry) => entry === undefined) || contexts?.some((entry) => entry === undefined) || omittedRanges?.some((entry) => entry === undefined)) return undefined;
	const conflictsWith = value.conflictsWith === undefined ? undefined : parseConflictReference(value.conflictsWith);
	if (value.conflictsWith !== undefined && conflictsWith === undefined) return undefined;
	return {
		ok: false,
		protocolVersion: 1,
		...(value.path !== undefined ? { path: value.path } : {}),
		code: value.code,
		message: value.message,
		targetCommitted: false,
		...(value.currentRevision !== undefined ? { currentRevision: value.currentRevision } : {}),
		...(requiredRanges ? { requiredRanges: requiredRanges as SnaplineSourceRange[] } : {}),
		...(contexts ? { contexts: contexts as SnaplineReadContext[] } : {}),
		...(omittedRanges ? { omittedRanges: omittedRanges as SnaplineOmittedRange[] } : {}),
		...(value.group !== undefined ? { group: value.group as SnaplineChangeGroup, groupIndex: value.groupIndex as number } : {}),
		...(conflictsWith ? { conflictsWith } : {}),
	};
}

function parseEffect(value: unknown): SnaplineEditEffect | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["group", "groupIndex", "changed", "oldStart", "oldEnd", "newLineCount", "lineDelta", "newStart", "newEnd"])) return undefined;
	if (
		!isChangeGroup(value.group) || !isSafeInteger(value.groupIndex, 0) || typeof value.changed !== "boolean" ||
		!isSafeInteger(value.oldStart, 1) || !isSafeInteger(value.oldEnd, 0) || !isSafeInteger(value.newLineCount, 0) ||
		!isSafeInteger(value.lineDelta) || !isSafeInteger(value.newStart, 1) || !isSafeInteger(value.newEnd, 0)
	) return undefined;
	if (value.oldEnd < value.oldStart - 1 || value.newEnd !== value.newStart + value.newLineCount - 1) return undefined;
	return {
		group: value.group,
		groupIndex: value.groupIndex,
		changed: value.changed,
		oldStart: value.oldStart,
		oldEnd: value.oldEnd,
		newLineCount: value.newLineCount,
		lineDelta: value.lineDelta,
		newStart: value.newStart,
		newEnd: value.newEnd,
	};
}

function parseStats(value: unknown): SnaplineApplyStats | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["requestedChanges", "effectiveChanges", "oldLineCount", "newLineCount", "insertedLines", "deletedLines"])) return undefined;
	for (const key of ["requestedChanges", "effectiveChanges", "oldLineCount", "newLineCount", "insertedLines", "deletedLines"] as const) {
		if (!isSafeInteger(value[key], 0)) return undefined;
	}
	return value as SnaplineApplyStats;
}

function parseWarning(value: unknown): SnaplineWarning | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["code", "message"]) || value.code !== "post_commit_durability" || typeof value.message !== "string") return undefined;
	if (Buffer.byteLength(value.message, "utf8") > MAX_WIRE_MESSAGE_BYTES) return undefined;
	return { code: "post_commit_durability", message: value.message };
}

function parseApplySuccess(value: unknown): SnaplineApplySuccess | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["ok", "protocolVersion", "path", "outcome", "sourceRevision", "newRevision", "contentChanged", "stats", "effects", "warnings"])) return undefined;
	if (
		value.ok !== true || value.protocolVersion !== 1 || typeof value.path !== "string" || value.path.length === 0 ||
		(value.outcome !== "applied" && value.outcome !== "no_op") || !isRawRevision(value.sourceRevision) || !isRawRevision(value.newRevision) ||
		typeof value.contentChanged !== "boolean" || !Array.isArray(value.effects) || !Array.isArray(value.warnings)
	) return undefined;
	const stats = parseStats(value.stats);
	const effects = value.effects.map(parseEffect);
	const warnings = value.warnings.map(parseWarning);
	if (!stats || effects.some((effect) => effect === undefined) || warnings.some((warning) => warning === undefined)) return undefined;
	if (effects.length !== stats.requestedChanges || stats.effectiveChanges !== effects.filter((effect) => effect?.changed).length) return undefined;
	if (stats.newLineCount !== stats.oldLineCount + stats.insertedLines - stats.deletedLines) return undefined;
	if (value.outcome === "applied") {
		if (!value.contentChanged || value.sourceRevision === value.newRevision || stats.effectiveChanges === 0) return undefined;
	} else if (value.contentChanged || value.sourceRevision !== value.newRevision || stats.effectiveChanges !== 0 || warnings.length !== 0) return undefined;
	return {
		ok: true,
		protocolVersion: 1,
		path: value.path,
		outcome: value.outcome,
		sourceRevision: value.sourceRevision,
		newRevision: value.newRevision,
		contentChanged: value.contentChanged,
		stats,
		effects: effects as SnaplineEditEffect[],
		warnings: warnings as SnaplineWarning[],
	};
}

export function parseSnaplineReadRun(run: SnaplineRun, request: SnaplineReadRequest): ParsedReadRun {
	if (run.exitCode !== 0) {
		return run.started === false
			? { disposition: "unavailable", message: processMessage(run) }
			: { disposition: "invalid_response", message: processMessage(run) };
	}
	const value = parseJSON(run.stdout);
	const success = parseReadSuccess(value, request);
	if (success) return { disposition: "success", result: success };
	const failure = parseLogicalFailure(value);
	if (failure) return { disposition: "rejected", failure };
	return { disposition: "invalid_response", message: "Snapline read returned an incompatible wire response." };
}

export function parseSnaplineApplyRun(run: SnaplineRun): ParsedApplyRun {
	if (run.exitCode !== 0) {
		return run.started === false
			? { disposition: "unavailable", message: processMessage(run) }
			: { disposition: "outcome_unknown", message: processMessage(run) };
	}
	const value = parseJSON(run.stdout);
	const success = parseApplySuccess(value);
	if (success) return { disposition: "success", result: success };
	const failure = parseLogicalFailure(value);
	if (failure) return { disposition: "rejected", failure };
	return { disposition: "outcome_unknown", message: "Snapline apply returned an incompatible wire response after the process started." };
}
