import type { SnapshotLedger, SnapshotStage } from "./snapshot-ledger.ts";
import { MAX_SNAPSHOT_DELTA_BYTES, snapshotDeltaBytes } from "./snapshot-ledger.ts";
import type { SnaplineDisplayedRange, SnaplineOmissionReason } from "./tool-details.ts";
import type { SnaplineOmittedRange, SnaplineReadContext } from "./wire.ts";

export const MAX_MODEL_READ_BYTES = 50 * 1024;

type ExactLine = { line: number; text: string; approximate: boolean };
type PrefixLine = { line: number; prefix: string; originalUtf8Bytes: number; approximate: boolean };

type FormattedSnapshotInput = {
	ledger: SnapshotLedger;
	stage: SnapshotStage;
	contexts: readonly SnaplineReadContext[];
	omittedRanges: readonly SnaplineOmittedRange[];
	totalLines: number;
};

export type FormattedSnapshot = {
	body: string;
	snapshot: string;
	displayedLines: Map<number, string>;
	displayedRanges: SnaplineDisplayedRange[];
	omittedRanges: SnaplineDisplayedRange[];
	nextOffset: number;
	delta: ReturnType<SnapshotLedger["previewDelta"]>;
	capacityRebased: boolean;
};

function sortedExactLines(contexts: readonly SnaplineReadContext[]): ExactLine[] {
	const lines: ExactLine[] = [];
	for (const context of contexts) {
		for (const [offset, text] of context.lines.entries()) {
			lines.push({ line: context.start + offset, text, approximate: context.approximate === true });
		}
	}
	return lines.sort((left, right) => left.line - right.line);
}

function prefixLines(contexts: readonly SnaplineReadContext[]): PrefixLine[] {
	return contexts
		.flatMap((context) => context.truncatedLine ? [{ ...context.truncatedLine, approximate: context.approximate === true }] : [])
		.sort((left, right) => left.line - right.line);
}

function mergeRanges(ranges: readonly SnaplineDisplayedRange[]): SnaplineDisplayedRange[] {
	const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: SnaplineDisplayedRange[] = [];
	for (const range of ordered) {
		const prior = merged.at(-1);
		if (prior && prior.reason === range.reason && prior.approximate === range.approximate && range.start <= prior.end + 1) {
			prior.end = Math.max(prior.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function rangesFromLineMap(lines: ReadonlyMap<number, string>, approximateLines: ReadonlySet<number>): SnaplineDisplayedRange[] {
	const ranges: SnaplineDisplayedRange[] = [];
	for (const line of [...lines.keys()].sort((left, right) => left - right)) {
		const approximate = approximateLines.has(line) ? true as const : undefined;
		const prior = ranges.at(-1);
		if (prior && prior.end + 1 === line && prior.approximate === approximate) prior.end = line;
		else ranges.push({ start: line, end: line, ...(approximate ? { approximate } : {}) });
	}
	return ranges;
}

function compactRange(range: SnaplineDisplayedRange): string {
	const coordinates = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
	return [coordinates, range.reason, range.approximate ? "approximate" : undefined].filter(Boolean).join(":");
}

function bodyText(
	snapshot: string,
	totalLines: number,
	displayed: ReadonlyMap<number, string>,
	approximateLines: ReadonlySet<number>,
	prefixes: readonly PrefixLine[],
	omitted: readonly SnaplineDisplayedRange[],
): string {
	const body: string[] = [];
	for (const [line, text] of [...displayed.entries()].sort((left, right) => left[0] - right[0])) body.push(`${line}:${text}`);
	for (const prefix of prefixes) {
		body.push(`${prefix.line}:${prefix.prefix} … [line truncated at ${prefix.originalUtf8Bytes} UTF-8 bytes; not editable${prefix.approximate ? "; approximate location" : ""}]`);
	}
	if (body.length > 0) body.push("");
	if (omitted.length > 0) body.push(`[omitted:${omitted.map(compactRange).join(",")}]`);
	const displayedRanges = rangesFromLineMap(displayed, approximateLines);
	const rangeReceipt = totalLines === 0 ? "empty" : displayedRanges.length === 0 ? "none" : displayedRanges.map(compactRange).join(",");
	const nextOffset = omitted.length > 0
		? Math.min(...omitted.map((range) => range.start))
		: displayed.size > 0 ? Math.max(...displayed.keys()) + 1 : totalLines === 0 ? 1 : 1;
	body.push(`[snapshot:${snapshot} lines:${rangeReceipt}/${totalLines} next:${nextOffset}]`);
	return body.join("\n");
}

function asDisplayedOmission(range: SnaplineOmittedRange): SnaplineDisplayedRange {
	return {
		start: range.start,
		end: range.end,
		reason: range.reason,
		...(range.approximate ? { approximate: true as const } : {}),
	};
}

export function collectVerifiedContextLines(contexts: readonly SnaplineReadContext[]): Map<number, string> {
	return new Map(sortedExactLines(contexts).filter((line) => !line.approximate).map(({ line, text }) => [line, text]));
}

function authorizedDisplayedLines(displayed: ReadonlyMap<number, string>, approximateLines: ReadonlySet<number>): Map<number, string> {
	return new Map([...displayed].filter(([line]) => !approximateLines.has(line)));
}

export function commitFormattedSnapshot(input: FormattedSnapshotInput): FormattedSnapshot {
	const exactLines = sortedExactLines(input.contexts);
	const prefixes = prefixLines(input.contexts);
	const approximateLines = new Set(exactLines.filter((line) => line.approximate).map((line) => line.line));
	const displayed = new Map<number, string>();
	const pluginOmissions: SnaplineDisplayedRange[] = [];
	const cliOmissions = input.omittedRanges.map(asDisplayedOmission);
	const pessimisticSnapshot = `s_${"_".repeat(43)}`;
	const exposesEmptyBoundary = input.totalLines === 0 && !input.contexts.some((context) => context.approximate === true);

	for (const candidate of exactLines) {
		const tentative = new Map(displayed);
		tentative.set(candidate.line, candidate.text);
		const tentativeOmissions = mergeRanges([
			...cliOmissions,
			...pluginOmissions,
			...exactLines
				.filter((line) => !tentative.has(line.line) && line.line !== candidate.line)
				.map((line) => ({ start: line.line, end: line.line, reason: "replay_delta_budget" as SnaplineOmissionReason })),
		]);
		const authorizedTentative = authorizedDisplayedLines(tentative, approximateLines);
		const previewDelta = input.ledger.previewDelta(input.stage, authorizedTentative, exposesEmptyBoundary, authorizedTentative);
		const previewBody = bodyText(pessimisticSnapshot, input.totalLines, tentative, approximateLines, prefixes, tentativeOmissions);
		if (snapshotDeltaBytes(previewDelta) <= MAX_SNAPSHOT_DELTA_BYTES && Buffer.byteLength(previewBody, "utf8") <= MAX_MODEL_READ_BYTES) {
			displayed.set(candidate.line, candidate.text);
		} else {
			pluginOmissions.push({ start: candidate.line, end: candidate.line, reason: "replay_delta_budget" });
		}
	}

	let displayedPrefixes = [...prefixes];
	let omissions = mergeRanges([...cliOmissions, ...pluginOmissions]);
	while (displayedPrefixes.length > 0 && Buffer.byteLength(bodyText(pessimisticSnapshot, input.totalLines, displayed, approximateLines, displayedPrefixes, omissions), "utf8") > MAX_MODEL_READ_BYTES) {
		displayedPrefixes = displayedPrefixes.slice(0, -1);
	}
	if (Buffer.byteLength(bodyText(pessimisticSnapshot, input.totalLines, displayed, approximateLines, displayedPrefixes, omissions), "utf8") > MAX_MODEL_READ_BYTES) {
		throw new Error("Snapshot receipt and omission metadata exceed the model output budget.");
	}

	const authorizedDisplayed = authorizedDisplayedLines(displayed, approximateLines);
	const committed = input.ledger.commit(input.stage, authorizedDisplayed, exposesEmptyBoundary, authorizedDisplayed);
	const body = bodyText(committed.node.id, input.totalLines, displayed, approximateLines, displayedPrefixes, omissions);
	if (Buffer.byteLength(body, "utf8") > MAX_MODEL_READ_BYTES) throw new Error("Committed snapshot body exceeds the model output budget.");
	const displayedRanges = rangesFromLineMap(displayed, approximateLines);
	const nextOffset = omissions.length > 0
		? Math.min(...omissions.map((range) => range.start))
		: displayed.size > 0 ? Math.max(...displayed.keys()) + 1 : 1;
	return {
		body,
		snapshot: committed.node.id,
		displayedLines: displayed,
		displayedRanges,
		omittedRanges: omissions,
		nextOffset,
		delta: committed.delta,
		capacityRebased: committed.capacityRebased,
	};
}
