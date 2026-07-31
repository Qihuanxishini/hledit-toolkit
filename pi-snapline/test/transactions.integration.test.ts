import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSnaplineApplyTransaction } from "../src/apply-transaction.ts";
import type { SnaplineRunner } from "../src/read-transaction.ts";
import { runSnaplineReadTransaction } from "../src/read-transaction.ts";
import { SnapshotLedger } from "../src/snapshot-ledger.ts";
import type { SnaplineApplyRequest, SnaplineReadRequest } from "../src/wire.ts";

const revisionA = `sha256:${"a".repeat(64)}`;
const revisionB = `sha256:${"b".repeat(64)}`;
const revisionC = `sha256:${"c".repeat(64)}`;

async function fixture(): Promise<{ cwd: string; file: string }> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "snapline-plugin-test-"));
	const file = path.join(cwd, "file.txt");
	await writeFile(file, "one\ntwo\nthree\n", "utf8");
	return { cwd, file };
}

function readSuccess(request: SnaplineReadRequest, lines: string[], revision: string) {
	const contexts = request.windows.map((window) => {
		const start = lines.length === 0 ? 1 : Math.min(window.offset, lines.length);
		const limit = lines.length === 0 ? 0 : Math.min(window.limit, lines.length - start + 1);
		const selected = lines.slice(start - 1, start - 1 + limit);
		const end = start + selected.length - 1;
		return {
			offset: start,
			limit,
			start,
			end,
			complete: true,
			nextOffset: end + 1,
			lines: selected,
		};
	});
	return {
		ok: true,
		protocolVersion: 1,
		path: request.path,
		revision,
		totalLines: lines.length,
		bom: false,
		contexts,
		omittedRanges: [],
	};
}

function readRunner(lines: string[], revision = revisionA): SnaplineRunner {
	return async (args, stdin) => {
		assert.deepEqual(args, ["read"]);
		const request = JSON.parse(stdin!) as SnaplineReadRequest;
		return { stdout: JSON.stringify(readSuccess(request, lines, revision)), stderr: "", exitCode: 0, started: true };
	};
}

async function establishSnapshot(cwd: string, ledger: SnapshotLedger): Promise<string> {
	const outcome = await runSnaplineReadTransaction({ path: "@file.txt", offset: 1, limit: 3 }, cwd, undefined, ledger, readRunner(["one", "two", "three"]));
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result" || outcome.result.details.disposition !== "succeeded") throw new Error("snapshot read failed");
	const snapshot = outcome.result.details.snapshot;
	if (!snapshot) throw new Error("snapshot id missing");
	return snapshot;
}

test("unified read establishes replay-bound snapshot proof", async () => {
	const { cwd, file } = await fixture();
	const ledger = new SnapshotLedger();
	let request: SnaplineReadRequest | undefined;
	const outcome = await runSnaplineReadTransaction({ path: "@file.txt", offset: 0, limit: 5000 }, cwd, undefined, ledger, async (args, stdin) => {
		assert.deepEqual(args, ["read"]);
		request = JSON.parse(stdin!) as SnaplineReadRequest;
		return { stdout: JSON.stringify(readSuccess(request, ["one", "two", "three"], revisionA)), stderr: "", exitCode: 0, started: true };
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.healthFailure, false);
	assert.equal(outcome.result.details.disposition, "succeeded");
	assert.equal(outcome.result.details.repairedOffset, 1);
	assert.equal(outcome.result.details.repairedLimit, 2000);
	assert.match(outcome.result.content[0]!.text, /\[snapshot:s_/);
	assert.match(outcome.result.content[0]!.text, /1:one\n2:two\n3:three/);
	assert.equal(request!.path, await path.resolve(file));
	assert.deepEqual(request!.windows, [{ offset: 1, limit: 2000 }]);
	assert.ok(ledger.hasEditableSnapshot());
	assert.ok(outcome.result.details.snapshotDelta);
});

test("read distinguishes image candidates and incompatible CLI responses", async () => {
	const { cwd } = await fixture();
	const image = await runSnaplineReadTransaction({ path: "file.txt" }, cwd, undefined, new SnapshotLedger(), async (_args, stdin) => {
		const request = JSON.parse(stdin!) as SnaplineReadRequest;
		return { stdout: JSON.stringify({ ok: false, protocolVersion: 1, path: request.path, code: "image_candidate", message: "image", targetCommitted: false }), stderr: "", exitCode: 0, started: true };
	});
	assert.equal(image.kind, "image_candidate");

	const malformed = await runSnaplineReadTransaction({ path: "file.txt" }, cwd, undefined, new SnapshotLedger(), async () => ({ stdout: "not-json", stderr: "", exitCode: 0, started: true }));
	assert.equal(malformed.kind, "result");
	if (malformed.kind === "result") {
		assert.equal(malformed.healthFailure, true);
		assert.equal(malformed.result.details.disposition, "unavailable");
	}
});

test("apply sends exact proof, validates receipts, and commits a child snapshot", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	let wireRequest: SnaplineApplyRequest | undefined;
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, replacements: [{ start: 2, end: 2, text: "TWO" }] },
		cwd,
		undefined,
		ledger,
		async (args, stdin) => {
			assert.deepEqual(args, ["apply"]);
			wireRequest = JSON.parse(stdin!) as SnaplineApplyRequest;
			return {
				stdout: JSON.stringify({
					ok: true, protocolVersion: 1, path: wireRequest.path, outcome: "applied",
					sourceRevision: revisionA, newRevision: revisionB, contentChanged: true,
					stats: { requestedChanges: 1, effectiveChanges: 1, oldLineCount: 3, newLineCount: 3, insertedLines: 1, deletedLines: 1 },
					effects: [{ group: "replacement", groupIndex: 0, changed: true, oldStart: 2, oldEnd: 2, newLineCount: 1, lineDelta: 0, newStart: 2, newEnd: 2 }],
					warnings: [],
				}),
				stderr: "", exitCode: 0, started: true,
			};
		},
	);
	assert.equal(outcome.healthFailure, false);
	assert.equal(outcome.result.details.disposition, "succeeded");
	assert.equal(outcome.result.details.contentChanged, true);
	assert.notEqual(outcome.result.details.snapshot, snapshot);
	assert.deepEqual(wireRequest!.proof, [{ start: 2, lines: ["two"] }]);
	assert.equal(wireRequest!.expectedRevision, revisionA);
	assert.deepEqual(wireRequest!.replacements, [{ start: 2, end: 2, text: "TWO" }]);
	const canonicalFileKey = outcome.result.details.canonicalFileKey!;
	assert.equal(ledger.head(canonicalFileKey)?.verifiedLines.get(2), "TWO");
	const oldLookup = ledger.lookup(canonicalFileKey, snapshot);
	assert.equal(oldLookup.ok, true);
});

test("no-op apply keeps the submitted snapshot", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, replacements: [{ start: 2, end: 2, text: "two" }] }, cwd, undefined, ledger,
		async (_args, stdin) => {
			const request = JSON.parse(stdin!) as SnaplineApplyRequest;
			return { stdout: JSON.stringify({
				ok: true, protocolVersion: 1, path: request.path, outcome: "no_op",
				sourceRevision: revisionA, newRevision: revisionA, contentChanged: false,
				stats: { requestedChanges: 1, effectiveChanges: 0, oldLineCount: 3, newLineCount: 3, insertedLines: 0, deletedLines: 0 },
				effects: [{ group: "replacement", groupIndex: 0, changed: false, oldStart: 2, oldEnd: 2, newLineCount: 1, lineDelta: 0, newStart: 2, newEnd: 2 }], warnings: [],
			}), stderr: "", exitCode: 0, started: true };
		},
	);
	assert.equal(outcome.result.details.disposition, "succeeded");
	assert.equal(outcome.result.details.contentChanged, false);
	assert.equal(outcome.result.details.snapshot, snapshot);
});


test("unknown snapshots close old ancestry and return an approximate recovery root", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const priorSnapshot = await establishSnapshot(cwd, ledger);
	let applyCalls = 0;
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot: `s_${"A".repeat(16)}`, deletions: [{ start: 2, end: 2 }] }, cwd, undefined, ledger,
		async (args, stdin) => {
			if (args[0] === "apply") applyCalls++;
			const request = JSON.parse(stdin!) as SnaplineReadRequest;
			return { stdout: JSON.stringify(readSuccess(request, ["one", "two", "three"], revisionA)), stderr: "", exitCode: 0, started: true };
		},
	);
	assert.equal(applyCalls, 0);
	assert.equal(outcome.result.details.disposition, "needs_review");
	assert.notEqual(outcome.result.details.recovery?.snapshot, priorSnapshot);
	assert.deepEqual(outcome.result.details.recovery?.displayedRanges, [{ start: 2, end: 2, approximate: true }]);
	assert.deepEqual(ledger.lookup(outcome.result.details.canonicalFileKey!, priorSnapshot), { ok: false, reason: "unknown_snapshot" });
	assert.equal(ledger.hasEditableSnapshot(), false);
});

test("stale apply recovers current context without replaying the request", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	let applyCalls = 0;
	let readCalls = 0;
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, deletions: [{ start: 2, end: 2 }] }, cwd, undefined, ledger,
		async (args, stdin) => {
			if (args[0] === "apply") {
				applyCalls++;
				const request = JSON.parse(stdin!) as SnaplineApplyRequest;
				return { stdout: JSON.stringify({ ok: false, protocolVersion: 1, path: request.path, code: "snapshot_stale", message: "stale", targetCommitted: false, currentRevision: revisionC }), stderr: "", exitCode: 0, started: true };
			}
			readCalls++;
			const request = JSON.parse(stdin!) as SnaplineReadRequest;
			return { stdout: JSON.stringify(readSuccess(request, ["one", "external", "three"], revisionC)), stderr: "", exitCode: 0, started: true };
		},
	);
	assert.equal(applyCalls, 1);
	assert.equal(readCalls, 1);
	assert.equal(outcome.result.details.disposition, "needs_review");
	assert.equal(outcome.result.details.contentChanged, false);
	assert.match(outcome.result.content[0]!.text, /2:external/);
	assert.ok(outcome.result.details.recovery?.snapshot);
	assert.deepEqual(ledger.lookup(outcome.result.details.canonicalFileKey!, snapshot), { ok: false, reason: "unknown_snapshot" });
});

test("started malformed apply becomes outcome_unknown and must not be retried", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	let applyCalls = 0;
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, deletions: [{ start: 1, end: 1 }] }, cwd, undefined, ledger,
		async (args, stdin) => {
			if (args[0] === "apply") {
				applyCalls++;
				return { stdout: "malformed", stderr: "", exitCode: 0, started: true };
			}
			const request = JSON.parse(stdin!) as SnaplineReadRequest;
			return { stdout: JSON.stringify(readSuccess(request, ["current"], revisionC)), stderr: "", exitCode: 0, started: true };
		},
	);
	assert.equal(applyCalls, 1);
	assert.equal(outcome.result.details.disposition, "outcome_unknown");
	assert.equal(outcome.healthFailure, true);
	assert.match(outcome.result.content[0]!.text, /Do not retry the same request/);
	assert.ok(outcome.result.details.recovery?.snapshot);
});

test("outcome_unknown recovery includes locally projected produced ranges", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	let recoveryRequest: SnaplineReadRequest | undefined;
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, insertions_after: [{ line: 1, text: "inserted-a\ninserted-b" }] }, cwd, undefined, ledger,
		async (args, stdin) => {
			if (args[0] === "apply") return { stdout: "malformed", stderr: "", exitCode: 0, started: true };
			recoveryRequest = JSON.parse(stdin!) as SnaplineReadRequest;
			return {
				stdout: JSON.stringify(readSuccess(recoveryRequest, ["one", "inserted-a", "inserted-b", "two", "three"], revisionC)),
				stderr: "", exitCode: 0, started: true,
			};
		},
	);
	assert.equal(outcome.healthFailure, true);
	assert.equal(outcome.result.details.disposition, "outcome_unknown");
	assert.deepEqual(recoveryRequest?.windows, [{ offset: 1, limit: 3 }]);
	assert.deepEqual(outcome.result.details.recovery?.displayedRanges, [{ start: 1, end: 3, approximate: true }]);
	assert.match(outcome.result.content[0]!.text, /2:inserted-a\n3:inserted-b/);
});


test("conflicting text under an unchanged revision becomes a health failure", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	await establishSnapshot(cwd, ledger);
	const outcome = await runSnaplineReadTransaction({ path: "file.txt", offset: 2, limit: 1 }, cwd, undefined, ledger, readRunner(["one", "DIFFERENT", "three"], revisionA));
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.healthFailure, true);
		assert.equal(outcome.result.details.disposition, "unavailable");
		assert.match(outcome.result.content[0]!.text, /Conflicting verified text/);
	}
});

test("post-commit ledger races return changed success instead of throwing", async () => {
	const { cwd } = await fixture();
	const ledger = new SnapshotLedger();
	const snapshot = await establishSnapshot(cwd, ledger);
	const outcome = await runSnaplineApplyTransaction(
		{ path: "file.txt", snapshot, replacements: [{ start: 2, end: 2, text: "TWO" }] }, cwd, undefined, ledger,
		async (_args, stdin) => {
			const request = JSON.parse(stdin!) as SnaplineApplyRequest;
			ledger.clear();
			return { stdout: JSON.stringify({
				ok: true, protocolVersion: 1, path: request.path, outcome: "applied",
				sourceRevision: revisionA, newRevision: revisionB, contentChanged: true,
				stats: { requestedChanges: 1, effectiveChanges: 1, oldLineCount: 3, newLineCount: 3, insertedLines: 1, deletedLines: 1 },
				effects: [{ group: "replacement", groupIndex: 0, changed: true, oldStart: 2, oldEnd: 2, newLineCount: 1, lineDelta: 0, newStart: 2, newEnd: 2 }], warnings: [],
			}), stderr: "", exitCode: 0, started: true };
		},
	);
	assert.equal(outcome.result.details.disposition, "succeeded");
	assert.equal(outcome.result.details.contentChanged, true);
	assert.equal(outcome.healthFailure, true);
	assert.equal(outcome.result.details.error?.code, "snapshot_persistence_failed");
});
