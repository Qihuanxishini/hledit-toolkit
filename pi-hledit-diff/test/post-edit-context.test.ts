import assert from "node:assert/strict";
import test from "node:test";

import { formatBatchUpdatedAnchorContext, parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";
import { producedLineRangesFromEditDeltas } from "../src/result.ts";

test("formatBatchUpdatedAnchorContext formats CLI-provided anchors", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [
				{ line: 1, anchor: "1#BHJ", text: "one" },
				{ line: 2, anchor: "2#BBK", text: "TWO" },
			],
			offset: 1,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	});
	assert.ok(context);

	const result = formatBatchUpdatedAnchorContext(context, [{ start: 1, end: 2 }]);
	assert.deepEqual(result, {
		text: "Updated anchors:\n1#BHJ:one\n2#BBK:TWO",
		offset: 1,
		limit: 2,
		truncated: false,
	});
	assert.ok(result.text.length < 100);
});

test("formatBatchUpdatedAnchorContext preserves CLI truncation guidance", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [{ line: 8, anchor: "8#BHJ", text: "partial", textTruncated: true }],
			offset: 8,
			limit: 1,
			desiredLimit: 25,
			truncated: false,
		},
	});
	assert.ok(context);

	const result = formatBatchUpdatedAnchorContext(context, [{ start: 8, end: 8 }]);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "Updated anchors:\n8#BHJ:partial\nUpdated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
});

test("formatBatchUpdatedAnchorContext formats an empty file", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: { lines: [], offset: 1, limit: 0, desiredLimit: 0, truncated: false },
	});
	assert.ok(context);

	assert.match(formatBatchUpdatedAnchorContext(context, []).text, /\(the file is empty\)/);
});

test("parseBatchUpdatedAnchorContext enforces the full batch contract", () => {
	const malformed = [
		{ ok: true },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "not-an-anchor", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#AA", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 2, anchor: "2#BBK", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BHJ", text: "x" }], offset: 1, limit: 2, desiredLimit: 2, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BHJ", text: "x" }], offset: 1, limit: 1, desiredLimit: 0, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BHJ", text: "x", textTruncated: "yes" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
	];

	for (const value of malformed) {
		assert.equal(parseBatchUpdatedAnchorContext(value), undefined);
	}
});

test("formatBatchUpdatedAnchorContext keeps only lines the edit produced", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [1, 2, 3, 4, 5].map((line) => ({ line, anchor: `${line}#BHJ`, text: `line ${line}` })),
			offset: 1,
			limit: 5,
			desiredLimit: 5,
			truncated: false,
		},
	});
	assert.ok(context);

	const result = formatBatchUpdatedAnchorContext(context, [{ start: 3, end: 3 }]);
	assert.equal(result.text, "Updated anchors:\n3#BHJ:line 3");
	assert.equal(result.truncated, false);
});

test("formatBatchUpdatedAnchorContext stays silent for a pure deletion", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [{ line: 40, anchor: "40#BHJ", text: "survivor" }],
			offset: 40,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	});
	assert.ok(context);

	// 纯删除在新坐标下产出空区间，即使落在窗口外也不应报不完整。
	const result = formatBatchUpdatedAnchorContext(context, [{ start: 500, end: 499 }]);
	assert.equal(result.text, "");
	assert.equal(result.truncated, false);
});

test("formatBatchUpdatedAnchorContext reports produced lines outside the CLI window", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [{ line: 4, anchor: "4#BHJ", text: "first change" }],
			offset: 4,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	});
	assert.ok(context);

	const result = formatBatchUpdatedAnchorContext(context, [{ start: 4, end: 4 }, { start: 693, end: 695 }]);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "Updated anchors:\n4#BHJ:first change\nUpdated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
});

test("producedLineRangesFromEditDeltas maps consumed ranges into new coordinates", () => {
	assert.deepEqual(
		producedLineRangesFromEditDeltas([
			{ oldStart: 10, oldEnd: 12, delta: 1 },
			{ oldStart: 20, oldEnd: 19, delta: 2 },
			{ oldStart: 30, oldEnd: 32, delta: -3 },
			{ oldStart: 40, oldEnd: 40, delta: 0 },
		]),
		[
			{ start: 10, end: 13 },
			{ start: 21, end: 22 },
			{ start: 33, end: 32 },
			{ start: 40, end: 40 },
		],
	);
});
