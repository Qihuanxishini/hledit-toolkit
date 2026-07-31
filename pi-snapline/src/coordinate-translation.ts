import type { SnaplineApplyParams } from "./schema.ts";
import type { SnaplineChangeGroup, SnaplineEditEffect } from "./wire.ts";
import { IntervalSet } from "./interval-set.ts";

export const MAX_TOTAL_CHANGES = 200;
export const MAX_CHANGE_TEXT_BYTES = 1024 * 1024;
export const MAX_PRODUCED_LINES = 20_000;

export type PreparedReplacement = {
	group: "replacement";
	groupIndex: number;
	start: number;
	end: number;
	text: string;
	producedLines: string[];
};
export type PreparedDeletion = {
	group: "deletion";
	groupIndex: number;
	start: number;
	end: number;
};
export type PreparedInsertion = {
	group: "insertion_before" | "insertion_after";
	groupIndex: number;
	line: number;
	boundary: number;
	text: string;
	producedLines: string[];
};
export type PreparedModelChange = PreparedReplacement | PreparedDeletion | PreparedInsertion;

export type PreparedModelBatch = {
	changes: PreparedModelChange[];
	totalTextBytes: number;
	producedLineCount: number;
};

export type LineageEffectBatch = readonly SnaplineEditEffect[];

export class SnaplineRequestError extends Error {
	readonly code: "invalid_request" | "range_out_of_bounds" | "exposure_missing" | "lineage_conflict";
	readonly change?: { group: SnaplineChangeGroup; groupIndex: number };

	constructor(code: SnaplineRequestError["code"], message: string, change?: { group: SnaplineChangeGroup; groupIndex: number }) {
		super(message);
		this.name = "SnaplineRequestError";
		this.code = code;
		this.change = change;
	}
}

export function decodeSnaplineText(text: string): { lines: string[]; endsWithLF: boolean } {
	if (text.includes("\r")) throw new SnaplineRequestError("invalid_request", "Change text must not contain carriage returns.");
	if (text.includes("\0")) throw new SnaplineRequestError("invalid_request", "Change text must not contain NUL bytes.");
	const endsWithLF = text.endsWith("\n");
	const lines = text.split("\n");
	if (endsWithLF) lines.pop();
	return { lines, endsWithLF };
}

function changeReference(change: PreparedModelChange): { group: SnaplineChangeGroup; groupIndex: number } {
	return { group: change.group, groupIndex: change.groupIndex };
}

function consumedRange(change: PreparedModelChange): { start: number; end: number } | undefined {
	return change.group === "replacement" || change.group === "deletion"
		? { start: change.start, end: change.end }
		: undefined;
}

function insertionBoundary(change: PreparedModelChange): number | undefined {
	return change.group === "insertion_before" || change.group === "insertion_after" ? change.boundary : undefined;
}

function validateSourceConflicts(changes: readonly PreparedModelChange[]): void {
	for (let firstIndex = 0; firstIndex < changes.length; firstIndex++) {
		const first = changes[firstIndex]!;
		for (let secondIndex = firstIndex + 1; secondIndex < changes.length; secondIndex++) {
			const second = changes[secondIndex]!;
			const firstRange = consumedRange(first);
			const secondRange = consumedRange(second);
			const firstBoundary = insertionBoundary(first);
			const secondBoundary = insertionBoundary(second);
			let conflict = false;
			if (firstRange && secondRange) {
				conflict = firstRange.start <= secondRange.end && secondRange.start <= firstRange.end;
			} else if (firstBoundary !== undefined && secondBoundary !== undefined) {
				conflict = firstBoundary === secondBoundary;
			} else {
				const boundary = firstBoundary ?? secondBoundary;
				const range = firstRange ?? secondRange;
				conflict = boundary !== undefined && range !== undefined && boundary >= range.start && boundary < range.end;
			}
			if (conflict) {
				throw new SnaplineRequestError(
					"invalid_request",
					`${second.group} ${second.groupIndex} conflicts with ${first.group} ${first.groupIndex}.`,
					changeReference(second),
				);
			}
		}
	}
}

export function prepareModelBatch(
	params: SnaplineApplyParams,
	totalLines: number,
	exposedCoverage: IntervalSet,
	exposedEmptyBoundary: boolean,
): PreparedModelBatch {
	const replacements = params.replacements ?? [];
	const deletions = params.deletions ?? [];
	const insertionsBefore = params.insertions_before ?? [];
	const insertionsAfter = params.insertions_after ?? [];
	const totalChanges = replacements.length + deletions.length + insertionsBefore.length + insertionsAfter.length;
	if (totalChanges === 0) throw new SnaplineRequestError("invalid_request", "At least one change group must be non-empty.");
	if (totalChanges > MAX_TOTAL_CHANGES) throw new SnaplineRequestError("invalid_request", `A batch accepts at most ${MAX_TOTAL_CHANGES} changes.`);
	if ([replacements, deletions, insertionsBefore, insertionsAfter].some((group) => group.length > 100)) {
		throw new SnaplineRequestError("invalid_request", "Each change group accepts at most 100 items.");
	}

	if (totalLines === 0) {
		if (!exposedEmptyBoundary) throw new SnaplineRequestError("exposure_missing", "The empty-file boundary was not exposed by this snapshot.");
		if (replacements.length !== 0 || deletions.length !== 0 || insertionsAfter.length !== 0 || insertionsBefore.length !== 1 || insertionsBefore[0]?.line !== 1) {
			throw new SnaplineRequestError("range_out_of_bounds", "An empty snapshot only accepts one insertion before line 1.");
		}
		if (insertionsBefore[0]?.text === "") throw new SnaplineRequestError("invalid_request", "Empty-file insertion text must not be empty.");
	}

	const changes: PreparedModelChange[] = [];
	let totalTextBytes = 0;
	let producedLineCount = 0;
	const decode = (text: string, group: SnaplineChangeGroup, groupIndex: number): string[] => {
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > MAX_CHANGE_TEXT_BYTES - totalTextBytes) {
			throw new SnaplineRequestError("invalid_request", `Change text exceeds the ${MAX_CHANGE_TEXT_BYTES}-byte batch limit.`, { group, groupIndex });
		}
		let lines: string[];
		try {
			lines = decodeSnaplineText(text).lines;
		} catch (error) {
			if (error instanceof SnaplineRequestError) {
				throw new SnaplineRequestError(error.code, error.message, { group, groupIndex });
			}
			throw error;
		}
		if (lines.length > MAX_PRODUCED_LINES - producedLineCount) {
			throw new SnaplineRequestError("invalid_request", `Changes produce more than ${MAX_PRODUCED_LINES} logical lines.`, { group, groupIndex });
		}
		totalTextBytes += textBytes;
		producedLineCount += lines.length;
		return lines;
	};
	const validateRange = (start: number, end: number, group: SnaplineChangeGroup, groupIndex: number) => {
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > totalLines) {
			throw new SnaplineRequestError("range_out_of_bounds", `${group} ${groupIndex} is outside snapshot lines 1-${totalLines}.`, { group, groupIndex });
		}
		if (!exposedCoverage.covers(start, end)) {
			throw new SnaplineRequestError("exposure_missing", `${group} ${groupIndex} uses lines not exposed by the submitted snapshot.`, { group, groupIndex });
		}
	};
	for (const [groupIndex, replacement] of replacements.entries()) {
		validateRange(replacement.start, replacement.end, "replacement", groupIndex);
		changes.push({ group: "replacement", groupIndex, ...replacement, producedLines: decode(replacement.text, "replacement", groupIndex) });
	}
	for (const [groupIndex, deletion] of deletions.entries()) {
		validateRange(deletion.start, deletion.end, "deletion", groupIndex);
		changes.push({ group: "deletion", groupIndex, ...deletion });
	}
	for (const [groupIndex, insertion] of insertionsBefore.entries()) {
		if (totalLines !== 0) validateRange(insertion.line, insertion.line, "insertion_before", groupIndex);
		changes.push({
			group: "insertion_before",
			groupIndex,
			...insertion,
			boundary: insertion.line - 1,
			producedLines: decode(insertion.text, "insertion_before", groupIndex),
		});
	}
	for (const [groupIndex, insertion] of insertionsAfter.entries()) {
		validateRange(insertion.line, insertion.line, "insertion_after", groupIndex);
		changes.push({
			group: "insertion_after",
			groupIndex,
			...insertion,
			boundary: insertion.line,
			producedLines: decode(insertion.text, "insertion_after", groupIndex),
		});
	}
	validateSourceConflicts(changes);
	return { changes, totalTextBytes, producedLineCount };
}

function translateRangeAcrossBatch(
	start: number,
	end: number,
	effects: LineageEffectBatch,
	change: PreparedModelChange,
): { start: number; end: number } {
	let shift = 0;
	for (const effect of effects) {
		if (!effect.changed) continue;
		if (effect.oldEnd >= effect.oldStart) {
			if (effect.oldStart <= end && start <= effect.oldEnd) {
				throw new SnaplineRequestError("lineage_conflict", `${change.group} ${change.groupIndex} was touched by a later edit.`, changeReference(change));
			}
			if (effect.oldEnd < start) shift += effect.lineDelta;
		} else {
			const boundary = effect.oldEnd;
			if (start <= boundary && boundary < end) {
				throw new SnaplineRequestError("lineage_conflict", `${change.group} ${change.groupIndex} contains a later insertion boundary.`, changeReference(change));
			}
			if (boundary < start) shift += effect.lineDelta;
		}
	}
	return { start: start + shift, end: end + shift };
}

function translateInsertionAcrossBatch(change: PreparedInsertion, effects: LineageEffectBatch): PreparedInsertion {
	const mappedAnchor = translateRangeAcrossBatch(change.line, change.line, effects, change).start;
	let boundaryShift = 0;
	for (const effect of effects) {
		if (!effect.changed) continue;
		if (effect.oldEnd >= effect.oldStart) {
			if (effect.oldStart <= change.boundary && change.boundary < effect.oldEnd) {
				throw new SnaplineRequestError("lineage_conflict", `${change.group} ${change.groupIndex} boundary was consumed by a later edit.`, changeReference(change));
			}
			if (effect.oldEnd <= change.boundary) boundaryShift += effect.lineDelta;
		} else {
			const historicalBoundary = effect.oldEnd;
			if (historicalBoundary === change.boundary) {
				throw new SnaplineRequestError("lineage_conflict", `${change.group} ${change.groupIndex} reuses a later insertion boundary.`, changeReference(change));
			}
			if (historicalBoundary < change.boundary) boundaryShift += effect.lineDelta;
		}
	}
	const mappedBoundary = change.boundary + boundaryShift;
	const expectedBoundary = change.group === "insertion_before" ? mappedAnchor - 1 : mappedAnchor;
	if (mappedBoundary !== expectedBoundary) {
		throw new SnaplineRequestError("lineage_conflict", `${change.group} ${change.groupIndex} no longer has a unique attachment boundary.`, changeReference(change));
	}
	return { ...change, line: mappedAnchor, boundary: mappedBoundary };
}

export function translateModelBatch(
	prepared: PreparedModelBatch,
	lineage: readonly LineageEffectBatch[],
): PreparedModelBatch {
	let changes = prepared.changes.map((change): PreparedModelChange =>
		"producedLines" in change ? { ...change, producedLines: [...change.producedLines] } : { ...change },
	);
	for (const effects of lineage) {
		changes = changes.map((change): PreparedModelChange => {
			if ("line" in change) return translateInsertionAcrossBatch(change, effects);
			const mapped = translateRangeAcrossBatch(change.start, change.end, effects, change);
			return { ...change, ...mapped };
		});
	}
	validateSourceConflicts(changes);
	return { ...prepared, changes };
}
