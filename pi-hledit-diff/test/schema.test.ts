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

function applyInput(changes: Array<Record<string, unknown>> = [{ action: "replace", anchors: ["1#BHJ"], lines: "test" }], overrides: Record<string, unknown> = {}) {
	return { path: "src/a.ts", proof_id: "proof-1", changes, ...overrides };
}

test("read and apply schemas compile", () => {
	const readValidator = Compile(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA);
	const applyValidator = Compile(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA);
	assert.equal(readValidator.Check({ path: "src/a.ts", windows: [{ offset: 1, limit: 20 }] }), true);
	assert.equal(applyValidator.Check(applyInput()), true);
	const itemSchema = HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA.properties.changes.items;
	assert.deepEqual(itemSchema.required, ["action", "anchors", "lines"]);
	assert.deepEqual(Object.keys(itemSchema.properties), itemSchema.required);
});

test("apply file changes rejects anchors outside the CLI hash alphabet", () => {
	for (const anchor of ["1#AA", "1#J+0", "1#BHK!", "1#BH", " 1#BHJ", "1 #BHJ", "1#BHJ :text"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput([{ action: "replace", anchors: [anchor], lines: "" }])), false);
	}
});

test("apply file changes accepts mixed operations with uniform required fields", () => {
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput([
		{ action: "replace", anchors: ["1#BHJ"], lines: "next" },
		{ action: "replace", anchors: ["2#BBK"], lines: "" },
		{ action: "insert_before", anchors: ["3#JKL"], lines: "before\nafter" },
		{ action: "insert_after", anchors: ["4#MNP"], lines: "after\nnext" },
		{ action: "replace", anchors: ["5#ABC", "7#DEF"], lines: "range" },
		{ action: "replace", anchors: ["8#GHI", "9#JKL"], lines: "" },
	])), true);
});

test("apply file changes rejects invalid action fields and old shapes", () => {
	for (const invalid of [
		applyInput([{ action: "delete", anchors: ["1#BHJ"], lines: "" }]),
		applyInput([{ action: "replace_range", anchors: ["1#BHJ"], lines: "" }]),
		applyInput([{ action: "insert_after", anchors: ["1#BHJ"], lines: ["array"] }]),
		applyInput([{ action: "replace", anchors: ["1#BHJ"], lines: "next", unknown_field: true }]),
		applyInput([{ action: "replace", anchor: "1#BHJ", lines: "" }]),
		applyInput([{ action: "replace", anchors: ["1#BHJ"], end_anchor: "2#BBK", lines: "" }]),
		applyInput([{ action: "replace", anchors: ["1#BHJ"] }]),
		...[[], ["1#BHJ", "2#BBK", "3#JKL"], [null], null].map((anchors) => applyInput([{ action: "replace", anchors, lines: "" }])),
	]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, invalid), false, JSON.stringify(invalid));
	}
});

test("apply schema requires changes and proof, rejecting extra root properties", () => {
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput()), true);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { path: "src/a.ts", proof_id: "p1" }), false);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { path: "src/a.ts", changes: [{ action: "replace", anchors: ["1#BHJ"], lines: "" }] }), false);
	for (const field of ["replace_ranges", "delete_ranges", "insert_before", "insert_after"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput(undefined, { [field]: [] })), false, field);
	}
	for (const hiddenField of ["revision", "proof", "readSet"]) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, applyInput(undefined, { [hiddenField]: "must remain internal" })), false, hiddenField);
	}
});
