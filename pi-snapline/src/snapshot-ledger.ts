import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { IntervalSet, type InclusiveInterval } from "./interval-set.ts";
import { RAW_REVISION_PATTERN, type SnaplineEditEffect } from "./wire.ts";

export const MAX_FILE_LINEAGE_NODES = 32;
export const MAX_FILE_EVIDENCE_LINES = 10_000;
export const MAX_FILE_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_EVIDENCE_LINES = 50_000;
export const MAX_SESSION_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_DELTA_BYTES = 64 * 1024;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const FULL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATTERN = /^s_[A-Za-z0-9_-]{16}(?:[A-Za-z0-9_-]{27})?$/;


function hasOnlyKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

export type SnapshotNode = {
	occurrenceKey: string;
	id: string;
	fullDigest: string;
	occurrenceNonce: string;
	canonicalFileKey: string;
	revision: string;
	totalLines: number;
	parentKey?: string;
	effectsFromParent?: readonly SnaplineEditEffect[];
	exposedCoverage: IntervalSet;
	exposedEmptyBoundary: boolean;
	verifiedLines: Map<number, string>;
	touchedAt: number;
};

export type PersistedLineRange = { start: number; lines: string[] };
export type SnapshotNodeDelta = {
	occurrenceKey: string;
	snapshot: string;
	fullDigest: string;
	occurrenceNonce: string;
	revision: string;
	totalLines: number;
	parentKey?: string;
	effectsFromParent?: SnaplineEditEffect[];
	exposedRanges: InclusiveInterval[];
	exposedEmptyBoundary: boolean;
	verifiedRanges: PersistedLineRange[];
	capacityRebased?: true;
};

export type SnapshotDelta = {
	protocolVersion: 1;
	canonicalFileKey: string;
	node: SnapshotNodeDelta;
};

export type SnapshotStage = {
	canonicalFileKey: string;
	baseVersion: number;
	node: SnapshotNode;
	mode: "merge" | "append" | "root";
	capacityRebased: boolean;
};

export type CommittedSnapshot = {
	node: SnapshotNode;
	delta: SnapshotDelta;
	capacityRebased: boolean;
	evictedFileKeys: string[];
};

export type ResolvedSnapshot = {
	source: SnapshotNode;
	head: SnapshotNode;
	lineage: readonly (readonly SnaplineEditEffect[])[];
};

export type SnapshotLookupFailure = "unknown_snapshot" | "ambiguous_snapshot" | "snapshot_not_in_head_ancestry";

export type SnapshotLookup =
	| { ok: true; value: ResolvedSnapshot }
	| { ok: false; reason: SnapshotLookupFailure };

type FileLineage = {
	version: number;
	headKey: string;
	nodes: Map<string, SnapshotNode>;
	touchedAt: number;
};

type SnapshotLedgerOptions = {
	randomBytes?: (size: number) => Buffer;
	now?: () => number;
	occurrenceDigest?: (canonicalFileKey: string, revision: string, nonce: string) => string;
};

function cloneNode(node: SnapshotNode): SnapshotNode {
	return {
		...node,
		effectsFromParent: node.effectsFromParent?.map((effect) => ({ ...effect })),
		exposedCoverage: node.exposedCoverage.clone(),
		verifiedLines: new Map(node.verifiedLines),
	};
}

function lineMapBytes(lines: ReadonlyMap<number, string>): number {
	let bytes = 0;
	for (const text of lines.values()) bytes += Buffer.byteLength(text, "utf8");
	return bytes;
}

function lineageUsage(lineage: FileLineage): { lines: number; bytes: number } {
	let lines = 0;
	let bytes = 0;
	for (const node of lineage.nodes.values()) {
		lines += node.verifiedLines.size;
		bytes += lineMapBytes(node.verifiedLines);
	}
	return { lines, bytes };
}

function fileLineageWithinCapacity(lineage: FileLineage): boolean {
	const usage = lineageUsage(lineage);
	return lineage.nodes.size <= MAX_FILE_LINEAGE_NODES && usage.lines <= MAX_FILE_EVIDENCE_LINES && usage.bytes <= MAX_FILE_EVIDENCE_BYTES;
}

function sortedLineEntries(lines: ReadonlyMap<number, string>): [number, string][] {
	return [...lines.entries()].sort((left, right) => left[0] - right[0]);
}

function addBoundedLines(target: Map<number, string>, source: ReadonlyMap<number, string>): void {
	let bytes = lineMapBytes(target);
	for (const [line, text] of sortedLineEntries(source)) {
		if (target.has(line)) continue;
		const textBytes = Buffer.byteLength(text, "utf8");
		if (target.size >= MAX_FILE_EVIDENCE_LINES || textBytes > MAX_FILE_EVIDENCE_BYTES - bytes) continue;
		target.set(line, text);
		bytes += textBytes;
	}
}

function retainBoundedLines(priority: ReadonlyMap<number, string>, optional: ReadonlyMap<number, string>): Map<number, string> {
	const retained = new Map<number, string>();
	addBoundedLines(retained, priority);
	if (retained.size !== priority.size) throw new Error("Priority snapshot evidence exceeds the per-file capacity.");
	addBoundedLines(retained, optional);
	return retained;
}

function mapToRanges(lines: ReadonlyMap<number, string>): PersistedLineRange[] {
	const entries = sortedLineEntries(lines);
	const ranges: PersistedLineRange[] = [];
	for (const [line, text] of entries) {
		const current = ranges.at(-1);
		if (current && current.start + current.lines.length === line) current.lines.push(text);
		else ranges.push({ start: line, lines: [text] });
	}
	return ranges;
}

function rangesToMap(ranges: readonly PersistedLineRange[]): Map<number, string> {
	const lines = new Map<number, string>();
	for (const range of ranges) {
		for (const [offset, text] of range.lines.entries()) lines.set(range.start + offset, text);
	}
	return lines;
}

function exposureFromLines(lines: ReadonlyMap<number, string>): InclusiveInterval[] {
	return mapToRanges(lines).map((range) => ({ start: range.start, end: range.start + range.lines.length - 1 }));
}

function effectConsumesLine(effect: SnaplineEditEffect, line: number): boolean {
	return effect.oldEnd >= effect.oldStart && line >= effect.oldStart && line <= effect.oldEnd;
}

function mapVerifiedLinesAcrossEffects(
	lines: ReadonlyMap<number, string>,
	effects: readonly SnaplineEditEffect[],
): Map<number, string> {
	const mapped = new Map<number, string>();
	for (const [line, text] of lines) {
		if (effects.some((effect) => effect.changed && effectConsumesLine(effect, line))) continue;
		let shift = 0;
		for (const effect of effects) {
			if (!effect.changed) continue;
			if (effect.oldEnd >= effect.oldStart) {
				if (effect.oldEnd < line) shift += effect.lineDelta;
			} else if (effect.oldEnd < line) {
				shift += effect.lineDelta;
			}
		}
		mapped.set(line + shift, text);
	}
	return mapped;
}

function snapshotDigest(canonicalFileKey: string, revision: string, nonce: string): { hex: string; token: string } {
	const digest = createHash("sha256")
		.update("snapline\0", "utf8")
		.update(canonicalFileKey, "utf8")
		.update("\0", "utf8")
		.update(revision, "utf8")
		.update("\0", "utf8")
		.update(nonce, "utf8")
		.digest();
	return { hex: digest.toString("hex"), token: digest.toString("base64url") };
}

function shortSnapshotId(fullDigest: string): string {
	return `s_${Buffer.from(fullDigest, "hex").toString("base64url").slice(0, 16)}`;
}

function fullSnapshotId(fullDigest: string): string {
	return `s_${Buffer.from(fullDigest, "hex").toString("base64url")}`;
}

function isValidEffect(effect: unknown): effect is SnaplineEditEffect {
	if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return false;
	const value = effect as Record<string, unknown>;
	const groups = ["replacement", "deletion", "insertion_before", "insertion_after"];
	return hasOnlyKeys(value, ["group", "groupIndex", "changed", "oldStart", "oldEnd", "newLineCount", "lineDelta", "newStart", "newEnd"]) &&
		typeof value.group === "string" && groups.includes(value.group) &&
		Number.isSafeInteger(value.groupIndex) && Number(value.groupIndex) >= 0 &&
		typeof value.changed === "boolean" &&
		Number.isSafeInteger(value.oldStart) && Number(value.oldStart) >= 1 &&
		Number.isSafeInteger(value.oldEnd) && Number(value.oldEnd) >= 0 &&
		Number(value.oldEnd) >= Number(value.oldStart) - 1 &&
		Number.isSafeInteger(value.newLineCount) && Number(value.newLineCount) >= 0 &&
		Number.isSafeInteger(value.lineDelta) &&
		Number.isSafeInteger(value.newStart) && Number(value.newStart) >= 1 &&
		Number.isSafeInteger(value.newEnd) && Number(value.newEnd) === Number(value.newStart) + Number(value.newLineCount) - 1;
}

function sameEffect(left: SnaplineEditEffect, right: SnaplineEditEffect): boolean {
	return left.group === right.group && left.groupIndex === right.groupIndex && left.changed === right.changed &&
		left.oldStart === right.oldStart && left.oldEnd === right.oldEnd && left.newLineCount === right.newLineCount &&
		left.lineDelta === right.lineDelta && left.newStart === right.newStart && left.newEnd === right.newEnd;
}

function sameEffects(left: readonly SnaplineEditEffect[] | undefined, right: readonly SnaplineEditEffect[] | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.length === right.length && left.every((effect, index) => sameEffect(effect, right[index]!));
}


function effectGroupOrder(group: SnaplineEditEffect["group"]): number {
	switch (group) {
		case "replacement": return 0;
		case "deletion": return 1;
		case "insertion_before": return 2;
		case "insertion_after": return 3;
	}
}

function expectedEffectNewStart(effect: SnaplineEditEffect, effects: readonly SnaplineEditEffect[]): number | undefined {
	let newStart = effect.oldEnd < effect.oldStart ? effect.oldEnd + 1 : effect.oldStart;
	for (const other of effects) {
		if (other === effect) continue;
		if (effect.oldEnd < effect.oldStart) {
			const boundary = effect.oldEnd;
			if (other.oldEnd >= other.oldStart) {
				if (other.oldEnd <= boundary) newStart += other.lineDelta;
			} else if (other.oldEnd < boundary) {
				newStart += other.lineDelta;
			}
		} else if (other.oldEnd >= other.oldStart) {
			if (other.oldEnd < effect.oldStart) newStart += other.lineDelta;
		} else if (other.oldEnd < effect.oldStart) {
			newStart += other.lineDelta;
		}
		if (!Number.isSafeInteger(newStart)) return undefined;
	}
	return newStart;
}

function lineageEffectsAreValid(
	effects: readonly SnaplineEditEffect[],
	parentTotalLines: number,
	childTotalLines: number,
): boolean {
	if (effects.length === 0 || effects.length > 200) return false;
	let priorOrder = -1;
	let priorGroupIndex = -1;
	let lineDelta = 0;
	for (const effect of effects) {
		const order = effectGroupOrder(effect.group);
		if (!effect.changed || effect.groupIndex >= 100 || order < priorOrder || (order === priorOrder && effect.groupIndex <= priorGroupIndex)) return false;
		priorOrder = order;
		priorGroupIndex = effect.groupIndex;
		const consumed = Math.max(0, effect.oldEnd - effect.oldStart + 1);
		if (effect.group === "replacement" || effect.group === "deletion") {
			if (effect.oldEnd < effect.oldStart || effect.oldEnd > parentTotalLines) return false;
			if (effect.group === "replacement" ? effect.newLineCount < 1 : effect.newLineCount !== 0) return false;
		} else {
			if (effect.oldEnd !== effect.oldStart - 1 || effect.newLineCount < 1) return false;
			if (effect.group === "insertion_before") {
				if (parentTotalLines === 0 ? effect.oldStart !== 1 : effect.oldStart > parentTotalLines) return false;
			} else if (parentTotalLines === 0 || effect.oldStart < 2 || effect.oldStart > parentTotalLines + 1) return false;
		}
		if (effect.lineDelta !== effect.newLineCount - consumed) return false;
		const expectedNewStart = expectedEffectNewStart(effect, effects);
		if (expectedNewStart === undefined || effect.newStart !== expectedNewStart) return false;
		if (effect.newLineCount > 0 && effect.newEnd > childTotalLines) return false;
		if (effect.newLineCount === 0 && effect.newStart > childTotalLines + 1) return false;
		lineDelta += effect.lineDelta;
		if (!Number.isSafeInteger(lineDelta)) return false;
	}
	if (!Number.isSafeInteger(parentTotalLines + lineDelta) || parentTotalLines + lineDelta !== childTotalLines) return false;

	for (let leftIndex = 0; leftIndex < effects.length; leftIndex++) {
		const left = effects[leftIndex]!;
		for (let rightIndex = leftIndex + 1; rightIndex < effects.length; rightIndex++) {
			const right = effects[rightIndex]!;
			const leftConsumes = left.oldEnd >= left.oldStart;
			const rightConsumes = right.oldEnd >= right.oldStart;
			if (leftConsumes && rightConsumes && left.oldStart <= right.oldEnd && right.oldStart <= left.oldEnd) return false;
			if (!leftConsumes && !rightConsumes && left.oldEnd === right.oldEnd) return false;
			if (leftConsumes !== rightConsumes) {
				const range = leftConsumes ? left : right;
				const boundary = leftConsumes ? right.oldEnd : left.oldEnd;
				if (boundary >= range.oldStart && boundary < range.oldEnd) return false;
			}
			if (left.newLineCount > 0 && right.newLineCount > 0 && left.newStart <= right.newEnd && right.newStart <= left.newEnd) return false;
		}
	}
	return true;
}

export class SnapshotLedger {
	readonly #files = new Map<string, FileLineage>();
	readonly #ambiguousShortIds = new Set<string>();
	readonly #randomBytes: (size: number) => Buffer;
	readonly #occurrenceDigest: (canonicalFileKey: string, revision: string, nonce: string) => string;
	readonly #now: () => number;

	constructor(options: SnapshotLedgerOptions = {}) {
		this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
		this.#occurrenceDigest = options.occurrenceDigest ?? ((canonicalFileKey, revision, nonce) => snapshotDigest(canonicalFileKey, revision, nonce).hex);
		this.#now = options.now ?? Date.now;
	}

	clear(): void {
		this.#files.clear();
		this.#ambiguousShortIds.clear();
	}

	clearFile(canonicalFileKey: string): void {
		this.#files.delete(canonicalFileKey);
		this.#refreshCollisionIds();
	}

	head(canonicalFileKey: string): SnapshotNode | undefined {
		const lineage = this.#files.get(canonicalFileKey);
		const node = lineage?.nodes.get(lineage.headKey);
		return node ? cloneNode(node) : undefined;
	}

	hasEditableSnapshot(): boolean {
		for (const lineage of this.#files.values()) {
			for (const node of lineage.nodes.values()) {
				if (node.exposedEmptyBoundary || node.exposedCoverage.toArray().length > 0) return true;
			}
		}
		return false;
	}

	lookup(canonicalFileKey: string, snapshotId: string): SnapshotLookup {
		const lineage = this.#files.get(canonicalFileKey);
		if (!lineage) return { ok: false, reason: "unknown_snapshot" };
		if (snapshotId.length === 18 && this.#ambiguousShortIds.has(snapshotId)) {
			return { ok: false, reason: "ambiguous_snapshot" };
		}
		const candidates = [...lineage.nodes.values()].filter((node) =>
			node.id === snapshotId || shortSnapshotId(node.fullDigest) === snapshotId || fullSnapshotId(node.fullDigest) === snapshotId,
		);
		if (candidates.length === 0) return { ok: false, reason: "unknown_snapshot" };
		if (candidates.length > 1) return { ok: false, reason: "ambiguous_snapshot" };
		const source = candidates[0]!;
		const head = lineage.nodes.get(lineage.headKey);
		if (!head) return { ok: false, reason: "unknown_snapshot" };
		const reverseBatches: (readonly SnaplineEditEffect[])[] = [];
		let cursor: SnapshotNode | undefined = head;
		while (cursor && cursor.occurrenceKey !== source.occurrenceKey) {
			if (!cursor.parentKey || !cursor.effectsFromParent) break;
			reverseBatches.push(cursor.effectsFromParent);
			cursor = lineage.nodes.get(cursor.parentKey);
		}
		if (!cursor || cursor.occurrenceKey !== source.occurrenceKey) {
			return { ok: false, reason: "snapshot_not_in_head_ancestry" };
		}
		this.#touchLineage(lineage);
		return {
			ok: true,
			value: { source: cloneNode(source), head: cloneNode(head), lineage: reverseBatches.reverse().map((batch) => batch.map((effect) => ({ ...effect }))) },
		};
	}

	stageRead(
		canonicalFileKey: string,
		revision: string,
		totalLines: number,
		verifiedLines: ReadonlyMap<number, string>,
		priorityLines: ReadonlyMap<number, string>,
	): SnapshotStage {
		const lineage = this.#files.get(canonicalFileKey);
		const head = lineage?.nodes.get(lineage.headKey);
		let capacityRebased = false;
		if (lineage && head && head.revision === revision && head.totalLines === totalLines) {
			const node = cloneNode(head);
			for (const [line, text] of verifiedLines) {
				const existing = node.verifiedLines.get(line);
				if (existing !== undefined && existing !== text) throw new Error(`Conflicting verified text at line ${line}.`);
				node.verifiedLines.set(line, text);
			}
			const projected: FileLineage = { ...lineage, nodes: new Map(lineage.nodes) };
			projected.nodes.set(node.occurrenceKey, node);
			if (fileLineageWithinCapacity(projected)) {
				return { canonicalFileKey, baseVersion: lineage.version, node, mode: "merge", capacityRebased: false };
			}
			capacityRebased = true;
		}
		const retained = retainBoundedLines(priorityLines, verifiedLines);
		return {
			canonicalFileKey,
			baseVersion: lineage?.version ?? 0,
			node: this.#newNode(canonicalFileKey, revision, totalLines, retained),
			mode: "root",
			capacityRebased,
		};
	}

	stageRecovery(
		canonicalFileKey: string,
		revision: string,
		totalLines: number,
		verifiedLines: ReadonlyMap<number, string>,
		priorityLines: ReadonlyMap<number, string>,
	): SnapshotStage {
		const lineage = this.#files.get(canonicalFileKey);
		return {
			canonicalFileKey,
			baseVersion: lineage?.version ?? 0,
			node: this.#newNode(canonicalFileKey, revision, totalLines, retainBoundedLines(priorityLines, verifiedLines)),
			mode: "root",
			capacityRebased: false,
		};
	}

	stageChangedApply(
		canonicalFileKey: string,
		newRevision: string,
		newTotalLines: number,
		effects: readonly SnaplineEditEffect[],
		generatedLines: ReadonlyMap<number, string>,
		priorityLines: ReadonlyMap<number, string>,
	): SnapshotStage {
		const lineage = this.#files.get(canonicalFileKey);
		const head = lineage?.nodes.get(lineage.headKey);
		if (!lineage || !head) throw new Error("Cannot append a snapshot without a current lineage head.");
		const mapped = mapVerifiedLinesAcrossEffects(head.verifiedLines, effects);
		for (const [line, text] of generatedLines) mapped.set(line, text);
		const child = this.#newNode(canonicalFileKey, newRevision, newTotalLines, mapped, head.occurrenceKey, effects);
		const projected = { ...lineage, nodes: new Map(lineage.nodes) };
		projected.nodes.set(child.occurrenceKey, child);
		if (fileLineageWithinCapacity(projected)) {
			return { canonicalFileKey, baseVersion: lineage.version, node: child, mode: "append", capacityRebased: false };
		}
		const root = this.#newNode(
			canonicalFileKey,
			newRevision,
			newTotalLines,
			retainBoundedLines(priorityLines, mapped),
		);
		return { canonicalFileKey, baseVersion: lineage.version, node: root, mode: "root", capacityRebased: true };
	}

	previewDelta(
		stage: SnapshotStage,
		exposedLines: ReadonlyMap<number, string>,
		exposedEmptyBoundary: boolean,
		persistedLines: ReadonlyMap<number, string>,
	): SnapshotDelta {
		const pessimistic = cloneNode(stage.node);
		pessimistic.id = fullSnapshotId(pessimistic.fullDigest);
		return this.#buildDelta(pessimistic, exposedLines, exposedEmptyBoundary, persistedLines, stage.capacityRebased);
	}

	commit(
		stage: SnapshotStage,
		exposedLines: ReadonlyMap<number, string>,
		exposedEmptyBoundary: boolean,
		persistedLines: ReadonlyMap<number, string>,
	): CommittedSnapshot {
		const current = this.#files.get(stage.canonicalFileKey);
		if ((current?.version ?? 0) !== stage.baseVersion) throw new Error("Snapshot stage became stale before commit.");
		const node = cloneNode(stage.node);
		for (const [line, text] of exposedLines) {
			if (node.verifiedLines.get(line) !== text) throw new Error(`Exposed line ${line} is not exact verified text.`);
			node.exposedCoverage.add(line, line);
		}
		for (const [line, text] of persistedLines) {
			if (node.verifiedLines.get(line) !== text) throw new Error(`Persisted line ${line} is not exact verified text.`);
		}
		if (node.totalLines !== 0 && exposedEmptyBoundary) throw new Error("Only zero-line snapshots can expose the virtual boundary.");
		node.exposedEmptyBoundary ||= exposedEmptyBoundary;
		node.touchedAt = this.#now();

		let lineage: FileLineage;
		if (stage.mode === "root" || !current) {
			lineage = { version: (current?.version ?? 0) + 1, headKey: node.occurrenceKey, nodes: new Map([[node.occurrenceKey, node]]), touchedAt: node.touchedAt };
		} else {
			lineage = { ...current, version: current.version + 1, headKey: stage.mode === "append" ? node.occurrenceKey : current.headKey, nodes: new Map(current.nodes), touchedAt: node.touchedAt };
			lineage.nodes.set(node.occurrenceKey, node);
		}
		if (!fileLineageWithinCapacity(lineage)) throw new Error("Committed snapshot exceeds per-file capacity.");
		this.#files.set(stage.canonicalFileKey, lineage);
		this.#refreshCollisionIds();
		const committedNode = lineage.nodes.get(node.occurrenceKey)!;
		const delta = this.#buildDelta(committedNode, exposedLines, exposedEmptyBoundary, persistedLines, stage.capacityRebased);
		if (snapshotDeltaBytes(delta) > MAX_SNAPSHOT_DELTA_BYTES) {
			if (current) this.#files.set(stage.canonicalFileKey, current);
			else this.#files.delete(stage.canonicalFileKey);
			this.#refreshCollisionIds();
			throw new Error("Snapshot delta exceeds the replay budget.");
		}
		const evictedFileKeys = this.#enforceSessionCapacity(stage.canonicalFileKey);
		return { node: cloneNode(committedNode), delta, capacityRebased: stage.capacityRebased, evictedFileKeys };
	}

	restoreDelta(delta: SnapshotDelta): boolean {
		const parsed = parseSnapshotDelta(delta);
		if (!parsed) return false;
		const persisted = rangesToMap(parsed.node.verifiedRanges);
		const exposure = new IntervalSet(parsed.node.exposedRanges);
		const existing = this.#files.get(parsed.canonicalFileKey);
		const existingNode = existing?.nodes.get(parsed.node.occurrenceKey);
		if (existingNode) {
			if (
				existingNode.revision !== parsed.node.revision || existingNode.totalLines !== parsed.node.totalLines ||
				existingNode.parentKey !== parsed.node.parentKey || !sameEffects(existingNode.effectsFromParent, parsed.node.effectsFromParent)
			) return false;
			const merged = cloneNode(existingNode);
			for (const [line, text] of persisted) {
				const prior = merged.verifiedLines.get(line);
				if (prior !== undefined && prior !== text) return false;
				merged.verifiedLines.set(line, text);
			}
			for (const interval of exposure.toArray()) merged.exposedCoverage.add(interval.start, interval.end);
			merged.exposedEmptyBoundary ||= parsed.node.exposedEmptyBoundary;
			const nodes = new Map(existing!.nodes);
			nodes.set(merged.occurrenceKey, merged);
			this.#files.set(parsed.canonicalFileKey, { ...existing!, version: existing!.version + 1, nodes, touchedAt: this.#now() });
		} else {
			const parentKey = parsed.node.parentKey;
			const parent = parentKey ? existing?.nodes.get(parentKey) : undefined;
			let canAppend = false;
			if (parentKey !== undefined && existing !== undefined) {
				if (
					parent === undefined || existing.headKey !== parent.occurrenceKey || parsed.node.effectsFromParent === undefined ||
					!lineageEffectsAreValid(parsed.node.effectsFromParent, parent.totalLines, parsed.node.totalLines)
				) return false;
				canAppend = true;
			}
			const node: SnapshotNode = {
				occurrenceKey: parsed.node.occurrenceKey,
				id: parsed.node.snapshot,
				fullDigest: parsed.node.fullDigest,
				occurrenceNonce: parsed.node.occurrenceNonce,
				canonicalFileKey: parsed.canonicalFileKey,
				revision: parsed.node.revision,
				totalLines: parsed.node.totalLines,
				...(canAppend ? { parentKey, effectsFromParent: parsed.node.effectsFromParent } : {}),
				exposedCoverage: exposure,
				exposedEmptyBoundary: parsed.node.exposedEmptyBoundary,
				verifiedLines: persisted,
				touchedAt: this.#now(),
			};
			if (canAppend && existing) {
				const nodes = new Map(existing.nodes);
				nodes.set(node.occurrenceKey, node);
				const candidate = { ...existing, version: existing.version + 1, headKey: node.occurrenceKey, nodes, touchedAt: node.touchedAt };
				this.#files.set(parsed.canonicalFileKey, fileLineageWithinCapacity(candidate) ? candidate : {
					version: candidate.version,
					headKey: node.occurrenceKey,
					nodes: new Map([[node.occurrenceKey, { ...node, parentKey: undefined, effectsFromParent: undefined }]]),
					touchedAt: node.touchedAt,
				});
			} else {
				this.#files.set(parsed.canonicalFileKey, { version: (existing?.version ?? 0) + 1, headKey: node.occurrenceKey, nodes: new Map([[node.occurrenceKey, node]]), touchedAt: node.touchedAt });
			}
		}
		this.#refreshCollisionIds();
		this.#enforceSessionCapacity(parsed.canonicalFileKey);
		return true;
	}

	#newNode(
		canonicalFileKey: string,
		revision: string,
		totalLines: number,
		verifiedLines: ReadonlyMap<number, string>,
		parentKey?: string,
		effectsFromParent?: readonly SnaplineEditEffect[],
	): SnapshotNode {
		if (!RAW_REVISION_PATTERN.test(revision)) throw new Error(`Invalid raw revision ${revision}.`);
		for (let attempt = 0; attempt < 8; attempt++) {
			const nonce = this.#randomBytes(16).toString("base64url");
			if (!NONCE_PATTERN.test(nonce)) throw new Error("Snapshot random source did not produce 16 bytes.");
			const fullDigest = this.#occurrenceDigest(canonicalFileKey, revision, nonce);
			if (!FULL_DIGEST_PATTERN.test(fullDigest)) throw new Error("Snapshot digest source did not produce 32 bytes.");
			if ([...this.#files.values()].some((lineage) => lineage.nodes.has(fullDigest))) continue;
			const token = Buffer.from(fullDigest, "hex").toString("base64url");
			return {
				occurrenceKey: fullDigest,
				id: `s_${token.slice(0, 16)}`,
				fullDigest,
				occurrenceNonce: nonce,
				canonicalFileKey,
				revision,
				totalLines,
				...(parentKey ? { parentKey } : {}),
				...(effectsFromParent ? { effectsFromParent: effectsFromParent.map((effect) => ({ ...effect })) } : {}),
				exposedCoverage: new IntervalSet(),
				exposedEmptyBoundary: false,
				verifiedLines: new Map(verifiedLines),
				touchedAt: this.#now(),
			};
		}
		throw new Error("Could not allocate a unique snapshot occurrence.");
	}

	#buildDelta(
		node: SnapshotNode,
		exposedLines: ReadonlyMap<number, string>,
		exposedEmptyBoundary: boolean,
		persistedLines: ReadonlyMap<number, string>,
		capacityRebased: boolean,
	): SnapshotDelta {
		for (const [line, text] of exposedLines) {
			if (persistedLines.get(line) !== text) throw new Error(`Exposed line ${line} is absent from the persisted delta.`);
		}
		return {
			protocolVersion: 1,
			canonicalFileKey: node.canonicalFileKey,
			node: {
				occurrenceKey: node.occurrenceKey,
				snapshot: node.id,
				fullDigest: node.fullDigest,
				occurrenceNonce: node.occurrenceNonce,
				revision: node.revision,
				totalLines: node.totalLines,
				...(node.parentKey ? { parentKey: node.parentKey } : {}),
				...(node.effectsFromParent ? { effectsFromParent: node.effectsFromParent.map((effect) => ({ ...effect })) } : {}),
				exposedRanges: exposureFromLines(exposedLines),
				exposedEmptyBoundary,
				verifiedRanges: mapToRanges(persistedLines),
				...(capacityRebased ? { capacityRebased: true as const } : {}),
			},
		};
	}

	#refreshCollisionIds(): void {
		this.#ambiguousShortIds.clear();
		const byShortId = new Map<string, SnapshotNode[]>();
		for (const lineage of this.#files.values()) {
			for (const node of lineage.nodes.values()) {
				const shortId = shortSnapshotId(node.fullDigest);
				const colliders = byShortId.get(shortId) ?? [];
				colliders.push(node);
				byShortId.set(shortId, colliders);
			}
		}
		for (const [shortId, nodes] of byShortId) {
			if (new Set(nodes.map((node) => node.fullDigest)).size > 1) this.#ambiguousShortIds.add(shortId);
			const distinctDigests = new Set(nodes.map((node) => node.fullDigest));
			for (const node of nodes) node.id = distinctDigests.size > 1 ? fullSnapshotId(node.fullDigest) : shortId;
		}
	}

	#touchLineage(lineage: FileLineage): void {
		lineage.touchedAt = this.#now();
	}

	#enforceSessionCapacity(currentFileKey: string): string[] {
		const evicted: string[] = [];
		const usage = () => {
			let lines = 0;
			let bytes = 0;
			for (const lineage of this.#files.values()) {
				const fileUsage = lineageUsage(lineage);
				lines += fileUsage.lines;
				bytes += fileUsage.bytes;
			}
			return { lines, bytes };
		};
		for (;;) {
			const currentUsage = usage();
			if (currentUsage.lines <= MAX_SESSION_EVIDENCE_LINES && currentUsage.bytes <= MAX_SESSION_EVIDENCE_BYTES) break;
			const candidate = [...this.#files.entries()]
				.filter(([key]) => key !== currentFileKey)
				.sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
			if (!candidate) throw new Error("Current snapshot lineage exceeds the session capacity.");
			this.#files.delete(candidate[0]);
			evicted.push(candidate[0]);
		}
		if (evicted.length > 0) this.#refreshCollisionIds();
		return evicted;
	}
}

export function snapshotDeltaBytes(delta: SnapshotDelta): number {
	return Buffer.byteLength(JSON.stringify(delta), "utf8");
}

export function parseSnapshotDelta(value: unknown): SnapshotDelta | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	if (
		!hasOnlyKeys(root, ["protocolVersion", "canonicalFileKey", "node"]) || root.protocolVersion !== 1 ||
		typeof root.canonicalFileKey !== "string" || root.canonicalFileKey.length === 0 || root.canonicalFileKey.includes("\0") ||
		typeof root.node !== "object" || root.node === null || Array.isArray(root.node)
	) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_DELTA_BYTES) return undefined;
	const node = root.node as Record<string, unknown>;
	if (!hasOnlyKeys(
		node,
		["occurrenceKey", "snapshot", "fullDigest", "occurrenceNonce", "revision", "totalLines", "exposedRanges", "exposedEmptyBoundary", "verifiedRanges"],
		["parentKey", "effectsFromParent", "capacityRebased"],
	)) return undefined;
	if (
		typeof node.occurrenceKey !== "string" || !FULL_DIGEST_PATTERN.test(node.occurrenceKey) ||
		typeof node.snapshot !== "string" || !SNAPSHOT_PATTERN.test(node.snapshot) ||
		typeof node.fullDigest !== "string" || node.fullDigest !== node.occurrenceKey ||
		typeof node.occurrenceNonce !== "string" || !NONCE_PATTERN.test(node.occurrenceNonce) ||
		typeof node.revision !== "string" || !RAW_REVISION_PATTERN.test(node.revision) ||
		!Number.isSafeInteger(node.totalLines) || Number(node.totalLines) < 0 ||
		(node.parentKey !== undefined && (typeof node.parentKey !== "string" || !FULL_DIGEST_PATTERN.test(node.parentKey))) ||
		(node.exposedEmptyBoundary !== true && node.exposedEmptyBoundary !== false) ||
		(node.capacityRebased !== undefined && node.capacityRebased !== true) ||
		!Array.isArray(node.exposedRanges) || !Array.isArray(node.verifiedRanges)
	) return undefined;
	const digest = snapshotDigest(root.canonicalFileKey, node.revision, node.occurrenceNonce);
	if (digest.hex !== node.fullDigest || (node.snapshot !== `s_${digest.token.slice(0, 16)}` && node.snapshot !== `s_${digest.token}`)) return undefined;
	if (node.parentKey === node.occurrenceKey) return undefined;
	const effects = node.effectsFromParent;
	if (effects !== undefined && (!Array.isArray(effects) || !effects.every(isValidEffect))) return undefined;
	if ((node.parentKey === undefined) !== (effects === undefined)) return undefined;
	if (node.capacityRebased === true && node.parentKey !== undefined) return undefined;

	const verifiedRanges: PersistedLineRange[] = [];
	const verified = new Map<number, string>();
	let verifiedBytes = 0;
	for (const rawRange of node.verifiedRanges) {
		if (typeof rawRange !== "object" || rawRange === null || Array.isArray(rawRange)) return undefined;
		const range = rawRange as Record<string, unknown>;
		if (
			!hasOnlyKeys(range, ["start", "lines"]) || !Number.isSafeInteger(range.start) || Number(range.start) < 1 ||
			!Array.isArray(range.lines) || range.lines.length === 0 ||
			!range.lines.every((line) => typeof line === "string" && !/[\r\n\0]/.test(line))
		) return undefined;
		const start = Number(range.start);
		const end = start + range.lines.length - 1;
		if (!Number.isSafeInteger(end) || end > Number(node.totalLines)) return undefined;
		for (const [offset, text] of (range.lines as string[]).entries()) {
			const line = start + offset;
			if (verified.has(line)) return undefined;
			const textBytes = Buffer.byteLength(text, "utf8");
			if (verified.size >= MAX_FILE_EVIDENCE_LINES || textBytes > MAX_FILE_EVIDENCE_BYTES - verifiedBytes) return undefined;
			verifiedBytes += textBytes;
			verified.set(line, text);
		}
		verifiedRanges.push({ start, lines: [...range.lines as string[]] });
	}
	const exposedRanges: InclusiveInterval[] = [];
	const exposure = new IntervalSet();
	try {
		for (const rawRange of node.exposedRanges) {
			if (typeof rawRange !== "object" || rawRange === null || Array.isArray(rawRange)) return undefined;
			const range = rawRange as Record<string, unknown>;
			if (!hasOnlyKeys(range, ["start", "end"]) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return undefined;
			const start = Number(range.start);
			const end = Number(range.end);
			exposure.add(start, end);
			for (let line = start; line <= end; line++) if (!verified.has(line)) return undefined;
			exposedRanges.push({ start, end });
		}
	} catch {
		return undefined;
	}
	if (node.exposedEmptyBoundary === true && Number(node.totalLines) !== 0) return undefined;
	return {
		protocolVersion: 1,
		canonicalFileKey: root.canonicalFileKey,
		node: {
			occurrenceKey: node.occurrenceKey,
			snapshot: node.snapshot,
			fullDigest: node.fullDigest,
			occurrenceNonce: node.occurrenceNonce,
			revision: node.revision,
			totalLines: Number(node.totalLines),
			...(node.parentKey !== undefined ? { parentKey: node.parentKey, effectsFromParent: (effects as SnaplineEditEffect[]).map((effect) => ({ ...effect })) } : {}),
			exposedRanges,
			exposedEmptyBoundary: node.exposedEmptyBoundary,
			verifiedRanges,
			...(node.capacityRebased === true ? { capacityRebased: true as const } : {}),
		},
	};
}
