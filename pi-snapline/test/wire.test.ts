import assert from "node:assert/strict";
import test from "node:test";

import { parseSnaplineApplyRun, parseSnaplineReadRun, type SnaplineApplySuccess, type SnaplineReadRequest } from "../src/wire.ts";
import type { SnaplineRun } from "../src/cli.ts";

const revisionA = `sha256:${"a".repeat(64)}`;
const revisionB = `sha256:${"b".repeat(64)}`;

const twoLineReadRequest: SnaplineReadRequest = {
	protocolVersion: 1,
	path: "file.txt",
	windows: [{ offset: 1, limit: 2 }],
};
const singleLineReadRequest: SnaplineReadRequest = {
	protocolVersion: 1,
	path: "file.txt",
	windows: [{ offset: 1, limit: 1 }],
};

function run(value: unknown, exitCode = 0, started = true): SnaplineRun {
	return { stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", exitCode, started };
}

function applied(): SnaplineApplySuccess {
	return {
		ok: true,
		protocolVersion: 1,
		path: "file.txt",
		outcome: "applied",
		sourceRevision: revisionA,
		newRevision: revisionB,
		contentChanged: true,
		stats: { requestedChanges: 1, effectiveChanges: 1, oldLineCount: 2, newLineCount: 2, insertedLines: 1, deletedLines: 1 },
		effects: [{ group: "replacement", groupIndex: 0, changed: true, oldStart: 1, oldEnd: 1, newLineCount: 1, lineDelta: 0, newStart: 1, newEnd: 1 }],
		warnings: [],
	};
}

test("parses bounded complete read responses", () => {
	const parsed = parseSnaplineReadRun(run({
		ok: true,
		protocolVersion: 1,
		path: "file.txt",
		revision: revisionA,
		totalLines: 3,
		bom: false,
		contexts: [{ offset: 1, limit: 2, start: 1, end: 2, complete: true, nextOffset: 3, lines: ["one", "two"] }],
		omittedRanges: [],
	}), twoLineReadRequest);
	assert.equal(parsed.disposition, "success");
	if (parsed.disposition === "success") assert.deepEqual(parsed.result.contexts[0]?.lines, ["one", "two"]);
});

test("rejects malformed read contexts and unknown fields", () => {
	const base = {
		ok: true, protocolVersion: 1, path: "file.txt", revision: revisionA, totalLines: 1, bom: false,
		contexts: [{ offset: 1, limit: 1, start: 1, end: 1, complete: true, nextOffset: 2, lines: ["one"] }], omittedRanges: [],
	};
	assert.equal(parseSnaplineReadRun(run({ ...base, unknown: true }), singleLineReadRequest).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...base, contexts: [{ ...base.contexts[0], nextOffset: 1 }] }), singleLineReadRequest).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...base, contexts: [{ ...base.contexts[0], lines: ["x\0y"] }] }), singleLineReadRequest).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...base, contexts: [{ ...base.contexts[0], lines: ["x\ny"] }] }), singleLineReadRequest).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...base, contexts: [{ ...base.contexts[0], lines: ["x\ry"] }] }), singleLineReadRequest).disposition, "success");
	assert.equal(parseSnaplineReadRun(run({ ...base, contexts: [{ ...base.contexts[0], lines: [], end: 0, nextOffset: 1, complete: false, truncatedLine: { line: 1, prefix: "x\ny", originalUtf8Bytes: 3 } }] }), singleLineReadRequest).disposition, "invalid_response");
});

test("rejects read responses that do not cover the normalized request windows", () => {
	const request: SnaplineReadRequest = { protocolVersion: 1, path: "file.txt", windows: [{ offset: 2, limit: 2 }] };
	const response = {
		ok: true, protocolVersion: 1, path: "file.txt", revision: revisionA, totalLines: 4, bom: false,
		contexts: [{ offset: 2, limit: 2, start: 2, end: 2, complete: false, nextOffset: 3, lines: ["two"] }],
		omittedRanges: [{ start: 3, end: 3, reason: "line_limit" }],
	};
	assert.equal(parseSnaplineReadRun(run(response), request).disposition, "success");
	assert.equal(parseSnaplineReadRun(run({ ...response, contexts: [] }), request).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...response, omittedRanges: [] }), request).disposition, "invalid_response");
	assert.equal(parseSnaplineReadRun(run({ ...response, contexts: [{ ...response.contexts[0], offset: 1 }] }), request).disposition, "invalid_response");
});

test("parses applied and no-op outcomes while enforcing invariants", () => {
	assert.equal(parseSnaplineApplyRun(run(applied())).disposition, "success");
	const noOp = {
		...applied(),
		outcome: "no_op",
		newRevision: revisionA,
		contentChanged: false,
		stats: { requestedChanges: 1, effectiveChanges: 0, oldLineCount: 2, newLineCount: 2, insertedLines: 0, deletedLines: 0 },
		effects: [{ ...applied().effects[0], changed: false, lineDelta: 0 }],
	};
	assert.equal(parseSnaplineApplyRun(run(noOp)).disposition, "success");
	assert.equal(parseSnaplineApplyRun(run({ ...applied(), contentChanged: false })).disposition, "outcome_unknown");
	assert.equal(parseSnaplineApplyRun(run({ ...applied(), effects: [] })).disposition, "outcome_unknown");
});

test("classifies unavailable and started malformed apply outcomes separately", () => {
	assert.equal(parseSnaplineApplyRun(run("", 1, false)).disposition, "unavailable");
	assert.equal(parseSnaplineApplyRun(run("", 1, true)).disposition, "outcome_unknown");
	assert.equal(parseSnaplineApplyRun(run("not json", 0, true)).disposition, "outcome_unknown");
	assert.equal(parseSnaplineReadRun(run("not json", 0, true), singleLineReadRequest).disposition, "invalid_response");
});

test("accepts trustworthy logical rejections only with targetCommitted false", () => {
	const failure = { ok: false, protocolVersion: 1, code: "stale_revision", message: "stale", targetCommitted: false, currentRevision: revisionB };
	assert.equal(parseSnaplineApplyRun(run(failure)).disposition, "rejected");
	assert.equal(parseSnaplineApplyRun(run({ ...failure, targetCommitted: true })).disposition, "outcome_unknown");
	assert.equal(parseSnaplineApplyRun(run({ ...failure, requiredRanges: {} })).disposition, "outcome_unknown");
	assert.equal(parseSnaplineApplyRun(run({ ...failure, contexts: "invalid" })).disposition, "outcome_unknown");
	assert.equal(parseSnaplineApplyRun(run({ ...failure, omittedRanges: null })).disposition, "outcome_unknown");
});
