import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { decodeFileChangeInput, prepareReadAnchorsArguments, prepareSearchAnchorsArguments } from "../src/prepare-arguments.ts";
import { HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, MAX_REPLACEMENT_LINE_COUNT } from "../src/schema.ts";

test("read and search argument preparation clamp only their own fields", () => {
	const read = prepareReadAnchorsArguments({ path: "src/a.ts", offset: 0, limit: 5000 });
	assert.deepEqual(read, { path: "src/a.ts", offset: 1, limit: 2000 });
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, read), true);

	const search = prepareSearchAnchorsArguments({ path: "src/a.ts", pattern: "token", offset: 0, limit: 5000, context: -2 });
	assert.deepEqual(search, { path: "src/a.ts", pattern: "token", offset: 1, limit: 2000, context: 0 });
	assert.equal(Value.Check(HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, search), true);

	const fractional = prepareReadAnchorsArguments({ path: "src/a.ts", offset: 1.5 });
	assert.equal(Value.Check(HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, fractional), false);
});

test("decodeFileChangeInput converts newline-delimited text once at the execute boundary", () => {
  const decoded = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [
      { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "first\r\nsecond\r\n" },
      { operation: "insert_after", anchor: "2#BJL", lines: "first\n\n" },
      { operation: "insert_before", anchor: "3#BJM", lines: "" },
    ],
  });

  assert.deepEqual(decoded, {
    params: {
      path: "src/a.ts",
      changes: [
        { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] },
        { operation: "insert_after", anchor: "2#BJL", lines: ["first", ""] },
        { operation: "insert_before", anchor: "3#BJM", lines: [""] },
      ],
    },
  });
});

test("decodeFileChangeInput enforces aggregate UTF-8 and produced-line limits", () => {
  const oversizedBytes = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "🙂".repeat(300_000) }],
  });
  assert.match("error" in oversizedBytes ? oversizedBytes.error : "", /1 MiB UTF-8/);

  const oversizedLines = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "\n".repeat(MAX_REPLACEMENT_LINE_COUNT + 1) }],
  });
  assert.match("error" in oversizedLines ? oversizedLines.error : "", /exceeds 20000 lines/);
});
