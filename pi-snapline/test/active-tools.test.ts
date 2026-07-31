import assert from "node:assert/strict";
import test from "node:test";

import {
	activateSnaplineApply,
	hasLegacyHleditConflict,
	preferLegacyConflictTools,
	preferNativeFallbackTools,
	preferSnaplineTools,
} from "../src/active-tools.ts";
import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "../src/schema.ts";

test("healthy mode replaces native text read/edit while preserving unrelated tools", () => {
	assert.deepEqual(
		preferSnaplineTools(["bash", "read", "edit", "write", "grep"], false),
		["bash", "write", "grep", SNAPLINE_READ_TOOL],
	);
	assert.deepEqual(
		preferSnaplineTools(["bash", "read", "edit", SNAPLINE_APPLY_TOOL], true),
		["bash", SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL],
	);
});

test("lazy apply activation is purely additive and idempotent", () => {
	const initial = ["bash", SNAPLINE_READ_TOOL];
	assert.deepEqual(activateSnaplineApply(initial), [...initial, SNAPLINE_APPLY_TOOL]);
	assert.deepEqual(activateSnaplineApply([...initial, SNAPLINE_APPLY_TOOL]), [...initial, SNAPLINE_APPLY_TOOL]);
});

test("fallback restores native read/edit without changing legacy tool activation", () => {
	assert.deepEqual(
		preferNativeFallbackTools(["bash", SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL, "hledit_read_anchors", "write"]),
		["bash", "hledit_read_anchors", "write", "read", "edit"],
	);
});

test("legacy conflict mode removes only Snapline's own tools", () => {
	assert.deepEqual(
		preferLegacyConflictTools(["bash", "read", "hledit_read_anchors", SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL]),
		["bash", "read", "hledit_read_anchors"],
	);
});

test("legacy tool names trigger conflict detection", () => {
	assert.equal(hasLegacyHleditConflict(["read", "hledit_read_anchors"]), true);
	assert.equal(hasLegacyHleditConflict(["hledit_apply_file_changes"]), true);
	assert.equal(hasLegacyHleditConflict([SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL]), false);
});
