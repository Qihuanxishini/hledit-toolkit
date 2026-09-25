import { anchorTokenLine } from "./anchor.ts";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { nextProofId } from "./proof-id.ts";
import { MAX_READ_LIMIT, type NormalizedReadRequest, type NormalizedSearchRequest } from "./read-args.ts";
import {
	isIntegerAtLeast,
	isRawRevision,
	isRecord,
	parseRunObject,
	type HleditErrorMetadata,
	type HleditReadLine,
	type HleditReadMetadata,
	type TextResult,
} from "./result.ts";

// read-range/search 响应的严格校验、错误本地化与模型正文排版。

export function parseHleditReadMetadata(value: unknown): HleditReadMetadata | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || !isRecord(value.requested) || !isRecord(value.actual) || !Array.isArray(value.lines)) return undefined;
	const requested = value.requested;
	if (!isIntegerAtLeast(requested.offset, 1) || !isIntegerAtLeast(requested.limit, 1)) return undefined;
	if (requested.pattern !== undefined && (typeof requested.pattern !== "string" || requested.pattern.length === 0)) return undefined;
	if (requested.context !== undefined && !isIntegerAtLeast(requested.context, 0)) return undefined;
	if (requested.ignoreCase !== undefined && requested.ignoreCase !== true) return undefined;
	if (requested.literal !== undefined && requested.literal !== true) return undefined;
	if (!value.lines.every((line) => isRecord(line) && typeof line.textTruncated === "boolean")) return undefined;
	const actual = value.actual;
	if (!isIntegerAtLeast(actual.lineCount, 0) || !isIntegerAtLeast(actual.totalLines, 0)) return undefined;
	if (actual.firstLine !== undefined && !isIntegerAtLeast(actual.firstLine, 1)) return undefined;
	if (actual.lastLine !== undefined && !isIntegerAtLeast(actual.lastLine, 1)) return undefined;
	if (typeof value.truncated !== "boolean" || typeof value.textTruncated !== "boolean" || typeof value.eof !== "boolean") return undefined;

	const request: NormalizedReadRequest | NormalizedSearchRequest = requested.pattern === undefined
		? { path: value.path, offset: requested.offset, limit: requested.limit }
		: {
			path: value.path,
			pattern: requested.pattern,
			offset: requested.offset,
			limit: requested.limit,
			...(requested.context !== undefined ? { context: requested.context } : {}),
			...(requested.ignoreCase === true ? { ignoreCase: true } : {}),
			...(requested.literal === true ? { literal: true } : {}),
		};
	const parsed = parseReadMetadata({
		ok: true,
		revision: value.revision,
		totalLines: actual.totalLines,
		lines: value.lines,
		truncated: value.truncated,
		...(value.nextOffset !== undefined ? { nextOffset: value.nextOffset } : {}),
		...(value.totalMatches !== undefined ? { totalMatches: value.totalMatches } : {}),
	}, request);
	if (!parsed) return undefined;
	if (
		parsed.actual.firstLine !== actual.firstLine ||
		parsed.actual.lastLine !== actual.lastLine ||
		parsed.actual.lineCount !== actual.lineCount ||
		parsed.textTruncated !== value.textTruncated ||
		parsed.eof !== value.eof ||
		parsed.totalMatches !== value.totalMatches
	) return undefined;
	return parsed;
}

export function parseUsableHleditReadMetadata(value: unknown): HleditReadMetadata | undefined {
	const read = parseHleditReadMetadata(value);
	return read && !read.textTruncated && read.requested.limit <= MAX_READ_LIMIT ? read : undefined;
}

function isRecoveryRead(value: unknown): value is HleditReadMetadata {
	if (!isRecord(value)) return false;
	const read = parseUsableHleditReadMetadata(value);
	return read !== undefined;
}

// 携带 recoveredReads 的 apply 拒绝码。恢复的每条终止分支都必须列在这里：实时执行会把
// 已完成的补读页记进 evidence，若对应的 code 不在集合内，branch replay 就会静默丢掉这些页，
// 实时状态与重放状态从此分歧（见 read-recovery.ts 的三条返回路径）。
export const READ_PROOF_RECOVERY_CODES = [
	"insufficient_read_proof",
	"source_line_truncated",
	"proof_recovery_read_failed",
	"proof_recovery_budget_exceeded",
] as const;

const READ_PROOF_RECOVERY_CODE_SET: ReadonlySet<string> = new Set<string>(READ_PROOF_RECOVERY_CODES);

export function parseRecoveredReads(value: unknown): HleditReadMetadata[] {
	if (
		!isRecord(value) || value.disposition !== "rejected" || typeof value.path !== "string" ||
		!isRecord(value.error) || typeof value.error.code !== "string" ||
		!READ_PROOF_RECOVERY_CODE_SET.has(value.error.code)
	) return [];
	if (!Array.isArray(value.recoveredReads)) return [];
	const reads: HleditReadMetadata[] = [];
	for (const candidate of value.recoveredReads) {
		if (!isRecoveryRead(candidate)) return [];
		if (candidate.path !== value.path) return [];
		reads.push(candidate);
	}
	return reads;
}

function parseReadLine(value: unknown, totalLines: number): HleditReadLine | undefined {
	if (!isRecord(value)) return undefined;
	const { line, anchor, text, textTruncated } = value;
	if (!isIntegerAtLeast(line, 1) || line > totalLines || typeof anchor !== "string" || typeof text !== "string") {
		return undefined;
	}
	if (textTruncated !== undefined && typeof textTruncated !== "boolean") return undefined;
	if (anchorTokenLine(anchor) !== line) return undefined;
	return { line, anchor, text, textTruncated: textTruncated === true };
}

function parseReadMetadata(
	parsed: Record<string, unknown>,
	request: NormalizedReadRequest | NormalizedSearchRequest,
): HleditReadMetadata | undefined {
	if (
		parsed.ok !== true ||
		!isRawRevision(parsed.revision) ||
		!isIntegerAtLeast(parsed.totalLines, 0) ||
		!Array.isArray(parsed.lines) ||
		typeof parsed.truncated !== "boolean"
	) {
		return undefined;
	}

	const searchRequest = "pattern" in request ? request : undefined;
	const totalLines = parsed.totalLines;
	const lines: HleditReadLine[] = [];
	let previousLine: number | undefined;
	for (const value of parsed.lines) {
		const line = parseReadLine(value, totalLines);
		if (!line || line.line < request.offset || (previousLine !== undefined && line.line <= previousLine)) return undefined;
		if (!searchRequest && previousLine !== undefined && line.line !== previousLine + 1) return undefined;
		lines.push(line);
		previousLine = line.line;
	}
	if (lines.length > request.limit) return undefined;
	if (!searchRequest && (lines.length === 0 || lines[0]?.line !== request.offset)) return undefined;

	let nextOffset: number | undefined;
	if (parsed.nextOffset !== undefined) {
		if (!isIntegerAtLeast(parsed.nextOffset, 1)) return undefined;
		nextOffset = parsed.nextOffset;
	}

	const firstLine = lines[0]?.line;
	const lastLine = lines[lines.length - 1]?.line;
	const textTruncated = lines.some((line) => line.textTruncated);
	if (textTruncated && !parsed.truncated) return undefined;
	if (nextOffset !== undefined) {
		if (!parsed.truncated || lastLine === undefined || nextOffset !== lastLine + 1 || nextOffset > totalLines) return undefined;
	}
	if (parsed.truncated && nextOffset === undefined && !textTruncated) return undefined;
	if (!parsed.truncated && nextOffset !== undefined) return undefined;
	if (!searchRequest && !parsed.truncated && lastLine !== totalLines) return undefined;
	if (searchRequest && !isIntegerAtLeast(parsed.totalMatches, 0)) return undefined;

	return {
		path: request.path,
		revision: parsed.revision,
		requested: {
			offset: request.offset,
			limit: request.limit,
			...(searchRequest ? { pattern: searchRequest.pattern } : {}),
			...(searchRequest?.context !== undefined ? { context: searchRequest.context } : {}),
			...(searchRequest?.ignoreCase ? { ignoreCase: true } : {}),
			...(searchRequest?.literal ? { literal: true } : {}),
		},
		actual: {
			...(firstLine !== undefined ? { firstLine } : {}),
			...(lastLine !== undefined ? { lastLine } : {}),
			lineCount: lines.length,
			totalLines,
		},
		lines,
		truncated: parsed.truncated,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		textTruncated,
		eof: !searchRequest && !parsed.truncated && lastLine === totalLines,
		...(searchRequest ? { totalMatches: parsed.totalMatches as number } : {}),
	};
}

// CLI 读取侧错误码全集：range / binary / encoding / directory / io / pattern / broad_pattern。
// 每个码必须同时给出 message 与 hint：兜底分支只会把错误码原样丢给模型，等于让它盲试。
type ReadErrorFacts = {
	code: string;
	rawMessage: string;
	requestedOffset?: number;
	totalLines?: number;
};

// RE2 编译错误的可操作内容就是出错位置本身，没有稳定可本地化的形状，直接转发 CLI 原文；
// 其余错误码只用结构化字段重述，不暴露 raw message。
function searchPatternCompileDetail(rawMessage: string): string | undefined {
	const compileFailure = /^invalid search pattern:\s*(.+)$/s.exec(rawMessage);
	return compileFailure?.[1];
}

function localizeReadErrorMessage(facts: ReadErrorFacts): string {
	const { code } = facts;
	if (code === "range" && facts.requestedOffset !== undefined && facts.totalLines !== undefined) {
		return `Starting line ${facts.requestedOffset} is outside the file range (${facts.totalLines} total lines).`;
	}
	if (code === "binary") {
		return "The target appears to be binary and cannot be read as text.";
	}
	if (code === "encoding") {
		return "The target is not valid UTF-8 text; reading was rejected to protect the original bytes.";
	}
	if (code === "directory") {
		return "The provided path is a directory, but hledit reads one concrete text file at a time.";
	}
	if (code === "io") {
		return "The file could not be read. Check its path, permissions, and whether it still exists.";
	}
	if (code === "pattern") {
		const detail = searchPatternCompileDetail(facts.rawMessage);
		return detail
			? `The search pattern is not a valid RE2 regular expression: ${detail}`
			: "The search pattern is empty or is not a valid RE2 regular expression.";
	}
	if (code === "broad_pattern") {
		return "The search pattern is an unconstrained wildcard (an unbounded \".\" repetition) that matches essentially every line, so it was rejected instead of returning whole-file output.";
	}
	return `hledit rejected this read (error code: ${code}).`;
}

function readErrorHint(facts: ReadErrorFacts): string | undefined {
	if (facts.code === "range" && facts.totalLines !== undefined) {
		return facts.totalLines === 0
			? "The file is empty, so no anchors exist. To add content to an empty file, use write."
			: `Set offset to an integer from 1 through ${facts.totalLines}.`;
	}
	if (facts.code === "directory") {
		return "Provide a concrete text file path. For a directory-wide search, locate candidate files first and search them individually.";
	}
	if (facts.code === "pattern") {
		return "hledit matches with Go RE2, which has no lookahead, lookbehind, or backreferences. Rewrite the pattern in RE2 syntax, or pass literal:true to match the text exactly.";
	}
	if (facts.code === "broad_pattern") {
		return "Search for concrete text, or add a subpattern that constrains the match. To inspect a contiguous region, call hledit_read_anchors instead.";
	}
	return undefined;
}

function parseReadErrorMetadata(parsed: Record<string, unknown>): HleditErrorMetadata | undefined {
	if (parsed.ok !== false || typeof parsed.error !== "string" || typeof parsed.message !== "string") return undefined;
	const requestedOffset = isIntegerAtLeast(parsed.requestedOffset, 1) ? parsed.requestedOffset : undefined;
	const totalLines = isIntegerAtLeast(parsed.totalLines, 0) ? parsed.totalLines : undefined;
	if (parsed.error === "range" && (requestedOffset === undefined || totalLines === undefined)) return undefined;

	const facts: ReadErrorFacts = {
		code: parsed.error,
		rawMessage: parsed.message,
		...(requestedOffset !== undefined ? { requestedOffset } : {}),
		...(totalLines !== undefined ? { totalLines } : {}),
	};
	const hint = readErrorHint(facts);
	return {
		code: facts.code,
		message: localizeReadErrorMessage(facts),
		rawMessage: facts.rawMessage,
		...(hint ? { hint } : {}),
		...(requestedOffset !== undefined ? { requestedOffset } : {}),
		...(totalLines !== undefined ? { totalLines } : {}),
	};
}

// 补读路径复用同一份渲染，但省略 proof_id：多页恢复只有一个权威 proof id，
// 逐页重复输出会让调用方抄到已经作废的那个（见 read-recovery.ts）。
export function formatReadMetadata(read: HleditReadMetadata, proofId?: string): string {
	const anchoredLines = read.lines.map((line) => `${line.anchor}:${line.text}`);
	const { firstLine, lastLine, lineCount, totalLines } = read.actual;
	const pattern = read.requested.pattern;
	let notice: string;

	if (read.textTruncated) {
		notice = `-- Source line text was truncated${lastLine !== undefined ? `; the last returned line is ${lastLine}` : ""} (${totalLines} lines total); rereading line ranges cannot recover the omitted in-line text. Truncated lines cannot establish edit proof; if the edit target includes such a line, rewrite the file with write instead.${read.nextOffset !== undefined ? ` To read later lines, continue with offset ${read.nextOffset}.` : ""} --`;
	} else if (pattern !== undefined) {
		if (lineCount === 0) {
			notice = `-- No lines matching ${JSON.stringify(pattern)} were found (${totalLines} lines total) --`;
		} else if (read.nextOffset !== undefined) {
			notice = `-- Returned ${lineCount} matching lines with context, ending at line ${lastLine} (${totalLines} lines total); continue with offset ${read.nextOffset} --`;
		} else {
			notice = `-- Returned ${lineCount} matching lines with context${read.totalMatches !== undefined ? ` (${read.totalMatches} matches total)` : ""} (${totalLines} lines total) --`;
		}
	} else if (read.nextOffset !== undefined) {
		notice = `-- Showing lines ${firstLine}-${lastLine} of ${totalLines}; continue with offset ${read.nextOffset} --`;
	} else {
		notice = `-- Showing lines ${firstLine}-${lastLine} of ${totalLines}; end of file --`;
	}

	return [
		...(proofId ? [`proof_id: ${proofId}`] : []),
		...anchoredLines,
		notice,
	].join("\n");
}

function formatReadError(error: HleditErrorMetadata): string {
	const lines = [error.message];
	if (error.hint) lines.push(`Suggestion: ${error.hint}`);
	lines.push(`Error code: ${error.code}`);
	return lines.join("\n");
}

function invalidReadResponseText(): string {
	return `Anchor read failed because the bundled hledit returned an incompatible response. Expected structured JSON with ok, totalLines, valid anchor lines, truncation state, and optional nextOffset.\n\n${HLEDIT_INSTALL_HINT}`;
}

export function readAnchorsResult(run: HleditRun, request: NormalizedReadRequest | NormalizedSearchRequest): TextResult {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return {
			content: [{ type: "text", text: text || HLEDIT_INSTALL_HINT }],
			details: { disposition: "unavailable", path: request.path },
		};
	}

	const parsed = parseRunObject(run);
	if (!parsed) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable", path: request.path },
		};
	}
	if (parsed.ok === false) {
		const error = parseReadErrorMetadata(parsed);
		if (!error) {
			return {
				content: [{ type: "text", text: invalidReadResponseText() }],
				details: { disposition: "unavailable", path: request.path },
			};
		}
		return {
			content: [{ type: "text", text: formatReadError(error) }],
			details: { disposition: "rejected", path: request.path, error },
		};
	}

	const read = parseReadMetadata(parsed, request);
	if (!read) {
		return {
			content: [{ type: "text", text: invalidReadResponseText() }],
			details: { disposition: "unavailable", path: request.path },
		};
	}
	const proofId = read.requested.pattern !== undefined && read.lines.length === 0 ? undefined : nextProofId();
	return {
		content: [{ type: "text", text: formatReadMetadata(read, proofId) }],
		details: {
			disposition: "succeeded",
			path: request.path,
			revision: read.revision,
			...(proofId ? { proofId } : {}),
			read,
		},
	};
}
