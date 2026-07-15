import { getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type HleditRenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

export type HleditRenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
	getFgAnsi?(name: string): string;
	getBgAnsi?(name: string): string;
};

type RgbColor = {
	r: number;
	g: number;
	b: number;
};

type DiffBackgroundPalette = {
	added: string;
	removed: string;
	container: string;
};

type DiffLineKind = "add" | "remove" | "context";

type DiffLine = {
	kind: DiffLineKind;
	lineNumber?: number;
	content: string;
};

type HighlightedDiffLine = {
	text: string;
	width: number;
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

type SplitDiffRow = {
	left?: DiffLine;
	right?: DiffLine;
	meta?: string;
};

const GENERATED_DIFF_LINE = /^([ +\-])(\s*\d+)\s(.*)$/;
const COLLAPSED_DIFF_LINES = 24;
const MAX_EXPANDED_DIFF_LINES = 2000;
const SPLIT_MIN_WIDTH = 120;
const SPLIT_SEPARATOR = " │ ";

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "Ctrl+O to expand";
	}
}

function normalizeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const fitted = truncateToWidth(text, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function ansi256ToRgb(index: number): RgbColor | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const baseColors: RgbColor[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return baseColors[index];
	}
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return { r: level, g: level, b: level };
	}
	const cubeIndex = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return {
		r: levels[Math.floor(cubeIndex / 36)] ?? 0,
		g: levels[Math.floor(cubeIndex / 6) % 6] ?? 0,
		b: levels[cubeIndex % 6] ?? 0,
	};
}

function ansiToRgb(ansi: string | undefined): RgbColor | undefined {
	if (!ansi) return undefined;
	const trueColor = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (trueColor) {
		return {
			r: Math.min(255, Number.parseInt(trueColor[1] ?? "0", 10)),
			g: Math.min(255, Number.parseInt(trueColor[2] ?? "0", 10)),
			b: Math.min(255, Number.parseInt(trueColor[3] ?? "0", 10)),
		};
	}
	const indexedColor = /\x1b\[(?:38|48);5;(\d{1,3})m/.exec(ansi);
	return indexedColor ? ansi256ToRgb(Number.parseInt(indexedColor[1] ?? "", 10)) : undefined;
}

function mixRgb(base: RgbColor, tint: RgbColor, tintRatio: number): RgbColor {
	const baseRatio = 1 - tintRatio;
	return {
		r: Math.round(base.r * baseRatio + tint.r * tintRatio),
		g: Math.round(base.g * baseRatio + tint.g * tintRatio),
		b: Math.round(base.b * baseRatio + tint.b * tintRatio),
	};
}

function toBackgroundAnsi(color: RgbColor): string {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

function resolveDiffBackgroundPalette(theme: HleditRenderTheme): DiffBackgroundPalette | undefined {
	if (!theme.getBgAnsi || !theme.getFgAnsi) return undefined;
	try {
		const containerAnsi = theme.getBgAnsi("toolSuccessBg");
		const container = ansiToRgb(containerAnsi);
		const added = ansiToRgb(theme.getFgAnsi("toolDiffAdded"));
		const removed = ansiToRgb(theme.getFgAnsi("toolDiffRemoved"));
		if (!container || !added || !removed) return undefined;
		return {
			added: toBackgroundAnsi(mixRgb(container, added, 0.14)),
			removed: toBackgroundAnsi(mixRgb(container, removed, 0.14)),
			container: containerAnsi,
		};
	} catch {
		return undefined;
	}
}

function applyChangeBackground(
	text: string,
	kind: DiffLineKind,
	palette: DiffBackgroundPalette | undefined,
): string {
	const rowBackground = kind === "add" ? palette?.added : kind === "remove" ? palette?.removed : undefined;
	if (!rowBackground || !palette) return text;
	// ANSI 全量重置或背景重置可能来自主题/高亮器；重置后立即恢复本行底色。
	const stable = text.replace(/\x1b\[(?:0|49)?m/g, (reset) => `${reset}${rowBackground}`);
	return `${rowBackground}${stable}${palette.container}`;
}

function parseGeneratedDiff(diff: string): ParsedDiff {
	const entries: DiffEntry[] = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let insideChangeGroup = false;

	for (const rawLine of diff.replace(/\r/g, "").split("\n")) {
		if (!rawLine && entries.length === 0) continue;
		const match = GENERATED_DIFF_LINE.exec(rawLine);
		if (!match) {
			entries.push({ kind: "meta", content: rawLine.trim() || "…" });
			insideChangeGroup = false;
			continue;
		}

		const marker = match[1];
		const lineNumber = Number.parseInt(match[2]?.trim() ?? "", 10);
		const kind: DiffLineKind = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
		if (kind !== "context" && !insideChangeGroup) {
			hunks++;
			insideChangeGroup = true;
		}
		if (kind === "add") added++;
		if (kind === "remove") removed++;
		entries.push({
			kind,
			lineNumber: Number.isFinite(lineNumber) ? lineNumber : undefined,
			content: match[3] ?? "",
		});
	}

	return { entries, added, removed, hunks: Math.max(hunks, added + removed > 0 ? 1 : 0) };
}

function collectLines(entries: DiffEntry[], start: number, kind: DiffLineKind): { lines: DiffLine[]; next: number } {
	const lines: DiffLine[] = [];
	let index = start;
	while (index < entries.length) {
		const entry = entries[index];
		if (!entry || entry.kind !== kind) break;
		lines.push(entry);
		index++;
	}
	return { lines, next: index };
}

function buildSplitRows(entries: DiffEntry[]): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index];
		if (!entry) break;
		if (entry.kind === "meta") {
			rows.push({ meta: entry.content });
			index++;
			continue;
		}
		if (entry.kind === "context") {
			rows.push({ left: entry, right: entry });
			index++;
			continue;
		}
		if (entry.kind === "remove") {
			const removed = collectLines(entries, index, "remove");
			const added = collectLines(entries, removed.next, "add");
			const pairCount = Math.max(removed.lines.length, added.lines.length);
			for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
				rows.push({ left: removed.lines[pairIndex], right: added.lines[pairIndex] });
			}
			index = added.next;
			continue;
		}
		rows.push({ right: entry });
		index++;
	}
	return rows;
}

function lineNumberWidth(entries: DiffEntry[]): number {
	let width = 2;
	for (const entry of entries) {
		if (entry.kind !== "meta" && entry.lineNumber !== undefined) {
			width = Math.max(width, String(entry.lineNumber).length);
		}
	}
	return width;
}

function resolveLanguage(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return getLanguageFromPath(path.replace(/^@/, ""));
	} catch {
		return undefined;
	}
}

function createLineHighlighter(language: string | undefined): {
	highlight(line: DiffLine): HighlightedDiffLine;
	clear(): void;
} {
	let highlightedLines = new WeakMap<DiffLine, HighlightedDiffLine>();
	return {
		highlight(line: DiffLine): HighlightedDiffLine {
			const cached = highlightedLines.get(line);
			if (cached !== undefined) return cached;
			const normalized = line.content.replace(/\t/g, "    ");
			let text = normalized;
			if (language && normalized) {
				try {
					text = highlightCode(normalized, language)[0] ?? normalized;
				} catch {
					text = normalized;
				}
			}
			const highlighted = { text, width: visibleWidth(normalized) };
			highlightedLines.set(line, highlighted);
			return highlighted;
		},
		clear(): void {
			highlightedLines = new WeakMap<DiffLine, HighlightedDiffLine>();
		},
	};
}

function wrapHighlightedLine(line: HighlightedDiffLine, width: number): HighlightedDiffLine[] {
	if (line.width <= width) return [line];
	return wrapTextWithAnsi(line.text, width).map((text) => ({ text, width: visibleWidth(text) }));
}

function lineColor(kind: DiffLineKind): "toolDiffAdded" | "toolDiffRemoved" | "dim" {
	if (kind === "add") return "toolDiffAdded";
	if (kind === "remove") return "toolDiffRemoved";
	return "dim";
}

function markerFor(kind: DiffLineKind): string {
	return kind === "context" ? " " : "▌";
}

function renderUnifiedLine(
	line: DiffLine,
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedDiffLine,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string[] {
	const plainNumber = line.lineNumber === undefined ? " ".repeat(numberWidth) : String(line.lineNumber).padStart(numberWidth, " ");
	const prefixWidth = 2 + numberWidth + 3;
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapHighlightedLine(highlightLine(line), contentWidth);
	const rows = wrapped.length > 0 ? wrapped : [{ text: "", width: 0 }];
	const color = lineColor(line.kind);

	return rows.map((content, index) => {
		const marker = index === 0 ? markerFor(line.kind) : " ";
		const number = index === 0 ? plainNumber : " ".repeat(numberWidth);
		const prefix = `${theme.fg(color, marker)} ${theme.fg(color, number)}${theme.fg("dim", " │ ")}`;
		const paddedContent = `${content.text}${" ".repeat(Math.max(0, contentWidth - content.width))}`;
		return applyChangeBackground(`${prefix}${paddedContent}`, line.kind, palette);
	});
}

function renderUnified(
	entries: DiffEntry[],
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedDiffLine,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string[] {
	const rows: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "meta") {
			rows.push(theme.fg("dim", truncateToWidth(`  ${entry.content}`, width, "")));
			continue;
		}
		rows.push(...renderUnifiedLine(entry, width, numberWidth, highlightLine, theme, palette));
	}
	return rows;
}

function renderSplitCell(
	line: DiffLine | undefined,
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedDiffLine,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string[] {
	if (!line) return [" ".repeat(width)];
	const plainNumber = line.lineNumber === undefined ? " ".repeat(numberWidth) : String(line.lineNumber).padStart(numberWidth, " ");
	const prefixWidth = 2 + numberWidth + 3;
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapHighlightedLine(highlightLine(line), contentWidth);
	const rows = wrapped.length > 0 ? wrapped : [{ text: "", width: 0 }];
	const color = lineColor(line.kind);

	return rows.map((content, index) => {
		const marker = index === 0 ? markerFor(line.kind) : " ";
		const number = index === 0 ? plainNumber : " ".repeat(numberWidth);
		const prefix = `${theme.fg(color, marker)} ${theme.fg(color, number)}${theme.fg("dim", " │ ")}`;
		const paddedContent = `${content.text}${" ".repeat(Math.max(0, contentWidth - content.width))}`;
		return applyChangeBackground(`${prefix}${paddedContent}`, line.kind, palette);
	});
}

function renderSplit(
	rowsToRender: SplitDiffRow[],
	width: number,
	numberWidth: number,
	highlightLine: (line: DiffLine) => HighlightedDiffLine,
	theme: HleditRenderTheme,
	palette: DiffBackgroundPalette | undefined,
): string[] {
	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const leftWidth = Math.floor((width - separatorWidth) / 2);
	const rightWidth = width - separatorWidth - leftWidth;
	const separator = theme.fg("dim", SPLIT_SEPARATOR);
	const rows: string[] = [];

	const oldLabel = fitToWidth(theme.fg("muted", theme.bold("old")), leftWidth);
	const newLabel = fitToWidth(theme.fg("muted", theme.bold("new")), rightWidth);
	rows.push(`${oldLabel}${separator}${newLabel}`);
	rows.push(theme.fg("dim", "─".repeat(width)));

	for (const row of rowsToRender) {
		if (row.meta !== undefined) {
			rows.push(theme.fg("dim", truncateToWidth(`  ${row.meta}`, width, "")));
			continue;
		}
		const left = renderSplitCell(row.left, leftWidth, numberWidth, highlightLine, theme, palette);
		const right = renderSplitCell(row.right, rightWidth, numberWidth, highlightLine, theme, palette);
		const rowCount = Math.max(left.length, right.length);
		for (let index = 0; index < rowCount; index++) {
			rows.push(`${left[index] ?? " ".repeat(leftWidth)}${separator}${right[index] ?? " ".repeat(rightWidth)}`);
		}
	}
	return rows;
}

function diffSummary(parsed: ParsedDiff, theme: HleditRenderTheme, mode?: "split" | "unified"): string {
	const pieces = [
		theme.fg("toolOutput", `↳ ${theme.bold("diff")}`),
		theme.fg("toolDiffAdded", `+${parsed.added}`),
		theme.fg("toolDiffRemoved", `-${parsed.removed}`),
		theme.fg("muted", `• ${parsed.hunks} ${parsed.hunks === 1 ? "hunk" : "hunks"}`),
	];
	if (mode) pieces.push(theme.fg("dim", `• ${mode}`));
	return pieces.join(" ");
}

function applyLineLimit(lines: string[], expanded: boolean, width: number, theme: HleditRenderTheme): string[] {
	const limit = expanded ? MAX_EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES;
	if (lines.length <= limit) return lines;
	const remaining = lines.length - limit;
	const hint = expanded
		? `… ${remaining} more diff lines`
		: `… ${remaining} more diff lines • ${expandHint()}`;
	return [...lines.slice(0, limit), "", truncateToWidth(theme.fg(expanded ? "warning" : "muted", hint), width, "")];
}

export function renderStandaloneDiff(
	diff: string,
	path: string | undefined,
	expanded: boolean,
	theme: HleditRenderTheme,
): HleditRenderComponent | undefined {
	if (!diff.trim()) return undefined;
	const parsed = parseGeneratedDiff(diff);
	if (parsed.entries.length === 0) return undefined;
	const lineHighlighter = createLineHighlighter(resolveLanguage(path));
	const splitRows = buildSplitRows(parsed.entries);
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
			if (safeWidth < 24) return storeRenderedLines(safeWidth, [truncateToWidth(diffSummary(parsed, theme), safeWidth, "")]);

			const mode = safeWidth >= SPLIT_MIN_WIDTH ? "split" : "unified";
			const body = mode === "split"
				? renderSplit(splitRows, safeWidth, numberWidth, lineHighlighter.highlight, theme, currentPalette())
				: renderUnified(parsed.entries, safeWidth, numberWidth, lineHighlighter.highlight, theme, currentPalette());
			const frame = theme.fg("dim", "─".repeat(safeWidth));
			return storeRenderedLines(safeWidth, [
				truncateToWidth(diffSummary(parsed, theme, mode), safeWidth, ""),
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
			lineHighlighter.clear();
		},
	};
}
