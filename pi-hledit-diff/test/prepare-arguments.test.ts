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
    changes: JSON.stringify({ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "first\nsecond" }),
  });
  assert.deepEqual(prepared, {
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments treats one trailing newline as a string terminator", () => {
  const prepared = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [
      { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "first\r\nsecond\r\n" },
      { operation: "insert_after", anchor: "2#BJL", lines: "first\n\n" },
    ],
  });

  assert.deepEqual(prepared.changes, [
    { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] },
    { operation: "insert_after", anchor: "2#BJL", lines: ["first", ""] },
  ]);
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments treats an empty string as one blank line", () => {
  const prepared = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "" }],
  });

  assert.deepEqual(prepared.changes, [{ operation: "insert_after", anchor: "1#BHJ", lines: [""] }]);
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments accepts a serialized changes array from tool callers", () => {
  const prepared = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: JSON.stringify([{ operation: "insert_after", anchor: "1#BHJ", lines: ["inserted"] }]),
  });

  assert.deepEqual(prepared, {
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: ["inserted"] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments unwraps doubly serialized structural arguments", () => {
  const expected = {
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] }],
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
    changes: JSON.stringify(JSON.stringify([{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: [sourceLine] }])),
  });
  assert.deepEqual(prepared, {
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: [sourceLine] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments leaves over-nested or invalid JSON for schema rejection", () => {
  const overNested = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify([{ operation: "delete_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ" }])))),
  });
  const invalid = prepareFileChangeArguments({ path: "src/a.ts", changes: "[{invalid" });

  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, overNested), false);
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, invalid), false);
});

test("prepareFileChangeArguments normalizes rendered anchors without changing operations", () => {
  const prepared = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [
      {
        operation: "replace_range",
        start_anchor: "10#BJL:old first line",
        end_anchor: "12#JMN:old last line",
        lines: ["replacement"],
      },
    ],
  });
  assert.deepEqual(prepared, {
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "10#BJL", end_anchor: "12#JMN", lines: ["replacement"] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), true);
});

test("prepareFileChangeArguments rejects old operation shapes without migration", () => {
  const oldShape = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [{ operation: "replace", anchor: "10#BJL", lines: ["replacement"] }],
  });
  assert.deepEqual(oldShape, {
    path: "src/a.ts",
    changes: [{ operation: "replace", anchor: "10#BJL", lines: ["replacement"] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, oldShape), false);
});

test("prepareFileChangeArguments preserves unknown fields for schema rejection", () => {
  const unknown = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["next"], content: "legacy" }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, unknown), false);
});

test("prepareFileChangeArguments does not split embedded newlines in an existing lines array", () => {
  const prepared = prepareFileChangeArguments({
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first\nsecond"] }],
  });
  assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, prepared), false);
});
