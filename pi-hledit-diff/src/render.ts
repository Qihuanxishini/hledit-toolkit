import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { fileChangeLineRange } from "./file-changes.ts";
import { MAX_READ_LIMIT, normalizeToolPath } from "./read-args.ts";
import type { HleditToolKind, TextResult } from "./result.ts";
import { decorateToolForDisplay, type RuntimeToolDefinition } from "./tool-display.ts";

export type RenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

export type RenderTheme = {
	fg: (name: string, text: string) => string;
	bold: (text: string) => string;
};

export type ToolRenderContextLike = {
	args?: unknown;
	[key: string]: unknown;
};

const VISUAL = {
	success: { nerd: "󰄬", theme: "success" },
	warning: { nerd: "", theme: "warning" },
	info: { nerd: "󰋽", theme: "accent" },
} as const;

type VisualState = keyof typeof VISUAL;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateIcon(theme: RenderTheme, state: VisualState): string {
	const visual = VISUAL[state];
	return theme.fg(visual.theme, visual.nerd);
}

function formatLineRange(first: number | undefined, last: number | undefined): string | undefined {
	if (first === undefined && last === undefined) {
		return undefined;
	}
	const start = first ?? last;
	const end = last ?? first;
	return start === end ? String(start) : `${start}-${end}`;
}

function foldedErrorLine(text: string): string {
	const lines = text.split(/\r?\n/).filter(Boolean);
	const first = lines[0] ?? "Failed.";
	const error = lines.find((line) => line.startsWith("Error:"));
	return error ? `${first} ${error.replace(/^Error:\s*/, "")}` : first;
}

function truncateLine(line: string, width: number): string {
	return truncateToWidth(line, width, "…");
}

function makeComponent(lines: string[]): RenderComponent {
	return {
		render(width: number) {
			return lines.map((line) => truncateLine(line, width));
		},
		invalidate() {},
	};
}

function getText(result: TextResult): string {
	const first = result.content[0];
	return typeof first?.text === "string" ? first.text : "";
}

function changedLineSummary(details: Record<string, unknown>): string | undefined {
	const range = formatLineRange(
		typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined,
		typeof details.lastChangedLine === "number" ? details.lastChangedLine : undefined,
	);
	return range ? `Changed lines: ${range}` : undefined;
}

export function renderHleditCall(kind: HleditToolKind, args: unknown, theme: RenderTheme): RenderComponent {
	const input = isRecord(args) ? args : {};
	const path = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
	const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : undefined;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
	const range =
		kind === "read_anchors"
			? formatLineRange(offset ?? 1, (offset ?? 1) + (limit ?? MAX_READ_LIMIT) - 1)
			: fileChangeLineRange(input.changes);
	const title = theme.fg("toolTitle", theme.bold(`${kind === "read_anchors" ? "read anchors" : "apply changes"}:`));
	const targetText = path ? theme.fg("accent", path) + (range ? theme.fg("warning", `:${range}`) : "") : "";
	return makeComponent([targetText ? `${title} ${targetText}` : title]);
}

export function createEditDiffRenderDelegate(): RuntimeToolDefinition {
	const tool: RuntimeToolDefinition = {
		name: "hledit-diff-renderer",
		label: "Hashline File Change Diff Renderer",
		description: "Internal renderer delegate for hledit_apply_file_changes diff output.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	};

	return decorateToolForDisplay(tool, {
		kind: "edit",
		overrideExistingRenderers: true,
		getPath(args: unknown) {
			return isRecord(args) && typeof args.path === "string" ? args.path : undefined;
		},
		getEditLineCount() {
			return 1;
		},
	});
}

export function hasDiffPayload(result: TextResult): boolean {
	const diff = result.details.diff;
	return typeof diff === "string" && diff.trim().length > 0;
}

export function renderWithEditDiffDelegate(
	delegate: RuntimeToolDefinition,
	result: TextResult,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): unknown | undefined {
	if (typeof delegate.renderResult !== "function") {
		return undefined;
	}

	try {
		const input = isRecord(context.args) ? context.args : {};
		return delegate.renderResult(result, options, theme, {
			...context,
			args: { path: typeof input.path === "string" ? normalizeToolPath(input.path) : undefined },
		});
	} catch {
		return undefined;
	}
}

export function renderFallbackResult(
	kind: HleditToolKind,
	result: TextResult,
	theme: RenderTheme,
	_context: ToolRenderContextLike,
): RenderComponent {
	const text = getText(result);
	const lines = text ? text.split(/\r?\n/) : [];
	const warningIcon = stateIcon(theme, "warning");
	const infoIcon = stateIcon(theme, "info");
	const successIcon = stateIcon(theme, "success");

	if (result.details.disposition !== "succeeded") {
		return makeComponent([`${warningIcon} ${foldedErrorLine(text)}`]);
	}

	if (kind === "read_anchors") {
		if (lines.length > 20) {
			return makeComponent([
				`${infoIcon} Anchors folded: ${lines.length} lines`,
				lines[0] ?? "",
				`... (${lines.length - 2} lines) ...`,
				lines[lines.length - 1] ?? "",
			]);
		}
		return makeComponent(lines.length > 0 ? lines : ["No anchored lines found."]);
	}

	const changed = changedLineSummary(result.details);
	const count = typeof result.details.editsApplied === "number" ? `Changes applied: ${result.details.editsApplied}.` : "Changes applied.";
	return makeComponent([`${successIcon} ${count}${changed ? ` ${changed}.` : ""}`]);
}
