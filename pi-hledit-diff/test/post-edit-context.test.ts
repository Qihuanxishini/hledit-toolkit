import assert from "node:assert/strict";
import test from "node:test";

import { formatBatchUpdatedAnchorContext, parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";

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

	assert.deepEqual(formatBatchUpdatedAnchorContext(context), {
		text: "Updated anchors (only the affected window, lines 1-2; not the whole file):\n1#BHJ:one\n2#BBK:TWO\nLater changes inside this window must use these new anchors. Anchors read earlier stay valid for unchanged lines outside the window; if an edit shifted a line number, a rejected call lists the verified renamed anchor to resubmit with. Call hledit_read_anchors only for ranges that were never read or when a failure requests a targeted read.",
		offset: 1,
		limit: 2,
		truncated: false,
	});
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

	const result = formatBatchUpdatedAnchorContext(context);
	assert.equal(result.truncated, true);
	assert.match(result.text, /offset:8 and limit:25/);
});

test("formatBatchUpdatedAnchorContext formats an empty file", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: { lines: [], offset: 1, limit: 0, desiredLimit: 0, truncated: false },
	});
	assert.ok(context);

	assert.match(formatBatchUpdatedAnchorContext(context).text, /\(the file is empty\)/);
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
