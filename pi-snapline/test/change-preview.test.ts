import assert from "node:assert/strict";
import test from "node:test";

import {
	buildSnaplineChangePreview,
	changePreviewDiffText,
	MAX_PREVIEW_BYTES,
	parseChangePreview,
} from "../src/change-preview.ts";
import { prepareModelBatch } from "../src/coordinate-translation.ts";
import { IntervalSet } from "../src/interval-set.ts";
import type { SnaplineEditEffect } from "../src/wire.ts";

function effect(oldStart: number, newStart: number, groupIndex: number): SnaplineEditEffect {
	return {
		group: "replacement", groupIndex, changed: true,
		oldStart, oldEnd: oldStart, newLineCount: 1, lineDelta: 0, newStart, newEnd: newStart,
	};
}

test("commit-bound preview renders distant edits as separate hunks", () => {
	const prepared = prepareModelBatch({
		path: "file", snapshot: "s_token",
		replacements: [{ start: 2, end: 2, text: "TWO" }, { start: 100, end: 100, text: "HUNDRED" }],
	}, 120, new IntervalSet([{ start: 1, end: 120 }]), false);
	const preview = buildSnaplineChangePreview(prepared, [effect(2, 2, 0), effect(100, 100, 1)], new Map([[2, "two"], [100, "hundred"]]));
	assert.ok(preview);
	const text = changePreviewDiffText(preview!);
	assert.match(text, /-2 two/);
	assert.match(text, /\+2 TWO/);
	assert.match(text, /\.\.\./);
	assert.match(text, /-100 hundred/);
	assert.match(text, /\+100 HUNDRED/);
});

test("preview generation fails closed when proof or effects do not match", () => {
	const prepared = prepareModelBatch({ path: "file", snapshot: "s_token", replacements: [{ start: 2, end: 2, text: "TWO" }] }, 3, new IntervalSet([{ start: 1, end: 3 }]), false);
	assert.equal(buildSnaplineChangePreview(prepared, [effect(2, 2, 0)], new Map()), undefined);
	assert.equal(buildSnaplineChangePreview(prepared, [{ ...effect(2, 2, 0), groupIndex: 9 }], new Map([[2, "two"]])), undefined);
});

test("very long preview lines remain UTF-8 bounded and explicitly truncated", () => {
	const oldText = "旧".repeat(MAX_PREVIEW_BYTES);
	const newText = "新".repeat(MAX_PREVIEW_BYTES);
	const prepared = prepareModelBatch({ path: "file", snapshot: "s_token", replacements: [{ start: 1, end: 1, text: newText }] }, 1, new IntervalSet([{ start: 1, end: 1 }]), false);
	const preview = buildSnaplineChangePreview(prepared, [effect(1, 1, 0)], new Map([[1, oldText]]));
	assert.ok(preview?.truncated);
	const bytes = preview!.lines.reduce((total, line) => total + Buffer.byteLength(line.text, "utf8") + 1, 0);
	assert.ok(bytes <= MAX_PREVIEW_BYTES);
	assert.ok(preview!.lines.some((line) => line.textTruncated));
	assert.ok(parseChangePreview(preview));
});

test("persisted preview parser rejects malformed coordinates and oversize data", () => {
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", oldLine: 1, text: "bad" }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "context", oldLine: 1, newLine: 1, text: "x", textTruncated: true }] }), undefined);
	assert.equal(parseChangePreview({ truncated: false, lines: [{ kind: "add", newLine: 1, text: "x".repeat(MAX_PREVIEW_BYTES + 1) }] }), undefined);
});
