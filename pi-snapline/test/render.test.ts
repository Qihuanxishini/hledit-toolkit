import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderSnaplineApplyResult, renderSnaplineCall, renderSnaplineReadResult, type RenderTheme } from "../src/render.ts";
import type { SnaplineApplyDetails, SnaplineReadDetails, TextToolResult } from "../src/tool-details.ts";

const theme: RenderTheme = {
	fg(_name, text) { return text; },
	bold(text) { return text; },
};

const resultOptions = { expanded: false, isPartial: false };

test("read renderer shows numbered source, snapshot metadata, and collapsed context", () => {
	const details: SnaplineReadDetails = {
		protocolVersion: 1, operation: "read", disposition: "succeeded", path: "file.ts", canonicalFileKey: "file.ts",
		canonicalTargetPath: "file.ts", snapshot: "s_snapshot", revision: `sha256:${"a".repeat(64)}`,
		totalLines: 20, displayedRanges: [{ start: 1, end: 13 }], omittedRanges: [], nextOffset: 14,
		snapshotDelta: { protocolVersion: 1, canonicalFileKey: "file.ts", node: {
			occurrenceKey: "occurrence", snapshot: "s_AAAAAAAAAAAAAAAA", fullDigest: "a".repeat(64), occurrenceNonce: "a".repeat(32), revision: `sha256:${"a".repeat(64)}`,
			totalLines: 20, effectsFromParent: [], verifiedRanges: [], exposedRanges: [], exposedEmptyBoundary: false,
		} },
	};
	const body = Array.from({ length: 13 }, (_, index) => `${index + 1}:line ${index + 1}`).join("\n");
	const result: TextToolResult<SnaplineReadDetails> = { content: [{ type: "text", text: body }], details };
	const lines = renderSnaplineReadResult(result, resultOptions, theme, { args: { path: "file.ts" } }).render(100);
	assert.match(lines.join("\n"), /13 lines/);
	assert.match(lines.join("\n"), /1 │ line 1/);
	assert.match(lines.join("\n"), /1 more lines/);
});

test("read renderer exposes isolated carriage returns and stays within narrow widths", () => {
	const details: SnaplineReadDetails = {
		protocolVersion: 1, operation: "read", disposition: "succeeded", path: "file.txt",
		canonicalFileKey: "file.txt", canonicalTargetPath: "file.txt", snapshot: "s_snapshot", totalLines: 1,
	};
	const result: TextToolResult<SnaplineReadDetails> = { content: [{ type: "text", text: "1:left\rright" }], details };
	const rendered = renderSnaplineReadResult(result, resultOptions, theme, { args: { path: "file.txt" } });
	const wide = rendered.render(100).join("\n");
	assert.match(wide, /left␍right/);
	assert.equal(wide.includes("\r"), false);
	for (let width = 0; width <= 8; width++) {
		rendered.invalidate();
		assert.ok(rendered.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("apply renderer uses committed multi-hunk preview rather than model receipt text", () => {
	const details: SnaplineApplyDetails = {
		protocolVersion: 1, operation: "apply", disposition: "succeeded", path: "file.txt", canonicalFileKey: "file.txt",
		canonicalTargetPath: "file.txt", sourceSnapshot: "s_old", snapshot: "s_new", contentChanged: true,
		stats: { requestedChanges: 1, effectiveChanges: 1, oldLineCount: 1, newLineCount: 1, insertedLines: 1, deletedLines: 1 },
		effects: [{ group: "replacement", groupIndex: 0, changed: true, oldStart: 1, oldEnd: 1, newLineCount: 1, lineDelta: 0, newStart: 1, newEnd: 1 }], warnings: [],
		preview: { truncated: false, lines: [
			{ kind: "remove", oldLine: 1, text: "old\rcarriage" },
			{ kind: "add", newLine: 1, text: "new" },
		] },
	};
	const result: TextToolResult<SnaplineApplyDetails> = { content: [{ type: "text", text: "Applied atomically" }], details };
	const rendered = renderSnaplineApplyResult(result, resultOptions, theme, { args: { path: "file.txt" } }).render(100).join("\n");
	assert.match(rendered, /old/);
	assert.match(rendered, /old␍carriage/);
	assert.equal(rendered.includes("\r"), false);
	assert.match(rendered, /new/);
});

test("call and failure renderers remain bounded", () => {
	const call = renderSnaplineCall("apply", { path: "file.txt", replacements: [{}, {}] }, theme, { cwd: process.cwd() }).render(30);
	assert.equal(call.length, 1);
	assert.ok(visibleWidth(call[0]!) <= 30);
	const failed: TextToolResult<SnaplineReadDetails> = {
		content: [{ type: "text", text: "first\nsecond" }],
		details: { protocolVersion: 1, operation: "read", disposition: "rejected", path: "file.txt", error: { code: "bad", message: "failure" } },
	};
	const rendered = renderSnaplineReadResult(failed, resultOptions, theme, {}).render(20);
	assert.equal(rendered.length, 1);
	assert.match(rendered[0]!, /failure/);
	const needsReview: TextToolResult<SnaplineApplyDetails> = {
		content: [{ type: "text", text: "Needs review: current context" }],
		details: { protocolVersion: 1, operation: "apply", disposition: "needs_review", path: "file.txt", contentChanged: false, error: { code: "stale", message: "review current lines" } },
	};
	const reviewRendered = renderSnaplineApplyResult(needsReview, resultOptions, theme, {}).render(40);
	assert.match(reviewRendered[0]!, /^! review current lines/);
});
