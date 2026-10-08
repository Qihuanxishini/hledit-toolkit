import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { lineFromAnchor } from "./anchor.ts";
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
	// [喵喵喵]: 仅用于渲染阶段保留一次 apply 中的操作边界，不改变编辑语义。
	changeIndex?: number;
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
	changeIndex: number;
	oldStart: number;
	oldLines: string[];
	newLines: string[];
};

// [喵喵喵]: 超限块只借用原始行数组；按首尾预算取行时才创建预览对象，不物化隐藏的中间行。
type PreviewSegment =
	| { lines: ChangePreviewLine[] }
	| { texts: readonly string[]; kind: "remove" | "add"; start: number; changeIndex: number };

function segmentLength(segment: PreviewSegment): number {
	return "lines" in segment ? segment.lines.length : segment.texts.length;
}

function* iteratePreviewLines(segments: readonly PreviewSegment[], reversed = false): Generator<ChangePreviewLine> {
	const step = reversed ? -1 : 1;
	for (let index = reversed ? segments.length - 1 : 0; index >= 0 && index < segments.length; index += step) {
		const segment = segments[index]!;
		const length = segmentLength(segment);
		for (let line = reversed ? length - 1 : 0; line >= 0 && line < length; line += step) {
			if ("lines" in segment) {
				yield segment.lines[line]!;
			} else {
				const text = segment.texts[line]!;
				yield segment.kind === "remove"
					? { kind: "remove", oldLine: segment.start + line, text, changeIndex: segment.changeIndex }
					: { kind: "add", newLine: segment.start + line, text, changeIndex: segment.changeIndex };
			}
		}
	}
}

const BLOCK_DIFF_LINE = /^([ +\-])\s*(\d+)\s(.*)$/s;

// [喵喵喵]: 受控简化 — 每次 apply 的最小 diff 累计输入不超过 2000 行/256 KiB；
// 超限块按输出预算惰性保留首尾。预算内仍出现卡顿时升级为可中断 diff。
function appendBlockSegments(
	target: PreviewSegment[],
	block: PreviewBlock,
	newStart: number,
	remainingDiffInput: { lines: number; bytes: number },
): boolean {
	const isReplacement = block.oldLines.length > 0 && block.newLines.length > 0;
	const inputLines = block.oldLines.length + block.newLines.length;
	const inputBytes = isReplacement && inputLines <= remainingDiffInput.lines
		? block.oldLines.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8") + 1, 0)
			+ block.newLines.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8") + 1, 0)
		: Infinity;
	if (!isReplacement || inputLines > remainingDiffInput.lines || inputBytes > remainingDiffInput.bytes) {
		target.push(
			{ texts: block.oldLines, kind: "remove", start: block.oldStart, changeIndex: block.changeIndex },
			{ texts: block.newLines, kind: "add", start: newStart, changeIndex: block.changeIndex },
		);
		return isReplacement;
	}
	remainingDiffInput.lines -= inputLines;
	remainingDiffInput.bytes -= inputBytes;
	const blockDiff = generateDiffString(`${block.oldLines.join("\n")}\n`, `${block.newLines.join("\n")}\n`, 0).diff;
	const lines: ChangePreviewLine[] = [];
	for (const rawLine of blockDiff.split("\n")) {
		const match = BLOCK_DIFF_LINE.exec(rawLine);
		if (!match) continue; // 折叠占位（"..."）不进入结构化 preview
		const relativeLine = Number.parseInt(match[2]!, 10);
		if (!Number.isSafeInteger(relativeLine) || relativeLine < 1) continue;
		if (match[1] === "-") {
			lines.push({ kind: "remove", oldLine: block.oldStart + relativeLine - 1, text: match[3] ?? "", changeIndex: block.changeIndex });
		} else if (match[1] === "+") {
			lines.push({ kind: "add", newLine: newStart + relativeLine - 1, text: match[3] ?? "", changeIndex: block.changeIndex });
		} else {
			lines.push({
				kind: "context",
				oldLine: block.oldStart + relativeLine - 1,
				newLine: newStart + relativeLine - 1,
				text: match[3] ?? "",
				changeIndex: block.changeIndex,
			});
		}
	}
	target.push({ lines });
	return false;
}

const PREVIEW_LINE_TRUNCATION_MARKER = " … [preview line truncated] … ";

function previewLineBytes(line: ChangePreviewLine): number {
	return Buffer.byteLength(line.text, "utf8") + 1;
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
function capPreviewLines(segments: readonly PreviewSegment[]): VerifiedChangePreview {
	const totalLines = segments.reduce((total, segment) => total + segmentLength(segment), 0);
	if (totalLines <= MAX_PREVIEW_LINES) {
		const lines: ChangePreviewLine[] = [];
		let bytes = 0;
		for (const line of iteratePreviewLines(segments)) {
			bytes += previewLineBytes(line);
			if (bytes > MAX_PREVIEW_BYTES) break;
			lines.push(line);
		}
		if (lines.length === totalLines) return { lines, truncated: false };
	}
	const headBudgetLines = Math.floor(MAX_PREVIEW_LINES / 2);
	const headBudgetBytes = Math.floor(MAX_PREVIEW_BYTES / 2);
	const head: ChangePreviewLine[] = [];
	let headBytes = 0;
	for (const line of iteratePreviewLines(segments)) {
		if (head.length >= headBudgetLines) break;
		const fitted = fitPreviewLine(line, headBudgetBytes - headBytes);
		if (!fitted) break;
		head.push(fitted);
		headBytes += previewLineBytes(fitted);
		if (fitted.textTruncated) break;
	}
	const tail: ChangePreviewLine[] = [];
	let tailBytes = 0;
	let index = totalLines;
	for (const line of iteratePreviewLines(segments, true)) {
		if (--index < head.length || head.length + tail.length >= MAX_PREVIEW_LINES) break;
		const fitted = fitPreviewLine(line, MAX_PREVIEW_BYTES - headBytes - tailBytes);
		if (!fitted) break;
		tail.push(fitted);
		tailBytes += previewLineBytes(fitted);
		if (fitted.textTruncated) break;
	}
	return { lines: [...head, ...tail.reverse()], truncated: true };
}

function previewFromBlocks(blocks: PreviewBlock[]): VerifiedChangePreview {
	const ordered = [...blocks].sort((left, right) =>
		left.oldStart - right.oldStart ||
		(left.oldStart + left.oldLines.length) - (right.oldStart + right.oldLines.length),
	);
	const segments: PreviewSegment[] = [];
	const remainingDiffInput = { lines: MAX_PREVIEW_LINES, bytes: MAX_PREVIEW_BYTES };
	let truncated = false;
	let shift = 0;
	for (const block of ordered) {
		if (appendBlockSegments(segments, block, block.oldStart + shift, remainingDiffInput)) truncated = true;
		shift += block.newLines.length - block.oldLines.length;
	}
	const preview = capPreviewLines(segments);
	return truncated ? { ...preview, truncated: true } : preview;
}

// anchored apply：每个 change 的旧行必须能从同 revision 消费行证据完整取出；
// 取不出（不应发生，proof 已覆盖）返回 undefined，由调用方降级为 previewError。
export function buildAnchoredChangePreview(
	changes: FileChangeParams["changes"],
	consumedLineText: ReadonlyMap<number, { text: string }>,
): VerifiedChangePreview | undefined {
	const blocks: PreviewBlock[] = [];
	for (const [changeIndex, change] of changes.entries()) {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			const anchorLine = lineFromAnchor(change.anchor);
			if (anchorLine === undefined) return undefined;
			blocks.push({
				changeIndex,
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
			changeIndex,
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
		const changeIndex = line.changeIndex;
		if (oldLine !== undefined && (typeof oldLine !== "number" || !Number.isSafeInteger(oldLine) || oldLine < 1)) return undefined;
		if (newLine !== undefined && (typeof newLine !== "number" || !Number.isSafeInteger(newLine) || newLine < 1)) return undefined;
		if (changeIndex !== undefined && (typeof changeIndex !== "number" || !Number.isSafeInteger(changeIndex) || changeIndex < 0)) return undefined;
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
			...(changeIndex !== undefined ? { changeIndex } : {}),
		});
	}
	if (!record.truncated && lines.some((line) => line.textTruncated)) return undefined;
	return { lines, truncated: record.truncated };
}

// TUI 渲染桥：把结构化 preview 转成 renderStandaloneDiff 消费的行号 diff 文本。
// lines 已按原文件位置排列；渲染桥只添加分隔，不按增删类型或跨操作相同文本重排。
export function changePreviewDiffText(preview: VerifiedChangePreview): string {
	const rendered: string[] = [];
	let previousOld: number | undefined;
	let previousNew: number | undefined;
	let previousKind: ChangePreviewLine["kind"] | undefined;
	let previousChangeIndex: number | undefined;

	for (const line of preview.lines) {
		const oldLine = line.kind === "add" ? undefined : line.oldLine;
		const newLine = line.kind === "remove" ? undefined : line.newLine;
		const continuesOld = oldLine !== undefined && previousOld !== undefined && oldLine <= previousOld + 1;
		const continuesNew = newLine !== undefined && previousNew !== undefined && newLine <= previousNew + 1;
		const hasChangeIndex = line.changeIndex !== undefined;
		const sameChange = hasChangeIndex && previousChangeIndex !== undefined && line.changeIndex === previousChangeIndex;
		const continuesSameChange = sameChange && (continuesOld || continuesNew || (previousKind === "remove" && line.kind === "add"));
		const continuesLegacyHunk = !hasChangeIndex && previousChangeIndex === undefined &&
			(continuesOld || continuesNew || (previousKind === "remove" && line.kind === "add"));
		if (rendered.length > 0 && !continuesSameChange && !continuesLegacyHunk) {
			// [喵喵喵]: 操作边界只留空行；同一侧行号确实向前跳跃时才表示省略。
			const skipsOld = oldLine !== undefined && previousOld !== undefined && oldLine > previousOld + 1;
			const skipsNew = newLine !== undefined && previousNew !== undefined && newLine > previousNew + 1;
			rendered.push(skipsOld || skipsNew ? "   ..." : "");
		}
		const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
		rendered.push(`${marker}${line.kind === "remove" ? oldLine : newLine} ${line.text}`);
		if (oldLine !== undefined) previousOld = oldLine;
		if (newLine !== undefined) previousNew = newLine;
		previousKind = line.kind;
		previousChangeIndex = line.changeIndex;
	}
	if (preview.truncated) {
		rendered.push("   … preview truncated …");
	}
	return rendered.join("\n");
}
