import type { HleditRun } from "./cli.ts";
import type { BatchAnchorContext, ProducedLineRange } from "./post-edit-context.ts";

// 三个工具共用的结果类型、结构化 details 与构造器；读取与写入各自的响应校验
// 分别位于 read-result.ts 与 apply-result.ts。

export type HleditToolKind = "read_anchors" | "search_anchors" | "apply_file_changes";
export type HleditDisposition = "succeeded" | "rejected" | "unavailable" | "outcome_unknown";

export type HleditReadLine = {
	line: number;
	anchor: string;
	text: string;
	textTruncated: boolean;
};

export type HleditReadMetadata = {
	path: string;
	revision: string;
	requested: {
		offset: number;
		limit: number;
		pattern?: string;
		context?: number;
		ignoreCase?: boolean;
		literal?: boolean;
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
	totalMatches?: number;
};

export type FileChangeAnchorField = "anchor" | "start_anchor" | "end_anchor";

export type HleditStaleAnchor = {
	changeNumber: number;
	fields: FileChangeAnchorField[];
	requestedAnchor: string;
	currentAnchor?: string;
	currentText?: string;
	currentTextTruncated?: true;
};

// 与 CLI EditDelta 对应：oldStart/oldEnd 是原始行坐标中被消费的区间（纯插入时
// oldEnd === oldStart-1 的空区间），delta 是该编辑造成的行数变化。
export type HleditEditDelta = {
	oldStart: number;
	oldEnd: number;
	delta: number;
};

export function parseEditDeltas(value: unknown): HleditEditDelta[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const deltas: HleditEditDelta[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const { oldStart, oldEnd, delta } = item;
		if (
			typeof oldStart !== "number" || !Number.isSafeInteger(oldStart) || oldStart < 1 ||
			typeof oldEnd !== "number" || !Number.isSafeInteger(oldEnd) || oldEnd < oldStart - 1 ||
			typeof delta !== "number" || !Number.isSafeInteger(delta)
		) {
			return undefined;
		}
		// 空消费区间只能是纯插入；非空区间的净变化不能低于整段删除。
		if (oldEnd === oldStart - 1 && delta <= 0) return undefined;
		if (oldEnd >= oldStart && delta < -(oldEnd - oldStart + 1)) return undefined;
		// CLI 按物理边界升序输出，消费区间互不重叠；乱序或重叠说明响应不可信，
		// 直接用于证据重映射会平移出错误行号。
		const previous = deltas.at(-1);
		if (previous && oldStart <= previous.oldEnd) return undefined;
		deltas.push({ oldStart, oldEnd, delta });
	}
	return deltas;
}

// 把 editDeltas 换算成新文件坐标下的产出区间：区间内的行是本次编辑新写入的，
// 模型没有任何旧锚点可用；纯删除产出空区间。parseEditDeltas 已保证升序不重叠。
export function producedLineRangesFromEditDeltas(deltas: HleditEditDelta[]): ProducedLineRange[] {
	let shift = 0;
	return deltas.map((delta) => {
		const start = delta.oldStart + shift;
		const producedCount = delta.oldEnd - delta.oldStart + 1 + delta.delta;
		shift += delta.delta;
		return { start, end: start + producedCount - 1 };
	});
}

export type HleditErrorMetadata = {
	nextAction?: "read_target" | "relocate_target" | "reduce_batch" | "review_and_retry" | "resolve_read_error" | "inspect_source";
	code: string;
	message: string;
	rawMessage?: string;
	hint?: string;
	requestedOffset?: number;
	totalLines?: number;
	changeNumber?: number;
	operation?: "replace_range" | "delete_range" | "insert_before" | "insert_after";
	staleAnchors?: HleditStaleAnchor[];
	currentAnchors?: BatchAnchorContext;
	currentRevision?: string;
	renamedAnchors?: Array<{ requested: string; current: string }>;
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
	path?: string;
	evidencePath?: string;
	revision?: string;
	proofId?: string;
	evidenceVersion?: 2;
	evidenceOrder?: { timeline: string; sequence: number };
	evidenceDropped?: true;
	baseProofId?: string;
	updatedAnchorSpans?: BatchAnchorContext[];
	unprovenAnchors?: string[];
	read?: HleditReadMetadata;
	recoveredReads?: HleditReadMetadata[];
	recoveryRequiredRanges?: Array<{ start: number; end: number }>;
	recoveryReadError?: { disposition: HleditDisposition; error?: HleditErrorMetadata };
	error?: HleditErrorMetadata;
	resolvedAnchors?: Array<{ requested: string; current: string }>;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
	isError?: boolean;
};

const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

export function isRawRevision(value: unknown): value is string {
	return typeof value === "string" && RAW_REVISION_PATTERN.test(value);
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

// 结果的 canonical 归属：path 用于展示与 compaction，evidencePath 是 evidence/queue 的键。
export function attachEvidencePath(result: TextResult, normalizedPath: string, evidencePath: string): TextResult {
	return {
		...result,
		details: { ...result.details, path: normalizedPath, evidencePath },
	};
}

export function unavailableToolResult(text: string): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition: "unavailable" },
	};
}

export function rejectedToolResult(text: string, error: HleditErrorMetadata): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition: "rejected", error },
	};
}

export function isFailedHleditResult(details: unknown): boolean {
	return isRecord(details) && details.disposition !== "succeeded";
}

export function shouldMarkHleditResultAsError(details: unknown): boolean {
	if (!isFailedHleditResult(details)) return false;
	if (!isRecord(details) || details.disposition !== "rejected" || !isRecord(details.error)) return true;
	return details.error.code !== "insufficient_read_proof";
}
