import assert from "node:assert/strict";
import test from "node:test";

import { renderFallbackResult, renderHleditCall, type RenderTheme } from "../src/render.ts";
import type { TextResult } from "../src/result.ts";

const theme: RenderTheme = {
	fg: (_name, text) => text,
	bold: (text) => text,
};

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(120);
}

test("renderHleditCall includes the anchored read range", () => {
	assert.deepEqual(lines(renderHleditCall("read_anchors", { path: "src/a.ts", offset: 3, limit: 5 }, theme)), ["read anchors: src/a.ts:3-7"]);
});

test("renderHleditCall includes the changed line range", () => {
	assert.deepEqual(
		lines(renderHleditCall("apply_file_changes", { path: "src/a.ts", changes: [{ anchor: "4#AA", end_anchor: "6#BB" }] }, theme)),
		["apply changes: src/a.ts:4-6"],
	);
});

test("renderFallbackResult folds long anchor output", () => {
	const text = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
	const result: TextResult = { content: [{ type: "text", text }], details: { disposition: "succeeded" } };

	assert.deepEqual(lines(renderFallbackResult("read_anchors", result, theme, {})), [
		"󰋽 Anchors folded: 21 lines",
		"line 1",
		"... (19 lines) ...",
		"line 21",
	]);
});

test("renderFallbackResult folds an apply failure", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes were not applied.\nError: stale" }],
		details: { disposition: "rejected" },
	};

	assert.deepEqual(lines(renderFallbackResult("apply_file_changes", result, theme, {})), [" Changes were not applied. stale"]);
});

test("renderFallbackResult summarizes successful file changes", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", editsApplied: 2, firstChangedLine: 4, lastChangedLine: 5 },
	};

	assert.deepEqual(lines(renderFallbackResult("apply_file_changes", result, theme, {})), ["󰄬 Changes applied: 2. Changed lines: 4-5."]);
});
