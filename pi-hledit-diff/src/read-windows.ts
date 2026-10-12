import { anchorTokenLine } from "./anchor.ts";
import type { HleditRun } from "./cli.ts";
import { nextProofId } from "./proof-id.ts";
import { MAX_READ_LIMIT, MAX_READ_WINDOWS, MAX_WINDOWS_BYTES, normalizeToolPath } from "./read-args.ts";
import { readAnchorsResult } from "./read-result.ts";
import { isRawRevision, isRecord, parseRunObject, rejectedToolResult, type HleditReadLine, type TextResult } from "./result.ts";
import type { ReadAnchorsParams } from "./schema.ts";

export type ReadWindow = { offset: number; limit: number };
export type WindowsRequest = { path: string; windows: ReadWindow[] };
export type WindowSegment = ReadWindow & { requestedWindows: number[] };
export type WindowRead = WindowSegment & { lines: HleditReadLine[]; truncated: boolean; nextOffset?: number };
export type WindowsReadMetadata = {
	path: string;
	revision: string;
	totalLines: number;
	requested: ReadWindow[];
	windows: WindowRead[];
	truncated: boolean;
};

function safeInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function parseWindows(value: unknown): ReadWindow[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_READ_WINDOWS) return undefined;
	const windows: ReadWindow[] = [];
	for (const window of value) {
		if (!isRecord(window) || Object.keys(window).some((key) => key !== "offset" && key !== "limit") ||
			!safeInteger(window.offset, 1) || !safeInteger(window.limit, 1) || window.limit > MAX_READ_LIMIT ||
			!Number.isSafeInteger(window.offset + window.limit - 1)) return undefined;
		windows.push({ offset: window.offset, limit: window.limit });
	}
	return windows;
}

export function normalizeWindowsRequest(params: ReadAnchorsParams): WindowsRequest | undefined {
	const windows = parseWindows(params.windows);
	return windows ? { path: normalizeToolPath(params.path), windows } : undefined;
}

// [喵喵喵]: 与 CLI 的物理合并规则相同；原始序号只用于对应请求，不复制重叠正文。
function mergeWindows(windows: readonly ReadWindow[], totalLines: number): WindowSegment[] {
	const sorted = windows.map((window, index) => ({
		offset: window.offset,
		end: Math.min(window.offset + window.limit - 1, totalLines),
		requestedWindows: [index + 1],
	})).sort((a, b) => a.offset - b.offset);
	const merged: typeof sorted = [];
	for (const window of sorted) {
		const last = merged.at(-1);
		if (last && window.offset <= last.end + 1) {
			last.end = Math.max(last.end, window.end);
			last.requestedWindows.push(...window.requestedWindows);
		} else merged.push(window);
	}
	return merged.map((window) => ({
		offset: window.offset, limit: window.end - window.offset + 1,
		requestedWindows: window.requestedWindows.sort((a, b) => a - b),
	}));
}

// [喵喵喵]: 实时结果与 branch replay 使用相同解析器；只信可由请求、总行数和完整行重算的元数据。
export function parseWindowsReadMetadata(value: unknown): WindowsReadMetadata | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || !isRawRevision(value.revision) ||
		!safeInteger(value.totalLines, 1) || typeof value.truncated !== "boolean" || !Array.isArray(value.windows)) return undefined;
	const totalLines = value.totalLines;
	const requested = parseWindows(value.requested);
	if (!requested || requested.some((window) => window.offset > totalLines)) return undefined;
	const expected = mergeWindows(requested, totalLines);
	if (expected.length !== value.windows.length) return undefined;
	const windows: WindowRead[] = [];
	let totalReturned = 0;
	for (const [index, item] of value.windows.entries()) {
		const segment = expected[index]!;
		if (!isRecord(item) || item.offset !== segment.offset || item.limit !== segment.limit ||
			!Array.isArray(item.requestedWindows) || item.requestedWindows.length !== segment.requestedWindows.length ||
			!item.requestedWindows.every((number, i) => number === segment.requestedWindows[i]) ||
			!Array.isArray(item.lines) || item.lines.length > segment.limit || typeof item.truncated !== "boolean") return undefined;
		const lines: HleditReadLine[] = [];
		for (const [row, line] of item.lines.entries()) {
			if (!isRecord(line) || line.line !== segment.offset + row || anchorTokenLine(line.anchor) !== line.line ||
				typeof line.text !== "string" || (line.textTruncated !== undefined && typeof line.textTruncated !== "boolean") ||
				(line.textTruncated === true && row !== item.lines.length - 1)) return undefined;
			lines.push({ line: line.line as number, anchor: line.anchor as string, text: line.text, textTruncated: line.textTruncated === true });
		}
		totalReturned += lines.length;
		if (totalReturned > MAX_READ_LIMIT) return undefined;
		const last = lines.at(-1);
		const truncated = lines.length < segment.limit || last?.textTruncated === true;
		const nextOffset = truncated ? last ? last.line + (last.textTruncated ? 0 : 1) : segment.offset : undefined;
		if (item.truncated !== truncated || item.nextOffset !== nextOffset) return undefined;
		windows.push({ ...segment, lines, truncated, ...(nextOffset !== undefined ? { nextOffset } : {}) });
	}
	if (value.truncated !== windows.some((window) => window.truncated)) return undefined;
	return { path: value.path, revision: value.revision, totalLines: value.totalLines, requested, windows, truncated: value.truncated };
}

function formatWindowsRead(read: WindowsReadMetadata, proofId?: string): string {
	const output = proofId ? [`proof_id: ${proofId}`] : ["Incomplete windows; this call created no read proof."];
	for (const window of read.windows) {
		const last = window.lines.at(-1);
		output.push(`-- windows ${window.requestedWindows.join(",")}: ${window.offset}-${window.offset + window.limit - 1}; ${window.lines.length} lines${window.truncated ? "; incomplete" : ""} --`);
		output.push(...window.lines.map((line) => `${line.anchor}:${line.text}`));
		if (window.truncated) output.push(`Pending source lines: ${window.nextOffset}-${window.offset + window.limit - 1}.${last?.textTruncated ? " Source text is truncated; its anchor is not proof." : ""}`);
	}
	if (read.truncated) output.push("No windows from this call were registered. Read the required ranges in smaller calls, including completed windows, and use the latest proof_id. Do not edit from this preview.");
	return output.join("\n");
}

export function readWindowsResult(run: HleditRun, request: WindowsRequest): TextResult {
	const parsed = parseRunObject(run);
	// [喵喵喵]: 文件/编码/越界错误复用单窗口诊断，成功响应才走独立的窗口协议。
	if (run.exitCode !== 0 || parsed?.ok !== true) {
		return readAnchorsResult(run, { path: request.path, ...request.windows[0]! });
	}
	const read = Buffer.byteLength(run.stdout, "utf8") <= MAX_WINDOWS_BYTES
		? parseWindowsReadMetadata({ ...parsed, path: request.path, requested: request.windows })
		: undefined;
	if (!read) return rejectedToolResult("The bundled CLI returned an incompatible read-windows response; no proof was created. Resync the bundled CLI before retrying.", {
		code: "invalid_read_response", message: "Invalid read-windows metadata.",
	});
	const proofId = read.truncated ? undefined : nextProofId();
	return {
		content: [{ type: "text", text: formatWindowsRead(read, proofId) }],
		details: {
			disposition: read.truncated ? "rejected" : "succeeded",
			path: request.path, windowsRead: read,
			...(proofId ? { proofId } : { error: { code: "incomplete_windows", message: "Read windows exceeded the shared budget; no proof was created." } }),
		},
	};
}
