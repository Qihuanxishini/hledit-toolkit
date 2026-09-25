import { keyHint, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, sliceByColumn, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changePreviewDiffText, parseChangePreview } from "./change-preview.ts";
import {
	renderStandaloneDiff,
	type DiffSummaryStats,
	type HleditRenderComponent,
	type HleditRenderTheme,
} from "./diff-renderer.ts";
import { fileChangeLineRanges } from "./file-changes.ts";
import { DEFAULT_READ_LIMIT, normalizeToolPath } from "./read-args.ts";
import { parseUpdatedAnchorSpans } from "./post-edit-context.ts";
import { createHighlightedTextCache, escapeTerminalControls } from "./syntax-highlight.ts";
import type { HleditToolKind, TextResult } from "./result.ts";

export type RenderComponent = HleditRenderComponent;
export type RenderTheme = HleditRenderTheme;
type RenderResult = AgentToolResult<TextResult["details"]>;

export type ToolRenderContextLike = {
	args?: unknown;
	isError?: boolean;
	cwd?: string;
};

type AnchoredSourceLine = {
	anchor: string;
	lineNumber: number;
	content: string;
};

const COLLAPSED_ANCHOR_ROWS = 12;

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "展开详情");
	} catch {
		return "按 Ctrl+O 展开";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatLineRange(first: number | undefined, last: number | undefined): string | undefined {
	if (first === undefined && last === undefined) return undefined;
	const start = first ?? last;
	const end = last ?? first;
	return start === end ? String(start) : `${start}-${end}`;
}

// 最终组件持有宽度缓存，避免子组件命中后仍重复扫描整段 ANSI 输出。
// [喵喵喵]: 消除历史工具结果在同宽重绘时的线性重复布局 (2026-07-15)
function component(renderLines: (width: number) => string[], onInvalidate?: () => void): RenderComponent {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number) {
			const safeWidth = Math.max(0, Math.floor(width));
			if (cachedLines && cachedWidth === safeWidth) return cachedLines;
			const lines = renderLines(safeWidth);
			cachedWidth = safeWidth;
			cachedLines = lines;
			return lines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
			onInvalidate?.();
		},
	};
}

function getText(result: RenderResult): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

function pathFromContext(context: ToolRenderContextLike): string | undefined {
	const args = isRecord(context.args) ? context.args : {};
	return typeof args.path === "string" ? normalizeToolPath(args.path) : undefined;
}

function linkedToolPath(styledPath: string, path: string, context: ToolRenderContextLike): string {
	if (typeof context.cwd !== "string") return styledPath;
	try {
		if (!getCapabilities().hyperlinks) return styledPath;
		return hyperlink(styledPath, pathToFileURL(resolve(context.cwd, path)).href);
	} catch {
		return styledPath;
	}
}

function createAnchoredSourceRowsComponent(
	lines: AnchoredSourceLine[],
	path: string | undefined,
	theme: RenderTheme,
	maxRows = Number.POSITIVE_INFINITY,
): RenderComponent {
	const anchorWidth = lines.reduce((width, line) => Math.max(width, line.anchor.length), 0);
	const prefixWidth = anchorWidth + 4;
	const highlighter = createHighlightedTextCache(path);

	return component((width) => {
		if (lines.length === 0 || width === 0) return [];
		const contentWidth = Math.max(1, width - prefixWidth);
		const rendered: string[] = [];

		for (const line of lines) {
			const remainingRows = maxRows - rendered.length;
			if (remainingRows <= 0) break;
			const highlighted = highlighter.highlight(line);
			// [喵喵喵]: 按屏幕行预算裁剪显示副本，再换行；隐藏尾部不参与布局，原始源码与 proof 保持完整。
			const visibleBudget = contentWidth * remainingRows;
			const displayText = highlighted.width > visibleBudget
				? `${sliceByColumn(highlighted.text, 0, visibleBudget, true)}\x1b[0m`
				: highlighted.text;
			const sourceRows = highlighted.width <= contentWidth
				? [displayText]
				: wrapTextWithAnsi(displayText, contentWidth);
			const wrapped = sourceRows.length > 0 ? sourceRows : [""];
			for (const [index, source] of wrapped.slice(0, remainingRows).entries()) {
				const anchor = index === 0 ? line.anchor.padStart(anchorWidth, " ") : " ".repeat(anchorWidth);
				const prefix = `${theme.fg(index === 0 ? "accent" : "dim", anchor)}${theme.fg("dim", " │ ")}`;
				const renderedLine = `${prefix}${source}`;
				rendered.push(width > prefixWidth ? renderedLine : truncateToWidth(renderedLine, width, ""));
			}
		}
		return rendered;
	}, () => {
		highlighter.clear();
	});
}

function renderFailure(result: RenderResult, expanded: boolean, theme: RenderTheme): RenderComponent {
	const rawLines = getText(result).split(/\r?\n/).filter(Boolean);
	const first = rawLines[0] ?? "Tool execution failed.";
	const structuredMessage = result.details.error?.message;
	const reasonLine = rawLines.find((line) => line.startsWith("Reason:") || line.startsWith("Message:"));
	const fallbackReason = reasonLine?.replace(/^(?:Reason:|Message:\s*)/, "") ?? rawLines[1];
	const summary = escapeTerminalControls(structuredMessage ?? (fallbackReason ? `${first} ${fallbackReason}` : first));
	return component((width) => {
		if (!expanded) return [truncateToWidth(theme.fg("error", `× ${summary}`), width, "")];
		return rawLines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? "error" : "muted", `${index === 0 ? "×" : " "} ${escapeTerminalControls(line)}`), width, ""));
	});
}

export function renderHleditCall(
	kind: HleditToolKind,
	args: unknown,
	theme: RenderTheme,
	context: ToolRenderContextLike = {},
): RenderComponent {
	const input = isRecord(args) ? args : {};
	const path = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
	const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : undefined;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
	const pattern = kind === "search_anchors" && typeof input.pattern === "string" ? input.pattern : undefined;
	const patternLiteral = kind === "search_anchors" && input.literal === true;
	const patternIgnoreCase = kind === "search_anchors" && input.ignore_case === true;
	const range = kind === "read_anchors"
		// 未提供 limit 时插件实际按 DEFAULT_READ_LIMIT 发起 CLI 请求，标题不得显示 2000。
		? formatLineRange(offset ?? 1, (offset ?? 1) + (limit ?? DEFAULT_READ_LIMIT) - 1)
		: kind === "apply_file_changes" ? fileChangeLineRanges(input.changes) : undefined;
	const operationCount = kind === "apply_file_changes" && Array.isArray(input.changes) ? input.changes.length : undefined;
	const searchContext = kind === "search_anchors" && typeof input.context === "number" && Number.isInteger(input.context) && input.context > 0 ? input.context : undefined;
	const titleText = kind === "read_anchors" ? "read for edit" : kind === "search_anchors" ? "search anchors" : "apply changes";
	const title = theme.fg("toolTitle", theme.bold(titleText));
	const styledPath = path ? linkedToolPath(theme.fg("accent", escapeTerminalControls(path)), path, context) : undefined;
	const target = styledPath ? styledPath + (range ? theme.fg("warning", `:${range}`) : "") : theme.fg("dim", "…");
	let suffix = "";
	if (operationCount !== undefined) {
		suffix = theme.fg("muted", `（${operationCount} 项操作）`);
	} else if (pattern !== undefined) {
		const options = [
			patternLiteral ? "字面匹配" : "正则匹配",
			patternIgnoreCase ? "忽略大小写" : "",
			searchContext === undefined ? "" : `上下文 ±${searchContext} 行`,
			offset === undefined || offset === 1 ? "" : `从第 ${offset} 行开始`,
			limit === undefined ? "" : `最多 ${limit} 行`,
		].filter(Boolean);
		suffix = theme.fg("muted", ` ${patternLiteral ? "包含" : "匹配"} ${escapeTerminalControls(JSON.stringify(pattern))}${options.length === 0 ? "" : `（${options.join("；")}）`}`);
	}
	return component((width) => [truncateToWidth(`${title} ${target}${suffix}`, width, "")]);
}

export function renderReadAnchorsResult(
	result: RenderResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	if (options.isPartial) {
		return component((width) => [truncateToWidth(theme.fg("warning", "正在读取锚点…"), width, "")]);
	}
	if (result.details.disposition !== "succeeded" || context.isError) {
		return renderFailure(result, options.expanded, theme);
	}

	const read = result.details.read;
	if (!read) {
		return component((width) => [truncateToWidth(theme.fg("warning", "缺少结构化读取结果；请重新读取目标文件"), width, "")]);
	}
	const path = pathFromContext(context);
	const visible = options.expanded ? read.lines : read.lines.slice(0, COLLAPSED_ANCHOR_ROWS);
	const sourceRowsComponent = createAnchoredSourceRowsComponent(
		visible.map((line) => ({ anchor: line.anchor, lineNumber: line.line, content: line.text })), path, theme,
		options.expanded ? Number.POSITIVE_INFINITY : COLLAPSED_ANCHOR_ROWS + 1,
	);
	return component((width) => {
		if (width === 0) return [];

		const { firstLine, lastLine, totalLines } = read.actual;
		const range = formatLineRange(firstLine, lastLine);
		const actualRange = range ? `第 ${range} 行 / 共 ${totalLines} 行` : `0 行 / 共 ${totalLines} 行`;
		const header = [
			theme.fg("toolOutput", read.lines.length === 0
				? "↳ 未找到锚点"
				: `↳ ${theme.bold(String(read.lines.length))} 行锚点`),
			theme.fg("muted", `• ${actualRange}`),
			read.nextOffset !== undefined ? theme.fg("warning", `• 下一页从第 ${read.nextOffset} 行开始`) : "",
			read.textTruncated ? theme.fg("warning", "• 行内容已截断") : "",
			read.eof ? theme.fg("muted", "• 已到文件末尾") : "",
		].filter(Boolean).join(" ");
		if (read.lines.length === 0 || width < 18) return [truncateToWidth(header, width, "")];

		const sourceRows = sourceRowsComponent.render(width);
		const wrappedRowsHidden = !options.expanded && sourceRows.length > COLLAPSED_ANCHOR_ROWS;
		const output = [
			truncateToWidth(header, width, ""),
			theme.fg("dim", "─".repeat(width)),
			...(wrappedRowsHidden ? sourceRows.slice(0, COLLAPSED_ANCHOR_ROWS) : sourceRows),
		];
		if (wrappedRowsHidden) {
			output.push("", truncateToWidth(theme.fg("muted", `… 预览已折叠 • ${expandHint()}`), width, ""));
		} else if (!options.expanded && read.lines.length > visible.length) {
			output.push("", truncateToWidth(theme.fg("muted", `… 还有 ${read.lines.length - visible.length} 行锚点 • ${expandHint()}`), width, ""));
		}
		if (read.nextOffset !== undefined) {
			output.push(truncateToWidth(theme.fg("warning", `继续读取请使用 offset ${read.nextOffset}`), width, ""));
		}
		if (read.textTruncated) {
			output.push(truncateToWidth(theme.fg("warning", "源文件行内容已截断；调整 offset 无法恢复该行被省略的文本"), width, ""));
		}
		return output;
	}, () => sourceRowsComponent.invalidate());
}

function successfulChangeSummary(result: RenderResult, theme: RenderTheme): string {
	if (result.details.contentChanged === false) {
		const edits = typeof result.details.editsApplied === "number" ? result.details.editsApplied : undefined;
		const checked = edits === undefined ? "无需修改" : `无需修改 • 已检查 ${edits} 项操作`;
		return `${theme.fg("success", "✓")} ${theme.fg("toolOutput", checked)}`;
	}
	const edits = typeof result.details.editsApplied === "number" ? result.details.editsApplied : undefined;
	const first = typeof result.details.firstChangedLine === "number" ? result.details.firstChangedLine : undefined;
	const last = typeof result.details.lastChangedLine === "number" ? result.details.lastChangedLine : undefined;
	const added = typeof result.details.linesAdded === "number" ? result.details.linesAdded : undefined;
	const deleted = typeof result.details.linesDeleted === "number" ? result.details.linesDeleted : undefined;
	const pieces = [
		theme.fg("success", "✓"),
		theme.fg("toolOutput", edits === undefined ? "修改已应用" : `已应用 ${edits} 项修改`),
	];
	const range = formatLineRange(first, last);
	if (range) pieces.push(theme.fg("muted", `• 第 ${range} 行`));
	if (added !== undefined || deleted !== undefined) {
		pieces.push(theme.fg("toolDiffAdded", `+${added ?? 0}`), theme.fg("toolDiffRemoved", `-${deleted ?? 0}`));
	}
	return pieces.join(" ");
}

export function renderFileChangesResult(
	result: RenderResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	if (options.isPartial) {
		return component((width) => [truncateToWidth(theme.fg("warning", "正在应用锚点修改…"), width, "")]);
	}
	if (result.details.disposition !== "succeeded" || context.isError) {
		return renderFailure(result, options.expanded, theme);
	}

	const path = pathFromContext(context);
	const diffWarning = typeof result.details.previewError === "string" ? result.details.previewError : undefined;
	const changePreview = parseChangePreview(result.details.changePreview);
	const diff = changePreview ? changePreviewDiffText(changePreview) : "";
	const writeWarnings = Array.isArray(result.details.warnings)
		? result.details.warnings.filter((warning): warning is string => typeof warning === "string")
		: [];
	const added = typeof result.details.linesAdded === "number" ? result.details.linesAdded : undefined;
	const deleted = typeof result.details.linesDeleted === "number" ? result.details.linesDeleted : undefined;
	const hasPreviewChange = changePreview?.lines.some((line) => line.kind === "add" || line.kind === "remove") === true;
	const summaryStats: DiffSummaryStats | undefined = changePreview && (changePreview.truncated || !hasPreviewChange) && added !== undefined && deleted !== undefined
		? { added, removed: deleted, completeHunks: false }
		: undefined;
	const diffComponent = renderStandaloneDiff(diff, path, options.expanded, theme, summaryStats, changePreview?.lines);
	const changeBodyComponent = diffComponent ?? component((width) => {
		if (width === 0) return [];
		return [truncateToWidth(successfulChangeSummary(result, theme), width, "")];
	});

	const updatedAnchorSpans = parseUpdatedAnchorSpans(result.details.updatedAnchorSpans) ?? [];
	const spanRanges = updatedAnchorSpans.map((span) => {
		const last = span.offset + span.desiredLimit - 1;
		return last === span.offset ? `第 ${span.offset} 行` : `第 ${span.offset}-${last} 行`;
	});
	const updatedAnchorHeading = spanRanges.length === 0
		? "更新后的锚点（产出区间）"
		: `更新后的锚点（产出区间：${spanRanges.join("、")}）`;
	const updatedAnchors = options.expanded
		? updatedAnchorSpans.flatMap((span) => span.lines.map((line) => ({ anchor: line.anchor, lineNumber: line.line, content: line.text })))
		: [];
	const updatedAnchorRows = createAnchoredSourceRowsComponent(updatedAnchors, path, theme);
	const anchorSpanTruncated = updatedAnchorSpans.some((span) => span.truncated || span.lines.some((line) => line.textTruncated));
	if (updatedAnchors.length === 0 && !diffWarning && writeWarnings.length === 0) return changeBodyComponent;

	return component((width) => {
		if (width === 0) return [];
		const lines = [...changeBodyComponent.render(width)];
		if (updatedAnchors.length > 0) {
			lines.push(
				"",
				truncateToWidth(theme.fg("muted", theme.bold(updatedAnchorHeading)), width, ""),
				...updatedAnchorRows.render(width),
			);
			if (anchorSpanTruncated) {
				lines.push(truncateToWidth(theme.fg("warning", "更新后的锚点 span 或行内容已截断；编辑前请重新读取所需范围"), width, ""));
			}
		}
		if (diffWarning) {
			lines.push(truncateToWidth(theme.fg("warning", `差异警告：${escapeTerminalControls(diffWarning)}`), width, ""));
		}
		for (const warning of writeWarnings) {
			lines.push(truncateToWidth(theme.fg("warning", `写入警告：${escapeTerminalControls(warning)}`), width, ""));
		}
		return lines;
	}, () => {
		changeBodyComponent.invalidate();
		updatedAnchorRows.invalidate();
	});
}
