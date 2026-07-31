import assert from "node:assert/strict";
import test from "node:test";

import {
	decodeSnaplineText,
	prepareModelBatch,
	SnaplineRequestError,
	translateModelBatch,
	type PreparedReplacement,
} from "../src/coordinate-translation.ts";
import { IntervalSet } from "../src/interval-set.ts";
import type { SnaplineApplyParams } from "../src/schema.ts";
import type { SnaplineEditEffect } from "../src/wire.ts";

function coverage(totalLines: number): IntervalSet {
	return totalLines === 0 ? new IntervalSet() : new IntervalSet([{ start: 1, end: totalLines }]);
}

function replacement(params: SnaplineApplyParams, totalLines = 10) {
	return prepareModelBatch(params, totalLines, coverage(totalLines), totalLines === 0);
}

test("decodes LF-delimited text without assigning trailing-newline semantics", () => {
	assert.deepEqual(decodeSnaplineText("one\ntwo\n"), { lines: ["one", "two"], endsWithLF: true });
	assert.deepEqual(decodeSnaplineText(""), { lines: [""], endsWithLF: false });
	assert.throws(() => decodeSnaplineText("bad\rtext"), SnaplineRequestError);
	assert.throws(() => decodeSnaplineText("bad\0text"), SnaplineRequestError);
});

test("requires exposure and rejects source-batch conflicts", () => {
	assert.throws(
		() => prepareModelBatch({ path: "x", snapshot: "s_x", replacements: [{ start: 2, end: 3, text: "x" }] }, 5, new IntervalSet([{ start: 1, end: 2 }]), false),
		(error: unknown) => error instanceof SnaplineRequestError && error.code === "exposure_missing",
	);
	assert.throws(
		() => replacement({ path: "x", snapshot: "s_x", replacements: [{ start: 2, end: 4, text: "x" }], deletions: [{ start: 4, end: 5 }] }),
		(error: unknown) => error instanceof SnaplineRequestError && error.code === "invalid_request",
	);
	assert.throws(
		() => replacement({ path: "x", snapshot: "s_x", replacements: [{ start: 2, end: 4, text: "x" }], insertions_after: [{ line: 2, text: "y" }] }),
		SnaplineRequestError,
	);
});

test("empty snapshots accept exactly one insertion before virtual line 1", () => {
	const prepared = replacement({ path: "x", snapshot: "s_x", insertions_before: [{ line: 1, text: "one\ntwo" }] }, 0);
	assert.deepEqual(prepared.changes[0], {
		group: "insertion_before", groupIndex: 0, line: 1, boundary: 0, text: "one\ntwo", producedLines: ["one", "two"],
	});
	assert.throws(() => replacement({ path: "x", snapshot: "s_x", insertions_after: [{ line: 1, text: "x" }] }, 0), SnaplineRequestError);
	assert.throws(() => prepareModelBatch({ path: "x", snapshot: "s_x", insertions_before: [{ line: 1, text: "x" }] }, 0, new IntervalSet(), false), SnaplineRequestError);
});

test("lineage translation shifts untouched ranges and rejects touched ranges", () => {
	const prepared = replacement({ path: "x", snapshot: "s_x", replacements: [{ start: 8, end: 9, text: "new" }] });
	const historical: SnaplineEditEffect = {
		group: "replacement", groupIndex: 0, changed: true,
		oldStart: 2, oldEnd: 4, newLineCount: 1, lineDelta: -2, newStart: 2, newEnd: 2,
	};
	const translated = translateModelBatch(prepared, [[historical]]);
	assert.deepEqual((translated.changes[0] as PreparedReplacement), { ...prepared.changes[0], start: 6, end: 7 });

	const touched = replacement({ path: "x", snapshot: "s_x", deletions: [{ start: 3, end: 5 }] });
	assert.throws(
		() => translateModelBatch(touched, [[historical]]),
		(error: unknown) => error instanceof SnaplineRequestError && error.code === "lineage_conflict",
	);
});

test("lineage translation rejects reused insertion boundaries", () => {
	const prepared = replacement({ path: "x", snapshot: "s_x", insertions_after: [{ line: 5, text: "new" }] });
	const historical: SnaplineEditEffect = {
		group: "insertion_after", groupIndex: 0, changed: true,
		oldStart: 6, oldEnd: 5, newLineCount: 2, lineDelta: 2, newStart: 6, newEnd: 7,
	};
	assert.throws(
		() => translateModelBatch(prepared, [[historical]]),
		(error: unknown) => error instanceof SnaplineRequestError && error.code === "lineage_conflict",
	);
});

test("range translation matches an independent projected-document reference", () => {
	let state = 0x6d2b79f5;
	const random = (max: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % max;
	};
	for (let iteration = 0; iteration < 2000; iteration++) {
		const total = 5 + random(45);
		const editStart = 1 + random(total);
		const editEnd = editStart + random(total - editStart + 1);
		const inserted = random(6);
		const deleted = editEnd - editStart + 1;
		const effect: SnaplineEditEffect = {
			group: "replacement", groupIndex: 0, changed: true,
			oldStart: editStart, oldEnd: editEnd, newLineCount: inserted, lineDelta: inserted - deleted,
			newStart: editStart, newEnd: editStart + inserted - 1,
		};
		const before = editStart > 1;
		const after = editEnd < total;
		if (!before && !after) continue;
		let requestStart: number;
		let requestEnd: number;
		if (before && (!after || random(2) === 0)) {
			requestStart = 1 + random(editStart - 1);
			requestEnd = requestStart + random(editStart - requestStart);
		} else {
			requestStart = editEnd + 1 + random(total - editEnd);
			requestEnd = requestStart + random(total - requestStart + 1);
		}
		const prepared = replacement({ path: "x", snapshot: "s_x", replacements: [{ start: requestStart, end: requestEnd, text: "x" }] }, total);
		const translated = translateModelBatch(prepared, [[effect]]).changes[0] as PreparedReplacement;

		const source = Array.from({ length: total }, (_, index) => index + 1);
		const projected = [...source.slice(0, editStart - 1), ...Array.from({ length: inserted }, () => -1), ...source.slice(editEnd)];
		const requestedTokens = source.slice(requestStart - 1, requestEnd);
		const expectedStart = projected.indexOf(requestedTokens[0]!) + 1;
		assert.ok(expectedStart > 0);
		assert.deepEqual(projected.slice(expectedStart - 1, expectedStart - 1 + requestedTokens.length), requestedTokens);
		assert.equal(translated.start, expectedStart);
		assert.equal(translated.end, expectedStart + requestedTokens.length - 1);
	}
});
