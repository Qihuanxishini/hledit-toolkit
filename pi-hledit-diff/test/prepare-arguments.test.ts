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

const emptyGroups = { replace_ranges: [], delete_ranges: [], insert_before: [], insert_after: [] };

test("decodeFileChangeInput converts grouped text once in fixed group order", () => {
	const decoded = decodeFileChangeInput({
		path: "src/a.ts",
		replace_ranges: [{ start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "first\r\nsecond\r\n" }],
		delete_ranges: [],
		insert_before: [{ anchor: "3#BJM", lines: "" }],
		insert_after: [{ anchor: "2#BJL", lines: "first\n\n" }],
	});
	assert.deepEqual(decoded, { params: { path: "src/a.ts", changes: [
		{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] },
		{ operation: "insert_before", anchor: "3#BJM", lines: [""] },
		{ operation: "insert_after", anchor: "2#BJL", lines: ["first", ""] },
	] } });
});

test("decodeFileChangeInput preserves lone carriage returns as source text", () => {
	for (const [text, lines] of [
		["first\rsecond", ["first\rsecond"]],
		["first\r", ["first\r"]],
		["first\r\r\nsecond\n", ["first\r", "second"]],
	] as const) {
		assert.deepEqual(decodeFileChangeInput({ ...emptyGroups, path: "src/a.ts", insert_after: [{ anchor: "1#BHJ", lines: text }] }), {
			params: { path: "src/a.ts", changes: [{ operation: "insert_after", anchor: "1#BHJ", lines }] },
		});
	}
	const oversized = decodeFileChangeInput({ ...emptyGroups, path: "src/a.ts", insert_after: [{ anchor: "1#BHJ", lines: "a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\r" }] });
	assert.ok("error" in oversized);
});

test("decodeFileChangeInput enforces aggregate UTF-8 and produced-line limits", () => {
	const decodeText = (lines: string) => decodeFileChangeInput({ ...emptyGroups, path: "src/a.ts", insert_after: [{ anchor: "1#BHJ", lines }] });
	const oversizedBytes = decodeText("🙂".repeat(300_000));
	assert.match("error" in oversizedBytes ? oversizedBytes.error : "", /1 MiB canonical UTF-8/);
	const canonicalAtLimit = decodeText("a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\n");
	assert.ok("params" in canonicalAtLimit, JSON.stringify(canonicalAtLimit));
	const canonicalOverLimit = decodeText("a".repeat(MAX_REPLACEMENT_TEXT_BYTES + 1) + "\n");
	assert.match("error" in canonicalOverLimit ? canonicalOverLimit.error : "", /1 MiB canonical UTF-8/);
	const oversizedLines = decodeText("\n".repeat(MAX_REPLACEMENT_LINE_COUNT + 1));
	assert.match("error" in oversizedLines ? oversizedLines.error : "", /exceeds 20000 lines/);
});

// [喵喵喵]: 真实宿主先运行 prepareArguments；分组必填及项总数跨组校验，不能依赖 schema 强制非空。
test("prepareFileChangeArguments rejects grouped field mismatches with one direct message", () => {
	const base = { ...emptyGroups, path: "src/a.ts", proof_id: "p.1" };
	const tool = { name: "hledit_apply_file_changes", description: "Apply file changes", parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA };
	const validate = (args: unknown) => {
		const original = structuredClone(args);
		const prepared = prepareFileChangeArguments(args);
		assert.equal(prepared, args);
		assert.deepEqual(args, original);
		return validateToolArguments(tool, { type: "toolCall", id: "shape", name: tool.name, arguments: prepared });
	};
	const item = { anchor: "12#Ab1", lines: "x" };
	const cases: [args: unknown, message: RegExp][] = [
		[{ ...base, replace_ranges: [{ anchor: "12#Ab1", lines: "x" }] }, /^replace_ranges\[0\] was rejected: requires start_anchor and end_anchor.*must not carry anchor/],
		[{ ...base, delete_ranges: [{ start_anchor: "12#Ab1", end_anchor: "12#Ab1", lines: "x" }] }, /^delete_ranges\[0\] was rejected: must not carry lines/],
		[{ ...base, insert_before: [{ anchor: "12#Ab1" }] }, /^insert_before\[0\] was rejected: requires lines/],
		[{ ...base, insert_before: [{ anchor: "12#Ab1", lines: null }] }, /^insert_before\[0\] was rejected: requires lines/],
		[{ ...base, insert_after: [{ ...item, start_anchor: "12#Ab1", end_anchor: "12#Ab1" }] }, /^insert_after\[0\] was rejected: must not carry start_anchor and end_anchor/],
		[{ ...base, insert_after: [{ ...item, operation: "insert_after" }] }, /^insert_after\[0\] was rejected: must not carry operation/],
		[{ ...base, insert_after: [{ anchor: "12#Ab1", lines: ["x"] }] }, /^insert_after\[0\]\.lines must be a string/],
		[{ ...base, insert_after: undefined }, /^insert_after must be an array/],
		[{ ...base, changes: [item] }, /^changes is no longer accepted/],
		[base, /1-200 items across all four groups/],
		[{ ...base, insert_before: Array(100).fill(item), insert_after: Array(101).fill(item) }, /1-200 items across all four groups/],
	];
	for (const [args, message] of cases) {
		assert.throws(() => validate(args), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, message);
			assert.match(error.message, /No edit was executed/);
			assert.doesNotMatch(error.message, /\n/);
			return true;
		});
		assert.deepEqual(decodeFileChangeInput(args as FileChangeInput), { error: (() => {
			try { prepareFileChangeArguments(args); } catch (error) { return (error as Error).message.replace(/ No edit was executed;.*$/, ""); }
		})() });
	}
	const valid: FileChangeInput = {
		path: "src/a.ts", proof_id: "p.1",
		replace_ranges: [{ start_anchor: "12#Ab1", end_anchor: "12#Ab1", lines: "x" }],
		delete_ranges: [{ start_anchor: "12#Ab1", end_anchor: "12#Ab1" }],
		insert_before: [item], insert_after: [item],
	};
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, valid), true);
	assert.ok("params" in decodeFileChangeInput(validate(valid)));
});
