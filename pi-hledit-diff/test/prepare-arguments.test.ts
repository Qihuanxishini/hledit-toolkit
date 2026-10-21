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

test("decodeFileChangeInput converts unified changes in file order", () => {
	const decoded = decodeFileChangeInput({
		path: "src/a.ts",
		changes: [
			{ action: "replace", anchors: ["1#BHJ", "1#BHJ"], lines: "first\r\nsecond\r\n" },
			{ action: "replace", anchors: ["2#DEL"], lines: "" }, // 删除单行
			{ action: "insert_before", anchors: ["3#BJM"], lines: "inserted\n" },
			{ action: "insert_after", anchors: ["2#BJL"], lines: "first\n\n" },
			{ action: "replace", anchors: ["4#BMO"], lines: "\n" }, // 单行空行
			{ action: "replace", anchors: ["5#BNP", "6#BQR"], lines: "" }, // 删除连续范围
		],
	});
	assert.deepEqual(decoded, { params: { path: "src/a.ts", changes: [
		{ operation: "replace", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] },
		{ operation: "replace", start_anchor: "2#DEL", end_anchor: "2#DEL", lines: [] },
		{ operation: "insert_before", anchor: "3#BJM", lines: ["inserted"] },
		{ operation: "insert_after", anchor: "2#BJL", lines: ["first", ""] },
		{ operation: "replace", start_anchor: "4#BMO", end_anchor: "4#BMO", lines: [""] },
		{ operation: "replace", start_anchor: "5#BNP", end_anchor: "6#BQR", lines: [] },
	] } });
});

test("decodeFileChangeInput preserves lone carriage returns as source text", () => {
	for (const [text, lines] of [
		["first\rsecond", ["first\rsecond"]],
		["first\r", ["first\r"]],
		["first\r\r\nsecond\n", ["first\r", "second"]],
	] as const) {
		assert.deepEqual(decodeFileChangeInput({ path: "src/a.ts", changes: [{ action: "insert_after", anchors: ["1#BHJ"], lines: text }] }), {
			params: { path: "src/a.ts", changes: [{ operation: "insert_after", anchor: "1#BHJ", lines }] },
		});
	}
	const oversized = decodeFileChangeInput({ path: "src/a.ts", changes: [{ action: "insert_after", anchors: ["1#BHJ"], lines: "a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\r" }] });
	assert.ok("error" in oversized);
});

test("decodeFileChangeInput enforces aggregate UTF-8 and produced-line limits", () => {
	const decodeText = (lines: string) => decodeFileChangeInput({ path: "src/a.ts", changes: [{ action: "insert_after", anchors: ["1#BHJ"], lines }] });
	const oversizedBytes = decodeText("🙂".repeat(300_000));
	assert.match("error" in oversizedBytes ? oversizedBytes.error : "", /changes\[0\] pushes the batch past the 1 MiB canonical UTF-8 replacement limit/);
	const canonicalAtLimit = decodeText("a".repeat(MAX_REPLACEMENT_TEXT_BYTES) + "\n");
	assert.ok("params" in canonicalAtLimit, JSON.stringify(canonicalAtLimit));
	const canonicalOverLimit = decodeText("a".repeat(MAX_REPLACEMENT_TEXT_BYTES + 1) + "\n");
	assert.match("error" in canonicalOverLimit ? canonicalOverLimit.error : "", /changes\[0\] pushes the batch past the 1 MiB canonical UTF-8 replacement limit/);
	const oversizedLines = decodeText("\n".repeat(MAX_REPLACEMENT_LINE_COUNT + 1));
	assert.match("error" in oversizedLines ? oversizedLines.error : "", /changes\[0\] pushes the batch past the 20000-line replacement limit/);
});

// [喵喵喵]: 宿主先运行 prepareArguments；单数组校验且不为旧四数组做兼容。
test("prepareFileChangeArguments validates changes and rejects invalid fields", () => {
	const base = { path: "src/a.ts", proof_id: "p.1" };
	const tool = { name: "hledit_apply_file_changes", description: "Apply file changes", parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA };
	const validate = (args: unknown) => {
		const original = structuredClone(args);
		const prepared = prepareFileChangeArguments(args);
		assert.equal(prepared, args);
		assert.deepEqual(args, original);
		return validateToolArguments(tool, { type: "toolCall", id: "shape", name: tool.name, arguments: prepared });
	};
	const item = { action: "replace" as const, anchors: ["12#Ab1"], lines: "x" };
	const cases: [args: unknown, message: RegExp][] = [
		[{ ...base, replace_ranges: [{ start_anchor: "12#Ab1", end_anchor: "12#Ab1", lines: "x" }] }, /Grouped arrays.*are no longer supported/],
		[{ ...base, changes: [{ ...item, action: "delete" }] }, /changes\[0\]\.action must be one of 'replace', 'insert_before', 'insert_after'/],
		[{ ...base, changes: [{ ...item, extra: "no", anchors: ["12#Ab1-13#Ab2"] }] }, /changes\[0\] \(replace\) was rejected: must not carry extra[\s\S]*changes\[0\]\.anchors\[0\] must be one complete LN#HASH token[\s\S]*two separate array elements/],
		[{ ...base, changes: [{ action: "insert_before", anchor: "12#Ab1", lines: "x" }] }, /must not carry anchor/],
		[{ ...base, changes: [{ ...item, end_anchor: "13#Ab2" }] }, /must not carry end_anchor/],
		[{ ...base, changes: [{ ...item, action: "insert_before", anchors: ["12#Ab1", "13#Ab2"] }] }, /requires exactly one anchor/],
		[{ ...base, changes: [{ ...item, action: "insert_after", lines: "" }] }, /requires a non-empty lines string/],
		[{ ...base, changes: [{ action: "replace", anchors: ["12#Ab1"] }] }, /lines must be a raw text string; use "" to delete/],
		[{ ...base, changes: [{ ...item, lines: null }] }, /lines must be a raw text string/],
		[{ ...base, changes: [{ ...item, action: "insert_after", lines: null }] }, /lines must be a raw text string/],
		[{ ...base, changes: [{ anchors: ["12#Ab1"], lines: "x" }] }, /changes\[0\]\.action must be one of/],
		[{ ...base, changes: ["12#Ab1"] }, /changes\[0\] must be an object/],
		[{ ...base, changes: [{ ...item, anchors: [12] }] }, /anchors\[0\] must be a string anchor token/],
		...([undefined, null, [], ["12#Ab1", "13#Ab2", "14#Ab3"]].map((anchors): [unknown, RegExp] =>
			[{ ...base, changes: [{ ...item, anchors }] }, /anchors must be an array of 1-2 anchor tokens/])),
		[{ ...base, changes: undefined }, /changes must be an array/],
		[{ ...base, changes: [] }, /1-200 items in changes/],
		[{ ...base, changes: Array(201).fill(item) }, /1-200 items in changes/],
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
		changes: [
			{ action: "replace", anchors: ["12#Ab1", "12#Ab1"], lines: "x" },
			{ action: "replace", anchors: ["13#Ab2"], lines: "" }, // 删除单行
			{ action: "insert_before", anchors: ["14#Ab3"], lines: "before" },
			{ action: "insert_after", anchors: ["15#Ab4"], lines: "after" },
		],
	};
	assert.equal(Value.Check(HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, valid), true);
	assert.ok("params" in decodeFileChangeInput(validate(valid)));
});
