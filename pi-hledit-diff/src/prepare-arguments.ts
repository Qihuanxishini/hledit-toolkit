import type { FileChangeParams, ReadAnchorsParams } from "./schema.ts";

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

function normalizeRawLines(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	return value.split(/\r\n|\r|\n/);
}

function normalizeChange(value: unknown): unknown {
	const parsed = parseJsonStructure(value, isRecord);
	if (!isRecord(parsed)) {
		return parsed;
	}

	// 只修复不改变编辑语义的序列化偏差；旧 operation 与旧字段由严格 schema 直接拒绝。
	const change: JsonRecord = { ...parsed };
	for (const field of ["anchor", "start_anchor", "end_anchor"] as const) {
		if (field in change) {
			change[field] = normalizeAnchor(change[field]);
		}
	}
	if ("lines" in change) {
		change.lines = normalizeRawLines(change.lines);
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
