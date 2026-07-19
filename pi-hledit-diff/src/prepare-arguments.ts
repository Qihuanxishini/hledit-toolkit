import type { FileChangeParams, ReadAnchorsParams } from "./schema.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	const anchor = /^(\d+#[A-Za-z0-9]+):/.exec(value);
	return anchor?.[1] ?? value;
}

function normalizeRawLines(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	return value.split(/\r\n|\r|\n/);
}

function normalizeChange(value: unknown): unknown {
	const parsed = parseJsonValue(value);
	if (!isRecord(parsed)) {
		return parsed;
	}

	// 仅修复语义唯一的常见偏差；其余字段保留给 schema 拒绝，避免猜测写入意图。
	const change: JsonRecord = { ...parsed };
	if (change.operation === undefined && typeof change.op === "string") {
		change.operation = change.op;
		delete change.op;
	}
	if (change.operation === "replace-range") {
		change.operation = "replace";
	}
	change.anchor = normalizeAnchor(change.anchor);
	if ("end_anchor" in change) {
		change.end_anchor = normalizeAnchor(change.end_anchor);
	}
	if ("lines" in change) {
		change.lines = normalizeRawLines(change.lines);
	}
	return change;
}

function normalizeChanges(value: unknown): unknown {
	const parsed = parseJsonValue(value);
	if (Array.isArray(parsed)) {
		return parsed.map(normalizeChange);
	}
	if (isRecord(parsed)) {
		return [normalizeChange(parsed)];
	}
	return parsed;
}

export function prepareReadAnchorsArguments(args: unknown): ReadAnchorsParams {
	const parsed = parseJsonValue(args);
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
	const parsed = parseJsonValue(args);
	if (!isRecord(parsed)) {
		return parsed as FileChangeParams;
	}
	return {
		...parsed,
		changes: normalizeChanges(parsed.changes),
	} as FileChangeParams;
}
