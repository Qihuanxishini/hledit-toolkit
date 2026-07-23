import assert from "node:assert/strict";
import test from "node:test";

import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	isAnchoredEditingTool,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
	preferAnchoredReadTool,
} from "../src/active-tools.ts";

test("preferAnchoredReadTool activates only anchored reads", () => {
	assert.deepEqual(preferAnchoredReadTool(["read", "edit", "hledit", "bash", HLEDIT_APPLY_FILE_CHANGES_TOOL]), [
		"read",
		"bash",
		HLEDIT_READ_ANCHORS_TOOL,
	]);
});

test("preferAnchoredEditingTools replaces built-in and legacy edit tools", () => {
	assert.deepEqual(preferAnchoredEditingTools(["read", "edit", "hledit", "bash"]), [
		"read",
		"bash",
		HLEDIT_READ_ANCHORS_TOOL,
		HLEDIT_APPLY_FILE_CHANGES_TOOL,
	]);
});

test("preferAnchoredEditingTools does not duplicate replacement tools", () => {
	assert.deepEqual(
		preferAnchoredEditingTools(["read", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]),
		["read", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL],
	);
});

test("preferBuiltInEditFallback removes unavailable hledit tools and restores edit", () => {
	assert.deepEqual(
		preferBuiltInEditFallback(["read", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL, "bash"]),
		["read", "bash", "edit"],
	);
});

test("preferBuiltInEditFallback preserves one existing edit entry", () => {
	assert.deepEqual(preferBuiltInEditFallback(["read", "edit", "hledit", "edit", "bash"]), ["read", "edit", "bash"]);
});

test("isAnchoredEditingTool identifies only the new tool names", () => {
	assert.equal(isAnchoredEditingTool(HLEDIT_READ_ANCHORS_TOOL), true);
	assert.equal(isAnchoredEditingTool(HLEDIT_APPLY_FILE_CHANGES_TOOL), true);
	assert.equal(isAnchoredEditingTool("hledit"), false);
});
