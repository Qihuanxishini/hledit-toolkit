import { SnapshotLedger, parseSnapshotDelta, type SnapshotDelta } from "./snapshot-ledger.ts";
import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "./schema.ts";
import type { SnaplineEditEffect } from "./wire.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

const EFFECT_KEYS = ["group", "groupIndex", "changed", "oldStart", "oldEnd", "newLineCount", "lineDelta", "newStart", "newEnd"] as const;
const EFFECT_GROUPS = new Set(["replacement", "deletion", "insertion_before", "insertion_after"]);

function parsePersistedEffects(value: unknown): SnaplineEditEffect[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const effects: SnaplineEditEffect[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !hasOnlyKeys(entry, EFFECT_KEYS) || typeof entry.group !== "string" || !EFFECT_GROUPS.has(entry.group) || typeof entry.changed !== "boolean") return undefined;
		for (const key of ["groupIndex", "oldStart", "oldEnd", "newLineCount", "lineDelta", "newStart", "newEnd"] as const) {
			if (!Number.isSafeInteger(entry[key])) return undefined;
		}
		if (
			Number(entry.groupIndex) < 0 || Number(entry.oldStart) < 1 || Number(entry.oldEnd) < 0 || Number(entry.oldEnd) < Number(entry.oldStart) - 1 ||
			Number(entry.newLineCount) < 0 || Number(entry.newStart) < 1 || Number(entry.newEnd) !== Number(entry.newStart) + Number(entry.newLineCount) - 1
		) return undefined;
		effects.push(entry as SnaplineEditEffect);
	}
	return effects;
}

function sameEffect(left: SnaplineEditEffect, right: SnaplineEditEffect): boolean {
	return EFFECT_KEYS.every((key) => left[key] === right[key]);
}

function commonEnvelopeMatches(
	delta: SnapshotDelta,
	envelope: Record<string, unknown>,
	expectedCanonicalFileKey?: string,
): boolean {
	const canonicalFileKey = expectedCanonicalFileKey ?? envelope.canonicalFileKey;
	return typeof canonicalFileKey === "string" && canonicalFileKey === delta.canonicalFileKey &&
		typeof envelope.snapshot === "string" && envelope.snapshot === delta.node.snapshot &&
		typeof envelope.revision === "string" && envelope.revision === delta.node.revision &&
		Number.isSafeInteger(envelope.totalLines) && envelope.totalLines === delta.node.totalLines;
}

function restoreReadDelta(ledger: SnapshotLedger, details: Record<string, unknown>): boolean {
	const delta = parseSnapshotDelta(details.snapshotDelta);
	if (!delta || !commonEnvelopeMatches(delta, details)) return false;
	if (details.capacityRebased !== undefined && details.capacityRebased !== true) return false;
	if ((details.capacityRebased === true) !== (delta.node.capacityRebased === true)) return false;
	return ledger.restoreDelta(delta);
}

function restoreApplyDelta(ledger: SnapshotLedger, details: Record<string, unknown>): boolean {
	const delta = parseSnapshotDelta(details.snapshotDelta);
	if (
		!delta || typeof details.canonicalFileKey !== "string" || details.canonicalFileKey !== delta.canonicalFileKey ||
		typeof details.snapshot !== "string" || details.snapshot !== delta.node.snapshot || !isRecord(details.stats)
	) return false;
	const effects = parsePersistedEffects(details.effects);
	if (!effects) return false;
	const changedEffects = effects.filter((effect) => effect.changed);
	if (
		!Number.isSafeInteger(details.stats.requestedChanges) || details.stats.requestedChanges !== effects.length ||
		!Number.isSafeInteger(details.stats.effectiveChanges) || details.stats.effectiveChanges !== changedEffects.length ||
		!Number.isSafeInteger(details.stats.oldLineCount) || Number(details.stats.oldLineCount) < 0 ||
		!Number.isSafeInteger(details.stats.newLineCount) || details.stats.newLineCount !== delta.node.totalLines ||
		!Number.isSafeInteger(details.stats.insertedLines) || Number(details.stats.insertedLines) < 0 ||
		!Number.isSafeInteger(details.stats.deletedLines) || Number(details.stats.deletedLines) < 0 ||
		Number(details.stats.newLineCount) !== Number(details.stats.oldLineCount) + Number(details.stats.insertedLines) - Number(details.stats.deletedLines)
	) return false;
	if (details.capacityRebased !== undefined && details.capacityRebased !== true) return false;
	const capacityRebased = details.capacityRebased === true;
	if (capacityRebased !== (delta.node.capacityRebased === true)) return false;
	if (!capacityRebased) {
		if (delta.node.parentKey === undefined || delta.node.effectsFromParent === undefined) return false;
		if (delta.node.effectsFromParent.length !== changedEffects.length || !delta.node.effectsFromParent.every((effect, index) => sameEffect(effect, changedEffects[index]!))) return false;
	}
	return ledger.restoreDelta(delta);
}

function restoreRecoveryDelta(
	ledger: SnapshotLedger,
	recovery: Record<string, unknown>,
	canonicalFileKey: string | undefined,
): boolean {
	const delta = parseSnapshotDelta(recovery.snapshotDelta);
	return delta !== undefined && commonEnvelopeMatches(delta, recovery, canonicalFileKey) && ledger.restoreDelta(delta);
}

function clearAffectedFile(ledger: SnapshotLedger, details: Record<string, unknown>): void {
	if (typeof details.canonicalFileKey === "string" && details.canonicalFileKey.length > 0) {
		ledger.clearFile(details.canonicalFileKey);
	} else {
		ledger.clear();
	}
}

export function restoreSnapshotLedgerFromBranch(branchEntries: readonly unknown[], ledger: SnapshotLedger): void {
	ledger.clear();
	for (const entryValue of branchEntries) {
		if (!isRecord(entryValue) || entryValue.type !== "message" || !isRecord(entryValue.message)) continue;
		const message = entryValue.message;
		if (message.role !== "toolResult" || typeof message.toolName !== "string") continue;

		if (message.toolName !== SNAPLINE_READ_TOOL && message.toolName !== SNAPLINE_APPLY_TOOL) {
			if (message.toolName === "write" || message.toolName === "edit" || message.toolName === "hledit_apply_file_changes") ledger.clear();
			continue;
		}
		const expectedOperation = message.toolName === SNAPLINE_READ_TOOL ? "read" : "apply";
		if (!isRecord(message.details) || message.details.protocolVersion !== 1 || message.details.operation !== expectedOperation) {
			if (message.toolName === SNAPLINE_APPLY_TOOL) ledger.clear();
			continue;
		}
		const details = message.details;
		if (message.toolName === SNAPLINE_READ_TOOL) {
			if (details.disposition === "succeeded" && !restoreReadDelta(ledger, details)) clearAffectedFile(ledger, details);
			continue;
		}
		if (details.disposition === "outcome_unknown") clearAffectedFile(ledger, details);
		if (details.disposition === "succeeded" && details.contentChanged === true) {
			if (!restoreApplyDelta(ledger, details)) clearAffectedFile(ledger, details);
			continue;
		}
		if ((details.disposition === "needs_review" || details.disposition === "outcome_unknown") && isRecord(details.recovery)) {
			const canonicalFileKey = typeof details.canonicalFileKey === "string" ? details.canonicalFileKey : undefined;
			if (!restoreRecoveryDelta(ledger, details.recovery, canonicalFileKey)) clearAffectedFile(ledger, details);
		}
	}
}
