import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { prepareFileChangeArguments, prepareReadAnchorsArguments } from "../src/prepare-arguments.ts";
import { HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA } from "../src/schema.ts";

test("prepareReadAnchorsArguments converts quoted read integers", () => {
	const prepared = prepareReadAnchorsArguments({ path: "src/a.ts", offset: "3", limit: "20", context: "0" });
	assert.deepEqual(prepared, { path: "src/a.ts", offset: 3, limit: 20, context: 0 });
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments parses JSON changes and wraps a single change", () => {
	const prepared = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: JSON.stringify({ operation: "replace", anchor: "1#BH", lines: "first\nsecond" }),
	});
	assert.deepEqual(prepared, {
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: ["first", "second"] }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments unwraps doubly serialized structural arguments", () => {
	const expected = {
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: ["first", "second"] }],
	};
	const prepared = prepareFileChangeArguments(
		JSON.stringify({
			path: "src/a.ts",
			changes: JSON.stringify(JSON.stringify(expected.changes[0])),
		}),
	);

	assert.deepEqual(prepared, expected);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments leaves strings inside lines untouched", () => {
	const sourceLine = JSON.stringify(JSON.stringify({ valid: "source text" }));
	const prepared = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: JSON.stringify(JSON.stringify([{ operation: "replace", anchor: "1#BH", lines: [sourceLine] }]))
	});

	assert.deepEqual(prepared, {
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: [sourceLine] }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments leaves over-nested or invalid JSON for schema rejection", () => {
	const overNested = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify([{ operation: "delete", anchor: "1#BH" }])))),
	});
	const invalid = prepareFileChangeArguments({ path: "src/a.ts", changes: "[{invalid" });

	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, overNested), false);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, invalid), false);
});

test("prepareFileChangeArguments normalizes range aliases and rendered anchor lines", () => {
	const prepared = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: [
			{
				op: "replace-range",
				anchor: "10#BJ:old first line",
				end_anchor: "12#JM:old last line",
				lines: ["replacement"],
			},
		],
	});
	assert.deepEqual(prepared, {
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "10#BJ", end_anchor: "12#JM", lines: ["replacement"] }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments rejects a range alias without end_anchor", () => {
	const prepared = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: [{ operation: "replace-range", anchor: "10#BJ", lines: ["replacement"] }],
	});

	assert.deepEqual(prepared, {
		path: "src/a.ts",
		changes: [{ operation: "replace-range", anchor: "10#BJ", lines: ["replacement"] }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), false);
});

test("prepareFileChangeArguments preserves ambiguous and unknown fields for schema rejection", () => {
	const ambiguous = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: [{ operation: "delete", anchor: "1#BH", lines: ["do not guess"] }],
	});
	const unknown = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: ["next"], content: "legacy" }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, ambiguous), false);
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, unknown), false);
});

test("prepareFileChangeArguments does not split embedded newlines in an existing lines array", () => {
	const prepared = prepareFileChangeArguments({
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: ["first\nsecond"] }],
	});
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), false);
});
