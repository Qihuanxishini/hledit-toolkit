import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createHighlightedTextCache, escapeTerminalControls, type HighlightedText } from "./syntax-highlight.ts";

export type HleditRenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

export type HleditRenderTheme = Pick<Theme, "fg" | "bold" | "appearance" | "getColorMode" | "style" | "getBgAnsi">;

type DiffBackgroundPalette = {
	added(text: string): string;
	removed(text: string): string;
	gutter(text: string, kind: "add" | "remove"): string;
	container: string;
};

type DiffLineKind = "add" | "remove" | "context";

type DiffLine = {
	kind: DiffLineKind;
	lineNumber: number;
	content: string;
	changeIndex?: number;
};

export type StructuredDiffLine = {
	kind: DiffLineKind;
	oldLine?: number;
	newLine?: number;
	text: string;
	changeIndex?: number;
};

type DiffMetaLine = {
	kind: "meta";
	content: string;
};

type DiffEntry = DiffLine | DiffMetaLine;

type ParsedDiff = {
	entries: DiffEntry[];
	added: number;
	removed: number;
	hunks: number;
};

export type DiffSummaryStats = {
	added: number;
	removed: number;
	completeHunks: boolean;
};

type PairedDiffRow = {
	left?: DiffLine;
	right?: DiffLine;
	meta?: string;
};

const GENERATED_DIFF_LINE = /^([ +\-])(\s*\d+)\s(.*)$/s;
const COLLAPSED_DIFF_LINES = 24;
const MAX_EXPANDED_DIFF_LINES = 2000;

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "展开详情");
	} catch {
		return "按 Ctrl+O 展开";
	}
}

function normalizeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function resolveDiffBackgroundPalette(theme: HleditRenderTheme): DiffBackgroundPalette {
	// 独立底色避免成功背景污染色相；深色取自参考截图，浅色沿用 GitHub 风格。
	const light = theme.appearance === "light";
	const indexed = theme.getColorMode() === "256color";
	const added = parseColor(indexed ? (light ? 194 : 22) : (light ? "#DAFBE1" : "#354330"));
	const removed = parseColor(indexed ? (light ? 224 : 52) : (light ? "#FFEBE9" : "#3E3831"));
	const addedFg = parseColor(light ? "#116329" : "#B5BD68");
	const removedFg = parseColor(light ? "#82071E" : "#CC6666");
	return {
		added: (text) => theme.style(text, { bg: added }),
		removed: (text) => theme.style(text, { bg: removed }),
		gutter: (text, kind) => theme.style(text, { fg: kind === "add" ? addedFg : removedFg }),
		container: theme.getBgAnsi("toolSuccessBg"),
	};
}

function applyChangeBackground(
	text: string,
	kind: DiffLineKind,
	palette: DiffBackgroundPalette | undefined,
): string {
	const rowBackground = kind === "add" ? palette?.added : kind === "remove" ? palette?.removed : undefined;
	if (!rowBackground || !palette) return text;
	// 宿主 style 负责在高亮器的内部 reset 后恢复本行底色，行末回到工具容器背景。
	return `${rowBackground(text)}${palette.container}`;
}

function parseGeneratedDiff(diff: string): ParsedDiff {
	const entries: DiffEntry[] = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let insideChangeGroup = false;

	for (const rawLine of diff.split("\n")) {
		if (!rawLine && entries.length === 0) continue;
		const match = GENERATED_DIFF_LINE.exec(rawLine);
		if (!match) {
			entries.push({ kind: "meta", content: rawLine.trim() });
			insideChangeGroup = false;
			continue;
		}

		const marker = match[1];
		const lineNumber = Number.parseInt(match[2]?.trim() ?? "", 10);
		if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
			entries.push({ kind: "meta", content: rawLine.trim() || "…" });
			insideChangeGroup = false;
			continue;
		}
		const kind: DiffLineKind = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
		if (kind !== "context" && !insideChangeGroup) {
			hunks++;
			insideChangeGroup = true;
		}
		if (kind === "add") added++;
		if (kind === "remove") removed++;
		entries.push({ kind, lineNumber, content: match[3] ?? "" });
	}

	return { entries, added, removed, hunks: Math.max(hunks, added + removed > 0 ? 1 : 0) };
}

function structuredLineKey(line: StructuredDiffLine): string {
	const number = line.kind === "remove" ? line.oldLine : line.newLine ?? line.oldLine;
	return `${line.kind}:${number ?? "?"}:${line.text}`;
}

function parsedLineKey(line: DiffLine): string {
	return `${line.kind}:${line.lineNumber}:${line.content}`;
}

function attachStructuredGroups(entries: DiffEntry[], lines: readonly StructuredDiffLine[]): DiffEntry[] | undefined {
	if (!lines.some((line) => line.changeIndex !== undefined)) return undefined;
	const candidates = new Map<string, StructuredDiffLine[]>();
	for (const line of lines) {
		const key = structuredLineKey(line);
		candidates.set(key, [...(candidates.get(key) ?? []), line]);
	}
	const used = new Set<StructuredDiffLine>();
	const mapped: DiffEntry[] = [];
	for (const entry of entries) {
		if (entry.kind === "meta") {
			mapped.push(entry);
			continue;
		}
		const candidate = candidates.get(parsedLineKey(entry))?.find((line) => !used.has(line));
		if (!candidate) return undefined;
		used.add(candidate);
		mapped.push(candidate.changeIndex === undefined ? entry : { ...entry, changeIndex: candidate.changeIndex });
	}
	return mapped;
}

function alignChangeRun(entries: DiffLine[]): PairedDiffRow[] {
	const removes = entries.filter((entry) => entry.kind === "remove");
	const adds = entries.filter((entry) => entry.kind === "add");
	const pairedRemove = new Map<DiffLine, DiffLine>();
	const pairedAdd = new Map<DiffLine, DiffLine>();
	const groups = new Set<number>();
	for (const entry of entries) {
		if (entry.changeIndex !== undefined) groups.add(entry.changeIndex);
	}

	// 同一操作内仍按原有顺序配对：replace_range 的删除/新增是明确的替换关系。
	for (const changeIndex of groups) {
		const groupRemoves = removes.filter((entry) => entry.changeIndex === changeIndex);
		const groupAdds = adds.filter((entry) => entry.changeIndex === changeIndex);
		const pairCount = Math.min(groupRemoves.length, groupAdds.length);
		for (let index = 0; index < pairCount; index += 1) {
			const remove = groupRemoves[index]!;
			const add = groupAdds[index]!;
			pairedRemove.set(remove, add);
			pairedAdd.set(add, remove);
		}
	}

	// 不同操作之间只把“文本唯一相同”的删除/新增视觉配对；重复项保守地保持单侧。
	const unmatchedRemoves = removes.filter((entry) => !pairedRemove.has(entry));
	const unmatchedAdds = adds.filter((entry) => !pairedAdd.has(entry));
	const removeByText = new Map<string, DiffLine[]>();
	const addByText = new Map<string, DiffLine[]>();
	for (const entry of unmatchedRemoves) removeByText.set(entry.content, [...(removeByText.get(entry.content) ?? []), entry]);
	for (const entry of unmatchedAdds) addByText.set(entry.content, [...(addByText.get(entry.content) ?? []), entry]);
	for (const [text, textRemoves] of removeByText) {
		const textAdds = addByText.get(text);
		if (textRemoves.length !== 1 || textAdds?.length !== 1) continue;
		const remove = textRemoves[0]!;
		const add = textAdds[0]!;
		if (remove.changeIndex === add.changeIndex) continue;
		pairedRemove.set(remove, add);
		pairedAdd.set(add, remove);
	}

	const rows: PairedDiffRow[] = [];
	let previousSingleSide: "left" | "right" | undefined;
	const appendSingle = (side: "left" | "right", line: DiffLine): void => {
		if (previousSingleSide !== undefined && previousSingleSide !== side) rows.push({ meta: "" });
		rows.push(side === "left" ? { left: line } : { right: line });
		previousSingleSide = side;
	};
	for (const entry of entries) {
		if (entry.kind === "remove") {
			const add = pairedRemove.get(entry);
			if (add) {
				rows.push({ left: entry, right: add });
				previousSingleSide = undefined;
			} else {
				appendSingle("left", entry);
			}
		} else {
			const remove = pairedAdd.get(entry);
			if (!remove) appendSingle("right", entry);
		}
	}
	return rows;
}

function buildStructuredPairs(entries: DiffEntry[], lines: readonly StructuredDiffLine[]): PairedDiffRow[] | undefined {
	const groupedEntries = attachStructuredGroups(entries, lines);
	if (!groupedEntries) return undefined;
	const rows: PairedDiffRow[] = [];
	let index = 0;
	while (index < groupedEntries.length) {
		const entry = groupedEntries[index]!;
		if (entry.kind === "meta") {
			rows.push({ meta: entry.content });
			index += 1;
		} else if (entry.kind === "context") {
			rows.push({ left: entry, right: entry });
			index += 1;
		} else {
			const run: DiffLine[] = [];
			while (index < groupedEntries.length) {
				const candidate = groupedEntries[index];
				if (!candidate || candidate.kind === "meta" || candidate.kind === "context") break;
				run.push(candidate);
				index += 1;
			}
			rows.push(...alignChangeRun(run));
		}
	}
	return rows;
}

function structuredUnifiedEntries(rows: PairedDiffRow[]): DiffEntry[] {
	const entries: DiffEntry[] = [];
	for (const row of rows) {
		if (row.meta !== undefined) {
			entries.push({ kind: "meta", content: row.meta });
		} else if (row.left && row.right && row.left === row.right) {
			entries.push(row.left);
		} else {
			if (row.left) entries.push(row.left);
			if (row.right) entries.push(row.right);
		}
	}
	return entries;
}

function lineNumberWidth(entries: DiffEntry[]): number {
	let width = 2;
	for (const entry of entries) {
		if (entry.kind !== "meta") width = Math.max(width, String(entry.lineNumber).length);
	}
	return width;
}

function wrapHighlightedLine(line: HighlightedText, width: number, maxRows: number): HighlightedText[] {
	if (line.width <= width) return [line];
	if (maxRows <= 0) return [];
	const visibleBudget = width * maxRows;
	if (line.width <= visibleBudget) {
		return wrapTextWithAnsi(line.text, width).map((text) => ({ text, width: visibleWidth(text) }));
	}

	// [喵喵喵]: 只取当前可见行预算内的高亮文本，避免为被裁掉的尾部生成完整 wrapped 数组。
	const boundedText = `${sliceByColumn(line.text, 0, visibleBudget, true)}\x1b[0m`;
	return wrapTextWithAnsi(boundedText, width)
		.slice(0, maxRows)
		.map((text) => ({ text, width: visibleWidth(text) }));
}

function lineColor(kind: DiffLineKind): "toolDiffAdded" | "toolDiffRemoved" | "dim" {
	if (kind === "add") return "toolDiffAdded";
	if (kind === "remove") return "toolDiffRemoved";
	return "dim";
}

// [喵喵喵]: 相同文本在不同位置仍是删除和新增；显式 +/- 与行号共同呈现位置变化。
function markerFor(kind: DiffLineKind): string {
	if (kind === "add") return "+";
	if (kind === "remove") return "-";
	return " ";
}

// 单栏使用完整可用宽度；超宽换行后续行只留缩进，避免重复行号被误认成新的源行。
function renderDiffLineRows(
	line: DiffLine,
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedText,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
	maxRows: number,
): string[] {
	const plainNumber = String(line.lineNumber).padStart(numberWidth, " ");
	const prefixWidth = 4 + numberWidth + 3;
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapHighlightedLine(highlightLine(line), contentWidth, maxRows);
	const rows = wrapped.length > 0 ? wrapped : [{ text: "", width: 0 }];
	const color = lineColor(line.kind);

	return rows.map((content, index) => {
		const marker = index === 0 ? markerFor(line.kind) : " ";
		const number = index === 0 ? plainNumber : " ".repeat(numberWidth);
		const stripe = line.kind === "context" ? " " : "▎";
		const label = `${stripe} ${marker} ${number}`;
		const gutter = palette && line.kind !== "context" ? palette.gutter(label, line.kind) : theme.fg(color, label);
		const prefix = `${gutter}${theme.fg("dim", " │ ")}`;
		const paddedContent = `${content.text}${" ".repeat(Math.max(0, contentWidth - content.width))}`;
		return applyChangeBackground(`${prefix}${paddedContent}`, line.kind, palette);
	});
}

function renderUnified(
	entries: DiffEntry[],
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedText,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
	maxRows: number,
): string[] {
	const rows: string[] = [];
	for (const entry of entries) {
		if (rows.length >= maxRows) break;
		if (entry.kind === "meta") {
			// [喵喵喵]: 空元数据仅隔离内部配对，不占可见行；真实省略标记继续显示。
			if (!entry.content.trim()) continue;
			const content = entry.content.trim() === "..." ? "⋮" : entry.content;
			rows.push(theme.fg("dim", truncateToWidth(`  ${escapeTerminalControls(content)}`, width, "")));
			continue;
		}
		rows.push(...renderDiffLineRows(entry, width, numberWidth, highlightLine, theme, palette, maxRows - rows.length));
	}
	return rows;
}

function diffSummary(
	parsed: ParsedDiff,
	theme: HleditRenderTheme,
	summaryStats?: DiffSummaryStats,
): string {
	const added = summaryStats?.added ?? parsed.added;
	const removed = summaryStats?.removed ?? parsed.removed;
	const pieces = [
		theme.fg("toolOutput", `↳ ${theme.bold("差异")}`),
		theme.fg("toolDiffAdded", `+${added}`),
		theme.fg("toolDiffRemoved", `-${removed}`),
	];
	if (summaryStats?.completeHunks !== false) pieces.push(theme.fg("muted", `• ${parsed.hunks} 个变更块`));
	else pieces.push(theme.fg("muted", "• 局部预览"));
	return pieces.join(" ");
}

function applyLineLimit(lines: string[], expanded: boolean, width: number, theme: HleditRenderTheme): string[] {
	const limit = expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES;
	if (lines.length <= limit) return lines;
	const hint = expanded ? "… 更多差异" : `… 预览已折叠 • ${expandHint()}`;
	return [...lines.slice(0, limit), "", truncateToWidth(theme.fg(expanded ? "warning" : "muted", hint), width, "")];
}

export function renderStandaloneDiff(
	diff: string,
	path: string | undefined,
	expanded: boolean,
	theme: HleditRenderTheme,
	summaryStats?: DiffSummaryStats,
	structuredLines?: readonly StructuredDiffLine[],
): HleditRenderComponent | undefined {
	if (!diff.trim()) return undefined;
	const parsed = parseGeneratedDiff(diff);
	if (parsed.entries.length === 0) return undefined;
	const highlighter = createHighlightedTextCache(path);
	const highlightLine = (line: DiffLine): HighlightedText => highlighter.highlight(line);
	const structuredRows = structuredLines ? buildStructuredPairs(parsed.entries, structuredLines) : undefined;
	const unifiedEntries = structuredRows ? structuredUnifiedEntries(structuredRows) : parsed.entries;
	const numberWidth = lineNumberWidth(parsed.entries);
	let paletteLoaded = false;
	let palette: DiffBackgroundPalette | undefined;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	function currentPalette(): DiffBackgroundPalette | undefined {
		if (!paletteLoaded) {
			palette = resolveDiffBackgroundPalette(theme);
			paletteLoaded = true;
		}
		return palette;
	}

	function storeRenderedLines(width: number, lines: string[]): string[] {
		cachedWidth = width;
		cachedLines = lines;
		return lines;
	}

	return {
		render(width: number): string[] {
			const safeWidth = normalizeWidth(width);
			if (cachedLines && cachedWidth === safeWidth) return cachedLines;
			if (safeWidth === 0) return storeRenderedLines(safeWidth, []);
			if (safeWidth < 24) return storeRenderedLines(safeWidth, [truncateToWidth(diffSummary(parsed, theme, summaryStats), safeWidth, "")]);

			// [喵喵喵]: 只布局显示上限加一行哨兵；摘要保留全量统计，
			// 不为隐藏行的精确换行数触发高亮和着色。(2026-09-05)
			const maxRows = (expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES) + 1;
			const body = renderUnified(unifiedEntries, safeWidth, numberWidth, highlightLine, theme, currentPalette(), maxRows);
			const frame = theme.fg("dim", "─".repeat(safeWidth));
			return storeRenderedLines(safeWidth, [
				truncateToWidth(diffSummary(parsed, theme, summaryStats), safeWidth, ""),
				frame,
				...applyLineLimit(body, expanded, safeWidth, theme),
				frame,
			]);
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
			paletteLoaded = false;
			palette = undefined;
			highlighter.clear();
		},
	};
}
