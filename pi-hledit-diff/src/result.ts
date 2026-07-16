import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { HLEDIT_INSTALL_HINT, type HleditRun } from "./cli.ts";
import { ANCHOR_HASH_PATTERN } from "./file-changes.ts";
import { parseBatchUpdatedAnchorContext } from "./post-edit-context.ts";

export type HleditToolKind = "read_anchors" | "apply_file_changes";
export type HleditDisposition = "succeeded" | "rejected" | "unavailable";

export type HleditResultContext = {
	path?: string;
};

export type HleditDetails = Record<string, unknown> & {
	disposition: HleditDisposition;
};

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HleditDetails;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function parseRunObject(run: HleditRun): Record<string, unknown> | null {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	return parseJsonObject(text);
}

function formatLineRange(first: number | undefined, last: number | undefined): string | undefined {
	if (first === undefined && last === undefined) {
		return undefined;
	}
	const start = first ?? last;
	const end = last ?? first;
	return start === end ? String(start) : `${start}-${end}`;
}

function lineDeltaSummary(parsed: Record<string, unknown>): string | undefined {
	const linesAdded = parsed.linesAdded;
	const linesDeleted = parsed.linesDeleted;
	if (typeof linesAdded !== "number" && typeof linesDeleted !== "number") {
		return undefined;
	}
	const added = typeof linesAdded === "number" ? linesAdded : 0;
	const deleted = typeof linesDeleted === "number" ? linesDeleted : 0;
	return `Lines: +${added} -${deleted}`;
}

function appendRemaps(lines: string[], result: Record<string, unknown>): void {
	if (!Array.isArray(result.remaps) || result.remaps.length === 0) {
		return;
	}

	lines.push("Current anchor hints:");
	for (const remap of result.remaps) {
		if (!isRecord(remap)) {
			continue;
		}
		const requested = typeof remap.requested === "string" ? remap.requested : undefined;
		const current = typeof remap.current === "string" ? remap.current : undefined;
		if (requested && current) {
			lines.push(`- ${requested} -> ${current}`);
		} else if (requested) {
			lines.push(`- ${requested}`);
		}
	}
}

function staleReadInstruction(result: Record<string, unknown>, path: string | undefined): string {
	const genericInstruction = "Read the affected range with hledit_read_anchors before retrying. Do not reuse pre-mutation anchors.";
	if (!path || !Array.isArray(result.remaps)) {
		return genericInstruction;
	}
	const remappedLineNumbers = result.remaps.flatMap((remap) => {
		if (!isRecord(remap)) {
			return [];
		}
		let anchor: string | undefined;
		if (typeof remap.current === "string") {
			anchor = remap.current;
		} else if (typeof remap.requested === "string") {
			anchor = remap.requested;
		}
		const match = anchor ? new RegExp(`^(\\d+)#${ANCHOR_HASH_PATTERN}$`).exec(anchor) : undefined;
		return match ? [Number(match[1])] : [];
	});
	if (remappedLineNumbers.length === 0) {
		return genericInstruction;
	}
	const offset = Math.max(1, Math.min(...remappedLineNumbers) - 2);
	return `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: 12 }) before retrying. Do not reuse pre-mutation anchors.`;
}

function formatFailureResult(result: Record<string, unknown>, kind: HleditToolKind, context: HleditResultContext): string {
	const lines = [kind === "apply_file_changes" ? "Atomic batch rejected; zero changes were applied." : "Anchor read failed."];
	if (typeof result.error === "string") {
		lines.push(`Error: ${result.error}`);
	}
	if (typeof result.message === "string" && result.message !== result.error) {
		lines.push(`Message: ${result.message}`);
	}
	if (typeof result.failed === "number") {
		lines.push(`Failed change: ${result.failed}`);
	}
	appendRemaps(lines, result);
	if (kind === "apply_file_changes" && result.error === "stale") {
		lines.push(staleReadInstruction(result, context.path));
	}
	return lines.join("\n");
}

function formatApplyResult(result: Record<string, unknown>): string {
	const lines = ["Changes applied."];
	if (typeof result.editsApplied === "number") {
		lines.push(`Changes applied: ${result.editsApplied}`);
	}
	const changed = formatLineRange(
		typeof result.firstChangedLine === "number" ? result.firstChangedLine : undefined,
		typeof result.lastChangedLine === "number" ? result.lastChangedLine : undefined,
	);
	if (changed) {
		lines.push(`Changed lines: ${changed}`);
	}
	const lineDelta = lineDeltaSummary(result);
	if (lineDelta) {
		lines.push(lineDelta);
	}
	return lines.join("\n");
}

function isValidApplySuccess(parsed: Record<string, unknown> | null): boolean {
	return (
		parsed?.ok === true &&
		typeof parsed.editsApplied === "number" &&
		Number.isInteger(parsed.editsApplied) &&
		parsed.editsApplied >= 0 &&
		parseBatchUpdatedAnchorContext(parsed) !== undefined
	);
}

function invalidApplySuccessText(): string {
	return `Changes were not applied: bundled hledit returned an incompatible success response. Expected JSON with ok:true, a non-negative integer editsApplied, and valid updatedAnchors.\n\n${HLEDIT_INSTALL_HINT}`;
}

function formatRunText(
	run: HleditRun,
	kind: HleditToolKind,
	context: HleditResultContext,
	parsed: Record<string, unknown> | null,
	applySuccessValid: boolean,
): string {
	const text = run.stdout.trimEnd() || run.stderr.trimEnd();
	if (run.exitCode !== 0) {
		return text || HLEDIT_INSTALL_HINT;
	}
	if (!text) {
		return kind === "apply_file_changes" ? invalidApplySuccessText() : "No anchored lines found.";
	}
	if (!parsed) {
		return kind === "apply_file_changes" ? invalidApplySuccessText() : text;
	}
	if (parsed.ok === false) {
		return formatFailureResult(parsed, kind, context);
	}
	if (kind === "apply_file_changes") {
		return applySuccessValid ? formatApplyResult(parsed) : invalidApplySuccessText();
	}
	return text;
}

export function extractCliSummary(parsed: Record<string, unknown> | null): Record<string, unknown> {
	if (!parsed) {
		return {};
	}

	const summary: Record<string, unknown> = {};
	for (const key of ["firstChangedLine", "lastChangedLine", "linesAdded", "linesDeleted", "editsApplied", "checked"] as const) {
		const value = parsed[key];
		if (typeof value === "number" || typeof value === "boolean") {
			summary[key] = value;
		}
	}
	return summary;
}

export function textResult(run: HleditRun, kind: HleditToolKind, context: HleditResultContext = {}): TextResult {
	const parsed = parseRunObject(run);
	const applySuccessValid = kind === "apply_file_changes" && isValidApplySuccess(parsed);
	const disposition: HleditDisposition =
		run.exitCode !== 0
			? "unavailable"
			: parsed?.ok === false
				? "rejected"
				: kind === "apply_file_changes" && !applySuccessValid
					? "unavailable"
					: "succeeded";
	return {
		content: [{ type: "text", text: formatRunText(run, kind, context, parsed, applySuccessValid) }],
		details: { disposition, ...extractCliSummary(parsed) },
	};
}

export function toolFailureResult(text: string, disposition: Exclude<HleditDisposition, "succeeded"> = "unavailable"): TextResult {
	return {
		content: [{ type: "text", text }],
		details: { disposition },
	};
}

export function isFailedHleditResult(details: unknown): boolean {
	return isRecord(details) && details.disposition !== "succeeded";
}

export function buildDiffDetails(
	path: string,
	beforeContent: string,
	afterContent: string,
	parsed: Record<string, unknown> | null,
): Record<string, unknown> {
	const diffResult = generateDiffString(beforeContent, afterContent);
	const patch = generateUnifiedPatch(path, beforeContent, afterContent);
	const cliFirstChangedLine = parsed?.firstChangedLine;
	return {
		...extractCliSummary(parsed),
		diff: diffResult.diff,
		patch,
		firstChangedLine: typeof cliFirstChangedLine === "number" ? cliFirstChangedLine : diffResult.firstChangedLine,
	};
}

export async function readUtf8File(path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
	try {
		return { ok: true, content: await readFile(path, "utf8") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
