import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

import { HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA } from "../src/schema.ts";

test("read anchors accepts only read arguments", () => {
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", offset: 3, limit: 20, grep: "needle", context: 2 }), true);
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", grep: "needle", context: -1 }), false);
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", changes: [] }), false);
});

test("schemas compile with the host-aligned TypeBox version", () => {
	const readValidator = Compile(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA);
	const applyValidator = Compile(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA);

	assert.equal(readValidator.Check({ path: "src/a.ts", offset: 1, limit: 20 }), true);
	assert.equal(applyValidator.Check({ path: "src/a.ts", changes: [{ operation: "delete", anchor: "1#BH" }] }), true);
});

test("apply file changes rejects anchors outside the CLI hash alphabet", () => {
	for (const anchor of ["1#AA", "1#J0", "1#Ja", "1#BHK"]) {
		assert.equal(
			Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
				path: "src/a.ts",
				changes: [{ operation: "delete", anchor }],
			}),
			false,
		);
	}
});

test("apply file changes accepts a strict discriminated change set", () => {
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [
				{ operation: "replace", anchor: "1#BH", lines: ["next"] },
				{ operation: "delete", anchor: "3#BB", end_anchor: "4#JK" },
				{ operation: "insert", anchor: "6#MN", position: "after", lines: ["one"] },
			],
		}),
		true,
	);
});

test("apply file changes rejects legacy and mixed protocol fields", () => {
	const base = { path: "src/a.ts", changes: [{ operation: "replace", anchor: "1#BH", lines: ["next"] }] };

	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { ...base, op: "batch" }), false);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { ...base, edits: "[]" }), false);
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "replace", anchor: "1#BH", lines: ["next"], content: "legacy" }],
		}),
		false,
	);
});

test("apply file changes rejects invalid operation-specific fields", () => {
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "replace", anchor: "1#BH", lines: [] }],
		}),
		false,
	);
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "delete", anchor: "1#BH", lines: ["wrong"] }],
		}),
		false,
	);
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "insert", anchor: "1#BH", lines: ["missing position"] }],
		}),
		false,
	);
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "insert", anchor: "1#BH", position: "before", end_anchor: "2#BB", lines: ["wrong"] }],
		}),
		false,
	);
	assert.equal(
		Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
			path: "src/a.ts",
			changes: [{ operation: "replace", anchor: "1#BH", lines: ["first\nsecond"] }],
		}),
		false,
	);
});
