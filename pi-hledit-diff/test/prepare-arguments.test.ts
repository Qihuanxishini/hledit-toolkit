import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

import { decodeFileChangeInput, prepareFileChangeArguments } from "../src/prepare-arguments.ts";
import { HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, MAX_REPLACEMENT_LINE_COUNT, MAX_REPLACEMENT_TEXT_BYTES, type FileChangeInput } from "../src/schema.ts";

test("read and search use host coercion before schema bounds validation", () => {
	for (const [name, schema, wrap] of [
		["hledit_read_anchors", HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
			(window: Record<string, number | string>) => ({ path: "src/a.ts", windows: [window] })],
		["hledit_search_anchors", HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
			(fields: Record<string, number | string>) => ({ path: "src/a.ts", pattern: "token", ...fields })],
	] as const) {
		const tool = { name, description: "Read source anchors", parameters: schema };
		const validate = (fields: Record<string, number | string>) => validateToolArguments(tool, {
			type: "toolCall", id: "read-shape", name, arguments: wrap(fields),
		});
		const base = { offset: 1, limit: 160 };
		assert.deepEqual(validate(base), wrap(base));
		assert.deepEqual(validate({ offset: "1", limit: "2000" }), wrap({ offset: 1, limit: 2000 }));
		// [喵喵喵]: Value.Convert 会截断小数；不能用仅 Value.Check 的断言代替真实宿主契约。
		for (const input of [{ ...base, offset: 1.5 }, { ...base, limit: 1.5 }]) {
			assert.deepEqual(validate(input), wrap({ offset: Math.trunc(input.offset), limit: Math.trunc(input.limit) }));
		}
		for (const invalid of [{ offset: 0 }, { offset: -1 }, { limit: 0 }, { limit: -1 }, { limit: 2001 }]) {
			assert.throws(() => validate({ ...base, ...invalid }), /Validation failed/, JSON.stringify(invalid));
		}
	}
	assert.throws(() => validateToolArguments({
		name: "hledit_search_anchors", description: "Search source anchors", parameters: HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
	}, {
		type: "toolCall", id: "search-shape", name: "hledit_search_anchors",
		arguments: { path: "src/a.ts", pattern: "token", context: -1 },
	}), /Validation failed/);
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

// [喵喵喵]: 分支 schema 与诊断约束同一组操作；实际宿主先运行 prepareArguments，再做 schema 校验。
test("prepareFileChangeArguments rejects operation/field mismatches with one direct message", () => {
	const wrap = (changes: Record<string, string | null>[]) => ({ path: "src/a.ts", proof_id: "p.1", changes });
	const tool = { name: "hledit_apply_file_changes", description: "Apply file changes", parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA };
	const validate = (changes: Record<string, string | null>[]) => {
		const args = wrap(changes);
		const original = structuredClone(args);
		const prepared = prepareFileChangeArguments(args);
		assert.equal(prepared, args);
		assert.deepEqual(args, original);
		return validateToolArguments(tool, { type: "toolCall", id: "shape", name: tool.name, arguments: prepared });
	};
	const cases: [changes: Record<string, string | null>[], message: RegExp][] = [
		[[{ operation: "replace_range", anchor: "12#Ab1", lines: "x" }],
			/^Change 1 was rejected: replace_range requires start_anchor and end_anchor.*must not carry anchor.*repeating the same token.*anchor is for inserts only/],
		[[{ operation: "delete_range", start_anchor: "12#Ab1", end_anchor: "12#Ab1", lines: "x" }],
			/^Change 1 was rejected: delete_range must not carry lines.*to replace content use replace_range/],
		[[{ operation: "insert_before", anchor: "12#Ab1" }],
			/^Change 1 was rejected: insert_before requires lines.*Use anchor and lines/],
		[[{ operation: "insert_before", anchor: "12#Ab1", lines: null }],
			/^Change 1 was rejected: insert_before requires lines/],
		[[{ operation: "insert_after", anchor: "12#Ab1", lines: "x", start_anchor: "12#Ab1", end_anchor: "12#Ab1" }],
			/^Change 1 was rejected: insert_after must not carry start_anchor and end_anchor.*Use anchor and lines/],
	];
	for (const [changes, message] of cases) {
		assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, wrap(changes)), false,
			`model-facing schema must reject combination errors: ${JSON.stringify(changes)}`);
		assert.throws(() => validate(changes), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, message);
			assert.doesNotMatch(error.message, /\n/);
			return true;
		});
	}
	const valid: FileChangeInput["changes"] = [
		{ operation: "replace_range", start_anchor: "12#Ab1", end_anchor: "12#Ab1", lines: "x" },
		{ operation: "delete_range", start_anchor: "12#Ab1", end_anchor: "12#Ab1" },
		{ operation: "insert_before", anchor: "12#Ab1", lines: "x" },
		{ operation: "insert_after", anchor: "12#Ab1", lines: "x" },
	];
	assert.ok("params" in decodeFileChangeInput(validate(valid)));
});
