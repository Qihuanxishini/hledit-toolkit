import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createHighlightedTextCache, escapeTerminalControls, type HighlightedText } from "./syntax-highlight.ts";
import type { ChangePreviewLine, VerifiedChangePreview } from "./change-preview.ts";

export type HleditRenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

export type HleditRenderTheme = Pick<Theme, "fg" | "bold" | "appearance" | "getColorMode" | "style" | "getBgAnsi">;

type DiffBackgroundPalette = {
	added(text: string): string;
	removed(text: string): string;
	gutter(text: string, kind: "add" | "remove"): string;
	base(text: string): string;
	container: string;
};

type DiffLineKind = "add" | "remove" | "context";

type DiffLine = {
	kind: DiffLineKind;
	lineNumber: number;
	oldLine?: number;
	newLine?: number;
	content: string;
	changeIndex?: number;
};

export type StructuredDiffLine = ChangePreviewLine;

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

type PreparedDiff = {
	parsed: ParsedDiff;
	structuredRows: PairedDiffRow[] | undefined;
	numberWidth: number;
};

// [喵喵喵]: 已验证 preview 的纯结构跨组件复用；主题 ANSI、宽度布局和高亮失效仍留在各组件内。
const preparedDiffCache = new WeakMap<VerifiedChangePreview, PreparedDiff>();

type SplitColumnWidths = {
	left: number;
	right: number;
};

const COLLAPSED_DIFF_LINES = 24;
const MAX_EXPANDED_DIFF_LINES = 2000;
const DIFF_GUTTER_COLUMNS = 7;
const SPLIT_GUTTER_COLUMNS = 5;
const MIN_SPLIT_WIDTH = 120;
const SPLIT_SEPARATOR = " │ ";
const SPLIT_SEPARATOR_COLUMNS = 3;

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
	// 增删行使用独立整行底色；非变更区域固定为 classic-dark 的工具绿色，不随主题切换。
	const light = theme.appearance === "light";
	const indexed = theme.getColorMode() === "256color";
	const added = parseColor(indexed ? (light ? 194 : 22) : (light ? "#DAFBE1" : "#354330"));
	const removed = parseColor(indexed ? (light ? 224 : 52) : (light ? "#FFEBE9" : "#3E3831"));
	const base = parseColor("#283228");
	const addedFg = parseColor(light ? "#116329" : "#B5BD68");
	const removedFg = parseColor(light ? "#82071E" : "#CC6666");
	return {
		added: (text) => theme.style(text, { bg: added }),
		removed: (text) => theme.style(text, { bg: removed }),
		gutter: (text, kind) => theme.style(text, { fg: kind === "add" ? addedFg : removedFg }),
		base: (text) => theme.style(text, { bg: base }),
		container: theme.getBgAnsi("toolSuccessBg"),
	};
}

function applyChangeBackground(
	text: string,
	kind: DiffLineKind,
	palette: DiffBackgroundPalette | undefined,
): string {
	const rowBackground = kind === "add" ? palette?.added : kind === "remove" ? palette?.removed : palette?.base;
	if (!rowBackground || !palette) return text;
	// 宿主 style 负责在高亮器的内部 reset 后恢复本行底色，行末回到工具容器背景。
	return `${rowBackground(text)}${palette.container}`;
}

function renderBaseRow(text: string, width: number, palette: DiffBackgroundPalette | undefined): string {
	// [喵喵喵]: 非代码行同样填满固定底色，避免间隔处露出不同的宿主背景。
	return applyChangeBackground(truncateToWidth(text, width, "", true), "context", palette);
}

// [喵喵喵]: 直接消费已验证 preview，保留旧预览无 changeIndex 时的单栏语义；不再文本化后重新匹配操作。
function buildPreviewDiff(preview: VerifiedChangePreview): ParsedDiff {
	const entries: DiffEntry[] = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let insideChangeGroup = false;
	let previousOld: number | undefined;
	let previousNew: number | undefined;
	let previousKind: ChangePreviewLine["kind"] | undefined;
	let previousChangeIndex: number | undefined;
	for (const line of preview.lines) {
		const oldLine = line.kind === "add" ? undefined : line.oldLine;
		const newLine = line.kind === "remove" ? undefined : line.newLine;
		const continuesOld = oldLine !== undefined && previousOld !== undefined && oldLine <= previousOld + 1;
		const continuesNew = newLine !== undefined && previousNew !== undefined && newLine <= previousNew + 1;
		const sameChange = line.changeIndex === previousChangeIndex;
		const continuous = sameChange && (continuesOld || continuesNew || (previousKind === "remove" && line.kind === "add"));
		if (entries.length > 0 && !continuous) {
			const skipsOld = oldLine !== undefined && previousOld !== undefined && oldLine > previousOld + 1;
			const skipsNew = newLine !== undefined && previousNew !== undefined && newLine > previousNew + 1;
			entries.push({ kind: "meta", content: skipsOld || skipsNew ? "..." : "" });
			insideChangeGroup = false;
		}
		if (line.kind !== "context" && !insideChangeGroup) {
			hunks++;
			insideChangeGroup = true;
		}
		if (line.kind === "add") added++;
		if (line.kind === "remove") removed++;
		entries.push({ kind: line.kind, lineNumber: (line.kind === "remove" ? oldLine : newLine)!,
			oldLine, newLine, changeIndex: line.changeIndex, content: line.text });
		if (oldLine !== undefined) previousOld = oldLine;
		if (newLine !== undefined) previousNew = newLine;
		previousKind = line.kind;
		previousChangeIndex = line.changeIndex;
	}
	if (preview.truncated) entries.push({ kind: "meta", content: "… preview truncated …" });
	return { entries, added, removed, hunks };
}

function alignChangeRun(entries: DiffLine[]): PairedDiffRow[] {
	const rows: PairedDiffRow[] = [];
	let index = 0;
	// [喵喵喵]: 只配对同一操作的连续片段；跨操作即使文本相同，也保留各自的文件位置。
	while (index < entries.length) {
		const changeIndex = entries[index]!.changeIndex;
		if (changeIndex === undefined) {
			const line = entries[index++]!;
			rows.push(line.kind === "remove" ? { left: line } : { right: line });
			continue;
		}
		const removes: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (index < entries.length && entries[index]!.changeIndex === changeIndex) {
			const line = entries[index++]!;
			(line.kind === "remove" ? removes : adds).push(line);
		}
		for (let pair = 0; pair < Math.max(removes.length, adds.length); pair += 1) {
			rows.push({ left: removes[pair], right: adds[pair] });
		}
	}
	return rows;
}

function buildStructuredPairs(entries: DiffEntry[]): PairedDiffRow[] {
	const rows: PairedDiffRow[] = [];
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index]!;
		if (entry.kind === "meta") {
			rows.push({ meta: entry.content });
			index += 1;
		} else if (entry.kind === "context") {
			rows.push({ left: entry, right: entry });
			index += 1;
		} else {
			const run: DiffLine[] = [];
			while (index < entries.length) {
				const candidate = entries[index];
				if (!candidate || candidate.kind === "meta" || candidate.kind === "context") break;
				run.push(candidate);
				index += 1;
			}
			rows.push(...alignChangeRun(run));
		}
	}
	return rows;
}

function* iterateUnifiedPairs(pairs: readonly PairedDiffRow[]): Iterable<DiffEntry> {
	// [喵喵喵]: 单栏按源码行展开同一操作的旧/新配对，续行仍跟随各自源码行；惰性遍历保留渲染预算。
	for (const pair of pairs) {
		if (pair.meta !== undefined) yield { kind: "meta", content: pair.meta };
		else {
			if (pair.left) yield pair.left;
			// [喵喵喵]: 上下文两侧引用同一行，只输出一次；不同位置的相同文本不去重。
			if (pair.right && pair.right !== pair.left) yield pair.right;
		}
	}
}
function lineNumberWidth(entries: DiffEntry[]): number {
	let width = 2;
	for (const entry of entries) {
		if (entry.kind === "meta") continue;
		width = Math.max(width, String(entry.lineNumber).length, String(entry.oldLine ?? 0).length, String(entry.newLine ?? 0).length);
	}
	return width;
}

function wrapHighlightedLine(line: HighlightedText, width: number, maxRows: number): HighlightedText[] {
	if (maxRows <= 0) return [];
	if (line.width <= width) return [line];
	const visibleBudget = width * maxRows;
	if (line.width <= visibleBudget) {
		return wrapTextWithAnsi(line.text, width).slice(0, maxRows).map((text) => ({ text, width: visibleWidth(text) }));
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

// 两种布局共用完整行底色；续行不重复源行号，避免被误认成新的源码行。
function renderDiffLineRows(
	line: DiffLine,
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedText,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
	maxRows: number,
	side?: "left" | "right",
): string[] {
	// [喵喵喵]: 上下文两侧可能因前面的增删产生行号偏移，不能复用统一栏的新行号。
	const lineNumber = side === "left" ? line.oldLine ?? line.lineNumber
		: side === "right" ? line.newLine ?? line.lineNumber : line.lineNumber;
	const plainNumber = String(lineNumber).padStart(numberWidth, " ");
	const prefixWidth = (side ? SPLIT_GUTTER_COLUMNS : DIFF_GUTTER_COLUMNS) + numberWidth;
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapHighlightedLine(highlightLine(line), contentWidth, maxRows);
	const rows = wrapped.length > 0 ? wrapped : [{ text: "", width: 0 }];
	const color = lineColor(line.kind);

	return rows.map((content, index) => {
		const marker = index === 0 ? markerFor(line.kind) : " ";
		const number = index === 0 ? plainNumber : " ".repeat(numberWidth);
		const stripe = line.kind === "context" ? " " : "▌";
		// [喵喵喵]: 双栏由 old/new 侧位表达增删，单栏仍保留 +/-，不只依赖颜色。
		const label = side ? `${stripe} ${number}` : `${stripe} ${marker} ${number}`;
		const gutter = palette && line.kind !== "context" ? palette.gutter(label, line.kind) : theme.fg(color, label);
		const prefix = `${gutter}${theme.fg("dim", " │ ")}`;
		const paddedContent = `${content.text}${" ".repeat(Math.max(0, contentWidth - content.width))}`;
		return applyChangeBackground(`${prefix}${paddedContent}`, line.kind, palette);
	});
}

function renderDiffMeta(
	content: string,
	width: number,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string | undefined {
	// [喵喵喵]: 空元数据仅隔离操作，不占可见行；真实省略标记继续显示。
	if (!content.trim()) return undefined;
	const label = content.trim() === "..." ? "⋮" : content;
	return renderBaseRow(theme.fg("dim", `  ${escapeTerminalControls(label)}`), width, palette);
}

function renderUnified(
	entries: Iterable<DiffEntry>,
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
			const meta = renderDiffMeta(entry.content, width, theme, palette);
			if (meta !== undefined) rows.push(meta);
			continue;
		}
		rows.push(...renderDiffLineRows(entry, width, numberWidth, highlightLine, theme, palette, maxRows - rows.length));
	}
	return rows;
}

function splitColumnWidths(width: number, numberWidth: number): SplitColumnWidths | undefined {
	const left = Math.floor((width - SPLIT_SEPARATOR_COLUMNS) / 2);
	const right = width - SPLIT_SEPARATOR_COLUMNS - left;
	// [喵喵喵]: 按组件净宽对齐工具渲染插件的断点，同时保证行号区之外仍有正文空间。
	if (width < MIN_SPLIT_WIDTH || left - Math.max(3, numberWidth) - SPLIT_GUTTER_COLUMNS < 1) return undefined;
	return { left, right };
}

function renderSplitTopBorder(
	columns: SplitColumnWidths,
	numberWidth: number,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string {
	const dividerColumn = numberWidth + SPLIT_GUTTER_COLUMNS - 2;
	const cell = (width: number) => `${"─".repeat(dividerColumn)}┬${"─".repeat(width - dividerColumn - 1)}`;
	const border = `${cell(columns.left)}─┬─${cell(columns.right)}`;
	return renderBaseRow(theme.fg("dim", border), columns.left + SPLIT_SEPARATOR_COLUMNS + columns.right, palette);
}

function renderSplitHeader(
	columns: SplitColumnWidths,
	numberWidth: number,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string {
	const cell = (label: string, width: number) => {
		const gutter = `${theme.fg("muted", `  ${label.padEnd(numberWidth, " ")}`)}${theme.fg("dim", " │ ")}`;
		return `${gutter}${" ".repeat(width - numberWidth - SPLIT_GUTTER_COLUMNS)}`;
	};
	return applyChangeBackground(`${cell("old", columns.left)}${theme.fg("dim", SPLIT_SEPARATOR)}${cell("new", columns.right)}`, "context", palette);
}

function renderSplitBlankCell(
	width: number,
	numberWidth: number,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string {
	// [喵喵喵]: 缺行和换行补位仍保留行号分隔线，让整张双栏表格连续对齐。
	return renderBaseRow(`${" ".repeat(numberWidth + 2)}${theme.fg("dim", " │ ")}`, width, palette);
}

function renderSplit(
	pairedRows: PairedDiffRow[],
	columns: SplitColumnWidths,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedText,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
	maxRows: number,
): string[] {
	const rows: string[] = [];
	const width = columns.left + SPLIT_SEPARATOR_COLUMNS + columns.right;
	const separator = applyChangeBackground(theme.fg("dim", SPLIT_SEPARATOR), "context", palette);
	const emptyLeft = renderSplitBlankCell(columns.left, numberWidth, theme, palette);
	const emptyRight = renderSplitBlankCell(columns.right, numberWidth, theme, palette);
	for (const pair of pairedRows) {
		if (rows.length >= maxRows) break;
		if (pair.meta !== undefined) {
			const meta = renderDiffMeta(pair.meta, width, theme, palette);
			if (meta !== undefined) rows.push(meta);
			continue;
		}
		const remaining = maxRows - rows.length;
		const left = pair.left ? renderDiffLineRows(pair.left, columns.left, numberWidth, highlightLine, theme, palette, remaining, "left") : [];
		const right = pair.right ? renderDiffLineRows(pair.right, columns.right, numberWidth, highlightLine, theme, palette, remaining, "right") : [];
		// [喵喵喵]: 每组按较高的一侧补齐；空位使用固定底色，不伪造增删行或让后续对应关系错位。
		for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
			rows.push(`${left[index] ?? emptyLeft}${separator}${right[index] ?? emptyRight}`);
		}
	}
	return rows;
}

function renderDiffStatBar(added: number, removed: number, width: number, theme: HleditRenderTheme): string | undefined {
	const total = added + removed;
	if (total === 0 || width < 20) return undefined;
	const slots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(0, Math.min(slots, Math.round(added / total * slots)));
	// [喵喵喵]: 色条表示增删比例而非进度；两类变更都有时各留至少一格，避免少量变更消失。
	if (added > 0 && addedSlots === 0) addedSlots = 1;
	if (removed > 0 && addedSlots === slots) addedSlots = slots - 1;
	const removedSlots = slots - addedSlots;
	const addedBar = addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "";
	const removedBar = removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "";
	return `${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`;
}

function diffSummary(
	parsed: ParsedDiff,
	width: number,
	mode: "split" | "unified" | undefined,
	theme: HleditRenderTheme,
	summaryStats?: DiffSummaryStats,
): string {
	const added = summaryStats?.added ?? parsed.added;
	const removed = summaryStats?.removed ?? parsed.removed;
	const counts = [
		theme.fg("toolDiffAdded", `+${added}`),
		theme.fg("toolDiffRemoved", `-${removed}`),
	].join(" ");
	const heading = `${theme.fg("toolOutput", `↳ ${theme.bold("diff")}`)} ${counts}`;
	const separator = theme.fg("muted", " • ");
	const partial = summaryStats?.completeHunks === false ? theme.fg("muted", "局部预览") : undefined;
	const detail = partial ?? (mode === "unified" ? theme.fg("muted", `${parsed.hunks} 个变更块`) : undefined);
	const layout = mode ? theme.fg("muted", mode) : "";
	const summary = heading + (detail ? separator + detail : "")
		+ (mode ? (mode === "split" ? " " : separator) + layout : "");
	const required = partial ? heading + separator + partial : heading;
	const meter = mode ? renderDiffStatBar(added, removed, width, theme) : undefined;
	// [喵喵喵]: 先为色条留位，再缩略辅助信息；增删计数和局部预览状态放不下时，色条让位。
	const meterSuffix = meter && visibleWidth(required) + 1 + visibleWidth(meter) <= width ? ` ${meter}` : "";
	const summaryWidth = width - visibleWidth(meterSuffix);
	const candidates = [
		summary,
		mode ? `${required} ${layout}` : required,
		required,
		partial ? counts + separator + partial : counts,
		partial ?? theme.fg("toolOutput", "diff"),
		...(partial ? [theme.fg("muted", "局部")] : []),
		theme.fg("muted", "…"),
	];
	// [喵喵喵]: 按完整信息单元降级，避免窄屏把数字或“局部预览”裁成误导性的半截文本。
	const fittedSummary = candidates.find((candidate) => visibleWidth(candidate) <= summaryWidth) ?? "";
	return fittedSummary + meterSuffix;
}

function applyLineLimit(
	lines: string[],
	expanded: boolean,
	width: number,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string[] {
	const limit = expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES;
	if (lines.length <= limit) return lines;
	const hint = expanded ? "… 更多差异" : `… 预览已折叠 • ${expandHint()}`;
	return [
		...lines.slice(0, limit),
		renderBaseRow("", width, palette),
		renderBaseRow(theme.fg(expanded ? "warning" : "muted", hint), width, palette),
	];
}

export function renderStandaloneDiff(
	preview: VerifiedChangePreview,
	path: string | undefined,
	expanded: boolean,
	theme: HleditRenderTheme,
	summaryStats?: DiffSummaryStats,
): HleditRenderComponent | undefined {
	let prepared = preparedDiffCache.get(preview);
	if (!prepared) {
		const parsed = buildPreviewDiff(preview);
		prepared = {
			parsed,
			structuredRows: preview.lines.some((line) => line.changeIndex !== undefined) ? buildStructuredPairs(parsed.entries) : undefined,
			numberWidth: lineNumberWidth(parsed.entries),
		};
		preparedDiffCache.set(preview, prepared);
	}
	const { parsed, structuredRows, numberWidth } = prepared;
	if (parsed.entries.length === 0) return undefined;
	const highlighter = createHighlightedTextCache(path);
	const highlightLine = (line: DiffLine): HighlightedText => highlighter.highlight(line);
	const entries = parsed.entries;
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
			const colors = currentPalette();
			// [喵喵喵]: 纯单侧变更与缺少操作关系的旧预览保持单栏，不猜测替换对应关系。
			const columns = structuredRows && parsed.added > 0 && parsed.removed > 0 ? splitColumnWidths(safeWidth, numberWidth) : undefined;
			const mode = safeWidth < 24 ? undefined : columns ? "split" : "unified";
			const summary = renderBaseRow(diffSummary(parsed, safeWidth, mode, theme, summaryStats), safeWidth, colors);
			if (safeWidth < 24) return storeRenderedLines(safeWidth, [summary]);

			// [喵喵喵]: 只布局显示上限加一行哨兵；摘要保留全量统计，
			// 不为隐藏行的精确换行数触发高亮和着色。(2026-09-05)
			const maxRows = (expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES) + 1;
			const splitNumberWidth = Math.max(3, numberWidth);
			const body = columns && structuredRows
				? renderSplit(structuredRows, columns, splitNumberWidth, highlightLine, theme, colors, maxRows)
				: renderUnified(structuredRows ? iterateUnifiedPairs(structuredRows) : entries, safeWidth, numberWidth, highlightLine, theme, colors, maxRows);
			const frame = columns
				? renderSplitTopBorder(columns, splitNumberWidth, theme, colors)
				: renderBaseRow(theme.fg("dim", "─".repeat(safeWidth)), safeWidth, colors);
			return storeRenderedLines(safeWidth, [
				summary,
				frame,
				...(columns ? [renderSplitHeader(columns, splitNumberWidth, theme, colors)] : []),
				...applyLineLimit(body, expanded, safeWidth, theme, colors),
				...(columns ? [] : [frame]),
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
