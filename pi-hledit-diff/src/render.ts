import { getLanguageFromPath, highlightCode, keyHint, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderStandaloneDiff, type HleditRenderComponent, type HleditRenderTheme } from "./diff-renderer.ts";
import { fileChangeLineRanges } from "./file-changes.ts";
import { MAX_READ_LIMIT, normalizeToolPath } from "./read-args.ts";
import type { HleditReadMetadata, HleditToolKind, TextResult } from "./result.ts";

export type RenderComponent = HleditRenderComponent;
export type RenderTheme = HleditRenderTheme;

export type ToolRenderContextLike = {
    args?: unknown;
    isError?: boolean;
    cwd?: string;
    [key: string]: unknown;
};

type AnchoredSourceLine = {
    anchor: string;
    lineNumber: number;
    content: string;
};

type ParsedAnchoredOutput = {
    lines: AnchoredSourceLine[];
    notices: string[];
};

const ANCHORED_SOURCE_LINE = /^(\d+#[A-Za-z0-9]+):(.*)$/;
const COLLAPSED_ANCHOR_LINES = 12;

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

function getText(result: TextResult): string {
    const first = result.content[0];
    return typeof first?.text === "string" ? first.text : "";
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

function parseAnchoredOutput(text: string): ParsedAnchoredOutput {
    const lines: AnchoredSourceLine[] = [];
    const notices: string[] = [];
    for (const rawLine of text.replace(/\r/g, "").split("\n")) {
        const match = ANCHORED_SOURCE_LINE.exec(rawLine);
        if (match) {
            const anchor = match[1] ?? "";
            const content = match[2] ?? "";
            lines.push({ anchor, lineNumber: Number.parseInt(anchor, 10), content });
            if (content.includes("[line truncated]")) notices.push("one or more source lines were truncated");
        } else if (rawLine.startsWith("--")) {
            notices.push(rawLine);
        }
    }
    return { lines, notices };
}

function localizeLegacyNotice(notice: string): string {
    if (notice.includes("source text truncated") || notice.includes("line truncated")) return "历史工具结果中的源文件内容已截断。";
    if (notice.includes("truncated")) return "历史工具结果已截断。";
    const rangeContinuation = /showing lines (\d+)-(\d+) of (\d+); use offset (\d+) to continue/.exec(notice);
    if (rangeContinuation) return `历史工具结果已显示第 ${rangeContinuation[1]}-${rangeContinuation[2]} 行（文件共 ${rangeContinuation[3]} 行）；继续读取请使用 offset ${rangeContinuation[4]}。`;
    const rangeEOF = /showing lines (\d+)-(\d+) of (\d+); end of file/.exec(notice);
    if (rangeEOF) return `历史工具结果已显示第 ${rangeEOF[1]}-${rangeEOF[2]} 行（文件共 ${rangeEOF[3]} 行），并已到文件末尾。`;
    return "历史工具结果包含额外的分页提示；如需继续操作，请重新调用 hledit_read_anchors。";
}

type ReadRenderState = {
    lines: AnchoredSourceLine[];
    totalLines?: number;
    nextOffset?: number;
    textTruncated: boolean;
    eof: boolean;
    legacyNotices: string[];
};

function readRenderState(result: TextResult): ReadRenderState {
    const read = result.details.read as HleditReadMetadata | undefined;
    if (read) {
        return {
            lines: read.lines.map((line) => ({ anchor: line.anchor, lineNumber: line.line, content: line.text })),
            totalLines: read.actual.totalLines,
            ...(read.nextOffset !== undefined ? { nextOffset: read.nextOffset } : {}),
            textTruncated: read.textTruncated,
            eof: read.eof,
            legacyNotices: [],
        };
    }

    // 历史会话中的旧结果没有结构化 details；只在渲染旧记录时保留文本回退。
    const legacy = parseAnchoredOutput(getText(result));
    return {
        lines: legacy.lines,
        textTruncated: legacy.notices.some((notice) => notice.includes("line truncated")),
        eof: false,
        legacyNotices: legacy.notices,
    };
}

function resolveLanguage(path: string | undefined): string | undefined {
    if (!path) return undefined;
    try {
        return getLanguageFromPath(path.replace(/^@/, ""));
    } catch {
        return undefined;
    }
}

function highlightedSourceLine(content: string, language: string | undefined): string {
    const normalized = content.replace(/\t/g, "    ");
    if (!language || !normalized) return normalized;
    try {
        return highlightCode(normalized, language)[0] ?? normalized;
    } catch {
        return normalized;
    }
}

function createAnchoredSourceRowsComponent(
    lines: AnchoredSourceLine[],
    path: string | undefined,
    theme: RenderTheme,
): RenderComponent {
    const anchorWidth = lines.reduce((width, line) => Math.max(width, line.anchor.length), 0);
    const prefixWidth = anchorWidth + 4;
    const language = resolveLanguage(path);
    let highlightedLines = new WeakMap<AnchoredSourceLine, { text: string; width: number }>();

    return component((width) => {
        if (lines.length === 0 || width === 0) return [];
        const contentWidth = Math.max(1, width - prefixWidth);
        const rendered: string[] = [];

        for (const line of lines) {
            let highlighted = highlightedLines.get(line);
            if (!highlighted) {
                const text = highlightedSourceLine(line.content, language);
                highlighted = { text, width: visibleWidth(text) };
                highlightedLines.set(line, highlighted);
            }
            const sourceRows = highlighted.width <= contentWidth
                ? [highlighted.text]
                : wrapTextWithAnsi(highlighted.text, contentWidth);
            const wrapped = sourceRows.length > 0 ? sourceRows : [""];
            for (const [index, source] of wrapped.entries()) {
                const anchor = index === 0 ? line.anchor.padStart(anchorWidth, " ") : " ".repeat(anchorWidth);
                const prefix = `${theme.fg(index === 0 ? "accent" : "dim", anchor)}${theme.fg("dim", " │ ")}`;
                const renderedLine = `${prefix}${source}`;
                rendered.push(width > prefixWidth ? renderedLine : truncateToWidth(renderedLine, width, ""));
            }
        }
        return rendered;
    }, () => {
        highlightedLines = new WeakMap();
    });
}

function renderFailure(result: TextResult, expanded: boolean, theme: RenderTheme): RenderComponent {
    const rawLines = getText(result).split(/\r?\n/).filter(Boolean);
    const first = rawLines[0] ?? "工具执行失败。";
    const structuredMessage = result.details.error?.message;
    const reasonLine = rawLines.find((line) => line.startsWith("原因：") || line.startsWith("Message:"));
    const fallbackReason = reasonLine?.replace(/^(?:原因：|Message:\s*)/, "") ?? rawLines[1];
    const summary = structuredMessage ?? (fallbackReason ? `${first} ${fallbackReason}` : first);
    return component((width) => {
        if (!expanded) return [truncateToWidth(theme.fg("error", `× ${summary}`), width, "")];
        return rawLines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? "error" : "muted", index === 0 ? `× ${line}` : `  ${line}`), width, ""));
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
    const grep = kind === "read_anchors" && typeof input.grep === "string" ? input.grep : undefined;
    const range = kind === "read_anchors"
		? grep ? undefined : formatLineRange(offset ?? 1, (offset ?? 1) + (limit ?? MAX_READ_LIMIT) - 1)
		: fileChangeLineRanges(input.changes);
    const operationCount = kind === "apply_file_changes" && Array.isArray(input.changes) ? input.changes.length : undefined;
    const grepContext = kind === "read_anchors" && typeof input.context === "number" && Number.isInteger(input.context) && input.context > 0 ? input.context : undefined;
    const title = theme.fg("toolTitle", theme.bold(kind === "read_anchors" ? "read anchors" : "apply changes"));
    const styledPath = path ? linkedToolPath(theme.fg("accent", path), path, context) : undefined;
    const target = styledPath ? styledPath + (range ? theme.fg("warning", `:${range}`) : "") : theme.fg("dim", "…");
    let suffix = "";
    if (operationCount !== undefined) {
        suffix = theme.fg("muted", `（${operationCount} 项操作）`);
    } else if (grep) {
        const options = [
            grepContext === undefined ? "" : `上下文 ±${grepContext} 行`,
            offset === undefined || offset === 1 ? "" : `从第 ${offset} 行开始`,
            limit === undefined ? "" : `最多 ${limit} 行`,
        ].filter(Boolean);
        suffix = theme.fg("muted", ` 包含 ${JSON.stringify(grep)}${options.length === 0 ? "" : `（${options.join("；")}）`}`);
    }
    return component((width) => [truncateToWidth(`${title} ${target}${suffix}`, width, "")]);
}

export function renderReadAnchorsResult(
    result: TextResult,
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

    const read = readRenderState(result);
    const path = pathFromContext(context);
    const visible = options.expanded ? read.lines : read.lines.slice(0, COLLAPSED_ANCHOR_LINES);
    const sourceRowsComponent = createAnchoredSourceRowsComponent(visible, path, theme);
    return component((width) => {
        if (width === 0) return [];

        const firstLine = read.lines[0]?.lineNumber;
        const lastLine = read.lines[read.lines.length - 1]?.lineNumber;
        const range = formatLineRange(firstLine, lastLine);
        const actualRange = read.totalLines !== undefined
			? range ? `第 ${range} 行 / 共 ${read.totalLines} 行` : `0 行 / 共 ${read.totalLines} 行`
			: range ? `第 ${range} 行` : undefined;
        const header = [
            theme.fg("toolOutput", read.lines.length === 0
				? "↳ 未找到锚点"
				: `↳ ${theme.bold(String(read.lines.length))} 行锚点`),
            actualRange ? theme.fg("muted", `• ${actualRange}`) : "",
            read.nextOffset !== undefined ? theme.fg("warning", `• 下一页从第 ${read.nextOffset} 行开始`) : "",
            read.textTruncated ? theme.fg("warning", "• 行内容已截断") : "",
            read.eof ? theme.fg("muted", "• 已到文件末尾") : "",
            read.legacyNotices.some((notice) => notice.includes("truncated")) ? theme.fg("warning", "• 历史输出已截断") : "",
        ].filter(Boolean).join(" ");
        if (read.lines.length === 0 || width < 18) return [truncateToWidth(header, width, "")];

        const output = [
            truncateToWidth(header, width, ""),
            theme.fg("dim", "─".repeat(width)),
            ...sourceRowsComponent.render(width),
        ];
        if (!options.expanded && read.lines.length > visible.length) {
            output.push("", truncateToWidth(theme.fg("muted", `… 还有 ${read.lines.length - visible.length} 行锚点 • ${expandHint()}`), width, ""));
        }
        if (read.nextOffset !== undefined) {
            output.push(truncateToWidth(theme.fg("warning", `继续读取请使用 offset ${read.nextOffset}`), width, ""));
        }
        if (read.textTruncated) {
            output.push(truncateToWidth(theme.fg("warning", "源文件行内容已截断；调整 offset 无法恢复该行被省略的文本"), width, ""));
        }
        for (const notice of read.legacyNotices) {
            output.push(truncateToWidth(theme.fg("warning", localizeLegacyNotice(notice)), width, ""));
        }
        return output;
    }, () => sourceRowsComponent.invalidate());
}

function successfulChangeSummary(result: TextResult, theme: RenderTheme): string {
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
    result: TextResult,
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
    const diffWarning = typeof result.details.diffError === "string" ? result.details.diffError : undefined;
    const diff = typeof result.details.diff === "string" ? result.details.diff : "";
    const writeWarnings = Array.isArray(result.details.warnings)
        ? result.details.warnings.filter((warning): warning is string => typeof warning === "string")
        : [];
    const diffComponent = renderStandaloneDiff(diff, path, options.expanded, theme);
    if (!diffComponent) {
        const summary = successfulChangeSummary(result, theme);
        return component((width) => {
            if (width === 0) return [];
            const lines = [truncateToWidth(summary, width, "")];
            if (diffWarning) lines.push(truncateToWidth(theme.fg("warning", `差异警告：${diffWarning}`), width, ""));
            for (const warning of writeWarnings) lines.push(truncateToWidth(theme.fg("warning", `写入警告：${warning}`), width, ""));
            return lines;
        });
    }

    const updatedAnchors = options.expanded ? parseAnchoredOutput(getText(result)).lines : [];
    const updatedAnchorRows = createAnchoredSourceRowsComponent(updatedAnchors, path, theme);
    if (updatedAnchors.length === 0 && !diffWarning && writeWarnings.length === 0) return diffComponent;

    return component((width) => {
        if (width === 0) return [];
        const lines = [...diffComponent.render(width)];
        if (updatedAnchors.length > 0) {
            lines.push(
                "",
                truncateToWidth(theme.fg("muted", theme.bold("更新后的锚点")), width, ""),
                ...updatedAnchorRows.render(width),
            );
        }
        if (diffWarning) {
            lines.push(truncateToWidth(theme.fg("warning", `差异警告：${diffWarning}`), width, ""));
        }
        for (const warning of writeWarnings) {
            lines.push(truncateToWidth(theme.fg("warning", `写入警告：${warning}`), width, ""));
        }
        return lines;
    }, () => {
        diffComponent.invalidate();
        updatedAnchorRows.invalidate();
    });
}
