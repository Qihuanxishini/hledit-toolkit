import assert from "node:assert/strict";
import test from "node:test";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL,
	preferAnchoredEditingTools,
} from "../src/active-tools.ts";

const AVAILABLE = ["read", "read_windows", "hledit_search_anchors", "edit"];

test("preferAnchoredEditingTools removes retired tools and preserves unrelated tools", () => {
	assert.deepEqual(preferAnchoredEditingTools(["read", "edit", "hledit", "bash"], AVAILABLE), [
		"read", "edit", "bash", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL,
	]);
});

test("preferAnchoredEditingTools does not duplicate replacement tools", () => {
	assert.deepEqual(
		preferAnchoredEditingTools(["read", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL], AVAILABLE),
		["read", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL],
	);
});
