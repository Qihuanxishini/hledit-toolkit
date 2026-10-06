import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { decodeFileChangeInput, prepareReadAnchorsArguments, prepareSearchAnchorsArguments } from "../src/prepare-arguments.ts";
import { HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, MAX_REPLACEMENT_LINE_COUNT, MAX_REPLACEMENT_TEXT_BYTES } from "../src/schema.ts";

test("read and search reject invalid values instead of silently clamping them", () => {
	for (const [prepare, schema, base] of [
		[prepareReadAnchorsArguments, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts" }],
		[prepareSearchAnchorsArguments, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, { path: "src/a.ts", pattern: "token" }],
	] as const) {
		assert.equal(Value.Check(schema, prepare(base)), true);
		assert.equal(Value.Check(schema, prepare({ ...base, offset: "1", limit: "2000" })), true);
		for (const invalid of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 2001 }]) {
			assert.equal(Value.Check(schema, prepare({ ...base, ...invalid })), false, JSON.stringify(invalid));
		}
	}
	assert.equal(Value.Check(HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
		prepareSearchAnchorsArguments({ path: "src/a.ts", pattern: "token", context: -1 })), false);
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

test("decodeFileChangeInput preserves lone carriage returns as source text", () => {
  for (const [text, lines] of [
    ["first\rsecond", ["first\rsecond"]],
    ["first\r", ["first\r"]],
    ["first\r\r\nsecond\n", ["first\r", "second"]],
  ] as const) {
    const decoded = decodeFileChangeInput({
      path: "src/a.ts",
      changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: text }],
    });
    assert.deepEqual(decoded, {
      params: { path: "src/a.ts", changes: [{ operation: "insert_after", anchor: "1#BHJ", lines }] },
    });
  }
  const oversized = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\r" }],
  });
  assert.ok("error" in oversized);
});
test("decodeFileChangeInput enforces aggregate UTF-8 and produced-line limits", () => {
  const oversizedBytes = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "🙂".repeat(300_000) }],
  });
  assert.match("error" in oversizedBytes ? oversizedBytes.error : "", /1 MiB canonical UTF-8/);

  const canonicalAtLimit = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\n" }],
  });
  assert.ok("params" in canonicalAtLimit, JSON.stringify(canonicalAtLimit));

  const canonicalOverLimit = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "a".repeat(MAX_REPLACEMENT_TEXT_BYTES + 1) + "\n" }],
  });
  assert.match("error" in canonicalOverLimit ? canonicalOverLimit.error : "", /1 MiB canonical UTF-8/);

  const oversizedLines = decodeFileChangeInput({
    path: "src/a.ts",
    changes: [{ operation: "insert_after", anchor: "1#BHJ", lines: "\n".repeat(MAX_REPLACEMENT_LINE_COUNT + 1) }],
  });
  assert.match("error" in oversizedLines ? oversizedLines.error : "", /exceeds 20000 lines/);
});
