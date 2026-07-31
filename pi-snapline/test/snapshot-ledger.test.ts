import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_FILE_EVIDENCE_LINES,
	MAX_FILE_LINEAGE_NODES,
	MAX_SNAPSHOT_DELTA_BYTES,
	parseSnapshotDelta,
	SnapshotLedger,
	snapshotDeltaBytes,
	type SnapshotDelta,
} from "../src/snapshot-ledger.ts";
import type { SnaplineEditEffect } from "../src/wire.ts";

const revision = (character: string) => `sha256:${character.repeat(64)}`;

function deterministicLedger(): SnapshotLedger {
	let counter = 0;
	return new SnapshotLedger({
		randomBytes(size) {
			const value = Buffer.alloc(size);
			value.writeUInt32BE(counter++, size - 4);
			return value;
		},
		now: (() => {
			let now = 0;
			return () => ++now;
		})(),
	});
}

function commitRead(
	ledger: SnapshotLedger,
	key: string,
	rev: string,
	lines: Map<number, string>,
	exposed = lines,
) {
	const totalLines = lines.size === 0 ? 0 : Math.max(...lines.keys());
	const stage = ledger.stageRead(key, rev, totalLines, lines, exposed);
	return ledger.commit(stage, exposed, totalLines === 0, exposed);
}

function insertionEffect(groupIndex = 0): SnaplineEditEffect {
	return {
		group: "insertion_after", groupIndex, changed: true,
		oldStart: 2, oldEnd: 1, newLineCount: 1, lineDelta: 1, newStart: 2, newEnd: 2,
	};
}

test("unchanged reads merge proof into one occurrence", () => {
	const ledger = deterministicLedger();
	const firstStage = ledger.stageRead("file", revision("a"), 2, new Map([[1, "one"]]), new Map([[1, "one"]]));
	const first = ledger.commit(firstStage, new Map([[1, "one"]]), false, new Map([[1, "one"]]));
	const stage = ledger.stageRead("file", revision("a"), 2, new Map([[2, "two"]]), new Map([[2, "two"]]));
	assert.equal(stage.mode, "merge");
	const second = ledger.commit(stage, new Map([[2, "two"]]), false, new Map([[2, "two"]]));
	assert.equal(second.node.occurrenceKey, first.node.occurrenceKey);
	assert.deepEqual(second.node.exposedCoverage.toArray(), [{ start: 1, end: 2 }]);
	assert.deepEqual([...second.node.verifiedLines], [[1, "one"], [2, "two"]]);
	assert.equal(ledger.hasEditableSnapshot(), true);
});

test("changed snapshots preserve ancestry but never inherit parent exposure", () => {
	const ledger = deterministicLedger();
	const root = commitRead(ledger, "file", revision("a"), new Map([[1, "one"], [2, "two"]]));
	const effect = insertionEffect();
	const stage = ledger.stageChangedApply("file", revision("b"), 3, [effect], new Map([[2, "inserted"]]), new Map([[2, "inserted"]]));
	const child = ledger.commit(stage, new Map([[2, "inserted"]]), false, new Map([[2, "inserted"]]));
	assert.equal(child.node.parentKey, root.node.occurrenceKey);
	assert.deepEqual(child.node.exposedCoverage.toArray(), [{ start: 2, end: 2 }]);
	assert.equal(child.node.verifiedLines.get(1), "one");
	assert.equal(child.node.verifiedLines.get(2), "inserted");
	assert.equal(child.node.verifiedLines.get(3), "two");

	const lookup = ledger.lookup("file", root.node.id);
	assert.equal(lookup.ok, true);
	if (lookup.ok) {
		assert.equal(lookup.value.head.occurrenceKey, child.node.occurrenceKey);
		assert.deepEqual(lookup.value.lineage, [[effect]]);
	}
});

test("content reversion creates a distinct occurrence-bound snapshot", () => {
	const ledger = deterministicLedger();
	const first = commitRead(ledger, "file", revision("a"), new Map([[1, "same"]]));
	const recoveryStage = ledger.stageRecovery("file", revision("a"), 1, new Map([[1, "same"]]), new Map([[1, "same"]]));
	const second = ledger.commit(recoveryStage, new Map([[1, "same"]]), false, new Map([[1, "same"]]));
	assert.notEqual(second.node.occurrenceKey, first.node.occurrenceKey);
	assert.notEqual(second.node.id, first.node.id);
	assert.deepEqual(ledger.lookup("file", first.node.id), { ok: false, reason: "unknown_snapshot" });
});


test("short-id collisions expand deterministically and reject historical ambiguous ids", () => {
	const sharedPrefix = "01".repeat(12);
	const digests = [`${sharedPrefix}${"02".repeat(20)}`, `${sharedPrefix}${"03".repeat(20)}`];
	let digestIndex = 0;
	const ledger = new SnapshotLedger({
		randomBytes: (size) => Buffer.alloc(size, digestIndex + 1),
		occurrenceDigest: () => digests[digestIndex++]!,
	});
	const first = commitRead(ledger, "first", revision("a"), new Map([[1, "one"]]));
	const historicalShortId = first.node.id;
	commitRead(ledger, "second", revision("b"), new Map([[1, "two"]]));
	assert.equal(historicalShortId.length, 18);
	const expandedFirstId = ledger.head("first")!.id;
	assert.equal(expandedFirstId.length, 45);
	assert.equal(ledger.head("second")!.id.length, 45);
	assert.deepEqual(ledger.lookup("first", historicalShortId), { ok: false, reason: "ambiguous_snapshot" });
	assert.equal(ledger.lookup("first", expandedFirstId).ok, true);
	ledger.clearFile("second");
	assert.equal(ledger.head("first")!.id, historicalShortId);
	assert.equal(ledger.lookup("first", historicalShortId).ok, true);
	assert.equal(ledger.lookup("first", expandedFirstId).ok, true);
});

test("typed deltas restore only persisted proof and exposure", () => {
	const ledger = deterministicLedger();
	const committed = commitRead(
		ledger,
		"file",
		revision("a"),
		new Map([[1, "shown"], [2, "runtime-only"]]),
		new Map([[1, "shown"]]),
	);
	assert.ok(snapshotDeltaBytes(committed.delta) <= MAX_SNAPSHOT_DELTA_BYTES);
	const restored = deterministicLedger();
	assert.equal(restored.restoreDelta(committed.delta), true);
	const head = restored.head("file");
	assert.deepEqual([...head!.verifiedLines], [[1, "shown"]]);
	assert.deepEqual(head!.exposedCoverage.toArray(), [{ start: 1, end: 1 }]);
	assert.equal(restored.lookup("file", committed.node.id).ok, true);
});

test("delta parser rejects digest, exposure, and ancestry tampering", () => {
	const ledger = deterministicLedger();
	const { delta } = commitRead(ledger, "file", revision("a"), new Map([[1, "one"]]));
	assert.ok(parseSnapshotDelta(delta));
	assert.equal(parseSnapshotDelta({ ...delta, canonicalFileKey: "other" }), undefined);
	assert.equal(parseSnapshotDelta({ ...delta, node: { ...delta.node, exposedRanges: [{ start: 2, end: 2 }] } }), undefined);
	assert.equal(parseSnapshotDelta({ ...delta, node: { ...delta.node, parentKey: delta.node.occurrenceKey, effectsFromParent: [insertionEffect()] } }), undefined);
	assert.equal(parseSnapshotDelta({ ...delta, extra: true }), undefined);
	assert.equal(parseSnapshotDelta({ ...delta, node: { ...delta.node, extra: true } }), undefined);
	assert.equal(parseSnapshotDelta({ ...delta, node: { ...delta.node, verifiedRanges: [{ start: 1, lines: ["one\n2:forged"] }] } }), undefined);
	const tooManyLines = {
		...delta,
		node: {
			...delta.node,
			totalLines: MAX_FILE_EVIDENCE_LINES + 1,
			exposedRanges: [],
			verifiedRanges: [{ start: 1, lines: Array(MAX_FILE_EVIDENCE_LINES + 1).fill("") }],
		},
	};
	assert.ok(snapshotDeltaBytes(tooManyLines) <= MAX_SNAPSHOT_DELTA_BYTES);
	assert.equal(parseSnapshotDelta(tooManyLines), undefined);
});

test("staged commits reject concurrent ledger changes", () => {
	const ledger = deterministicLedger();
	commitRead(ledger, "file", revision("a"), new Map([[1, "one"]]));
	const stale = ledger.stageRead("file", revision("a"), 2, new Map([[2, "two"]]), new Map([[2, "two"]]));
	commitRead(ledger, "file", revision("b"), new Map([[1, "external"]]));
	assert.throws(() => ledger.commit(stale, new Map([[2, "two"]]), false, new Map([[2, "two"]])), /stale/);
});

test("lineage overflow rebases to a bounded root and invalidates old ancestry", () => {
	const ledger = deterministicLedger();
	const root = commitRead(ledger, "file", revision("0"), new Map([[1, "one"]]));
	let rebased = false;
	for (let index = 1; index <= MAX_FILE_LINEAGE_NODES; index++) {
		const character = (index % 10).toString();
		const stage = ledger.stageChangedApply("file", revision(character), 1 + index, [insertionEffect(index)], new Map([[2, `new-${index}`]]), new Map([[2, `new-${index}`]]));
		const committed = ledger.commit(stage, new Map([[2, `new-${index}`]]), false, new Map([[2, `new-${index}`]]));
		rebased ||= committed.capacityRebased;
	}
	assert.equal(rebased, true);
	assert.deepEqual(ledger.lookup("file", root.node.id), { ok: false, reason: "unknown_snapshot" });
});

test("oversized replay deltas roll back without retaining a partial lineage", () => {
	const ledger = deterministicLedger();
	const huge = "x".repeat(MAX_SNAPSHOT_DELTA_BYTES + 1024);
	const lines = new Map([[1, huge]]);
	const stage = ledger.stageRead("file", revision("a"), 1, lines, lines);
	assert.throws(() => ledger.commit(stage, lines, false, lines), /replay budget/);
	assert.equal(ledger.head("file"), undefined);
});

test("restore rejects structurally valid-looking deltas above the replay budget", () => {
	const fake = { protocolVersion: 1, canonicalFileKey: "file", node: { padding: "x".repeat(MAX_SNAPSHOT_DELTA_BYTES) } } as unknown as SnapshotDelta;
	assert.equal(parseSnapshotDelta(fake), undefined);
});
