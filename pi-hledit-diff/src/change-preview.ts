import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { lineFromAnchor } from "./file-changes.ts";
import type { FileChangeParams, ReplaceOnceParams } from "./schema.ts";

// 提交绑定的局部 change preview（OPTIMIZATION-ROADMAP Phase 4 / D4）：
// 只由已验证的输入构成——anchored apply 用读取证据中被消费的旧行加请求的新行，
// replace-once 用请求的 old/new 加 CLI 已验证的起始行。外部进程在编辑间隙的
// 无关修改不可能混入，因为不再对完整文件前后快照做 diff。

export type ChangePreviewLine = {
	kind: "context" | "remove" | "add";
	oldLine?: number;
	newLine?: number;
	text: string;
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

function previewTextBytes(lines: ChangePreviewLine[]): number {
	return lines.reduce((total, line) => total + line.text.length + 1, 0);
}

// 超限时保留首尾片段并标记 truncated；变更统计始终由 CLI summary 提供，不依赖 preview。
function capPreviewLines(lines: ChangePreviewLine[]): VerifiedChangePreview {
	if (lines.length <= MAX_PREVIEW_LINES && previewTextBytes(lines) <= MAX_PREVIEW_BYTES) {
		return { lines, truncated: false };
	}
	const headBudgetLines = Math.floor(MAX_PREVIEW_LINES / 2);
	const headBudgetBytes = Math.floor(MAX_PREVIEW_BYTES / 2);
	const head: ChangePreviewLine[] = [];
	let headBytes = 0;
	for (const line of lines) {
		if (head.length >= headBudgetLines || headBytes + line.text.length + 1 > headBudgetBytes) break;
		head.push(line);
		headBytes += line.text.length + 1;
	}
	const tail: ChangePreviewLine[] = [];
	let tailBytes = 0;
	for (let index = lines.length - 1; index > head.length - 1; index -= 1) {
		const line = lines[index]!;
		if (head.length + tail.length >= MAX_PREVIEW_LINES || headBytes + tailBytes + line.text.length + 1 > MAX_PREVIEW_BYTES) break;
		tail.unshift(line);
		tailBytes += line.text.length + 1;
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

// replace-once：oldStart 必须来自 CLI 已验证的 editDeltas（唯一消费区间起点）。
export function buildReplaceOncePreview(params: ReplaceOnceParams, oldStart: number): VerifiedChangePreview {
	return previewFromBlocks([{
		oldStart,
		oldLines: params.old_lines as string[],
		newLines: params.new_lines as string[],
	}]);
}

export function emptyChangePreview(): VerifiedChangePreview {
	return { lines: [], truncated: false };
}

// 历史 session 的 details 可能被外部改写，渲染前重新验证结构。
export function parseChangePreview(value: unknown): VerifiedChangePreview | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.truncated !== "boolean" || !Array.isArray(record.lines)) return undefined;
	const lines: ChangePreviewLine[] = [];
	for (const entry of record.lines) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const line = entry as Record<string, unknown>;
		if ((line.kind !== "context" && line.kind !== "remove" && line.kind !== "add") || typeof line.text !== "string") return undefined;
		const oldLine = line.oldLine;
		const newLine = line.newLine;
		if (oldLine !== undefined && (typeof oldLine !== "number" || !Number.isSafeInteger(oldLine) || oldLine < 1)) return undefined;
		if (newLine !== undefined && (typeof newLine !== "number" || !Number.isSafeInteger(newLine) || newLine < 1)) return undefined;
		lines.push({
			kind: line.kind,
			...(oldLine !== undefined ? { oldLine } : {}),
			...(newLine !== undefined ? { newLine } : {}),
			text: line.text,
		});
	}
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
