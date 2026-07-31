import assert from "node:assert/strict";
import test from "node:test";

import { commitFormattedSnapshot, collectVerifiedContextLines, MAX_MODEL_READ_BYTES } from "../src/snapshot-format.ts";
import { MAX_SNAPSHOT_DELTA_BYTES, SnapshotLedger, snapshotDeltaBytes } from "../src/snapshot-ledger.ts";
import type { SnaplineReadContext } from "../src/wire.ts";

const revision = `sha256:${"a".repeat(64)}`;

function context(start: number, lines: string[]): SnaplineReadContext {
	return {
		offset: start,
		limit: lines.length,
		start,
		end: start + lines.length - 1,
		complete: true,
		nextOffset: start + lines.length,
		lines,
	};
}

test("formatter numbers exact lines and persists every exposed line", () => {
	const ledger = new SnapshotLedger();
	const contexts = [context(2, ["two", "three"])];
	const verified = collectVerifiedContextLines(contexts);
	const stage = ledger.stageRead("file", revision, 5, verified, verified);
	const formatted = commitFormattedSnapshot({ ledger, stage, contexts, omittedRanges: [], totalLines: 5 });
	assert.match(formatted.body, /^2:two\n3:three/);
	assert.deepEqual(formatted.displayedRanges, [{ start: 2, end: 3 }]);
	assert.deepEqual(formatted.delta.node.exposedRanges, [{ start: 2, end: 3 }]);
	assert.deepEqual(formatted.delta.node.verifiedRanges, [{ start: 2, lines: ["two", "three"] }]);
});


test("recovery snapshots label approximate displayed coordinates", () => {
	const ledger = new SnapshotLedger();
	const approximateContext = { ...context(2, ["two", "three"]), approximate: true as const };
	const verified = collectVerifiedContextLines([approximateContext]);
	const stage = ledger.stageRecovery("file", revision, 5, verified, verified);
	const formatted = commitFormattedSnapshot({ ledger, stage, contexts: [approximateContext], omittedRanges: [], totalLines: 5 });
	assert.match(formatted.body, /lines:2-3:approximate\/5/);
	assert.deepEqual(formatted.displayedRanges, [{ start: 2, end: 3, approximate: true }]);
	assert.equal(verified.size, 0);
	assert.deepEqual(formatted.delta.node.exposedRanges, []);
	assert.deepEqual(formatted.delta.node.verifiedRanges, []);
	assert.equal(ledger.hasEditableSnapshot(), false);
});

test("truncated prefixes are visible but never authorized as proof", () => {
	const ledger = new SnapshotLedger();
	const contexts: SnaplineReadContext[] = [{
		offset: 1, limit: 1, start: 1, end: 0, complete: false, nextOffset: 1, lines: [],
		truncatedLine: { line: 1, prefix: "prefix", originalUtf8Bytes: 100_000 },
	}];
	const verified = collectVerifiedContextLines(contexts);
	assert.equal(verified.size, 0);
	const stage = ledger.stageRead("file", revision, 1, verified, verified);
	const formatted = commitFormattedSnapshot({
		ledger, stage, contexts,
		omittedRanges: [{ start: 1, end: 1, reason: "line_too_long" }], totalLines: 1,
	});
	assert.match(formatted.body, /not editable/);
	assert.deepEqual(formatted.displayedRanges, []);
	assert.deepEqual(formatted.delta.node.exposedRanges, []);
	assert.equal(ledger.hasEditableSnapshot(), false);
});

test("empty reads expose only the virtual before-line-1 boundary", () => {
	const ledger = new SnapshotLedger();
	const contexts = [context(1, [])];
	const stage = ledger.stageRead("empty", revision, 0, new Map(), new Map());
	const formatted = commitFormattedSnapshot({ ledger, stage, contexts, omittedRanges: [], totalLines: 0 });
	assert.match(formatted.body, /lines:empty\/0/);
	assert.equal(formatted.delta.node.exposedEmptyBoundary, true);
	assert.equal(ledger.head("empty")?.exposedEmptyBoundary, true);
});

test("model and replay budgets drop complete lines before authorization", () => {
	const ledger = new SnapshotLedger();
	const lines = Array.from({ length: 120 }, (_, index) => `${index}:` + "界".repeat(140));
	const contexts = [context(1, lines)];
	const verified = collectVerifiedContextLines(contexts);
	const stage = ledger.stageRead("large", revision, lines.length, verified, verified);
	const formatted = commitFormattedSnapshot({ ledger, stage, contexts, omittedRanges: [], totalLines: lines.length });
	assert.ok(Buffer.byteLength(formatted.body, "utf8") <= MAX_MODEL_READ_BYTES);
	assert.ok(snapshotDeltaBytes(formatted.delta) <= MAX_SNAPSHOT_DELTA_BYTES);
	assert.ok(formatted.displayedLines.size < lines.length);
	assert.ok(formatted.omittedRanges.some((range) => range.reason === "replay_delta_budget"));
	const replayed = new SnapshotLedger();
	assert.equal(replayed.restoreDelta(formatted.delta), true);
	assert.deepEqual(replayed.head("large")?.exposedCoverage.toArray(), formatted.displayedRanges);
});
