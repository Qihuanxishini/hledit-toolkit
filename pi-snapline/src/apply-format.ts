import type { PreparedModelBatch } from "./coordinate-translation.ts";
import { MAX_SNAPSHOT_DELTA_BYTES, SnapshotLedger, snapshotDeltaBytes, type SnapshotStage } from "./snapshot-ledger.ts";
import type { SnaplineApplyStats, SnaplineEditEffect, SnaplineWarning } from "./wire.ts";

export const MAX_APPLY_RECEIPT_BYTES = 8 * 1024;

export type ProducedReceiptRange = {
	group: "replacement" | "insertion_before" | "insertion_after";
	groupIndex: number;
	start: number;
	end: number;
};

type ApplySnapshotInput = {
	ledger: SnapshotLedger;
	stage: SnapshotStage;
	prepared: PreparedModelBatch;
	effects: readonly SnaplineEditEffect[];
	generatedLines: ReadonlyMap<number, string>;
	stats: SnaplineApplyStats;
	warnings: readonly SnaplineWarning[];
};

export type CommittedApplySnapshot = {
	body: string;
	snapshot: string;
	producedRanges: ProducedReceiptRange[];
	producedTruncated: boolean;
	delta: ReturnType<SnapshotLedger["previewDelta"]>;
	capacityRebased: boolean;
};

function label(range: ProducedReceiptRange): string {
	const prefix = range.group === "replacement" ? "r" : range.group === "insertion_before" ? "ib" : "ia";
	return `${prefix}${range.groupIndex}=${range.start}-${range.end}`;
}

function receiptBody(
	snapshot: string,
	stats: SnaplineApplyStats,
	ranges: readonly ProducedReceiptRange[],
	truncated: boolean,
	warnings: readonly SnaplineWarning[],
): string {
	const lines = [`Applied ${stats.effectiveChanges} changes atomically. snapshot:${snapshot}`];
	if (ranges.length > 0) lines.push(`produced:${ranges.map(label).join(",")}`);
	if (truncated) lines.push("produced_truncated: fresh read required for omitted generated ranges");
	for (const warning of warnings) lines.push(`warning:${warning.code}:${warning.message}`);
	return lines.join("\n");
}

function candidateRanges(prepared: PreparedModelBatch, effects: readonly SnaplineEditEffect[]): ProducedReceiptRange[] {
	const ranges: ProducedReceiptRange[] = [];
	for (const effect of effects) {
		if (!effect.changed || effect.newLineCount === 0 || effect.group === "deletion") continue;
		const change = prepared.changes.find((candidate) => candidate.group === effect.group && candidate.groupIndex === effect.groupIndex);
		if (!change || !("producedLines" in change) || change.producedLines.length !== effect.newLineCount) {
			throw new Error(`Generated text is missing for ${effect.group} ${effect.groupIndex}.`);
		}
		ranges.push({
			group: effect.group,
			groupIndex: effect.groupIndex,
			start: effect.newStart,
			end: effect.newEnd,
		});
	}
	return ranges;
}

function linesForRanges(
	ranges: readonly ProducedReceiptRange[],
	generatedLines: ReadonlyMap<number, string>,
): Map<number, string> {
	const lines = new Map<number, string>();
	for (const range of ranges) {
		for (let line = range.start; line <= range.end; line++) {
			const text = generatedLines.get(line);
			if (text === undefined) throw new Error(`Generated line ${line} is missing from the validated apply result.`);
			lines.set(line, text);
		}
	}
	return lines;
}

export function commitAppliedSnapshot(input: ApplySnapshotInput): CommittedApplySnapshot {
	const candidates = candidateRanges(input.prepared, input.effects);
	const selected: ProducedReceiptRange[] = [];
	const pessimisticSnapshot = `s_${"_".repeat(43)}`;
	for (const candidate of candidates) {
		const tentativeRanges = [...selected, candidate];
		const tentativeLines = linesForRanges(tentativeRanges, input.generatedLines);
		const truncated = tentativeRanges.length < candidates.length;
		const delta = input.ledger.previewDelta(input.stage, tentativeLines, false, tentativeLines);
		const body = receiptBody(pessimisticSnapshot, input.stats, tentativeRanges, truncated, input.warnings);
		if (snapshotDeltaBytes(delta) <= MAX_SNAPSHOT_DELTA_BYTES && Buffer.byteLength(body, "utf8") <= MAX_APPLY_RECEIPT_BYTES) {
			selected.push(candidate);
		}
	}
	const selectedLines = linesForRanges(selected, input.generatedLines);
	const committed = input.ledger.commit(input.stage, selectedLines, false, selectedLines);
	const producedTruncated = selected.length < candidates.length;
	const body = receiptBody(committed.node.id, input.stats, selected, producedTruncated, input.warnings);
	if (Buffer.byteLength(body, "utf8") > MAX_APPLY_RECEIPT_BYTES) throw new Error("Committed apply receipt exceeds its model-visible budget.");
	return {
		body,
		snapshot: committed.node.id,
		producedRanges: selected,
		producedTruncated,
		delta: committed.delta,
		capacityRebased: committed.capacityRebased,
	};
}
