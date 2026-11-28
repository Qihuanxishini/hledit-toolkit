import { keyHint, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseChangePreview, type VerifiedChangePreview } from "./change-preview.ts";
import {
	renderStandaloneDiff,
	type DiffSummaryStats,
	type HleditRenderComponent,
	type HleditRenderTheme,
} from "./diff-renderer.ts";
import { fileChangeLineRanges } from "./file-changes.ts";
import { normalizeToolPath } from "./read-args.ts";
import { formatReadContinuation } from "./read-result.ts";
import { parseUpdatedAnchorSpans, type BatchAnchorContext } from "./post-edit-context.ts";
import { createHighlightedTextCache, escapeTerminalControls } from "./syntax-highlight.ts";
import type { HleditErrorMetadata, HleditReadLine, HleditToolKind, TextResult } from "./result.ts";

export type RenderComponent = HleditRenderComponent;
export type RenderTheme = HleditRenderTheme;
type RenderResult = AgentToolResult<TextResult["details"]>;

type ToolRenderContextLike = {
	args?: unknown;
	isError?: boolean;
	cwd?: string;
	lastComponent?: unknown;
	isPartial?: boolean;
	keyText?: (keybinding: Parameters<typeof keyHint>[0]) => string;
};

const renderComponentKeys = new WeakMap<object, readonly unknown[]>();

function reuseComponent(
	lastComponent: unknown,
	key: readonly unknown[],
	create: () => RenderComponent,
): RenderComponent {
	if (isRecord(lastComponent)) {
		const cached = renderComponentKeys.get(lastComponent);
		if (cached && cached.length === key.length && cached.every((value, index) => Object.is(value, key[index]))) {
			return lastComponent as RenderComponent;
		}
	}
	const created = create();
	renderComponentKeys.set(created, key);
	return created;
}

type AnchoredSourceLine = {
	anchor: string;
	content: string;
};

const COLLAPSED_SEARCH_ROWS = 12;
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
	if (typeof args.path !== "string") return undefined;
	try {
		return normalizeToolPath(args.path);
	} catch {
		// [喵喵喵]: 执行失败的路径仍须可展示，不能在渲染错误时再次抛出解析异常。
		return args.path;
	}
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

function readRequestRange(args: unknown): string | undefined {
	const input = isRecord(args) ? args : {};
	if (Array.isArray(input.windows)) {
		return input.windows.flatMap((window) => isRecord(window) && typeof window.offset === "number" && typeof window.limit === "number"
			? [formatLineRange(window.offset, window.offset + window.limit - 1)] : []).join(",");
	}
	const offset = typeof input.offset === "number" ? input.offset : undefined;
	const limit = typeof input.limit === "number" ? input.limit : undefined;
	return offset === undefined && limit === undefined ? undefined
		: formatLineRange(offset ?? 1, limit === undefined ? undefined : (offset ?? 1) + limit - 1);
}

function displayReadPath(path: string, cwd: string | undefined): string {
	let display = path;
	if (isAbsolute(path)) {
		for (const [base, prefix] of [[cwd, ""], [homedir(), "~/"]] as const) {
			if (!base) continue;
			const local = relative(base, path);
			if (local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) && prefix.length + local.length < display.length) {
				display = prefix + local;
			}
		}
	}
	return escapeTerminalControls(display.split(sep).join("/"));
}

function fitReadPath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const parts = path.split("/");
	for (let index = 1; index < parts.length; index++) {
		const tail = `…/${parts.slice(index).join("/")}`;
		if (visibleWidth(tail) <= width) return tail;
	}
	return truncateToWidth(parts.at(-1) || path, width, "…");
}

export function renderReadHeading(
	path: string | undefined,
	range: string | undefined,
	metadata: string[],
	warnings: string[],
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	const display = path ? displayReadPath(path, context.cwd) : "…";
	const filenameWidth = visibleWidth(display.split("/").at(-1) || display);
	return component((width) => {
		if (width === 0) return [];
		const title = `${theme.fg("toolTitle", theme.bold("read"))} `;
		const titleWidth = visibleWidth(title);
		const pathMinimum = Math.min(filenameWidth, Math.max(1, width - titleWidth));
		const rangeText = range ? truncateToWidth(`:${range}`, Math.max(0, width - titleWidth - pathMinimum), "…") : "";
		const minimum = titleWidth + pathMinimum + visibleWidth(rangeText);
		const warningText = warnings.join(" · ");
		const inlineWarning = warningText && minimum + visibleWidth(` · ${warningText}`) <= width ? ` · ${warningText}` : "";
		const optional = [...metadata];
		while (optional.length && minimum + visibleWidth(inlineWarning + ` · ${optional.join(" · ")}`) > width) optional.pop();
		const suffix = optional.length ? ` · ${optional.join(" · ")}` : "";
		const pathWidth = Math.max(0, width - titleWidth - visibleWidth(rangeText + inlineWarning + suffix));
		const pathText = theme.fg("accent", fitReadPath(display, pathWidth));
		const target = path ? linkedToolPath(pathText, path, context) : pathText;
		const line = title + target + theme.fg("muted", rangeText + suffix) + theme.fg("warning", inlineWarning);
		return [
			truncateToWidth(line, width, "…"),
			...(!inlineWarning && warningText ? wrapTextWithAnsi(theme.fg("warning", warningText), width) : []),
		];
	});
}

export function renderReadCall(args: unknown, theme: RenderTheme, context: ToolRenderContextLike = {}): RenderComponent {
	return reuseComponent(context.lastComponent, ["read-call", args, theme, context.cwd, context.isPartial], () => {
		// [喵喵喵]: 完成后的标题由结果槽合并输出；返回空组件不占行，也不触发宿主 fallback。
		if (context.isPartial === false) return component(() => []);
		return renderReadHeading(pathFromContext({ args }), readRequestRange(args), [], context.isPartial ? ["读取中…"] : [], theme, context);
	});
}

function renderCompactReadResult(
	result: RenderResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	if (options.isPartial) return component(() => []);
	const { read, windowsRead } = result.details;
	const path = pathFromContext(context) ?? result.details.path ?? read?.path ?? windowsRead?.path;
	if (result.details.disposition !== "succeeded" || context.isError) {
		const heading = renderReadHeading(path, readRequestRange(context.args), [], [], theme, context);
		const failure = renderFailure("read", result, options.expanded, theme, true);
		return component((width) => [...heading.render(width), ...failure.render(width)], () => {
			heading.invalidate();
			failure.invalidate();
		});
	}
	if (!read && !windowsRead) {
		return renderReadHeading(path, undefined, [], ["缺少结构化读取结果；请重新读取目标文件"], theme, context);
	}
	const lines = windowsRead ? windowsRead.windows.flatMap((window) => window.lines) : read!.lines;
	const range = windowsRead
		? windowsRead.windows.flatMap((window) => window.lines.length ? [formatLineRange(window.lines[0]!.line, window.lines.at(-1)!.line)] : []).join(",")
		: formatLineRange(read!.actual.firstLine, read!.actual.lastLine);
	const totalLines = windowsRead?.totalLines ?? read!.actual.totalLines;
	const continuation = read ? formatReadContinuation(read) : undefined;
	const textTruncated = read?.textTruncated ?? lines.some((line) => line.textTruncated);
	const warnings = [
		continuation !== undefined ? `未读完 · 续读 ${read!.nextOffset}` : "",
		textTruncated ? "内容截断" : "",
	].filter(Boolean);
	const hint = `${context.keyText?.("app.tools.expand") ?? ""} 展开`.trim();
	const heading = renderReadHeading(path, range, [
		totalLines === 0 ? "空文件" : `${lines.length} 行`,
		!options.expanded && lines.length ? hint : "",
	].filter(Boolean), warnings, theme, context);
	if (!options.expanded) return heading;

	const requestedRange = windowsRead
		? windowsRead.requested.map((window) => formatLineRange(window.offset, window.offset + window.limit - 1)).join(",")
		: formatLineRange(read!.requested.offset, read!.requested.offset + read!.requested.limit - 1);
	const detail = [
		`共 ${totalLines} 行`,
		windowsRead ? `${windowsRead.requested.length} 个窗口` : "",
		requestedRange !== range ? `请求 ${requestedRange}` : "",
		read?.eof ? "已到文件末尾" : "",
	].filter(Boolean).join(" · ");
	const source = createAnchoredRowsComponent(lines, path, theme);
	return component((width) => width === 0 ? [] : [
		...heading.render(width),
		...wrapTextWithAnsi(theme.fg("muted", detail), width),
		...source.render(width),
		...(continuation !== undefined ? wrapTextWithAnsi(theme.fg("warning", `继续读取请使用 ${continuation}`), width) : []),
		...(textTruncated ? wrapTextWithAnsi(theme.fg("warning", "源文件行内容已截断；调整读取范围无法恢复该行被省略的文本"), width) : []),
	], () => {
		heading.invalidate();
		source.invalidate();
	});
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

function createAnchoredRowsComponent(
	lines: HleditReadLine[],
	path: string | undefined,
	theme: RenderTheme,
	maxRows?: number,
): RenderComponent {
	return createAnchoredSourceRowsComponent(
		lines.map((line) => ({ anchor: line.anchor, content: line.text })),
		path,
		theme,
		maxRows,
	);
}

function failureReason(error: HleditErrorMetadata | undefined): string | undefined {
	// [喵喵喵]: I/O 的通用说明不足以区分缺失文件、权限拒绝等原因；仅显示层优先采用原始诊断。
	return (error?.code === "io" ? error.rawMessage?.trim() : undefined) || error?.message?.trim() || undefined;
}

function renderFailure(kind: "read" | "apply", result: RenderResult, expanded: boolean, theme: RenderTheme, wrapSummary = false): RenderComponent {
	const rawLines = getText(result).split(/\r?\n/).filter(Boolean);
	const first = rawLines[0] ?? "Tool execution failed.";
	const { disposition, error, recoveredReads, recoveryReadError, proofId } = result.details;
	// [喵喵喵]: 补读失败的直接原因在内层；通用 proof 说明保留在展开正文，不遮住读取故障。
	const recoveryReason = error?.code === "proof_recovery_read_failed" ? failureReason(recoveryReadError?.error) : undefined;
	const structuredMessage = recoveryReason ? `补读失败：${recoveryReason}` : failureReason(error);
	const reasonLine = rawLines.find((line) => line.startsWith("Reason:") || line.startsWith("Message:"));
	const fallbackReason = reasonLine?.replace(/^(?:Reason|Message):\s*/, "") ?? rawLines[1];
	const summary = escapeTerminalControls(structuredMessage ?? (fallbackReason ? `${first} ${fallbackReason}` : first));
	const reviewReady = kind === "apply" && disposition === "rejected" && proofId && (
		(error?.code === "insufficient_read_proof" && recoveredReads?.length) ||
		(error?.code === "stale" && error.currentAnchors && !error.currentAnchors.truncated && error.currentAnchors.lines.every((line) => !line.textTruncated))
	);
	// [喵喵喵]: 只有编辑工具能声明写入状态；成功回包与宿主错误标记冲突时，不推断“未写入”。
	const statusConflict = disposition === "succeeded";
	const writeOutcomeUnknown = kind === "apply" && disposition === "outcome_unknown";
	const label = statusConflict ? "! 状态不一致"
		: kind === "read" ? "× 读取失败"
		: writeOutcomeUnknown ? "! 结果未知"
		: reviewReady ? "↳ 待复核（未写入）"
		: disposition === "unavailable" ? "× 未执行" : "× 未写入";
	const color = statusConflict || writeOutcomeUnknown || reviewReady ? "warning" : "error";
	return component((width) => {
		if (width <= 0) return [];
		if (!expanded) {
			const text = theme.fg(color, `${label} · ${summary}`);
			return wrapSummary ? wrapTextWithAnsi(text, width) : [truncateToWidth(text, width, "…")];
		}
		return rawLines.flatMap((line, index) => wrapTextWithAnsi(
			theme.fg(index === 0 ? color : "muted", `${index === 0 ? label + " ·" : " "} ${escapeTerminalControls(line)}`), width,
		));
	});
}

export function renderHleditCall(
	kind: HleditToolKind,
	args: unknown,
	theme: RenderTheme,
	context: ToolRenderContextLike = {},
): RenderComponent {
	if (kind === "read_anchors") return renderReadCall(args, theme, context);
	return reuseComponent(context.lastComponent, ["call", kind, args, theme, context.cwd, Boolean(context.isError)], () => {
		const input = isRecord(args) ? args : {};
	const path = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
	const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : undefined;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
	const pattern = kind === "search_anchors" && typeof input.pattern === "string" ? input.pattern : undefined;
	const patternLiteral = kind === "search_anchors" && input.literal === true;
	const patternIgnoreCase = kind === "search_anchors" && input.ignore_case === true;
	// [喵喵喵]: 调用摘要只读当前公开 anchors；不把旧参数形状作为可继续使用的接口展示。
	const changes = kind === "apply_file_changes" && Array.isArray(input.changes) ? input.changes : undefined;
	const range = kind === "apply_file_changes" ? fileChangeLineRanges(changes) : undefined;
	const operationCount = changes?.length;
	const searchContext = kind === "search_anchors" && typeof input.context === "number" && Number.isInteger(input.context) && input.context > 0 ? input.context : undefined;
	const titleText = kind === "search_anchors" ? "search anchors" : "apply changes";
	const escapedPath = path ? escapeTerminalControls(path) : undefined;
	const suffixText = operationCount !== undefined
		? `（${operationCount} 项操作）`
		: pattern !== undefined
			? (() => {
				const options = [
					patternLiteral ? "字面匹配" : "正则匹配",
					patternIgnoreCase ? "忽略大小写" : "",
					searchContext === undefined ? "" : `上下文 ±${searchContext} 行`,
					offset === undefined || offset === 1 ? "" : `从第 ${offset} 行开始`,
					limit === undefined ? "" : `最多 ${limit} 行`,
				].filter(Boolean);
				return ` ${patternLiteral ? "包含" : "匹配"} ${escapeTerminalControls(JSON.stringify(pattern))}${options.length === 0 ? "" : `（${options.join("；")}）`}`;
			})()
			: undefined;
		return component((width) => {
			const title = theme.fg("toolTitle", theme.bold(titleText));
			const styledPath = path && escapedPath ? linkedToolPath(theme.fg("accent", escapedPath), path, context) : undefined;
			const target = styledPath ? styledPath + (range ? theme.fg("warning", `:${range}`) : "") : theme.fg("dim", "…");
			const suffix = suffixText === undefined ? "" : theme.fg("muted", suffixText);
			return [truncateToWidth(`${title} ${target}${suffix}`, width, "")];
		});
	});
}

export function renderReadAnchorsResult(
	result: RenderResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	return reuseComponent(
		context.lastComponent,
		["read", result.content, result.details, options.expanded, Boolean(options.isPartial), Boolean(context.isError), pathFromContext(context), readRequestRange(context.args), isRecord(context.args) && typeof context.args.pattern === "string", context.cwd, context.keyText, theme],
		() => {
			const search = result.details.read?.requested.pattern !== undefined || (isRecord(context.args) && typeof context.args.pattern === "string");
			if (!search) return renderCompactReadResult(result, options, theme, context);
			if (options.isPartial) {
		return component((width) => [truncateToWidth(theme.fg("warning", "正在读取锚点…"), width, "")]);
	}
	if (result.details.disposition !== "succeeded" || context.isError) {
		return renderFailure("read", result, options.expanded, theme);
	}

	const read = result.details.read;
	if (!read) {
		return component((width) => [truncateToWidth(theme.fg("warning", "缺少结构化读取结果；请重新读取目标文件"), width, "")]);
	}
	const continuation = formatReadContinuation(read);
	const preview = !options.expanded;
	const headerText = () => {
		const { firstLine, lastLine, totalLines } = read.actual;
		const range = formatLineRange(firstLine, lastLine);
		const actualRange = range ? `第 ${range} 行 / 共 ${totalLines} 行` : `0 行 / 共 ${totalLines} 行`;
		return [
			theme.fg("toolOutput", read.lines.length === 0
				? "↳ 未找到锚点"
				: `↳ ${theme.bold(String(read.lines.length))} 行锚点`),
			theme.fg("muted", `• ${actualRange}`),
			continuation !== undefined ? theme.fg("warning", `• 下一页从第 ${read.nextOffset} 行开始`) : "",
			read.textTruncated ? theme.fg("warning", "• 行内容已截断") : "",
			read.eof ? theme.fg("muted", "• 已到文件末尾") : "",
		].filter(Boolean).join(" ");
	};
	if (read.lines.length === 0) {
		return component((width) => width <= 0 ? [] : [truncateToWidth(headerText(), width, "")]);
	}
	const visibleLines = preview ? read.lines.slice(0, COLLAPSED_SEARCH_ROWS) : read.lines;
	// [喵喵喵]: 多渲染一个屏幕行检测换行溢出，不能用源码行数判断长行是否隐藏。
	const sourceRowsComponent = createAnchoredRowsComponent(
		visibleLines, pathFromContext(context), theme, preview ? COLLAPSED_SEARCH_ROWS + 1 : undefined,
	);
	return component((width) => {
		if (width === 0) return [];
		const header = headerText();
		if (width < 18) return [truncateToWidth(header, width, "")];

		const rows = sourceRowsComponent.render(width);
		const wrappedRowsHidden = preview && rows.length > COLLAPSED_SEARCH_ROWS;

		const output = [
			truncateToWidth(header, width, ""),
			theme.fg("dim", "─".repeat(width)),
			...(wrappedRowsHidden ? rows.slice(0, COLLAPSED_SEARCH_ROWS) : rows),
		];
		if (preview) {
			const hint = wrappedRowsHidden ? "预览已折叠"
				: read.lines.length > visibleLines.length ? `还有 ${read.lines.length - visibleLines.length} 行锚点` : undefined;
			if (hint) output.push("", truncateToWidth(theme.fg("muted", `… ${hint} • ${expandHint()}`), width, ""));
		}
		if (continuation !== undefined) {
			output.push(truncateToWidth(theme.fg("warning", `继续读取请使用 ${continuation}`), width, ""));
		}
		if (read.textTruncated) {
			output.push(truncateToWidth(theme.fg("warning", "源文件行内容已截断；调整读取范围无法恢复该行被省略的文本"), width, ""));
		}
		return output;
			}, () => sourceRowsComponent.invalidate());
		},
	);
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

type ApplyRenderDetails = {
	changePreview: VerifiedChangePreview | undefined;
	updatedAnchorSpans: BatchAnchorContext[];
};

// [喵喵喵]: 宿主每轮 updateDisplay 都会重建组件；结构解析是纯函数，按 details
// 对象身份缓存复用。updateResult 会传入新的 details 对象，缓存随之自然失效。
const applyParsedDetailsCache = new WeakMap<object, ApplyRenderDetails>();

function parseApplyRenderDetails(details: Record<string, unknown>): ApplyRenderDetails {
	const changePreview = parseChangePreview(details.changePreview);
	return {
		changePreview,
		updatedAnchorSpans: parseUpdatedAnchorSpans(details.updatedAnchorSpans) ?? [],
	};
}
export function renderFileChangesResult(
	result: RenderResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): RenderComponent {
	return reuseComponent(
		context.lastComponent,
		["apply", result.content, result.details, options.expanded, Boolean(options.isPartial), Boolean(context.isError), pathFromContext(context), theme],
		() => {
			if (options.isPartial) {
		return component((width) => [truncateToWidth(theme.fg("warning", "正在应用锚点修改…"), width, "")]);
	}
	if (result.details.disposition !== "succeeded" || context.isError) {
		return renderFailure("apply", result, options.expanded, theme);
	}

	const path = pathFromContext(context);
	const diffWarning = typeof result.details.previewError === "string" ? result.details.previewError : undefined;
	let parsedDetails = applyParsedDetailsCache.get(result.details);
	if (!parsedDetails) {
		parsedDetails = parseApplyRenderDetails(result.details);
		applyParsedDetailsCache.set(result.details, parsedDetails);
	}
	const { changePreview } = parsedDetails;
	const writeWarnings = Array.isArray(result.details.warnings)
		? result.details.warnings.filter((warning): warning is string => typeof warning === "string")
		: [];
	const added = typeof result.details.linesAdded === "number" ? result.details.linesAdded : undefined;
	const deleted = typeof result.details.linesDeleted === "number" ? result.details.linesDeleted : undefined;
	const hasPreviewChange = changePreview?.lines.some((line) => line.kind === "add" || line.kind === "remove") === true;
	const summaryStats: DiffSummaryStats | undefined = changePreview && (changePreview.truncated || !hasPreviewChange) && added !== undefined && deleted !== undefined
		? { added, removed: deleted, completeHunks: false }
		: undefined;
	const diffComponent = changePreview ? renderStandaloneDiff(changePreview, path, options.expanded, theme, summaryStats) : undefined;
	const changeBodyComponent = diffComponent ?? component((width) => {
		if (width === 0) return [];
		return [truncateToWidth(successfulChangeSummary(result, theme), width, "")];
	});

	const updatedAnchorSpans = parsedDetails.updatedAnchorSpans;
	const updatedAnchors = options.expanded
		? updatedAnchorSpans.flatMap((span) => span.lines.map((line) => ({ anchor: line.anchor, content: line.text })))
		: [];
	if (updatedAnchors.length === 0 && !diffWarning && writeWarnings.length === 0) return changeBodyComponent;
	const updatedAnchorRows = updatedAnchors.length > 0 ? createAnchoredSourceRowsComponent(updatedAnchors, path, theme) : undefined;
	const spanRanges = updatedAnchorSpans.map((span) => {
		const last = span.offset + span.desiredLimit - 1;
		return last === span.offset ? `第 ${span.offset} 行` : `第 ${span.offset}-${last} 行`;
	});
	const updatedAnchorHeading = spanRanges.length === 0
		? "更新后的锚点（产出区间）"
		: `更新后的锚点（产出区间：${spanRanges.join("、")}）`;
	const anchorSpanTruncated = updatedAnchorSpans.some((span) => span.truncated || span.lines.some((line) => line.textTruncated));
	return component((width) => {
		if (width === 0) return [];
		const lines = [...changeBodyComponent.render(width)];
		if (updatedAnchorRows) {
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
		updatedAnchorRows?.invalidate();
			});
		},
	);
}
