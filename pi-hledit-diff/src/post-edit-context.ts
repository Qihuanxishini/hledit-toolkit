import { anchorTokenLine } from "./anchor.ts";

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
		if (
			line !== offset + index ||
			// anchor 语法已拒绝前导零，因此行号数值相等即字面一致。
			anchorTokenLine(item.anchor) !== line ||
			typeof item.text !== "string" ||
			typeof textTruncated !== "boolean"
		) {
			return undefined;
		}
		lines.push({ line, anchor: item.anchor as string, text: item.text, textTruncated });
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

// [喵喵喵]: 逐 span 验证正文；一处截断不撤销其他完整产出的证据，也不消耗它们的正文回退预算。
export function formatPostEditContext(
	spans: readonly BatchAnchorContext[],
	outputs?: readonly { reference: string; lines: readonly string[] }[],
): PostEditContextResult & { spans: BatchAnchorContext[] } {
	const producing = outputs?.filter((output) => output.lines.length > 0);
	const verified = spans.map((span, index) => {
		const output = producing?.[index];
		return producing?.length === spans.length && output !== undefined &&
			!span.truncated && span.limit === span.desiredLimit && span.lines.length === output.lines.length &&
			span.lines.every((line, row) => !line.textTruncated && line.text === output.lines[row]);
	});
	const fallback = limitVisibleAnchorSpans(spans.filter((_, index) => !verified[index]));
	let fallbackIndex = 0;
	const retained = spans.map((span, index) => verified[index] ? span : fallback[fallbackIndex++]!);
	const summaries = spans.flatMap((span, index) => {
		if (!verified[index]) return [];
		const first = span.lines[0]!.anchor;
		const last = span.lines[span.lines.length - 1]!.anchor;
		// [喵喵喵]: 与输入使用相同数组语法，避免模型把摘要区间连写成一个 token。
		const anchors = span.limit > 1 ? [first, last] : [first];
		return [`- ${producing![index]!.reference}.anchors: ${JSON.stringify(anchors)} (${span.limit} ${span.limit === 1 ? "line" : "lines"})`];
	});
	const visible = formatUpdatedAnchorSpans(fallback);
	return {
		text: [summaries.length > 0 ? ["New output anchors (submitted text verified):", ...summaries].join("\n") : "", visible.text].filter(Boolean).join("\n\n"),
		truncated: visible.truncated,
		spans: retained,
	};
}

// [喵喵喵]: 内部证据预算大于模型回退预算；回退只登记实际显示的完整行，不能把隐藏正文授权为 proof。
function limitVisibleAnchorSpans(spans: readonly BatchAnchorContext[]): BatchAnchorContext[] {
	let remainingLines = 80;
	let remainingBytes = 16 * 1024;
	return spans.map((span) => {
		const lines: BatchAnchorLine[] = [];
		for (const line of span.lines) {
			const bytes = Buffer.byteLength(`${line.anchor}:${line.text}\n`, "utf8");
			if (remainingLines === 0 || bytes > remainingBytes) break;
			lines.push(line);
			remainingLines--;
			remainingBytes -= bytes;
		}
		return { ...span, lines, limit: lines.length, truncated: span.truncated || lines.length < span.desiredLimit };
	});
}

// [喵喵喵]: 正文回退保留截断提示；纯删除没有新锚点，不输出空块。
export function formatUpdatedAnchorSpans(spans: readonly BatchAnchorContext[]): PostEditContextResult {
	const producedLines = spans.flatMap((span) => span.lines);
	const incomplete = spans.some((span) => span.truncated || span.lines.some((line) => line.textTruncated));

	const output: string[] = [];
	if (producedLines.length > 0) {
		output.push("Updated anchors:", ...producedLines.map((line) => `${line.anchor}:${line.text}`));
	}
	if (incomplete) {
		output.push("Updated anchors above are incomplete; read any missing or text-truncated target lines before editing them. Verified output ranges remain usable with the returned proof_id.");
	}
	return { text: output.join("\n"), truncated: incomplete };
}
