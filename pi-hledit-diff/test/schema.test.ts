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
  assert.equal(
    applyValidator.Check({
      path: "src/a.ts",
      changes: [{ operation: "delete_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ" }],
    }),
    true,
  );
});

test("apply file changes rejects anchors outside the CLI hash alphabet", () => {
  for (const anchor of ["1#AA", "1#J+0", "1#BHK!", "1#BH", " 1#BHJ", "1 #BHJ", "1#BHJ :text"]) {
    assert.equal(
      Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
        path: "src/a.ts",
        changes: [{ operation: "delete_range", start_anchor: anchor, end_anchor: anchor }],
      }),
      false,
    );
  }
});

test("apply file changes accepts only complete explicit operations", () => {
  assert.equal(
    Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
      path: "src/a.ts",
      changes: [
        { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["next"] },
        { operation: "delete_range", start_anchor: "3#BBK", end_anchor: "4#JKL" },
        { operation: "insert_before", anchor: "6#MNP", lines: ["before"] },
        { operation: "insert_after", anchor: "8#NPQ", lines: ["after"] },
      ],
    }),
    true,
  );
});

test("apply file changes rejects old operation shapes", () => {
  for (const change of [
    { operation: "replace", anchor: "1#BHJ", lines: ["next"] },
    { operation: "delete", anchor: "1#BHJ" },
    { operation: "insert", anchor: "1#BHJ", position: "after", lines: ["next"] },
    { operation: "replace-range", anchor: "1#BHJ", end_anchor: "2#BBK", lines: ["next"] },
  ]) {
    assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { path: "src/a.ts", changes: [change] }), false);
  }
});

test("apply file changes rejects mixed and invalid operation-specific fields", () => {
  const invalidChanges = [
    { operation: "replace_range", start_anchor: "1#BHJ", lines: ["missing end"] },
    { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: [] },
    { operation: "delete_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["wrong"] },
    { operation: "insert_before", anchor: "1#BHJ", end_anchor: "2#BBK", lines: ["wrong"] },
    { operation: "insert_after", anchor: "1#BHJ", position: "after", lines: ["wrong"] },
    { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first\nsecond"] },
  ];

  for (const change of invalidChanges) {
    assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, { path: "src/a.ts", changes: [change] }), false);
  }
  assert.equal(
    Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
      path: "src/a.ts",
      changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: ["next"], content: "unknown" }],
    }),
    false,
  );
  for (const hiddenField of ["revision", "proof", "readSet"]) {
    assert.equal(
      Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, {
        path: "src/a.ts",
        changes: [{ operation: "delete_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ" }],
        [hiddenField]: "must remain internal",
      }),
      false,
    );
  }
});
