import { getLanguageFromPath, highlightCode, keyHint, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { changePreviewDiffText, parseChangePreview } from "./change-preview.ts";
import { renderStandaloneDiff, type DiffRenderComponent, type DiffRenderTheme, type DiffSummaryStats } from "./diff-renderer.ts";
import { DEFAULT_READ_LIMIT } from "./schema.ts";
import type { SnaplineApplyDetails, SnaplineReadDetails, TextToolResult } from "./tool-details.ts";

export type RenderComponent = DiffRenderComponent;
export type RenderTheme = DiffRenderTheme;
export type ToolRenderContextLike = {
	args?: unknown;
	isError?: boolean;
	cwd?: string;
};

type NumberedSourceLine = { lineNumber: number; content: string };
const NUMBERED_SOURCE_LINE = /^(\d+):([^\n]*)$/;
const COLLAPSED_SOURCE_LINES = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "展开详情");
	} catch {
		return "按 Ctrl+O 展开";
	}
}

function component(renderLines: (width: number) => string[], onInvalidate?: () => void): RenderComponent {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number) {
			const safeWidth = Math.max(0, Math.floor(width));
			if (cachedLines && cachedWidth === safeWidth) return cachedLines;
			cachedLines = renderLines(safeWidth);
			cachedWidth = safeWidth;
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
			onInvalidate?.();
		},
	};
}

function resultText(result: TextToolResult<unknown>): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function pathFromContext(context: ToolRenderContextLike): string | undefined {
	const args = isRecord(context.args) ? context.args : {};
	return typeof args.path === "string" ? args.path.replace(/^@/, "") : undefined;
}

function linkedPath(path: string, context: ToolRenderContextLike, theme: RenderTheme): string {
	const styled = theme.fg("accent", path);
	if (typeof context.cwd !== "string") return styled;
	try {
		return getCapabilities().hyperlinks ? hyperlink(styled, pathToFileURL(resolve(context.cwd, path)).href) : styled;
	} catch {
		return styled;
	}
}

function formatRange(start: number, end: number): string {
	return start === end ? String(start) : `${start}-${end}`;
}

function sourceLines(text: string): NumberedSourceLine[] {
	const lines: NumberedSourceLine[] = [];
	for (const rawLine of text.split("\n")) {
		const match = NUMBERED_SOURCE_LINE.exec(rawLine);
		if (match) {
			lines.push({ lineNumber: Number.parseInt(match[1]!, 10), content: (match[2] ?? "").replace(/\r/g, "␍") });
		}
	}
	return lines;
}

function sourceRows(lines: NumberedSourceLine[], path: string | undefined, theme: RenderTheme): RenderComponent {
	const numberWidth = lines.reduce((width, line) => Math.max(width, String(line.lineNumber).length), 1);
	const prefixWidth = numberWidth + 3;
	let language: string | undefined;
	try {
		language = path ? getLanguageFromPath(path) : undefined;
	} catch {
		language = undefined;
	}
	let highlighted = new WeakMap<NumberedSourceLine, { text: string; width: number }>();
	return component((width) => {
		if (width <= prefixWidth) return [];
		const contentWidth = width - prefixWidth;
		const output: string[] = [];
		for (const line of lines) {
			let cached = highlighted.get(line);
			if (!cached) {
				const normalized = line.content.replace(/\t/g, "    ");
				let text = normalized;
				if (language && normalized) {
					try { text = highlightCode(normalized, language)[0] ?? normalized; } catch { text = normalized; }
				}
				cached = { text, width: visibleWidth(normalized) };
				highlighted.set(line, cached);
			}
			const wrapped = cached.width <= contentWidth ? [cached.text] : wrapTextWithAnsi(cached.text, contentWidth);
			for (const [index, text] of wrapped.entries()) {
				const number = index === 0 ? String(line.lineNumber).padStart(numberWidth, " ") : " ".repeat(numberWidth);
				output.push(truncateToWidth(`${theme.fg(index === 0 ? "accent" : "dim", number)}${theme.fg("dim", " │ ")}${text}`, width, ""));
			}
		}
		return output;
	}, () => { highlighted = new WeakMap(); });
}

function failureComponent(
	result: TextToolResult<{ error?: { message: string } }>,
	expanded: boolean,
	theme: RenderTheme,
	tone: "error" | "warning" = "error",
): RenderComponent {
	const lines = resultText(result).split(/\r?\n/).filter(Boolean);
	const summary = result.details.error?.message ?? lines[0] ?? "Tool execution failed.";
	const marker = tone === "error" ? "×" : "!";
	return component((width) => expanded
		? lines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? tone : "muted", `${index === 0 ? marker : " "} ${line}`), width, ""))
		: [truncateToWidth(theme.fg(tone, `${marker} ${summary}`), width, "")],
	);
}

export function renderSnaplineCall(
	kind: "read" | "apply",
	args: unknown,
	theme: RenderTheme,
	context: ToolRenderContextLike = {},
): RenderComponent {
	const input = isRecord(args) ? args : {};
	const path = typeof input.path === "string" ? input.path.replace(/^@/, "") : undefined;
	const title = theme.fg("toolTitle", theme.bold(kind === "read" ? "snapshot read" : "snapshot apply"));
	let suffix = "";
	if (kind === "read") {
		const offset = typeof input.offset === "number" ? input.offset : 1;
		const limit = typeof input.limit === "number" ? input.limit : DEFAULT_READ_LIMIT;
		suffix = theme.fg("warning", `:${formatRange(offset, offset + limit - 1)}`);
	} else {
		let count = 0;
		for (const group of [input.replacements, input.deletions, input.insertions_before, input.insertions_after]) {
			if (Array.isArray(group)) count += group.length;
		}
		suffix = theme.fg("muted", ` (${count} changes)`);
	}
	const target = path ? `${linkedPath(path, context, theme)}${kind === "read" ? suffix : ""}` : theme.fg("dim", "…");
	return component((width) => [truncateToWidth(`${title} ${target}${kind === "apply" ? suffix : ""}`, width, "")]);
}

export function renderSnaplineReadResult(
	result: TextToolResult<SnaplineReadDetails>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	if (options.isPartial) return component((width) => [truncateToWidth(theme.fg("warning", "正在读取 snapshot…"), width, "")]);
	if (result.details.disposition !== "succeeded" || context.isError) return failureComponent(result, options.expanded, theme);
	const allLines = sourceLines(resultText(result));
	const visible = options.expanded ? allLines : allLines.slice(0, COLLAPSED_SOURCE_LINES);
	const rows = sourceRows(visible, pathFromContext(context), theme);
	return component((width) => {
		const range = allLines.length > 0 ? formatRange(allLines[0]!.lineNumber, allLines.at(-1)!.lineNumber) : "empty";
		const header = [
			theme.fg("toolOutput", `↳ ${theme.bold(String(allLines.length))} lines`),
			theme.fg("muted", `• ${range} / ${result.details.totalLines ?? "?"}`),
			result.details.snapshot ? theme.fg("accent", `• ${result.details.snapshot}`) : "",
			result.details.omittedRanges?.length ? theme.fg("warning", "• omitted context") : "",
		].filter(Boolean).join(" ");
		const output = [truncateToWidth(header, width, ""), ...(visible.length > 0 ? [theme.fg("dim", "─".repeat(width)), ...rows.render(width)] : [])];
		if (!options.expanded && allLines.length > visible.length) output.push(truncateToWidth(theme.fg("muted", `… ${allLines.length - visible.length} more lines • ${expandHint()}`), width, ""));
		return output;
	}, () => rows.invalidate());
}

export function renderSnaplineApplyResult(
	result: TextToolResult<SnaplineApplyDetails>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	if (options.isPartial) return component((width) => [truncateToWidth(theme.fg("warning", "正在应用 snapshot 变更…"), width, "")]);
	if (result.details.disposition !== "succeeded" || context.isError) {
		const tone = result.details.disposition === "needs_review" && !context.isError ? "warning" : "error";
		return failureComponent(result, options.expanded, theme, tone);
	}
	const preview = parseChangePreview(result.details.preview);
	const diff = preview ? changePreviewDiffText(preview) : "";
	const stats = result.details.stats;
	const summaryStats: DiffSummaryStats | undefined = stats
		? { added: stats.insertedLines, removed: stats.deletedLines, completeHunks: preview?.truncated !== true }
		: undefined;
	const renderedDiff = renderStandaloneDiff(diff, pathFromContext(context), options.expanded, theme, summaryStats);
	if (renderedDiff) return renderedDiff;
	return component((width) => [truncateToWidth(
		result.details.contentChanged === false
			? `${theme.fg("success", "✓")} ${theme.fg("toolOutput", "No byte changes needed")}`
			: `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Applied ${stats?.effectiveChanges ?? "?"} changes atomically`)}`,
		width,
		"",
	)]);
}
