import assert from "node:assert/strict";
import test from "node:test";

import { formatBatchUpdatedAnchorContext, parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";

test("formatBatchUpdatedAnchorContext formats CLI-provided anchors", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [
				{ line: 1, anchor: "1#BH", text: "one" },
				{ line: 2, anchor: "2#BB", text: "TWO" },
			],
			offset: 1,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	});
	assert.ok(context);

	assert.deepEqual(formatBatchUpdatedAnchorContext(context), {
		text: "更新后的锚点：\n1#BH:one\n2#BB:TWO\n后续修改请使用这些新锚点，或重新调用 hledit_read_anchors。不要继续使用本次修改前读取的锚点。",
		offset: 1,
		limit: 2,
		truncated: false,
	});
});

test("formatBatchUpdatedAnchorContext preserves CLI truncation guidance", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: {
			lines: [{ line: 8, anchor: "8#BH", text: "partial", textTruncated: true }],
			offset: 8,
			limit: 1,
			desiredLimit: 25,
			truncated: false,
		},
	});
	assert.ok(context);

	const result = formatBatchUpdatedAnchorContext(context);
	assert.equal(result.truncated, true);
	assert.match(result.text, /offset:8、limit:25/);
});

test("formatBatchUpdatedAnchorContext formats an empty file", () => {
	const context = parseBatchUpdatedAnchorContext({
		updatedAnchors: { lines: [], offset: 1, limit: 0, desiredLimit: 0, truncated: false },
	});
	assert.ok(context);

	assert.match(formatBatchUpdatedAnchorContext(context).text, /（文件为空）/);
});

test("parseBatchUpdatedAnchorContext enforces the full batch contract", () => {
	const malformed = [
		{ ok: true },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "not-an-anchor", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#AA", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 2, anchor: "2#BB", text: "x" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BH", text: "x" }], offset: 1, limit: 2, desiredLimit: 2, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BH", text: "x" }], offset: 1, limit: 1, desiredLimit: 0, truncated: false } },
		{ updatedAnchors: { lines: [{ line: 1, anchor: "1#BH", text: "x", textTruncated: "yes" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } },
	];

	for (const value of malformed) {
		assert.equal(parseBatchUpdatedAnchorContext(value), undefined);
	}
});
