import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";

// 锚点 token 形状在每个 anchor span 的逐行校验热路径上使用，只编译一次。
const ANCHOR_TOKEN_PATTERN = new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`);

export type BatchAnchorLine = {
	line: number;
	anchor: string;
	text: string;
	textTruncated: boolean;
};

export type BatchAnchorContext = {
	lines: BatchAnchorLine[];
	offset: number;
	limit: number;
	desiredLimit: number;
	truncated: boolean;
};

export type PostEditContextResult = {
	text: string;
	truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseAnchorContext(value: unknown): BatchAnchorContext | undefined {
	if (!isRecord(value) || !Array.isArray(value.lines) || typeof value.truncated !== "boolean") {
		return undefined;
	}

	const offset = positiveInteger(value.offset);
	const limit = nonNegativeInteger(value.limit);
	const desiredLimit = nonNegativeInteger(value.desiredLimit);
	if (offset === undefined || limit === undefined || desiredLimit === undefined || limit !== value.lines.length || desiredLimit < limit) {
		return undefined;
	}

	const lines: BatchAnchorLine[] = [];
	for (const [index, item] of value.lines.entries()) {
		if (!isRecord(item)) {
			return undefined;
		}
		const line = positiveInteger(item.line);
		const textTruncated = item.textTruncated ?? false;
		const anchorMatch = typeof item.anchor === "string" ? ANCHOR_TOKEN_PATTERN.exec(item.anchor) : null;
		if (
			line !== offset + index ||
			anchorMatch === null ||
			// 不能只比数值：前导零形式（"007#abc"）不是合法锚点，必须拒绝。
			anchorMatch[1] !== String(line) ||
			typeof item.text !== "string" ||
			typeof textTruncated !== "boolean"
		) {
			return undefined;
		}
		lines.push({ line, anchor: anchorMatch[0], text: item.text, textTruncated });
	}

	return { lines, offset, limit, desiredLimit, truncated: value.truncated };
}

// 成功 batch 的产出 span：每个 span精确覆盖一个编辑在新坐标下写出的区间，按物理顺序
// 排列且互不重叠。span 与 editDeltas 的一一对应由 result.ts 对照请求校验。
export function parseUpdatedAnchorSpans(value: unknown): BatchAnchorContext[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const spans: BatchAnchorContext[] = [];
	let previousEnd = 0;
	for (const item of value) {
		const span = parseAnchorContext(item);
		if (!span || span.desiredLimit < 1 || span.offset <= previousEnd) return undefined;
		previousEnd = span.offset + span.desiredLimit - 1;
		spans.push(span);
	}
	return spans;
}

// 一个 change 在新文件坐标下写出的行区间；纯删除什么都没写出，产出空区间（end < start）。
export type ProducedLineRange = { start: number; end: number };

// span 里的行全部是本次编辑新写入的，模型没有任何旧锚点可用，因此整体进入模型正文；
// 区间外的行已由 editDeltas 平移与 verified rename 覆盖，CLI 不再返回。纯删除没有 span，
// 不输出 anchor 块；只有 span 被预算截断或产出行文本被截断时才提示不完整。
export function formatUpdatedAnchorSpans(spans: readonly BatchAnchorContext[]): PostEditContextResult {
	const producedLines = spans.flatMap((span) => span.lines);
	const incomplete = spans.some((span) => span.truncated || span.lines.some((line) => line.textTruncated));

	const output: string[] = [];
	if (producedLines.length > 0) {
		output.push("Updated anchors:", ...producedLines.map((line) => `${line.anchor}:${line.text}`));
	}
	if (incomplete) {
		output.push("Updated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
	}
	return { text: output.join("\n"), truncated: incomplete };
}
