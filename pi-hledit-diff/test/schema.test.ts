import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

import { HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA } from "../src/schema.ts";

test("read and search schemas keep their contracts separate", () => {
	const read = { path: "src/a.ts", windows: [{ offset: 3, limit: 20 }] };
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, read), true);
	for (const invalid of [
		{ ...read, pattern: "needle" },
		{ ...read, offset: 3, limit: 20 },
		{ path: "src/a.ts", offset: 3, limit: 20 },
		{ path: "src/a.ts" },
	]) {
		assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, invalid), false, JSON.stringify(invalid));
	}
	assert.equal(Value.Check(HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", pattern: "needle", context: 2 }), true);
	assert.equal(Value.Check(HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", pattern: "needle", context: -1 }), false);
	assert.equal(Value.Check(HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", pattern: "" }), false);
});

const groups = { replace_ranges: [], delete_ranges: [], insert_before: [], insert_after: [] };
function applyInput(overrides: Record<string, unknown> = {}) {
	return { path: "src/a.ts", proof_id: "proof-1", ...groups, ...overrides };
}

test("read and apply schemas compile", () => {
	const readValidator = Compile(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA);
	const applyValidator = Compile(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA);
	assert.equal(readValidator.Check({ path: "src/a.ts", windows: [{ offset: 1, limit: 20 }] }), true);
	assert.equal(applyValidator.Check(applyInput({ delete_ranges: [{ start_anchor: "1#BHJ", end_anchor: "1#BHJ" }] })), true);
});

test("apply file changes rejects anchors outside the CLI hash alphabet", () => {
	for (const anchor of ["1#AA", "1#J+0", "1#BHK!", "1#BH", " 1#BHJ", "1 #BHJ", "1#BHJ :text"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({ delete_ranges: [{ start_anchor: anchor, end_anchor: anchor }] })), false);
	}
});

test("apply file changes accepts grouped inputs with operation-specific fields", () => {
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({
		replace_ranges: [{ start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "next" }],
		delete_ranges: [{ start_anchor: "1#BHJ", end_anchor: "1#BHJ" }],
		insert_before: [{ anchor: "2#BBK", lines: "before\nafter" }],
		insert_after: [{ anchor: "3#JKL", lines: "after\nnext" }],
	})), true);
});

test("apply file changes rejects operation fields and old operation shapes", () => {
	for (const invalid of [
		applyInput({ replace_ranges: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "next" }] }),
		applyInput({ delete_ranges: [{ operation: "delete_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ" }] }),
		applyInput({ insert_after: [{ operation: "insert_after", anchor: "1#BHJ", lines: "next" }] }),
		applyInput({ changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "next" }] }),
		applyInput({ replace_ranges: [{ start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["next"] }] }),
	]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, invalid), false, JSON.stringify(invalid));
	}
});

test("apply schema requires all public groups and proof, while allowing empty groups for aggregate checks", () => {
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput()), true);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({ delete_ranges: undefined })), false);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({ proof_id: undefined })), false);
	for (const field of ["position", "content"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({ insert_after: [{ anchor: "1#BHJ", lines: "next", [field]: "unknown" }] })), false, field);
	}
	for (const hiddenField of ["revision", "proof", "readSet"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput({ [hiddenField]: "must remain internal" })), false, hiddenField);
	}
});
