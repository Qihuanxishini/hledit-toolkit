import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { indexedColor, mixColors, rgbColor, truncateToWidth, visibleWidth, type Color, type TextStyle } from "@earendil-works/pi-tui";
import { createHighlightedTextCache, escapeTerminalControls } from "./syntax-highlight.ts";
import type { ChangePreviewLine, VerifiedChangePreview } from "./change-preview.ts";

export type HleditRenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

export type HleditRenderTheme = Pick<Theme, "fg" | "bold" | "appearance" | "colors" | "getColorMode" | "style" | "getBgAnsi">;

type DiffLine = {
	kind: "add" | "remove" | "context";
	lineNumber: number;
	content: string;
	text: string;
	changeIndex?: number;
	counterpart?: DiffLine;
	emphasis?: [number, number];
};

export type StructuredDiffLine = ChangePreviewLine;

type DiffMetaLine = { kind: "meta"; text: string };
type DiffEntry = DiffLine | DiffMetaLine;
type ParsedDiff = { entries: DiffEntry[]; added: number; removed: number; hunks: number; truncated: boolean };

export type DiffSummaryStats = {
	added: number;
	removed: number;
	completeHunks: boolean;
};

type SyntaxSpan = { end: number; style: TextStyle };
type RowPalette = {
	base: Color;
	add: { row: Color; emphasis: Color };
	remove: { row: Color; emphasis: Color };
};
type LineSlice = { line: DiffLine; start: number; end: number; columns: number };
type LayoutRow = DiffMetaLine | { kind: DiffLine["kind"]; slice: LineSlice };
type PreparedDiff = { parsed: ParsedDiff; numberWidth: number };

// [喵喵喵]: 已验证 preview 的纯结构跨组件复用；主题 ANSI、宽度布局和高亮失效仍留在各组件内。
const preparedDiffCache = new WeakMap<VerifiedChangePreview, PreparedDiff>();
const COLLAPSED_DIFF_LINES = 24;
const MAX_EXPANDED_DIFF_LINES = 2000;
const GAP_ROW: DiffMetaLine = { kind: "meta", text: "…" };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "展开详情");
	} catch {
		return "按 Ctrl+O 展开";
	}
}

function makePalette(theme: HleditRenderTheme): RowPalette {
	const base = theme.colors.toolSuccessBg;
	const light = theme.appearance === "light";
	const tint = (color: Color) => ({
		row: mixColors(base, color, light ? 0.07 : 0.1, "srgb"),
		emphasis: mixColors(base, color, light ? 0.18 : 0.26, "srgb"),
	});
	return { base, add: tint(theme.colors.toolDiffAdded), remove: tint(theme.colors.toolDiffRemoved) };
}

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
			entries.push({ kind: "meta", text: skipsOld || skipsNew ? "…" : "" });
			insideChangeGroup = false;
		}
		if (line.kind !== "context" && !insideChangeGroup) {
			hunks++;
			insideChangeGroup = true;
		}
		if (line.kind === "add") added++;
		if (line.kind === "remove") removed++;
		entries.push({ kind: line.kind, lineNumber: (line.kind === "remove" ? oldLine : newLine)!,
			changeIndex: line.changeIndex, content: line.text, text: escapeTerminalControls(line.text.replace(/\t/g, "    ")) });
		if (oldLine !== undefined) previousOld = oldLine;
		if (newLine !== undefined) previousNew = newLine;
		previousKind = line.kind;
		previousChangeIndex = line.changeIndex;
	}
	if (preview.truncated) entries.push({ kind: "meta", text: "… preview truncated …" });
	for (let index = 0; index < entries.length;) {
		const entry = entries[index]!;
		if (entry.kind === "meta" || entry.kind === "context" || entry.changeIndex === undefined) {
			index++;
			continue;
		}
		const before: DiffLine[] = [];
		const after: DiffLine[] = [];
		while (index < entries.length) {
			const line = entries[index]!;
			if (line.kind === "meta" || line.kind === "context" || line.changeIndex !== entry.changeIndex) break;
			(line.kind === "remove" ? before : after).push(line);
			index++;
		}
		// [喵喵喵]: 配对仅用于行内强调，不重排行；缺少操作关联时不猜测对应关系。
		for (let pair = 0; pair < Math.min(before.length, after.length); pair++) {
			before[pair]!.counterpart = after[pair];
			after[pair]!.counterpart = before[pair];
		}
	}
	return { entries, added, removed, hunks, truncated: preview.truncated };
}

function emphasizePair(before: DiffLine, after: DiffLine): void {
	const oldChars = Array.from(segmenter.segment(before.text), ({ segment }) => segment);
	const newChars = Array.from(segmenter.segment(after.text), ({ segment }) => segment);
	let prefix = 0;
	while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) prefix++;
	let suffix = 0;
	while (suffix < oldChars.length - prefix && suffix < newChars.length - prefix
		&& oldChars[oldChars.length - suffix - 1] === newChars[newChars.length - suffix - 1]) suffix++;
	const start = oldChars.slice(0, prefix).join("").length;
	before.emphasis = [start, before.text.length - oldChars.slice(oldChars.length - suffix).join("").length];
	after.emphasis = [start, after.text.length - newChars.slice(newChars.length - suffix).join("").length];
}

function syntaxSpans(text: string, highlighted: string): SyntaxSpan[] {
	const spans: SyntaxSpan[] = [];
	let style: TextStyle = {};
	let offset = 0;
	let plain = "";
	const append = (part: string) => {
		if (part) {
			plain += part;
			spans.push({ end: plain.length, style: { ...style } });
		}
	};
	// [喵喵喵]: 仅消费缓存高亮的前景与属性；按原文字素着色，避免 ANSI reset 吞掉差异底色。
	for (const match of highlighted.matchAll(/\x1b\[([\d;]*)m/g)) {
		append(highlighted.slice(offset, match.index));
		const codes = match[1]!.split(";").map(Number);
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index]!;
			if (code === 0) style = {};
			else if (code === 38 && codes[index + 1] === 2) {
				style.fg = rgbColor(codes[index + 2]!, codes[index + 3]!, codes[index + 4]!);
				index += 4;
			} else if (code === 38 && codes[index + 1] === 5) {
				style.fg = indexedColor(codes[index + 2]!);
				index += 2;
			} else if (code >= 30 && code <= 37) style.fg = indexedColor(code - 30);
			else if (code >= 90 && code <= 97) style.fg = indexedColor(code - 82);
			else if (code === 39) delete style.fg;
			else if (code === 1) style.bold = true;
			else if (code === 2) style.dim = true;
			else if (code === 3) style.italic = true;
			else if (code === 4) style.underline = true;
			else if (code === 7) style.inverse = true;
			else if (code === 9) style.strikethrough = true;
			else if (code === 22) { delete style.bold; delete style.dim; }
			else if (code === 23) delete style.italic;
			else if (code === 24) delete style.underline;
			else if (code === 27) delete style.inverse;
			else if (code === 29) delete style.strikethrough;
		}
		offset = match.index! + match[0].length;
	}
	append(highlighted.slice(offset));
	return plain === text && spans.length ? spans : [{ end: text.length, style: {} }];
}

function contentWidth(width: number, numberWidth: number): number {
	return Math.max(1, width - (numberWidth ? numberWidth + 5 : 2));
}

function* wrapLine(line: DiffLine, width: number): Generator<LineSlice> {
	let start = 0;
	let columns = 0;
	for (const { segment, index } of segmenter.segment(line.text)) {
		const size = Math.min(visibleWidth(segment), width);
		if (columns + size > width) {
			yield { line, start, end: index, columns };
			start = index;
			columns = 0;
		}
		columns += size;
	}
	yield { line, start, end: line.text.length, columns };
}

function collectRows(entries: DiffEntry[], codeWidth: number, maxRows: number, start = 0, end = entries.length): LayoutRow[] {
	const rows: LayoutRow[] = [];
	for (let index = start; index < end; index++) {
		const line = entries[index]!;
		if (line.kind === "meta") {
			if (line.text) rows.push(line);
		} else {
			for (const slice of wrapLine(line, codeWidth)) {
				rows.push({ kind: line.kind, slice });
				if (rows.length >= maxRows) return rows;
			}
		}
		if (rows.length >= maxRows) break;
	}
	return rows;
}

function previewRows(entries: DiffEntry[], rows: LayoutRow[], codeWidth: number): LayoutRow[] {
	let shown = rows.slice(0, COLLAPSED_DIFF_LINES);
	if (rows.length <= COLLAPSED_DIFF_LINES) return shown;
	const firstAdded = entries.findIndex((line) => line.kind === "add");
	const firstRemoved = entries.findIndex((line) => line.kind === "remove");
	const firstChanged = entries.findIndex((line) => line.kind === "add" || line.kind === "remove");
	if (firstChanged < 0) return shown;
	const leading = firstChanged > 0 ? [GAP_ROW] : [];
	const slots = COLLAPSED_DIFF_LINES - leading.length;
	if (!shown.some((row) => row.kind === "add" || row.kind === "remove")) {
		shown = [...leading, ...collectRows(entries, codeWidth, slots, firstChanged)];
	}
	// [喵喵喵]: 折叠态同时露出增删；只布局各片段预算加一行哨兵，不展开隐藏的长行尾部。
	if (firstAdded >= 0 && firstRemoved >= 0
		&& (!shown.some((row) => row.kind === "add") || !shown.some((row) => row.kind === "remove"))) {
		const nextStart = Math.max(firstAdded, firstRemoved);
		const firstCount = Math.floor((slots - 1) / 2);
		const first = collectRows(entries, codeWidth, firstCount + 1, firstChanged, nextStart);
		const gap = first.length > firstCount ? [GAP_ROW] : [];
		const head = first.slice(0, firstCount);
		shown = [...leading, ...head, ...gap, ...collectRows(entries, codeWidth, slots - head.length - gap.length, nextStart)];
	}
	return shown;
}

function renderLine(slice: LineSlice, width: number, numberWidth: number, theme: HleditRenderTheme, palette: RowPalette, spans: SyntaxSpan[]): string {
	const { line } = slice;
	const color = line.kind === "add" ? "toolDiffAdded" : line.kind === "remove" ? "toolDiffRemoved" : "dim";
	const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
	const colors = line.kind === "context" ? undefined : palette[line.kind];
	const bg = colors?.row ?? palette.base;
	const codeWidth = contentWidth(width, numberWidth);
	const prefix = theme.style(`${marker} `, { fg: color, bg, bold: line.kind !== "context" })
		+ (numberWidth ? theme.style((slice.start > 0 ? "" : String(line.lineNumber)).padStart(numberWidth) + " ", { fg: color, bg })
			+ theme.style("│ ", { fg: "dim", bg }) : "");
	let content = "";
	let chunk = "";
	let spanIndex = 0;
	let activeSpan = 0;
	let emphasized = false;
	const flush = () => {
		if (chunk) content += theme.style(chunk, { fg: "text", ...spans[activeSpan]?.style, bg: emphasized ? colors?.emphasis ?? bg : bg });
		chunk = "";
	};
	for (const { segment, index: relativeIndex } of segmenter.segment(line.text.slice(slice.start, slice.end))) {
		const index = slice.start + relativeIndex;
		while (spanIndex + 1 < spans.length && index >= spans[spanIndex]!.end) spanIndex++;
		const emphasis = !!line.emphasis && index >= line.emphasis[0] && index < line.emphasis[1];
		if (spanIndex !== activeSpan || emphasis !== emphasized) flush();
		activeSpan = spanIndex;
		emphasized = emphasis;
		chunk += visibleWidth(segment) > codeWidth ? "…" : segment;
	}
	flush();
	return prefix + content + theme.style(" ".repeat(codeWidth - slice.columns), { bg });
}

function renderDiffStatBar(added: number, removed: number, width: number, theme: HleditRenderTheme): string | undefined {
	const total = added + removed;
	if (total === 0 || width < 20) return undefined;
	const slots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(0, Math.min(slots, Math.round(added / total * slots)));
	// [喵喵喵]: 色条表示增删比例而非进度；两类变更都有时各留至少一格。
	if (added > 0 && addedSlots === 0) addedSlots = 1;
	if (removed > 0 && addedSlots === slots) addedSlots = slots - 1;
	const removedSlots = slots - addedSlots;
	return theme.fg("dim", "[")
		+ (addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "")
		+ (removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "")
		+ theme.fg("dim", "]");
}

function diffSummary(parsed: ParsedDiff, width: number, theme: HleditRenderTheme, summaryStats?: DiffSummaryStats): string {
	const added = summaryStats?.added ?? parsed.added;
	const removed = summaryStats?.removed ?? parsed.removed;
	const counts = theme.fg("toolDiffAdded", `+${added}`) + " " + theme.fg("toolDiffRemoved", `-${removed}`);
	const base = theme.fg("text", `↳ ${theme.bold("diff")}`) + " " + counts;
	const partial = parsed.truncated || summaryStats?.completeHunks === false;
	const detail = theme.fg("muted", partial ? " · 局部预览" : ` · ${parsed.hunks} ${parsed.hunks === 1 ? "hunk" : "hunks"}`);
	const full = base + detail;
	const meter = renderDiffStatBar(added, removed, width, theme);
	const required = partial ? full : base;
	const suffix = meter && visibleWidth(required) + 1 + visibleWidth(meter) <= width ? ` ${meter}` : "";
	const available = width - visibleWidth(suffix);
	const candidates = partial
		? [full, counts + detail, theme.fg("muted", "局部预览"), theme.fg("muted", "局部")]
		: [full, base, counts];
	return (candidates.find((text) => visibleWidth(text) <= available) ?? theme.fg("muted", "…")) + suffix;
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
		const numberWidth = parsed.entries.reduce((width, line) => line.kind === "meta" ? width : Math.max(width, String(line.lineNumber).length), 2);
		prepared = { parsed, numberWidth };
		preparedDiffCache.set(preview, prepared);
	}
	const { parsed, numberWidth: numbers } = prepared;
	if (parsed.entries.length === 0) return undefined;
	const highlighter = createHighlightedTextCache(path);
	const syntax = new Map<DiffLine, SyntaxSpan[]>();
	let palette: RowPalette | undefined;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	function spansFor(line: DiffLine): SyntaxSpan[] {
		if (line.counterpart && !line.emphasis) {
			emphasizePair(line.kind === "remove" ? line : line.counterpart, line.kind === "add" ? line : line.counterpart);
		}
		let spans = syntax.get(line);
		if (!spans) {
			spans = syntaxSpans(line.text, highlighter.highlight(line).text);
			syntax.set(line, spans);
		}
		return spans;
	}

	return {
		render(width: number): string[] {
			const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			if (cachedLines && cachedWidth === safeWidth) return cachedLines;
			cachedWidth = safeWidth;
			if (safeWidth === 0) return cachedLines = [];
			const output = [diffSummary(parsed, safeWidth, theme, summaryStats)];
			if (safeWidth < 8) return cachedLines = output;
			const numberWidth = safeWidth >= Math.max(18, numbers + 7) ? numbers : 0;
			const codeWidth = contentWidth(safeWidth, numberWidth);
			const limit = expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES;
			const rows = collectRows(parsed.entries, codeWidth, limit + 1);
			const shown = expanded ? rows.slice(0, limit) : previewRows(parsed.entries, rows, codeWidth);
			if (numberWidth) output.push(theme.fg("dim", "─".repeat(safeWidth)));
			for (const row of shown) {
				output.push(row.kind === "meta"
					? theme.fg(row === GAP_ROW ? "muted" : "dim", truncateToWidth(row.text, safeWidth))
					: renderLine(row.slice, safeWidth, numberWidth, theme, palette ??= makePalette(theme), spansFor(row.slice.line)));
			}
			if (rows.length > limit) {
				const hint = expandHint();
				const labels = expanded ? ["… 更多差异"] : [`预览已折叠 · ${hint}`, hint];
				const label = labels.find((text) => visibleWidth(text) <= safeWidth) ?? truncateToWidth(labels[0]!, safeWidth);
				output.push(theme.fg(expanded ? "warning" : "muted", label));
			}
			return cachedLines = output;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
			palette = undefined;
			syntax.clear();
			highlighter.clear();
		},
	};
}
