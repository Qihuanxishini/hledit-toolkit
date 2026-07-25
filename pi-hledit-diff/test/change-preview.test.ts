import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAnchoredChangePreview,
	buildReplaceOncePreview,
	changePreviewDiffText,
	emptyChangePreview,
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

test("replace-once preview uses the CLI-verified start line", () => {
	const preview = buildReplaceOncePreview({ path: "a.txt", old_lines: ["b"], new_lines: ["B1", "B2"] }, 2);

	assert.deepEqual(preview, {
		truncated: false,
		lines: [
			{ kind: "remove", oldLine: 2, text: "b" },
			{ kind: "add", newLine: 2, text: "B1" },
			{ kind: "add", newLine: 3, text: "B2" },
		],
	});
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

test("change preview survives a details JSON round trip and rejects malformed shapes", () => {
	const preview = buildReplaceOncePreview({ path: "a.txt", old_lines: ["b"], new_lines: ["B"] }, 2);
	assert.deepEqual(parseChangePreview(JSON.parse(JSON.stringify(preview))), preview);
	assert.deepEqual(parseChangePreview(JSON.parse(JSON.stringify(emptyChangePreview()))), { lines: [], truncated: false });

	assert.equal(parseChangePreview(undefined), undefined);
	assert.equal(parseChangePreview({ lines: "no" }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "swap", text: "x" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", newLine: 0, text: "x" }] }), undefined);
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
