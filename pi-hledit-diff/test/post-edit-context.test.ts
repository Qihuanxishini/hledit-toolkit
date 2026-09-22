import assert from "node:assert/strict";
import test from "node:test";

import { formatUpdatedAnchorSpans, parseUpdatedAnchorSpans } from "../src/post-edit-context.ts";
import { producedLineRangesFromEditDeltas } from "../src/result.ts";

test("formatUpdatedAnchorSpans lists every produced line across spans", () => {
	const spans = parseUpdatedAnchorSpans([
		{
			lines: [
				{ line: 1, anchor: "1#BHJ", text: "one" },
				{ line: 2, anchor: "2#BBK", text: "TWO" },
			],
			offset: 1,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
		{ lines: [{ line: 9, anchor: "9#BBL", text: "nine" }], offset: 9, limit: 1, desiredLimit: 1, truncated: false },
	]);
	assert.ok(spans);

	const result = formatUpdatedAnchorSpans(spans);
	assert.deepEqual(result, {
		text: "Updated anchors:\n1#BHJ:one\n2#BBK:TWO\n9#BBL:nine",
		truncated: false,
	});
});

test("formatUpdatedAnchorSpans reports a text-truncated produced line", () => {
	const spans = parseUpdatedAnchorSpans([
		{
			lines: [{ line: 8, anchor: "8#BHJ", text: "partial", textTruncated: true }],
			offset: 8,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	]);
	assert.ok(spans);

	const result = formatUpdatedAnchorSpans(spans);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "Updated anchors:\n8#BHJ:partial\nUpdated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
});

test("formatUpdatedAnchorSpans reports a span cut short by the CLI budget", () => {
	const spans = parseUpdatedAnchorSpans([
		{ lines: [{ line: 4, anchor: "4#BHJ", text: "first change" }], offset: 4, limit: 1, desiredLimit: 1, truncated: false },
		{ lines: [], offset: 693, limit: 0, desiredLimit: 3, truncated: true },
	]);
	assert.ok(spans);

	const result = formatUpdatedAnchorSpans(spans);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "Updated anchors:\n4#BHJ:first change\nUpdated anchors are incomplete; call hledit_read_anchors for any changed line you need to edit again.");
});

test("formatUpdatedAnchorSpans stays silent for a pure deletion", () => {
	const spans = parseUpdatedAnchorSpans([]);
	assert.ok(spans);

	const result = formatUpdatedAnchorSpans(spans);
	assert.equal(result.text, "");
	assert.equal(result.truncated, false);
});

test("parseUpdatedAnchorSpans enforces the per-span contract and physical order", () => {
	const span = (offset: number, desiredLimit: number) => ({
		lines: [{ line: offset, anchor: `${offset}#BHJ`, text: "x" }],
		offset,
		limit: 1,
		desiredLimit,
		truncated: desiredLimit > 1,
	});
	const malformed: unknown[] = [
		{ lines: [], offset: 1, limit: 0, desiredLimit: 0, truncated: false },
		[{ lines: [{ line: 1, anchor: "not-an-anchor", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false }],
		[{ lines: [{ line: 1, anchor: "1#AA", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false }],
		[{ lines: [{ line: 2, anchor: "2#BBK", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false }],
		[{ lines: [{ line: 1, anchor: "1#BHJ", text: "x" }], offset: 1, limit: 2, desiredLimit: 2, truncated: false }],
		[{ lines: [{ line: 1, anchor: "1#BHJ", text: "x" }], offset: 1, limit: 1, desiredLimit: 0, truncated: false }],
		[{ lines: [{ line: 1, anchor: "1#BHJ", text: "x", textTruncated: "yes" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false }],
		// span 必须按物理顺序且互不重叠。
		[span(5, 1), span(3, 1)],
		[span(3, 4), span(6, 1)],
	];

	for (const value of malformed) {
		assert.equal(parseUpdatedAnchorSpans(value), undefined, JSON.stringify(value));
	}
	assert.equal(parseUpdatedAnchorSpans([span(3, 3), span(6, 1)])?.length, 2);
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
