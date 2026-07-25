import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";

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
		if (
			line !== offset + index ||
			typeof item.anchor !== "string" ||
			!new RegExp(`^${line}#${ANCHOR_HASH_PATTERN}$`).test(item.anchor) ||
			typeof item.text !== "string" ||
			typeof textTruncated !== "boolean"
		) {
			return undefined;
		}
		lines.push({ line, anchor: item.anchor, text: item.text, textTruncated });
	}

	return { lines, offset, limit, desiredLimit, truncated: value.truncated };
}

export function parseBatchUpdatedAnchorContext(parsed: Record<string, unknown> | null): BatchAnchorContext | undefined {
	return parseAnchorContext(parsed?.updatedAnchors);
}

export function formatBatchUpdatedAnchorContext(context: BatchAnchorContext): PostEditContextResult {
	const truncated = context.truncated || context.lines.some((line) => line.textTruncated);
	const lastLine = context.limit === 0 ? undefined : context.offset + context.limit - 1;
	const scope = lastLine === undefined
		? "Updated anchors (local window; the file is now empty):"
		: `Updated anchors (only the affected window, lines ${context.offset}-${lastLine}; not the whole file):`;
	const output = [
		scope,
		context.lines.map((line) => `${line.anchor}:${line.text}`).join("\n") || "(the file is empty)",
		// 与证据重映射协议一致：窗口外未变更行的旧锚点仍有效；行号平移由拒绝响应给出
		// 经验证更名。不得再让模型在窗口外无条件重读。
		"Later changes inside this window must use these new anchors. Anchors read earlier stay valid for unchanged lines outside the window; if an edit shifted a line number, a rejected call lists the verified renamed anchor to resubmit with. Call hledit_read_anchors only for ranges that were never read or when a failure requests a targeted read.",
	];
	if (truncated) {
		output.push(`The anchor context was truncated; call hledit_read_anchors with offset:${context.offset} and limit:${context.desiredLimit}.`);
	}

	return {
		text: output.join("\n"),
		offset: context.offset,
		limit: context.limit,
		truncated,
	};
}
