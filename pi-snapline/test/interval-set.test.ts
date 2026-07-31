import assert from "node:assert/strict";
import test from "node:test";

import { IntervalSet } from "../src/interval-set.ts";

test("inclusive intervals merge overlap and adjacency", () => {
	const intervals = new IntervalSet([{ start: 5, end: 7 }]);
	intervals.add(1, 2);
	intervals.add(3, 4);
	intervals.add(10, 12);
	assert.deepEqual(intervals.toArray(), [{ start: 1, end: 7 }, { start: 10, end: 12 }]);
	assert.equal(intervals.covers(2, 6), true);
	assert.equal(intervals.covers(7, 10), false);
	assert.equal(intervals.contains(11), true);
});

test("invalid intervals fail closed", () => {
	for (const range of [[0, 1], [2, 1], [1.5, 2], [1, Number.MAX_SAFE_INTEGER + 1]] as const) {
		assert.throws(() => new IntervalSet([{ start: range[0], end: range[1] }]));
	}
});

test("clone does not share mutable state", () => {
	const source = new IntervalSet([{ start: 1, end: 2 }]);
	const clone = source.clone();
	clone.add(3, 3);
	assert.deepEqual(source.toArray(), [{ start: 1, end: 2 }]);
	assert.deepEqual(clone.toArray(), [{ start: 1, end: 3 }]);
});
