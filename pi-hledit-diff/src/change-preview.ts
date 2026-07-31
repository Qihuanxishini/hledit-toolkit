import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { lineFromAnchor } from "./file-changes.ts";
import type { FileChangeParams } from "./schema.ts";

// 提交绑定的局部 change preview：
// 只由 anchored apply 的同 revision 消费行证据和请求新行构成；外部进程在编辑
// 间隙的无关修改不会混入，因为这里不读取完整文件前后快照。

export type ChangePreviewLine = {
	kind: "context" | "remove" | "add";
	oldLine?: number;
	newLine?: number;
	text: string;
	textTruncated?: true;
};

export type VerifiedChangePreview = {
	lines: ChangePreviewLine[];
	truncated: boolean;
};

export const MAX_PREVIEW_LINES = 2000;
export const MAX_PREVIEW_BYTES = 256 * 1024;

// 与 CLI editDeltas 相同的物理顺序区间：oldStart 为消费区间起点（纯插入是
// oldEnd === oldStart-1 的空区间），oldLines/newLines 是该块的旧/新文本。
type PreviewBlock = {
	oldStart: number;
	oldLines: string[];
	newLines: string[];
};

const BLOCK_DIFF_LINE = /^([ +\-])\s*(\d+)\s(.*)$/;

// 单块内部最小 diff：复用 generateDiffString(contextLines=0) 并把块内相对行号
// 平移回文件坐标。旧块/新块之一为空时直接展开，不经过 diff。
function appendBlockLines(target: ChangePreviewLine[], block: PreviewBlock, newStart: number): void {
	if (block.oldLines.length === 0) {
		block.newLines.forEach((text, index) => target.push({ kind: "add", newLine: newStart + index, text }));
		return;
	}
	if (block.newLines.length === 0) {
		block.oldLines.forEach((text, index) => target.push({ kind: "remove", oldLine: block.oldStart + index, text }));
		return;
	}
	const blockDiff = generateDiffString(`${block.oldLines.join("\n")}\n`, `${block.newLines.join("\n")}\n`, 0).diff;
	for (const rawLine of blockDiff.split("\n")) {
		const match = BLOCK_DIFF_LINE.exec(rawLine);
		if (!match) continue; // 折叠占位（"..."）不进入结构化 preview
		const relativeLine = Number.parseInt(match[2]!, 10);
		if (!Number.isSafeInteger(relativeLine) || relativeLine < 1) continue;
		if (match[1] === "-") {
			target.push({ kind: "remove", oldLine: block.oldStart + relativeLine - 1, text: match[3] ?? "" });
		} else if (match[1] === "+") {
			target.push({ kind: "add", newLine: newStart + relativeLine - 1, text: match[3] ?? "" });
		} else {
			target.push({
				kind: "context",
				oldLine: block.oldStart + relativeLine - 1,
				newLine: newStart + relativeLine - 1,
				text: match[3] ?? "",
			});
		}
	}
}

const PREVIEW_LINE_TRUNCATION_MARKER = " … [preview line truncated] … ";

function previewLineBytes(line: ChangePreviewLine): number {
	return Buffer.byteLength(line.text, "utf8") + 1;
}

function previewTextBytes(lines: ChangePreviewLine[]): number {
	return lines.reduce((total, line) => total + previewLineBytes(line), 0);
}

function utf8Prefix(text: string, maxBytes: number): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	if (low > 0 && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low -= 1;
	return text.slice(0, low);
}

function utf8Suffix(text: string, maxBytes: number): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const length = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(text.length - length), "utf8") <= maxBytes) low = length;
		else high = length - 1;
	}
	let start = text.length - low;
	if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!)) start += 1;
	return text.slice(start);
}

function fitPreviewLine(line: ChangePreviewLine, maxBytes: number): ChangePreviewLine | undefined {
	if (previewLineBytes(line) <= maxBytes) return line;
	const textBudget = maxBytes - 1;
	const markerBytes = Buffer.byteLength(PREVIEW_LINE_TRUNCATION_MARKER, "utf8");
	if (textBudget < markerBytes) return undefined;
	const fragmentBudget = textBudget - markerBytes;
	const head = utf8Prefix(line.text, Math.floor(fragmentBudget / 2));
	const tail = utf8Suffix(line.text, fragmentBudget - Buffer.byteLength(head, "utf8"));
	return { ...line, text: `${head}${PREVIEW_LINE_TRUNCATION_MARKER}${tail}`, textTruncated: true };
}

// 超限时保留首尾片段并标记 truncated；单个超长行也在 UTF-8 byte budget 内保留首尾。
// 完整变更统计始终由 CLI summary 提供，不依赖局部 preview。
function capPreviewLines(lines: ChangePreviewLine[]): VerifiedChangePreview {
	if (lines.length <= MAX_PREVIEW_LINES && previewTextBytes(lines) <= MAX_PREVIEW_BYTES) {
		return { lines, truncated: false };
	}
	const headBudgetLines = Math.floor(MAX_PREVIEW_LINES / 2);
	const headBudgetBytes = Math.floor(MAX_PREVIEW_BYTES / 2);
	const head: ChangePreviewLine[] = [];
	let headBytes = 0;
	for (const line of lines) {
		if (head.length >= headBudgetLines) break;
		const fitted = fitPreviewLine(line, headBudgetBytes - headBytes);
		if (!fitted) break;
		head.push(fitted);
		headBytes += previewLineBytes(fitted);
		if (fitted.textTruncated) break;
	}
	const tail: ChangePreviewLine[] = [];
	let tailBytes = 0;
	for (let index = lines.length - 1; index > head.length - 1; index -= 1) {
		if (head.length + tail.length >= MAX_PREVIEW_LINES) break;
		const line = lines[index]!;
		const fitted = fitPreviewLine(line, MAX_PREVIEW_BYTES - headBytes - tailBytes);
		if (!fitted) break;
		tail.unshift(fitted);
		tailBytes += previewLineBytes(fitted);
		if (fitted.textTruncated) break;
	}
	return { lines: [...head, ...tail], truncated: true };
}

function previewFromBlocks(blocks: PreviewBlock[]): VerifiedChangePreview {
	const ordered = [...blocks].sort((left, right) =>
		left.oldStart - right.oldStart ||
		(left.oldStart + left.oldLines.length) - (right.oldStart + right.oldLines.length),
	);
	const lines: ChangePreviewLine[] = [];
	let shift = 0;
	for (const block of ordered) {
		appendBlockLines(lines, block, block.oldStart + shift);
		shift += block.newLines.length - block.oldLines.length;
	}
	return capPreviewLines(lines);
}

// anchored apply：每个 change 的旧行必须能从同 revision 消费行证据完整取出；
// 取不出（不应发生，proof 已覆盖）返回 undefined，由调用方降级为 previewError。
export function buildAnchoredChangePreview(
	changes: FileChangeParams["changes"],
	consumedLineText: ReadonlyMap<number, { text: string }>,
): VerifiedChangePreview | undefined {
	const blocks: PreviewBlock[] = [];
	for (const change of changes) {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			const anchorLine = lineFromAnchor(change.anchor);
			if (anchorLine === undefined) return undefined;
			blocks.push({
				oldStart: change.operation === "insert_before" ? anchorLine : anchorLine + 1,
				oldLines: [],
				newLines: change.lines,
			});
			continue;
		}
		const start = lineFromAnchor(change.start_anchor);
		const end = lineFromAnchor(change.end_anchor);
		if (start === undefined || end === undefined || end < start) return undefined;
		const oldLines: string[] = [];
		for (let line = start; line <= end; line += 1) {
			const text = consumedLineText.get(line)?.text;
			if (text === undefined) return undefined;
			oldLines.push(text);
		}
		blocks.push({
			oldStart: start,
			oldLines,
			newLines: change.operation === "replace_range" ? change.lines : [],
		});
	}
	return previewFromBlocks(blocks);
}


export function emptyChangePreview(): VerifiedChangePreview {
	return { lines: [], truncated: false };
}

// 历史 session 的 details 可能被外部改写，渲染前重新验证结构。
export function parseChangePreview(value: unknown): VerifiedChangePreview | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.truncated !== "boolean" || !Array.isArray(record.lines)) return undefined;
	if (record.lines.length > MAX_PREVIEW_LINES) return undefined;
	const lines: ChangePreviewLine[] = [];
	let bytes = 0;
	for (const entry of record.lines) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const line = entry as Record<string, unknown>;
		if ((line.kind !== "context" && line.kind !== "remove" && line.kind !== "add") || typeof line.text !== "string") return undefined;
		const oldLine = line.oldLine;
		const newLine = line.newLine;
		if (oldLine !== undefined && (typeof oldLine !== "number" || !Number.isSafeInteger(oldLine) || oldLine < 1)) return undefined;
		if (newLine !== undefined && (typeof newLine !== "number" || !Number.isSafeInteger(newLine) || newLine < 1)) return undefined;
		if (line.kind === "add" && (newLine === undefined || oldLine !== undefined)) return undefined;
		if (line.kind === "remove" && (oldLine === undefined || newLine !== undefined)) return undefined;
		if (line.kind === "context" && (oldLine === undefined || newLine === undefined)) return undefined;
		if (line.textTruncated !== undefined && line.textTruncated !== true) return undefined;
		bytes += Buffer.byteLength(line.text, "utf8") + 1;
		if (bytes > MAX_PREVIEW_BYTES) return undefined;
		lines.push({
			kind: line.kind,
			...(oldLine !== undefined ? { oldLine } : {}),
			...(newLine !== undefined ? { newLine } : {}),
			text: line.text,
			...(line.textTruncated === true ? { textTruncated: true as const } : {}),
		});
	}
	if (!record.truncated && lines.some((line) => line.textTruncated)) return undefined;
	return { lines, truncated: record.truncated };
}

// TUI 渲染桥：把结构化 preview 转成 renderStandaloneDiff 消费的行号 diff 文本。
// 不连续块之间插入折叠占位，truncated 时追加提示占位。
export function changePreviewDiffText(preview: VerifiedChangePreview): string {
	const rendered: string[] = [];
	let previousOld: number | undefined;
	let previousNew: number | undefined;
	let previousKind: ChangePreviewLine["kind"] | undefined;
	for (const line of preview.lines) {
		const oldLine = line.kind === "add" ? undefined : line.oldLine;
		const newLine = line.kind === "remove" ? undefined : line.newLine;
		const continuesOld = oldLine !== undefined && previousOld !== undefined && oldLine <= previousOld + 1;
		const continuesNew = newLine !== undefined && previousNew !== undefined && newLine <= previousNew + 1;
		// 同一 hunk 内 removes 紧跟 adds，二者行号坐标系不同，不视为断点。
		const continuesHunk = previousKind === "remove" && line.kind === "add";
		if (rendered.length > 0 && !continuesOld && !continuesNew && !continuesHunk) {
			rendered.push("   ...");
		}
		const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
		rendered.push(`${marker}${line.kind === "remove" ? oldLine : newLine} ${line.text}`);
		if (oldLine !== undefined) previousOld = oldLine;
		if (newLine !== undefined) previousNew = newLine;
		previousKind = line.kind;
	}
	if (preview.truncated) {
		rendered.push("   … preview truncated …");
	}
	return rendered.join("\n");
}
