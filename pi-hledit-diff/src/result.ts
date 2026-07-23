import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";
import { parseAnchorContext, parseBatchUpdatedAnchorContext, type BatchAnchorContext } from "./post-edit-context.ts";
import type { NormalizedReadRequest } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

export type HleditToolKind = "read_anchors" | "apply_file_changes";
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
		grep?: string;
		context?: number;
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

export type HleditErrorMetadata = {
	code: string;
	message: string;
	rawMessage?: string;
	hint?: string;
	requestedOffset?: number;
	totalLines?: number;
	changeNumber?: number;
	operation?: "replace_range" | "delete_range" | "insert_before" | "insert_after";
	anchor?: string;
	outputLineCount?: number;
	relatedChangeNumber?: number;
	candidateEndAnchor?: string;
	staleAnchors?: HleditStaleAnchor[];
	currentAnchors?: BatchAnchorContext;
	currentRevision?: string;
};

type ApplyResultContext = {
	path?: string;
	changes?: FileChangeParams["changes"];
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
	path?: string;
	evidencePath?: string;
	revision?: string;
	updatedAnchors?: BatchAnchorContext;
	read?: HleditReadMetadata;
	error?: HleditErrorMetadata;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
};

const READ_ANCHOR_PATTERN = new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`);
const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isRawRevision(value: unknown): value is string {
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

function parseReadLine(value: unknown, totalLines: number): HleditReadLine | undefined {
	if (!isRecord(value)) return undefined;
	const { line, anchor, text, textTruncated } = value;
	if (!isIntegerAtLeast(line, 1) || line > totalLines || typeof anchor !== "string" || typeof text !== "string") {
		return undefined;
	}
	if (textTruncated !== undefined && typeof textTruncated !== "boolean") return undefined;
	const anchorMatch = READ_ANCHOR_PATTERN.exec(anchor);
	if (!anchorMatch || Number(anchorMatch[1]) !== line) return undefined;
	return { line, anchor, text, textTruncated: textTruncated === true };
}

function parseReadMetadata(parsed: Record<string, unknown>, request: NormalizedReadRequest): HleditReadMetadata | undefined {
	if (
		parsed.ok !== true ||
		!isRawRevision(parsed.revision) ||
		!isIntegerAtLeast(parsed.totalLines, 0) ||
		!Array.isArray(parsed.lines) ||
		typeof parsed.truncated !== "boolean"
	) {
		return undefined;
	}

	const totalLines = parsed.totalLines;
	const lines: HleditReadLine[] = [];
	let previousLine: number | undefined;
	for (const value of parsed.lines) {
		const line = parseReadLine(value, totalLines);
		if (!line || line.line < request.offset || (previousLine !== undefined && line.line <= previousLine)) return undefined;
		if (!request.grep && previousLine !== undefined && line.line !== previousLine + 1) return undefined;
		lines.push(line);
		previousLine = line.line;
	}
	if (lines.length > request.limit) return undefined;
	if (!request.grep && (lines.length === 0 || lines[0]?.line !== request.offset)) return undefined;

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
	if (!request.grep && !parsed.truncated && lastLine !== totalLines) return undefined;

	return {
		path: request.path,
		revision: parsed.revision,
		requested: {
			offset: request.offset,
			limit: request.limit,
			...(request.grep ? { grep: request.grep } : {}),
			...(request.context !== undefined ? { context: request.context } : {}),
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
		eof: !request.grep && !parsed.truncated && lastLine === totalLines,
	};
}

function localizeReadErrorMessage(
	code: string,
	requestedOffset: number | undefined,
	totalLines: number | undefined,
): string {
	if (code === "range" && requestedOffset !== undefined && totalLines !== undefined) {
		return `起始行 ${requestedOffset} 超出文件范围（文件共 ${totalLines} 行）。`;
	}
	if (code === "binary") {
		return "目标文件疑似为二进制，无法按文本读取。";
	}
	if (code === "encoding") {
		return "目标文件不是有效的 UTF-8 文本，已拒绝读取以避免损坏原始字节。";
	}
	if (code === "io") {
		return "读取文件失败；请检查路径、权限以及文件是否仍然存在。";
	}
	return `hledit 拒绝了本次读取（错误代码：${code}）。`;
}

function parseReadErrorMetadata(parsed: Record<string, unknown>): HleditErrorMetadata | undefined {
	if (parsed.ok !== false || typeof parsed.error !== "string" || typeof parsed.message !== "string") return undefined;
	const requestedOffset = isIntegerAtLeast(parsed.requestedOffset, 1) ? parsed.requestedOffset : undefined;
	const totalLines = isIntegerAtLeast(parsed.totalLines, 0) ? parsed.totalLines : undefined;
	if (parsed.error === "range" && (requestedOffset === undefined || totalLines === undefined)) return undefined;

	let hint: string | undefined;
	if (parsed.error === "range" && totalLines !== undefined) {
		hint = totalLines === 0
			? "文件为空，当前没有可读取的正整数行号。"
			: `请将 offset 设为 1 到 ${totalLines} 之间的整数。`;
	}
	return {
		code: parsed.error,
		message: localizeReadErrorMessage(parsed.error, requestedOffset, totalLines),
		rawMessage: parsed.message,
		...(hint ? { hint } : {}),
		...(requestedOffset !== undefined ? { requestedOffset } : {}),
		...(totalLines !== undefined ? { totalLines } : {}),
	};
}

function formatReadMetadata(read: HleditReadMetadata): string {
	const anchoredLines = read.lines.map((line) => `${line.anchor}:${line.text}`);
	const { firstLine, lastLine, lineCount, totalLines } = read.actual;
	const filter = read.requested.grep;
	let notice: string;

	if (read.textTruncated) {
		notice = `-- 源文件内容已截断${lastLine !== undefined ? `，最后返回第 ${lastLine} 行` : ""}（文件共 ${totalLines} 行）；按行续读无法恢复被省略的行内文本 --`;
	} else if (filter) {
		if (lineCount === 0) {
			notice = `-- 文件共 ${totalLines} 行，未找到包含 ${JSON.stringify(filter)} 的内容 --`;
		} else if (read.nextOffset !== undefined) {
			notice = `-- 已返回 ${lineCount} 行匹配结果及上下文，最后到第 ${lastLine} 行（文件共 ${totalLines} 行）；继续读取请使用 offset ${read.nextOffset} --`;
		} else {
			notice = `-- 已返回全部 ${lineCount} 行匹配结果及上下文（文件共 ${totalLines} 行） --`;
		}
	} else if (read.nextOffset !== undefined) {
		notice = `-- 已显示第 ${firstLine}-${lastLine} 行（文件共 ${totalLines} 行）；继续读取请使用 offset ${read.nextOffset} --`;
	} else {
		notice = `-- 已显示第 ${firstLine}-${lastLine} 行（文件共 ${totalLines} 行）；已到文件末尾 --`;
	}

	return [...anchoredLines, notice].join("\n");
}

function formatReadError(error: HleditErrorMetadata): string {
	const lines = [error.message];
	if (error.hint) lines.push(`建议：${error.hint}`);
	lines.push(`错误代码：${error.code}`);
	return lines.join("\n");
}

function invalidReadResponseText(): string {
	return `锚点读取失败：随扩展附带的 hledit 返回了不兼容的响应。预期得到包含 ok、totalLines、有效锚点行、截断状态及可选 nextOffset 的结构化 JSON。\n\n${HLEDIT_INSTALL_HINT}`;
}

export function readAnchorsResult(run: HleditRun, request: NormalizedReadRequest): TextResult {
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
	return {
		content: [{ type: "text", text: formatReadMetadata(read) }],
		details: { disposition: "succeeded", path: request.path, revision: read.revision, read },
	};
}

function formatLineRange(first: number | undefined, last: number | undefined): string | undefined {
	if (first === undefined && last === undefined) {
		return undefined;
	}
	const start = first ?? last;
	const end = last ?? first;
	return start === end ? String(start) : `${start}-${end}`;
}

function lineDeltaSummary(parsed: Record<string, unknown>): string | undefined {
	const linesAdded = parsed.linesAdded;
	const linesDeleted = parsed.linesDeleted;
	if (typeof linesAdded !== "number" && typeof linesDeleted !== "number") {
		return undefined;
	}
	const added = typeof linesAdded === "number" ? linesAdded : 0;
	const deleted = typeof linesDeleted === "number" ? linesDeleted : 0;
	return `行数变化：+${added} -${deleted}`;
}

function appendRemaps(
	lines: string[],
	result: Record<string, unknown>,
	staleAnchors: HleditStaleAnchor[] | undefined,
): void {
	if (!Array.isArray(result.remaps) || result.remaps.length === 0) {
		return;
	}

	const represented = new Set(
		staleAnchors?.map((anchor) => `${anchor.requestedAnchor}\0${anchor.currentAnchor ?? ""}`) ?? [],
	);
	const rendered = new Set<string>();
	for (const remap of result.remaps) {
		if (!isRecord(remap)) {
			continue;
		}
		const requested = typeof remap.requested === "string" ? remap.requested : undefined;
		const current = typeof remap.current === "string" ? remap.current : undefined;
		if (requested && represented.has(`${requested}\0${current ?? ""}`)) {
			continue;
		}
		const text = requested && current ? `- ${requested} -> ${current}` : requested ? `- ${requested}` : undefined;
		if (text) {
			rendered.add(text);
		}
	}
	if (rendered.size > 0) {
		lines.push("其他 stale 锚点：", ...rendered);
	}
}

function changeAnchorFields(change: FileChangeParams["changes"][number]): Array<[FileChangeAnchorField, string]> {
	switch (change.operation) {
		case "replace_range":
		case "delete_range":
			return [
				["start_anchor", change.start_anchor],
				["end_anchor", change.end_anchor],
			];
		case "insert_before":
		case "insert_after":
			return [["anchor", change.anchor]];
	}
}

function parseStaleAnchors(
	result: Record<string, unknown>,
	currentAnchors: BatchAnchorContext | undefined,
	context: ApplyResultContext,
): HleditStaleAnchor[] | undefined {
	if (!isIntegerAtLeast(result.failed, 0) || !Array.isArray(result.remaps)) {
		return undefined;
	}
	const change = context.changes?.[result.failed];
	if (!change) {
		return undefined;
	}

	const staleAnchors: HleditStaleAnchor[] = [];
	for (const [field, requestedAnchor] of changeAnchorFields(change)) {
		const remap = result.remaps.find(
			(candidate) => isRecord(candidate) && candidate.requested === requestedAnchor,
		);
		if (!isRecord(remap)) {
			continue;
		}
		const currentAnchor =
			typeof remap.current === "string" && READ_ANCHOR_PATTERN.test(remap.current) ? remap.current : undefined;
		const existing = staleAnchors.find(
			(candidate) => candidate.requestedAnchor === requestedAnchor && candidate.currentAnchor === currentAnchor,
		);
		if (existing) {
			existing.fields.push(field);
			continue;
		}
		const currentLine = currentAnchor
			? currentAnchors?.lines.find((line) => line.anchor === currentAnchor)
			: undefined;
		staleAnchors.push({
			changeNumber: result.failed + 1,
			fields: [field],
			requestedAnchor,
			...(currentAnchor ? { currentAnchor } : {}),
			...(currentLine ? { currentText: currentLine.text } : {}),
			...(currentLine?.textTruncated ? { currentTextTruncated: true as const } : {}),
		});
	}
	return staleAnchors.length > 0 ? staleAnchors : undefined;
}

function appendStaleAnchorDetails(lines: string[], staleAnchors: HleditStaleAnchor[] | undefined): void {
	if (!staleAnchors) {
		return;
	}

	lines.push(`第 ${staleAnchors[0]!.changeNumber} 项锚点核对：`);
	for (const staleAnchor of staleAnchors) {
		const fields = staleAnchor.fields.join("/");
		lines.push(`- 字段：${fields}`, `  提交的锚点：${staleAnchor.requestedAnchor}`);
		if (staleAnchor.currentAnchor) {
			const annotatedAnchor =
				staleAnchor.currentText === undefined
					? staleAnchor.currentAnchor
					: `${staleAnchor.currentAnchor}:${staleAnchor.currentText}${staleAnchor.currentTextTruncated ? "（文本已截断）" : ""}`;
			lines.push(
				`  当前同号行：${annotatedAnchor}`,
				`  核对目标后，可在下一次显式提交中将 ${fields} 改为 ${staleAnchor.currentAnchor}。`,
			);
		} else {
			lines.push("  当前同号行不存在；必须重新读取受影响范围。");
		}
	}
	lines.push("上述内容仅供核对；工具不会自动修正锚点或重试批次。");
}

function appendCurrentAnchorContext(lines: string[], context: BatchAnchorContext | undefined): void {
	if (!context) {
		return;
	}
	lines.push("提交时文件中的当前锚点快照（请先核对内容；下一次提交仍会再次校验）：");
	lines.push(context.lines.map((line) => `${line.anchor}:${line.text}`).join("\n") || "（文件为空）");
	lines.push("该快照不会自动重试或覆盖并发修改；只有确认窗口仍覆盖原定目标及完整范围时，才可使用其中的新锚点；否则必须重新读取受影响范围。");
	if (context.truncated || context.lines.some((line) => line.textTruncated)) {
		lines.push(`当前快照已截断；请调用 hledit_read_anchors，并使用 offset:${context.offset}、limit:${context.desiredLimit} 获取完整范围。`);
	}
}

function staleReadInstruction(result: Record<string, unknown>, path: string | undefined): string {
	const genericInstruction = "重试前请重新调用 hledit_read_anchors 读取受影响范围；不要复用修改前的旧锚点。";
	if (!path || !Array.isArray(result.remaps)) {
		return genericInstruction;
	}
	const remappedLineNumbers = result.remaps.flatMap((remap) => {
		if (!isRecord(remap)) {
			return [];
		}
		let anchor: string | undefined;
		if (typeof remap.current === "string") {
			anchor = remap.current;
		} else if (typeof remap.requested === "string") {
			anchor = remap.requested;
		}
		const match = anchor ? new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`).exec(anchor) : undefined;
		return match ? [Number(match[1])] : [];
	});
	if (remappedLineNumbers.length === 0) {
		return genericInstruction;
	}
	const offset = Math.max(1, Math.min(...remappedLineNumbers) - 2);
	return `重试前请调用 hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: 12 })；不要复用修改前的旧锚点。`;
}

function localizeInvalidApplyMessage(rawMessage: string, failedChange: number | undefined): string {
	const prefix = failedChange === undefined ? "批次修改" : `第 ${failedChange} 项修改`;
	const unknownField = /unknown field "([^"]+)"/.exec(rawMessage);
	if (unknownField) return `批次 JSON 包含不支持的字段 ${JSON.stringify(unknownField[1])}；请检查字段拼写。`;
	if (rawMessage.includes("batch request contains no edits")) return "批次中没有任何修改项。";
	if (rawMessage.includes("invalid batch request")) return "批次 JSON 结构无效，无法解析修改请求。";
	if (rawMessage.includes("invalid end anchor")) return `${prefix}的 end_anchor 格式无效。`;
	if (rawMessage.includes("invalid anchor")) return `${prefix}的 anchor 格式无效。`;
	if (rawMessage.includes("start line") && rawMessage.includes("> end line")) return `${prefix}的起始行晚于结束行。`;
	if (rawMessage.includes("insert does not accept end_pos")) return `${prefix}是 insert，不能同时提供 end_anchor。`;
	if (rawMessage.includes("insert requires non-empty content")) return `${prefix}是 insert，lines 至少需要包含一行。`;
	if (rawMessage.includes("unknown op")) return `${prefix}使用了不支持的 operation。`;
	if (rawMessage.includes("overlaps") || rawMessage.includes("conflicts") || rawMessage.includes("already consumed range")) {
		return `${prefix}与同批次的其他修改范围重叠；请合并或调整为互不冲突的修改。`;
	}
	return `${prefix}无效；请检查 operation、锚点、范围顺序和 lines 内容。`;
}

function localizeIOApplyMessage(rawMessage: string): string {
	const hardLinks = /file has (\d+) hard links/.exec(rawMessage);
	if (hardLinks) {
		return `目标文件存在 ${hardLinks[1]} 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。`;
	}
	if (rawMessage.includes("non-regular file")) return "目标不是普通文件，已拒绝写入。";
	if (rawMessage.includes("could not be read")) return "无法读取目标文件；请检查路径、权限以及文件是否仍然存在。";
	if (rawMessage.includes("resolve target")) return "无法解析目标文件；symlink 可能已失效或路径不可访问。";
	if (rawMessage.includes("resolve parent")) return "无法解析目标文件所在目录。";
	if (rawMessage.includes("inspect hard links")) return "无法确认目标文件的 hardlink 状态，因此为安全起见拒绝写入。";
	if (rawMessage.includes("create temporary sibling")) return "无法在目标文件所在目录创建原子写入所需的临时文件。";
	if (rawMessage.includes("preserve permissions")) return "无法把原文件权限复制到临时文件。";
	if (rawMessage.includes("write temporary file")) return "写入临时文件失败，目标文件保持不变。";
	if (rawMessage.includes("synchronize temporary file")) return "同步临时文件失败，目标文件保持不变。";
	if (rawMessage.includes("close temporary file")) return "关闭临时文件失败，目标文件保持不变。";
	if (rawMessage.includes("replace target")) return "原子替换目标文件失败。";
	return "文件操作失败；请检查路径、权限、文件类型和链接状态。";
}

function parseApplyErrorMetadata(result: Record<string, unknown>, context: ApplyResultContext): HleditErrorMetadata | undefined {
	if (result.ok !== false || typeof result.error !== "string" || typeof result.message !== "string") return undefined;
	const failedChange = isIntegerAtLeast(result.failed, 0) ? result.failed + 1 : undefined;
	const currentAnchors = result.error === "stale" ? parseAnchorContext(result.currentAnchors) : undefined;
	const staleAnchors = result.error === "stale" ? parseStaleAnchors(result, currentAnchors, context) : undefined;
	const currentRevision = isRawRevision(result.currentRevision) ? result.currentRevision : undefined;
	let message: string;
	switch (result.error) {
		case "stale":
			message = failedChange === undefined ? "一个或多个锚点已失效。" : `第 ${failedChange} 项修改使用的锚点已失效。`;
			break;
		case "insufficient_read_proof":
			message = "读取证据未覆盖本次修改依赖的全部原始行。";
			break;
		case "source_changed_before_commit":
			message = "目标文件在提交前发生变化，已取消原子替换。";
			break;
		case "invalid":
			message = localizeInvalidApplyMessage(result.message, failedChange);
			break;
		case "binary":
			message = "目标文件疑似为二进制，无法按文本修改。";
			break;
		case "encoding":
			message = "目标文件不是有效的 UTF-8 文本，已拒绝修改以避免损坏原始字节。";
			break;
		case "io":
			message = localizeIOApplyMessage(result.message);
			break;
		default:
			message = `hledit 拒绝了本次修改（错误代码：${result.error}）。`;
	}
	return {
		code: result.error,
		message,
		rawMessage: result.message,
		...(staleAnchors ? { staleAnchors } : {}),
		...(currentAnchors ? { currentAnchors } : {}),
		...(currentRevision ? { currentRevision } : {}),
	};
}

function localizeApplyWarning(warning: string): string {
	if (warning.startsWith("file was replaced, but directory metadata could not be synchronized:")) {
		return "文件内容已成功替换，但目录元数据未能同步；断电等极端场景下，持久性保证可能降低。";
	}
	return "文件已成功修改，但写入持久性存在警告；详细技术信息已保留在工具结果中。";
}

function formatApplyFailureResult(
	result: Record<string, unknown>,
	context: ApplyResultContext,
	error: HleditErrorMetadata,
): string {
	const lines = ["原子批次已拒绝，未写入任何内容。", `原因：${error.message}`, `错误代码：${error.code}`];
	if (isIntegerAtLeast(result.failed, 0)) {
		lines.push(`失败位置：第 ${result.failed + 1} 项修改`);
	}
	appendStaleAnchorDetails(lines, error.staleAnchors);
	appendRemaps(lines, result, error.staleAnchors);
	if (error.code === "stale") {
		appendCurrentAnchorContext(lines, error.currentAnchors);
		if (error.currentAnchors) {
			lines.push("只有确认上方窗口仍覆盖原定目标及完整范围时，才可使用其中的新锚点重新提交；否则请重新调用 hledit_read_anchors。");
		} else {
			lines.push(staleReadInstruction(result, context.path));
		}
	}
	return lines.join("\n");
}

function appendApplyWarnings(lines: string[], result: Record<string, unknown>): void {
	if (!Array.isArray(result.warnings)) {
		return;
	}
	const warnings = result.warnings.filter((warning): warning is string => typeof warning === "string");
	if (warnings.length === 0) {
		return;
	}
	lines.push("警告：", ...warnings.map((warning) => `- ${localizeApplyWarning(warning)}`));
}

function formatApplyResult(result: Record<string, unknown>): string {
	if (result.contentChanged === false) {
		const lines = ["无需修改；原锚点仍有效。"];
		appendApplyWarnings(lines, result);
		return lines.join("\n");
	}
	const lines = ["修改已应用。"];
	if (typeof result.editsApplied === "number") {
		lines.push(`已应用操作：${result.editsApplied} 项`);
	}
	const changed = formatLineRange(
		typeof result.firstChangedLine === "number" ? result.firstChangedLine : undefined,
		typeof result.lastChangedLine === "number" ? result.lastChangedLine : undefined,
	);
	if (changed) {
		lines.push(`影响行：${changed}`);
	}
	const lineDelta = lineDeltaSummary(result);
	if (lineDelta) {
		lines.push(lineDelta);
	}
	appendApplyWarnings(lines, result);
	return lines.join("\n");
}

function isValidApplySuccess(parsed: Record<string, unknown> | null): boolean {
	return (
		parsed?.ok === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		parsed.editsApplied >= 0 &&
		(parsed.contentChanged === undefined || typeof parsed.contentChanged === "boolean") &&
		(parsed.warnings === undefined || (Array.isArray(parsed.warnings) && parsed.warnings.every((warning) => typeof warning === "string"))) &&
		isRawRevision(parsed.revision) &&
		parseBatchUpdatedAnchorContext(parsed) !== undefined
	);
}

function isValidFileChangeCheckSuccess(parsed: Record<string, unknown> | null): boolean {
	return (
		parsed?.ok === true &&
		parsed.checked === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		parsed.editsApplied >= 0 &&
		typeof parsed.contentChanged === "boolean"
		&& isRawRevision(parsed.revision)
	);
}

function invalidFileChangeCheckText(): string {
	return "hledit 返回了不兼容的 --check 响应，工具未继续执行写入。请调用 hledit_read_anchors 检查目标文件后再重试。";
}

function invalidApplySuccessText(): string {
	return `随扩展附带的 hledit 返回了不兼容的成功响应。文件可能已经变化；重试前请调用 hledit_read_anchors 检查当前内容。预期得到 ok:true、有效 revision、非负整数 editsApplied 和有效 updatedAnchors。\n\n${HLEDIT_INSTALL_HINT}`;
}

function outcomeUnknownText(run: HleditRun): string {
	const diagnostic = (run.stdout.trimEnd() || run.stderr.trimEnd()).slice(0, 800);
	const lines = [
		"hledit 批次的执行结果未知；文件可能已经写入，禁止直接重试原请求。",
		"请先调用 hledit_read_anchors 重新读取目标文件。",
	];
	if (diagnostic) {
		lines.push(`诊断：${diagnostic}${diagnostic.length === 800 ? "…" : ""}`);
	}
	return lines.join("\n");
}

function formatApplyRunText(
	run: HleditRun,
	context: ApplyResultContext,
	parsed: Record<string, unknown> | null,
	applySuccessValid: boolean,
	applyError: HleditErrorMetadata | undefined,
): string {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return run.started === false ? text || HLEDIT_INSTALL_HINT : outcomeUnknownText(run);
	}
	if (!text || !parsed) {
		return invalidApplySuccessText();
	}
	if (parsed.ok === false) {
		return applyError ? formatApplyFailureResult(parsed, context, applyError) : invalidApplySuccessText();
	}
	return applySuccessValid ? formatApplyResult(parsed) : invalidApplySuccessText();
}

export function extractCliSummary(parsed: Record<string, unknown> | null): Record<string, unknown> {
	if (!parsed) {
		return {};
	}

	const summary: Record<string, unknown> = {};
	for (const key of ["firstChangedLine", "lastChangedLine", "linesAdded", "linesDeleted", "editsApplied", "checked", "contentChanged"] as const) {
		const value = parsed[key];
		if (typeof value === "number" || typeof value === "boolean") {
			summary[key] = value;
		}
	}
	if (Array.isArray(parsed.warnings) && parsed.warnings.every((warning) => typeof warning === "string")) {
		summary.warnings = parsed.warnings.map(localizeApplyWarning);
		summary.rawWarnings = parsed.warnings;
	}
	if (isRawRevision(parsed.revision)) summary.revision = parsed.revision;
	if (isRawRevision(parsed.currentRevision)) summary.currentRevision = parsed.currentRevision;
	return summary;
}

export function applyFileChangesResult(run: HleditRun, context: ApplyResultContext = {}): TextResult {
	const parsed = parseRunObject(run);
	const applySuccessValid = isValidApplySuccess(parsed);
	const applyError = parsed ? parseApplyErrorMetadata(parsed, context) : undefined;
	const disposition: HleditDisposition =
		run.exitCode !== 0
			? run.started === false
				? "unavailable"
				: "outcome_unknown"
			: parsed?.ok === false
				? applyError
					? "rejected"
					: "unavailable"
				: !applySuccessValid
					? "outcome_unknown"
					: "succeeded";
	return {
		content: [{ type: "text", text: formatApplyRunText(run, context, parsed, applySuccessValid, applyError) }],
		details: {
			disposition,
			...(context.path ? { path: context.path } : {}),
			...extractCliSummary(parsed),
			...(applyError ? { error: applyError } : {}),
		},
	};
}

export function fileChangeCheckFailure(run: HleditRun, context: ApplyResultContext = {}): TextResult | undefined {
	const parsed = parseRunObject(run);
	if (run.exitCode === 0 && isValidFileChangeCheckSuccess(parsed)) {
		return undefined;
	}
	if (run.exitCode !== 0) {
		const text = run.stdout.trimEnd() || run.stderr.trimEnd() || HLEDIT_INSTALL_HINT;
		return unavailableToolResult(text);
	}
	if (parsed?.ok === true) {
		return unavailableToolResult(invalidFileChangeCheckText());
	}
	return applyFileChangesResult(run, context);
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

export function buildDiffDetails(
	path: string,
	beforeContent: string,
	afterContent: string,
	parsed: Record<string, unknown> | null,
): Record<string, unknown> {
	const diffResult = generateDiffString(beforeContent, afterContent);
	const patch = generateUnifiedPatch(path, beforeContent, afterContent);
	const cliFirstChangedLine = parsed?.firstChangedLine;
	return {
		...extractCliSummary(parsed),
		diff: diffResult.diff,
		patch,
		firstChangedLine: typeof cliFirstChangedLine === "number" ? cliFirstChangedLine : diffResult.firstChangedLine,
	};
}

export async function readUtf8File(path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
	try {
		const bytes = await readFile(path);
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { ok: true, content };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
