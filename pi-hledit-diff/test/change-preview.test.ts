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
			{ kind: "remove", oldLine: 2, text: "two", changeIndex: 0 },
			{ kind: "add", newLine: 2, text: "TWO", changeIndex: 0 },
			{ kind: "add", newLine: 3, text: "TWO2", changeIndex: 0 },
			{ kind: "add", newLine: 6, text: "N", changeIndex: 1 },
			{ kind: "remove", oldLine: 5, text: "five", changeIndex: 2 },
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
		{ kind: "remove", oldLine: 11, text: "beta", changeIndex: 0 },
		{ kind: "add", newLine: 11, text: "CHANGED", changeIndex: 0 },
	]);
});

test("large replacements avoid serializing an unbounded diff and retain bounded head/tail evidence", () => {
	const size = 10_000;
	const replacements = Array.from({ length: size }, (_, index) => `new-${index}`);
	replacements.join = () => { throw new Error("oversized replacement reached diff serialization"); };
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "1#AAA", end_anchor: `${size}#AAA`, lines: replacements }],
		consumedLines(Array.from({ length: size }, (_, index) => [index + 1, `old-${index}`])),
	);
	assert.ok(preview?.truncated);
	assert.ok(preview.lines.length <= MAX_PREVIEW_LINES);
	assert.deepEqual(preview.lines[0], { kind: "remove", oldLine: 1, text: "old-0", changeIndex: 0 });
	assert.deepEqual(preview.lines.at(-1), { kind: "add", newLine: size, text: `new-${size - 1}`, changeIndex: 0 });
	assert.deepEqual(parseChangePreview(JSON.parse(JSON.stringify(preview))), preview);
});

test("replacement diff work is budgeted across the complete batch", () => {
	const size = 256;
	const consumed = consumedLines(Array.from({ length: size * 5 }, (_, index) => [index + 1, `old-${index}`]));
	const changes = Array.from({ length: 5 }, (_, changeIndex) => ({
		operation: "replace_range" as const,
		start_anchor: `${changeIndex * size + 1}#AAA`,
		end_anchor: `${(changeIndex + 1) * size}#AAA`,
		lines: Array.from({ length: size }, (_, index) => index === 0 ? "changed" : `old-${changeIndex * size + index}`),
	}));
	const preview = buildAnchoredChangePreview(changes, consumed);
	assert.ok(preview?.truncated);
	assert.equal(preview.lines.filter((line) => line.changeIndex === 0).length, 2);
	assert.ok(preview.lines.some((line) => line.changeIndex === 4 && line.text === "old-1025"));
});

test("replacement diff checks UTF-8 bytes before joining its input", () => {
	const replacements = ["中".repeat(MAX_PREVIEW_BYTES)];
	replacements.join = () => { throw new Error("oversized UTF-8 text reached diff serialization"); };
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "1#AAA", end_anchor: "1#AAA", lines: replacements }],
		consumedLines([[1, "before"]]),
	);
	assert.ok(preview?.truncated);
	assert.ok(preview.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.text, "utf8") + 1, 0) <= MAX_PREVIEW_BYTES);
});

test("replacement preview preserves carriage returns and Unicode line separators", () => {
	const old = "before\rtext\u2028tail";
	const next = "after\rtext\u2029tail";
	const preview = buildAnchoredChangePreview(
		[{ operation: "replace_range", start_anchor: "1#AAA", end_anchor: "1#AAA", lines: [next] }],
		consumedLines([[1, old]]),
	);
	assert.deepEqual(preview?.lines.map((line) => line.text), [old, next]);
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

test("adjacent insert, replacement and deletion use blank operation separators", () => {
	const preview = buildAnchoredChangePreview([
		{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "3#BBB", lines: ["BRAVO", "CHARLIE"] },
		{ operation: "delete_range", start_anchor: "4#CCC", end_anchor: "4#CCC" },
		{ operation: "insert_after", anchor: "1#DDD", lines: ["inserted-line"] },
	], consumedLines([[1, "alpha"], [2, "bravo"], [3, "charlie"], [4, "echo-line"]]));
	assert.ok(preview);
	assert.equal(changePreviewDiffText(preview), [
		"+2 inserted-line", "", "-2 bravo", "-3 charlie", "+3 BRAVO", "+4 CHARLIE", "", "-4 echo-line",
	].join("\n"));
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


test("changePreviewDiffText preserves source order when separate edits contain identical text", () => {
	const preview = buildAnchoredChangePreview(
		[
			{ operation: "delete_range", start_anchor: "2#AAA", end_anchor: "3#BBB" },
			{ operation: "insert_after", anchor: "4#CCC", lines: ["same", "added"] },
		],
		consumedLines([[2, "same"], [3, "removed"], [4, "kept"]]),
	);

	assert.ok(preview);
	assert.equal(
		changePreviewDiffText(preview),
		["-2 same", "-3 removed", "", "+3 same", "+4 added"].join("\n"),
	);
});
});
