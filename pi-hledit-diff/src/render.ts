import { getLanguageFromPath, highlightCode, keyHint, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderStandaloneDiff, type HleditRenderComponent, type HleditRenderTheme } from "./diff-renderer.ts";
import { fileChangeLineRange } from "./file-changes.ts";
import { MAX_READ_LIMIT, normalizeToolPath } from "./read-args.ts";
import type { HleditToolKind, TextResult } from "./result.ts";

export type RenderComponent = HleditRenderComponent;
export type RenderTheme = HleditRenderTheme;

export type ToolRenderContextLike = {
    args?: unknown;
    isError?: boolean;
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
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "Ctrl+O to expand";
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
    const first = rawLines[0] ?? "Tool failed.";
    const errorLine = rawLines.find((line) => line.startsWith("Error:"));
    const summary = errorLine ? `${first} ${errorLine.replace(/^Error:\s*/, "")}` : first;
    return component((width) => {
        if (!expanded) return [truncateToWidth(theme.fg("error", `× ${summary}`), width, "")];
        return rawLines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? "error" : "muted", index === 0 ? `× ${line}` : `  ${line}`), width, ""));
    });
}

export function renderHleditCall(kind: HleditToolKind, args: unknown, theme: RenderTheme): RenderComponent {
    const input = isRecord(args) ? args : {};
    const path = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
    const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : undefined;
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
    const range = kind === "read_anchors"
        ? formatLineRange(offset ?? 1, (offset ?? 1) + (limit ?? MAX_READ_LIMIT) - 1)
        : fileChangeLineRange(input.changes);
    const operationCount = kind === "apply_file_changes" && Array.isArray(input.changes) ? input.changes.length : undefined;
    const grep = kind === "read_anchors" && typeof input.grep === "string" ? input.grep : undefined;
    const title = theme.fg("toolTitle", theme.bold(kind === "read_anchors" ? "read anchors" : "apply changes"));
    const target = path ? theme.fg("accent", path) + (range ? theme.fg("warning", `:${range}`) : "") : theme.fg("dim", "…");
    const suffix = operationCount !== undefined
        ? theme.fg("muted", ` (${operationCount} ${operationCount === 1 ? "operation" : "operations"})`)
        : grep
            ? theme.fg("muted", ` contains ${JSON.stringify(grep)}`)
            : "";
    return component((width) => [truncateToWidth(`${title} ${target}${suffix}`, width, "")]);
}

export function renderReadAnchorsResult(
    result: TextResult,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    context: ToolRenderContextLike,
): RenderComponent {
    if (options.isPartial) {
        return component((width) => [truncateToWidth(theme.fg("warning", "reading anchors…"), width, "")]);
    }
    if (result.details.disposition !== "succeeded" || context.isError) {
        return renderFailure(result, options.expanded, theme);
    }

    const parsed = parseAnchoredOutput(getText(result));
    const path = pathFromContext(context);
    const visible = options.expanded ? parsed.lines : parsed.lines.slice(0, COLLAPSED_ANCHOR_LINES);
    const sourceRowsComponent = createAnchoredSourceRowsComponent(visible, path, theme);
    return component((width) => {
        if (width === 0) return [];
        if (parsed.lines.length === 0) {
            return [truncateToWidth(theme.fg("muted", "↳ no anchored lines"), width, "")];
        }

        const firstLine = parsed.lines[0]?.lineNumber;
        const lastLine = parsed.lines[parsed.lines.length - 1]?.lineNumber;
        const range = formatLineRange(firstLine, lastLine);
        const header = [
            theme.fg("toolOutput", `↳ ${theme.bold(String(parsed.lines.length))} anchored ${parsed.lines.length === 1 ? "line" : "lines"}`),
            range ? theme.fg("muted", `• ${range}`) : "",
            parsed.notices.length > 0 ? theme.fg("warning", "• truncated") : "",
        ].filter(Boolean).join(" ");
        if (width < 18) return [truncateToWidth(header, width, "")];

        const output = [
            truncateToWidth(header, width, ""),
            theme.fg("dim", "─".repeat(width)),
            ...sourceRowsComponent.render(width),
        ];
        if (!options.expanded && parsed.lines.length > visible.length) {
            output.push("", truncateToWidth(theme.fg("muted", `… ${parsed.lines.length - visible.length} more anchored lines • ${expandHint()}`), width, ""));
        }
        for (const notice of parsed.notices) {
            output.push(truncateToWidth(theme.fg("warning", notice), width, ""));
        }
        return output;
    }, () => sourceRowsComponent.invalidate());
}

function successfulChangeSummary(result: TextResult, theme: RenderTheme): string {
    const edits = typeof result.details.editsApplied === "number" ? result.details.editsApplied : undefined;
    const first = typeof result.details.firstChangedLine === "number" ? result.details.firstChangedLine : undefined;
    const last = typeof result.details.lastChangedLine === "number" ? result.details.lastChangedLine : undefined;
    const added = typeof result.details.linesAdded === "number" ? result.details.linesAdded : undefined;
    const deleted = typeof result.details.linesDeleted === "number" ? result.details.linesDeleted : undefined;
    const pieces = [
        theme.fg("success", "✓"),
        theme.fg("toolOutput", edits === undefined ? "changes applied" : `${edits} ${edits === 1 ? "change" : "changes"} applied`),
    ];
    const range = formatLineRange(first, last);
    if (range) pieces.push(theme.fg("muted", `• lines ${range}`));
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
        return component((width) => [truncateToWidth(theme.fg("warning", "applying anchored changes…"), width, "")]);
    }
    if (result.details.disposition !== "succeeded" || context.isError) {
        return renderFailure(result, options.expanded, theme);
    }

    const path = pathFromContext(context);
    const diff = typeof result.details.diff === "string" ? result.details.diff : "";
    const diffComponent = renderStandaloneDiff(diff, path, options.expanded, theme);
    if (!diffComponent) {
        const summary = successfulChangeSummary(result, theme);
        return component((width) => [truncateToWidth(summary, width, "")]);
    }

    const updatedAnchors = options.expanded ? parseAnchoredOutput(getText(result)).lines : [];
    const updatedAnchorRows = createAnchoredSourceRowsComponent(updatedAnchors, path, theme);
    const diffWarning = typeof result.details.diffError === "string" ? result.details.diffError : undefined;
    if (updatedAnchors.length === 0 && !diffWarning) return diffComponent;

    return component((width) => {
        if (width === 0) return [];
        const lines = [...diffComponent.render(width)];
        if (updatedAnchors.length > 0) {
            lines.push(
                "",
                truncateToWidth(theme.fg("muted", theme.bold("updated anchors")), width, ""),
                ...updatedAnchorRows.render(width),
            );
        }
        if (diffWarning) {
            lines.push(truncateToWidth(theme.fg("warning", `Diff warning: ${diffWarning}`), width, ""));
        }
        return lines;
    }, () => {
        diffComponent.invalidate();
        updatedAnchorRows.invalidate();
    });
}

export function renderFallbackResult(
    kind: HleditToolKind,
    result: TextResult,
    theme: RenderTheme,
    context: ToolRenderContextLike,
): RenderComponent {
    const options = { expanded: false, isPartial: false } as ToolRenderResultOptions;
    return kind === "read_anchors"
        ? renderReadAnchorsResult(result, options, theme, context)
        : renderFileChangesResult(result, options, theme, context);
}
