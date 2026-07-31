import assert from "node:assert/strict";
import test from "node:test";

import { recordSnaplineFileOperations } from "../src/compaction-files.ts";
import { restoreSnapshotLedgerFromBranch } from "../src/replay.ts";
import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "../src/schema.ts";
import { SnapshotLedger } from "../src/snapshot-ledger.ts";
import type { SnaplineEditEffect } from "../src/wire.ts";

const revision = (character: string) => `sha256:${character.repeat(64)}`;

function ledgerWithDeterminism(): SnapshotLedger {
	let counter = 0;
	return new SnapshotLedger({ randomBytes: (size) => {
		const bytes = Buffer.alloc(size);
		bytes.writeUInt32BE(counter++, size - 4);
		return bytes;
	} });
}

function toolEntry(toolName: string, details: unknown) {
	if (typeof details === "object" && details !== null && !Array.isArray(details)) {
		const normalized = { ...(details as Record<string, unknown>) };
		const delta = normalized.snapshotDelta;
		if (typeof delta === "object" && delta !== null && !Array.isArray(delta)) {
			const node = (delta as Record<string, unknown>).node;
			const canonicalFileKey = (delta as Record<string, unknown>).canonicalFileKey;
			if (typeof node === "object" && node !== null && !Array.isArray(node)) {
				const snapshotNode = node as Record<string, unknown>;
				if (typeof canonicalFileKey === "string") normalized.canonicalFileKey ??= canonicalFileKey;
				normalized.snapshot ??= snapshotNode.snapshot;
				normalized.revision ??= snapshotNode.revision;
				normalized.totalLines ??= snapshotNode.totalLines;
				if (toolName === SNAPLINE_APPLY_TOOL && normalized.contentChanged === true) {
					const persistedEffects = Array.isArray(snapshotNode.effectsFromParent) ? snapshotNode.effectsFromParent as Array<Record<string, unknown>> : [];
					const insertedLines = persistedEffects.reduce((sum, effect) => sum + Number(effect.newLineCount), 0);
					const deletedLines = persistedEffects.reduce((sum, effect) => sum + Math.max(0, Number(effect.oldEnd) - Number(effect.oldStart) + 1), 0);
					const newLineCount = Number(snapshotNode.totalLines);
					normalized.stats ??= {
						requestedChanges: persistedEffects.length,
						effectiveChanges: persistedEffects.length,
						oldLineCount: newLineCount - insertedLines + deletedLines,
						newLineCount,
						insertedLines,
						deletedLines,
					};
					normalized.effects ??= persistedEffects;
				}
			}
		}
		if (typeof normalized.recovery === "object" && normalized.recovery !== null && !Array.isArray(normalized.recovery)) {
			const recovery = { ...(normalized.recovery as Record<string, unknown>) };
			const recoveryDelta = recovery.snapshotDelta;
			if (typeof recoveryDelta === "object" && recoveryDelta !== null && !Array.isArray(recoveryDelta)) {
				const recoveryNode = (recoveryDelta as Record<string, unknown>).node;
				const recoveryKey = (recoveryDelta as Record<string, unknown>).canonicalFileKey;
				if (typeof recoveryNode === "object" && recoveryNode !== null && !Array.isArray(recoveryNode)) {
					const node = recoveryNode as Record<string, unknown>;
					recovery.snapshot ??= node.snapshot;
					recovery.revision ??= node.revision;
					recovery.totalLines ??= node.totalLines;
					normalized.canonicalFileKey ??= recoveryKey;
				}
			}
			normalized.recovery = recovery;
		}
		return { type: "message", message: { role: "toolResult", toolName, details: normalized } };
	}
	return { type: "message", message: { role: "toolResult", toolName, details } };
}

function readAndChildDeltas() {
	const ledger = ledgerWithDeterminism();
	const rootStage = ledger.stageRead("file", revision("a"), 2, new Map([[1, "one"], [2, "two"]]), new Map([[1, "one"], [2, "two"]]));
	const root = ledger.commit(rootStage, new Map([[1, "one"], [2, "two"]]), false, new Map([[1, "one"], [2, "two"]]));
	const effect: SnaplineEditEffect = {
		group: "replacement", groupIndex: 0, changed: true,
		oldStart: 2, oldEnd: 2, newLineCount: 1, lineDelta: 0, newStart: 2, newEnd: 2,
	};
	const childStage = ledger.stageChangedApply("file", revision("b"), 2, [effect], new Map([[2, "TWO"]]), new Map([[2, "TWO"]]));
	const child = ledger.commit(childStage, new Map([[2, "TWO"]]), false, new Map([[2, "TWO"]]));
	return { root, child };
}

test("branch replay reconstructs lineage exclusively from typed details", () => {
	const { root, child } = readAndChildDeltas();
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true, snapshotDelta: child.delta }),
	], restored);
	const lookup = restored.lookup("file", root.node.id);
	assert.equal(lookup.ok, true);
	if (lookup.ok) assert.equal(lookup.value.head.id, child.node.id);
});

test("native mutation barriers discard earlier proof before replaying later deltas", () => {
	const { root, child } = readAndChildDeltas();
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry("write", undefined),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true, snapshotDelta: child.delta }),
	], restored);
	assert.deepEqual(restored.lookup("file", root.node.id), { ok: false, reason: "unknown_snapshot" });
	assert.equal(restored.lookup("file", child.node.id).ok, true);
});

test("outcome_unknown clears old lineage and restores only bounded recovery", () => {
	const { root } = readAndChildDeltas();
	const recoveryLedger = ledgerWithDeterminism();
	const stage = recoveryLedger.stageRecovery("file", revision("c"), 1, new Map([[1, "current"]]), new Map([[1, "current"]]));
	const recovery = recoveryLedger.commit(stage, new Map([[1, "current"]]), false, new Map([[1, "current"]]));
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "outcome_unknown", recovery: { snapshotDelta: recovery.delta } }),
	], restored);
	assert.deepEqual(restored.lookup("file", root.node.id), { ok: false, reason: "unknown_snapshot" });
	assert.equal(restored.lookup("file", recovery.node.id).ok, true);
});

test("replay rejects tampered lineage coordinates instead of translating through them", () => {
	const { root, child } = readAndChildDeltas();
	const tampered = structuredClone(child.delta);
	tampered.node.effectsFromParent![0]!.newStart = 1;
	tampered.node.effectsFromParent![0]!.newEnd = 1;
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true, snapshotDelta: tampered }),
	], restored);
	assert.equal(restored.head("file"), undefined);
});


test("replay rejects an apply envelope that disagrees with its snapshot delta", () => {
	const { root, child } = readAndChildDeltas();
	const mismatchedEffect = { ...child.delta.node.effectsFromParent![0]!, oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 };
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, {
			protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true,
			effects: [mismatchedEffect], snapshotDelta: child.delta,
		}),
	], restored);
	assert.equal(restored.head("file"), undefined);
});


test("replay accepts a valid mixed-group simultaneous lineage batch", () => {
	const ledger = ledgerWithDeterminism();
	const sourceLines = new Map(Array.from({ length: 5 }, (_, index) => [index + 1, `line-${index + 1}`] as const));
	const rootStage = ledger.stageRead("file", revision("a"), 5, sourceLines, sourceLines);
	const root = ledger.commit(rootStage, sourceLines, false, sourceLines);
	const effects: SnaplineEditEffect[] = [
		{ group: "replacement", groupIndex: 0, changed: true, oldStart: 3, oldEnd: 3, newLineCount: 2, lineDelta: 1, newStart: 4, newEnd: 5 },
		{ group: "deletion", groupIndex: 0, changed: true, oldStart: 5, oldEnd: 5, newLineCount: 0, lineDelta: -1, newStart: 8, newEnd: 7 },
		{ group: "insertion_before", groupIndex: 0, changed: true, oldStart: 1, oldEnd: 0, newLineCount: 1, lineDelta: 1, newStart: 1, newEnd: 1 },
		{ group: "insertion_after", groupIndex: 0, changed: true, oldStart: 5, oldEnd: 4, newLineCount: 1, lineDelta: 1, newStart: 7, newEnd: 7 },
	];
	const generated = new Map([[1, "before"], [4, "replacement-a"], [5, "replacement-b"], [7, "after"]]);
	const childStage = ledger.stageChangedApply("file", revision("b"), 7, effects, generated, generated);
	const child = ledger.commit(childStage, generated, false, generated);
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true, snapshotDelta: child.delta }),
	], restored);
	const lookup = restored.lookup("file", root.node.id);
	assert.equal(lookup.ok, true);
	if (lookup.ok) assert.equal(lookup.value.head.id, child.node.id);
});

test("malformed changed-apply replay fails closed", () => {
	const { root } = readAndChildDeltas();
	const restored = new SnapshotLedger();
	restoreSnapshotLedgerFromBranch([
		toolEntry(SNAPLINE_READ_TOOL, { protocolVersion: 1, operation: "read", disposition: "succeeded", snapshotDelta: root.delta }),
		toolEntry(SNAPLINE_APPLY_TOOL, { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true }),
	], restored);
	assert.equal(restored.head("file"), undefined);
});

test("compaction records read, edit, no-op, recovery, and uncertain operations", () => {
	const fileOps = { read: new Set<string>(), edited: new Set<string>() };
	recordSnaplineFileOperations([
		{ role: "toolResult", toolName: SNAPLINE_READ_TOOL, details: { protocolVersion: 1, operation: "read", disposition: "succeeded", path: "read.txt" } },
		{ role: "toolResult", toolName: SNAPLINE_APPLY_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: true, path: "changed.txt" } },
		{ role: "toolResult", toolName: SNAPLINE_APPLY_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "succeeded", contentChanged: false, path: "noop.txt" } },
		{ role: "toolResult", toolName: SNAPLINE_APPLY_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "needs_review", path: "recovered.txt", recovery: { snapshot: "s_token" } } },
		{ role: "toolResult", toolName: SNAPLINE_APPLY_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "outcome_unknown", path: "uncertain.txt" } },
		{ role: "toolResult", toolName: SNAPLINE_READ_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "succeeded", path: "ignored.txt" } },
	], fileOps);
	assert.deepEqual([...fileOps.read].sort(), ["noop.txt", "read.txt", "recovered.txt"]);
	assert.deepEqual([...fileOps.edited].sort(), ["changed.txt", "uncertain.txt"]);
});
