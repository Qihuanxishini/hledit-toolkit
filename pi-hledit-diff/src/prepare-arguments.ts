import type { FileChangeParams, ReadAnchorsParams, ReplaceOnceParams } from "./schema.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_JSON_UNWRAP_DEPTH = 2;

function parseJsonValue(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function parseJsonStructure(value: unknown, isExpectedStructure: (value: unknown) => boolean): unknown {
	let current = value;
	for (let depth = 0; depth < MAX_JSON_UNWRAP_DEPTH; depth++) {
		if (isExpectedStructure(current) || typeof current !== "string") {
			return current;
		}
		const parsed = parseJsonValue(current);
		if (parsed === current) {
			return current;
		}
		current = parsed;
	}
	return current;
}

function normalizePositiveInteger(value: unknown): unknown {
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		return value;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : value;
}

function normalizeNonNegativeInteger(value: unknown): unknown {
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		return value;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : value;
}

function normalizeAnchor(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const anchor = /^(\d+#[A-Za-z0-9_-]{3}):/.exec(value);
	return anchor?.[1] ?? value;
}

function normalizeReplacementLines(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const lines = value.split(/\r\n|\r|\n/);
	// 字符串末尾的单个换行只终止最后一行；显式数组中的空字符串仍表示调用方要求的空行。
	if (lines.length > 1 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

function normalizeChange(value: unknown): unknown {
	const parsed = parseJsonStructure(value, isRecord);
	if (!isRecord(parsed)) {
		return parsed;
	}

	// 将公开输入的等价表达规范化为内部形状；旧 operation 与旧字段仍由严格 schema 拒绝。
	const change: JsonRecord = { ...parsed };
	for (const field of ["anchor", "start_anchor", "end_anchor"] as const) {
		if (field in change) {
			change[field] = normalizeAnchor(change[field]);
		}
	}
	if ("lines" in change) {
		change.lines = normalizeReplacementLines(change.lines);
	}
	return change;
}

function normalizeChanges(value: unknown): unknown {
	const parsed = parseJsonStructure(value, (candidate) => Array.isArray(candidate) || isRecord(candidate));
	if (Array.isArray(parsed)) {
		return parsed.map(normalizeChange);
	}
	if (isRecord(parsed)) {
		return [normalizeChange(parsed)];
	}
	return parsed;
}

export function prepareReadAnchorsArguments(args: unknown): ReadAnchorsParams {
	const parsed = parseJsonStructure(args, isRecord);
	if (!isRecord(parsed)) {
		return parsed as ReadAnchorsParams;
	}
	return {
		...parsed,
		offset: normalizePositiveInteger(parsed.offset),
		limit: normalizePositiveInteger(parsed.limit),
		context: normalizeNonNegativeInteger(parsed.context),
	} as ReadAnchorsParams;
}

export function prepareFileChangeArguments(args: unknown): FileChangeParams {
	const parsed = parseJsonStructure(args, isRecord);
	if (!isRecord(parsed)) {
		return parsed as FileChangeParams;
	}
	return {
		...parsed,
		changes: normalizeChanges(parsed.changes),
	} as FileChangeParams;
}

export function prepareReplaceOnceArguments(args: unknown): ReplaceOnceParams {
	const parsed = parseJsonStructure(args, isRecord);
	if (!isRecord(parsed)) {
		return parsed as ReplaceOnceParams;
	}
	return {
		...parsed,
		old_lines: normalizeReplacementLines(parsed.old_lines),
		new_lines: normalizeReplacementLines(parsed.new_lines),
	} as ReplaceOnceParams;
}
