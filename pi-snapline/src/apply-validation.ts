import type { PreparedInsertion, PreparedModelBatch, PreparedModelChange } from "./coordinate-translation.ts";
import type { SnapshotNode } from "./snapshot-ledger.ts";
import type {
	SnaplineApplyRequest,
	SnaplineApplyStats,
	SnaplineApplySuccess,
	SnaplineEditEffect,
	SnaplineProofRange,
} from "./wire.ts";

export class ApplyValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyValidationError";
	}
}

function groupOrder(group: SnaplineEditEffect["group"]): number {
	switch (group) {
		case "replacement": return 0;
		case "deletion": return 1;
		case "insertion_before": return 2;
		case "insertion_after": return 3;
	}
}

function producedLines(change: PreparedModelChange): string[] {
	return "producedLines" in change ? change.producedLines : [];
}

function oldCoordinates(change: PreparedModelChange): { oldStart: number; oldEnd: number } {
	if (change.group === "replacement" || change.group === "deletion") return { oldStart: change.start, oldEnd: change.end };
	return change.group === "insertion_before"
		? { oldStart: change.line, oldEnd: change.line - 1 }
		: { oldStart: change.line + 1, oldEnd: change.line };
}

function changeIsEffective(change: PreparedModelChange, sourceLines: ReadonlyMap<number, string>): boolean {
	if (change.group !== "replacement") return true;
	const generated = change.producedLines;
	if (generated.length !== change.end - change.start + 1) return true;
	return generated.some((text, index) => sourceLines.get(change.start + index) !== text);
}

function expectedNewStart(change: PreparedModelChange, effective: readonly PreparedModelChange[]): number {
	const coordinates = oldCoordinates(change);
	let newStart = coordinates.oldEnd < coordinates.oldStart ? coordinates.oldEnd + 1 : coordinates.oldStart;
	for (const prior of effective) {
		if (prior.group === change.group && prior.groupIndex === change.groupIndex) continue;
		const priorCoordinates = oldCoordinates(prior);
		const priorProduced = producedLines(prior).length;
		const priorConsumed = Math.max(0, priorCoordinates.oldEnd - priorCoordinates.oldStart + 1);
		const delta = priorProduced - priorConsumed;
		if (coordinates.oldEnd < coordinates.oldStart) {
			const boundary = coordinates.oldEnd;
			if (priorCoordinates.oldEnd >= priorCoordinates.oldStart) {
				if (priorCoordinates.oldEnd <= boundary) newStart += delta;
			} else if (priorCoordinates.oldEnd < boundary) newStart += delta;
		} else if (priorCoordinates.oldEnd >= priorCoordinates.oldStart) {
			if (priorCoordinates.oldEnd < coordinates.oldStart) newStart += delta;
		} else if (priorCoordinates.oldEnd < coordinates.oldStart) {
			newStart += delta;
		}
	}
	return newStart;
}

// [喵喵喵]: 未知提交结果必须覆盖可能已生成的坐标；这里复用 receipt 的有效变更和坐标投影规则，避免恢复窗口与验证规则分叉 (2026-07-31)。
export function projectApplyProducedRanges(
	prepared: PreparedModelBatch,
	sourceProof: ReadonlyMap<number, string>,
): Array<{ start: number; end: number }> {
	const effectiveChanges = prepared.changes.filter((change) => changeIsEffective(change, sourceProof));
	return effectiveChanges.flatMap((change) => {
		const lineCount = producedLines(change).length;
		if (lineCount === 0) return [];
		const start = expectedNewStart(change, effectiveChanges);
		return [{ start, end: start + lineCount - 1 }];
	});
}

function proofRanges(lines: ReadonlyMap<number, string>): SnaplineProofRange[] {
	const ranges: SnaplineProofRange[] = [];
	for (const [line, text] of [...lines.entries()].sort((left, right) => left[0] - right[0])) {
		const prior = ranges.at(-1);
		if (prior && prior.start + prior.lines.length === line) prior.lines.push(text);
		else ranges.push({ start: line, lines: [text] });
	}
	return ranges;
}

export function collectApplyProof(
	prepared: PreparedModelBatch,
	head: SnapshotNode,
): { lines: Map<number, string>; ranges: SnaplineProofRange[] } {
	const required = new Set<number>();
	for (const change of prepared.changes) {
		if (change.group === "replacement" || change.group === "deletion") {
			for (let line = change.start; line <= change.end; line++) required.add(line);
		} else {
			required.add(change.line);
		}
	}
	if (head.totalLines === 0) required.clear();
	if (required.size > 10_000) throw new ApplyValidationError("The translated batch requires more than 10,000 proof lines.");
	const lines = new Map<number, string>();
	let textBytes = 0;
	for (const line of [...required].sort((left, right) => left - right)) {
		const text = head.verifiedLines.get(line);
		if (text === undefined) throw new ApplyValidationError(`Current snapshot proof is missing line ${line}.`);
		textBytes += Buffer.byteLength(text, "utf8");
		if (textBytes > 4 * 1024 * 1024) throw new ApplyValidationError("Current snapshot proof exceeds the 4 MiB proof budget.");
		lines.set(line, text);
	}
	return { lines, ranges: proofRanges(lines) };
}

export function buildApplyWireRequest(
	path: string,
	expectedRevision: string,
	proof: readonly SnaplineProofRange[],
	prepared: PreparedModelBatch,
): SnaplineApplyRequest {
	return {
		protocolVersion: 1,
		path,
		expectedRevision,
		proof: proof.map((range) => ({ start: range.start, lines: [...range.lines] })),
		replacements: prepared.changes
			.filter((change) => change.group === "replacement")
			.sort((left, right) => left.groupIndex - right.groupIndex)
			.map((change) => ({ start: change.start, end: change.end, text: change.text })),
		deletions: prepared.changes
			.filter((change) => change.group === "deletion")
			.sort((left, right) => left.groupIndex - right.groupIndex)
			.map((change) => ({ start: change.start, end: change.end })),
		insertionsBefore: prepared.changes
			.filter((change): change is PreparedInsertion => change.group === "insertion_before")
			.sort((left, right) => left.groupIndex - right.groupIndex)
			.map((change) => ({ line: change.line, text: change.text })),
		insertionsAfter: prepared.changes
			.filter((change): change is PreparedInsertion => change.group === "insertion_after")
			.sort((left, right) => left.groupIndex - right.groupIndex)
			.map((change) => ({ line: change.line, text: change.text })),
	};
}

function expectedStats(
	changes: readonly PreparedModelChange[],
	effective: readonly PreparedModelChange[],
	oldLineCount: number,
): SnaplineApplyStats {
	let insertedLines = 0;
	let deletedLines = 0;
	for (const change of effective) {
		insertedLines += producedLines(change).length;
		const coordinates = oldCoordinates(change);
		deletedLines += Math.max(0, coordinates.oldEnd - coordinates.oldStart + 1);
	}
	return {
		requestedChanges: changes.length,
		effectiveChanges: effective.length,
		oldLineCount,
		newLineCount: oldLineCount + insertedLines - deletedLines,
		insertedLines,
		deletedLines,
	};
}

function sameStats(left: SnaplineApplyStats, right: SnaplineApplyStats): boolean {
	return left.requestedChanges === right.requestedChanges && left.effectiveChanges === right.effectiveChanges &&
		left.oldLineCount === right.oldLineCount && left.newLineCount === right.newLineCount &&
		left.insertedLines === right.insertedLines && left.deletedLines === right.deletedLines;
}

export type ValidatedApplySuccess = {
	result: SnaplineApplySuccess;
	effects: SnaplineEditEffect[];
	effectiveChanges: PreparedModelChange[];
	generatedLines: Map<number, string>;
};

export function validateApplySuccess(
	result: SnaplineApplySuccess,
	prepared: PreparedModelBatch,
	head: SnapshotNode,
	sourceProof: ReadonlyMap<number, string>,
): ValidatedApplySuccess {
	if (result.sourceRevision !== head.revision) throw new ApplyValidationError("CLI source revision does not match the current lineage head.");
	const orderedChanges = [...prepared.changes].sort((left, right) => groupOrder(left.group) - groupOrder(right.group) || left.groupIndex - right.groupIndex);
	if (result.effects.length !== orderedChanges.length) throw new ApplyValidationError("CLI returned the wrong number of edit effects.");
	const effectiveChanges = orderedChanges.filter((change) => changeIsEffective(change, sourceProof));
	for (const [index, change] of orderedChanges.entries()) {
		const effect = result.effects[index]!;
		const coordinates = oldCoordinates(change);
		const generated = producedLines(change);
		const changed = effectiveChanges.includes(change);
		const consumed = Math.max(0, coordinates.oldEnd - coordinates.oldStart + 1);
		const lineDelta = changed ? generated.length - consumed : 0;
		const newStart = expectedNewStart(change, effectiveChanges);
		if (
			effect.group !== change.group || effect.groupIndex !== change.groupIndex || effect.changed !== changed ||
			effect.oldStart !== coordinates.oldStart || effect.oldEnd !== coordinates.oldEnd ||
			effect.newLineCount !== generated.length || effect.lineDelta !== lineDelta ||
			effect.newStart !== newStart || effect.newEnd !== newStart + generated.length - 1
		) throw new ApplyValidationError(`CLI effect ${effect.group} ${effect.groupIndex} does not match the translated request.`);
	}
	const stats = expectedStats(orderedChanges, effectiveChanges, head.totalLines);
	if (!sameStats(result.stats, stats)) throw new ApplyValidationError("CLI aggregate statistics do not match the validated effects.");
	if ((result.outcome === "applied") !== (effectiveChanges.length > 0)) throw new ApplyValidationError("CLI outcome does not match the effective changes.");
	const generatedLines = new Map<number, string>();
	for (const [index, change] of orderedChanges.entries()) {
		const effect = result.effects[index]!;
		if (!effect.changed) continue;
		for (const [offset, text] of producedLines(change).entries()) {
			const line = effect.newStart + offset;
			if (generatedLines.has(line)) throw new ApplyValidationError(`CLI produced ranges overlap at line ${line}.`);
			generatedLines.set(line, text);
		}
	}
	return { result, effects: result.effects.map((effect) => ({ ...effect })), effectiveChanges, generatedLines };
}
