import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAnchoredChangePreview,
	changePreviewDiffText,
	emptyChangePreview,
	MAX_PREVIEW_BYTES,
	MAX_PREVIEW_LINES,
	parseChangePreview,
} from "../src/change-preview.ts";

function consumedLines(entries: Array<[number, string]>): Map<number, { text: string }> {
	return new Map(entries.map(([line, text]) => [line, { text }]));
}

test("anchored preview offsets multi-block edits with intra-block minimal diff", () => {
	const preview = buildAnchoredChangePreview(
		[
			{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "2#AAA", lines: ["TWO", "TWO2"] },
			{ operation: "insert_after", anchor: "4#BBB", lines: ["N"] },
			{ operation: "delete_range", start_anchor: "5#CCC", end_anchor: "5#CCC" },
		],
		consumedLines([[2, "two"], [4, "four"], [5, "five"]]),
	);

	assert.deepEqual(preview, {
		truncated: false,
		lines: [
			{ kind: "remove", oldLine: 2, text: "two" },
			{ kind: "add", newLine: 2, text: "TWO" },
			{ kind: "add", newLine: 3, text: "TWO2" },
			{ kind: "add", newLine: 6, text: "N" },
			{ kind: "remove", oldLine: 5, text: "five" },
		],
	});
});

test("anchored preview keeps the minimal diff inside a replacement block", () => {
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "10#AAA", end_anchor: "12#CCC", lines: ["alpha", "CHANGED", "gamma"] }],
		consumedLines([[10, "alpha"], [11, "beta"], [12, "gamma"]]),
	);

	// 未变化的首尾行不进入 preview：块内 diff 只保留真实变化。
	assert.deepEqual(preview?.lines, [
		{ kind: "remove", oldLine: 11, text: "beta" },
		{ kind: "add", newLine: 11, text: "CHANGED" },
	]);
});

test("anchored preview refuses to guess when a consumed line is missing from evidence", () => {
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "3#BBB", lines: ["next"] }],
		consumedLines([[2, "two"]]),
	);

	assert.equal(preview, undefined);
});


test("oversized previews keep head and tail fragments and mark truncation", () => {
	const inserted = Array.from({ length: MAX_PREVIEW_LINES + 500 }, (_, index) => `line-${index}`);
	const preview = buildAnchoredChangePreview(
		[{ operation: "insert_after", anchor: "1#AAA", lines: inserted }],
		consumedLines([[1, "one"]]),
	);

	assert.ok(preview);
	assert.equal(preview.truncated, true);
	assert.ok(preview.lines.length <= MAX_PREVIEW_LINES);
	assert.equal(preview.lines[0]?.text, "line-0");
	assert.equal(preview.lines.at(-1)?.text, `line-${inserted.length - 1}`);
});


test("preview byte cap counts Chinese and emoji as UTF-8 and clips one oversized line", () => {
	const original = `${"中文🙂".repeat(MAX_PREVIEW_BYTES)}TAIL`;
	const preview = buildAnchoredChangePreview(
		[{ operation: "insert_after", anchor: "1#AAA", lines: [original] }],
		consumedLines([[1, "one"]]),
	);

	assert.ok(preview);
	assert.equal(preview.truncated, true);
	assert.equal(preview.lines.length, 1);
	assert.equal(preview.lines[0]?.textTruncated, true);
	assert.match(preview.lines[0]?.text ?? "", /^中文/);
	assert.match(preview.lines[0]?.text ?? "", /TAIL$/);
	const bytes = preview.lines.reduce((total, line) => total + Buffer.byteLength(line.text, "utf8") + 1, 0);
	assert.ok(bytes <= MAX_PREVIEW_BYTES, `${bytes} must not exceed ${MAX_PREVIEW_BYTES}`);
	assert.equal(Buffer.from(preview.lines[0]?.text ?? "", "utf8").toString("utf8"), preview.lines[0]?.text);
});

test("change preview survives a details JSON round trip and rejects malformed shapes", () => {
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "2#AAA", lines: ["B"] }],
		consumedLines([[2, "b"]]),
	);
	assert.ok(preview);
	assert.deepEqual(parseChangePreview(JSON.parse(JSON.stringify(preview))), preview);
	assert.deepEqual(parseChangePreview(JSON.parse(JSON.stringify(emptyChangePreview()))), { lines: [], truncated: false });

	assert.equal(parseChangePreview(undefined), undefined);
	assert.equal(parseChangePreview({ lines: "no" }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "swap", text: "x" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", newLine: 0, text: "x" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", text: "x" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "remove", oldLine: 1, newLine: 1, text: "x" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", newLine: 1, text: "x", textTruncated: true }] }), undefined);
});

test("changePreviewDiffText renders line-numbered hunks with fold markers", () => {
	const preview = buildAnchoredChangePreview(
		[
			{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "2#AAA", lines: ["TWO", "TWO2"] },
			{ operation: "insert_after", anchor: "4#BBB", lines: ["N"] },
			{ operation: "delete_range", start_anchor: "5#CCC", end_anchor: "5#CCC" },
		],
		consumedLines([[2, "two"], [4, "four"], [5, "five"]]),
	);

	assert.ok(preview);
	assert.equal(
		changePreviewDiffText(preview),
		["-2 two", "+2 TWO", "+3 TWO2", "   ...", "+6 N", "   ...", "-5 five"].join("\n"),
	);
	assert.equal(changePreviewDiffText(emptyChangePreview()), "");
	assert.match(changePreviewDiffText({ lines: [{ kind: "add", newLine: 1, text: "x" }], truncated: true }), /preview truncated/);
});
