import { MAX_READ_LIMIT } from "./read-args.ts";
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

// 读取参数越界不改变读取语义，就地钳制到 schema 合法域，避免可自愈的调用直接失败；
// 非整数形状仍交给严格 schema 拒绝。
function parseIntegerLike(value: unknown): unknown {
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return value;
}

function clampReadOffset(value: unknown): unknown {
	const parsed = parseIntegerLike(value);
	if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) return parsed;
	return Math.max(1, parsed);
}

function clampReadLimit(value: unknown): unknown {
	const parsed = parseIntegerLike(value);
	if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) return parsed;
	// 无意义的 limit 回退到默认窗口，而不是放大成一次失败调用。
	if (parsed < 1) return undefined;
	return Math.min(parsed, MAX_READ_LIMIT);
}

function clampReadContext(value: unknown): unknown {
	const parsed = parseIntegerLike(value);
	if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) return parsed;
	return Math.max(0, parsed);
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

// 布尔参数的字符串形状（"true"/"false"）宽容转换；其余形状交给 schema 拒绝。
function normalizeBooleanLike(value: unknown): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	return value;
}

export function prepareReadAnchorsArguments(args: unknown): ReadAnchorsParams {
	const parsed = parseJsonStructure(args, isRecord);
	if (!isRecord(parsed)) {
		return parsed as ReadAnchorsParams;
	}
	return {
		...parsed,
		offset: clampReadOffset(parsed.offset),
		limit: clampReadLimit(parsed.limit),
		context: clampReadContext(parsed.context),
		ignore_case: normalizeBooleanLike(parsed.ignore_case),
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
		// 空字符串 new_lines 保持原样交给 schema 拒绝：它通常表达"删除"意图，
		// 归一化成 [""] 会静默变成"替换为一个空行"。
		new_lines: parsed.new_lines === "" ? parsed.new_lines : normalizeReplacementLines(parsed.new_lines),
	} as ReplaceOnceParams;
}
