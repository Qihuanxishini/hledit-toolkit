import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";

// 锚点 token 形状在每个 anchor window 的逐行校验热路径上使用，只编译一次。
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
	offset: number;
	limit: number;
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

export function parseBatchUpdatedAnchorContext(parsed: Record<string, unknown> | null): BatchAnchorContext | undefined {
	return parseAnchorContext(parsed?.updatedAnchors);
}

// 一个 change 在新文件坐标下写出的行区间；纯删除什么都没写出，产出空区间（end < start）。
export type ProducedLineRange = { start: number; end: number };

// 只有落在本次编辑产出区间内的锚点才是模型无法从旧证据推出的新信息：区间外的行
// 已由 editDeltas 平移与 verified rename 覆盖。CLI 窗口按 firstChanged..lastChanged 取
// 整段，跨度大的多 change batch 会把截断额度塞满无关上下文，因此模型正文按产出
// 区间过滤；details.updatedAnchors 仍保留完整窗口供 evidence 与 TUI 使用。
export function formatBatchUpdatedAnchorContext(
	context: BatchAnchorContext,
	producedLineRanges: readonly ProducedLineRange[],
): PostEditContextResult {
	// 纯删除的空区间既没新行可展示，也不应因落在窗口外而报不完整。
	const nonEmptyRanges = producedLineRanges.filter((range) => range.end >= range.start);
	const producedLines = context.lines.filter((line) =>
		nonEmptyRanges.some((range) => line.line >= range.start && line.line <= range.end));
	const windowEnd = context.offset + context.limit - 1;
	// 只关心产出行本身是否完整可得：CLI 的 context.truncated 只说明上下文行被砍，
	// 而上下文行本就不再进入模型正文；窗口真的没盖到产出行时，下面的边界比较
	// 会直接命中（parseAnchorContext 保证 lines 从 offset 起逐行连续且 limit === lines.length）。
	const incomplete = producedLines.some((line) => line.textTruncated)
		|| nonEmptyRanges.some((range) => range.start < context.offset || range.end > windowEnd);

	const output: string[] = [];
	if (context.lines.length === 0) {
		output.push("Updated anchors:", "(the file is empty)");
	} else if (producedLines.length > 0) {
		output.push("Updated anchors:", ...producedLines.map((line) => `${line.anchor}:${line.text}`));
	}
	if (incomplete) {
		output.push("Updated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
	}

	return {
		text: output.join("\n"),
		offset: context.offset,
		limit: context.limit,
		truncated: incomplete,
	};
}
