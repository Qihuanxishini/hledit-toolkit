import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { prepareReplaceOnceArguments } from "../src/prepare-arguments.ts";
import { HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA } from "../src/schema.ts";

test("replace-once schema accepts exact multiline content and rejects incomplete shapes", () => {
	assert.equal(
		Value.Check(HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA, {
			path: "src/a.ts",
			old_lines: "old\nblock",
			new_lines: ["new", "block"],
		}),
		true,
	);
	for (const input of [
		{ path: "src/a.ts", old_lines: "old" },
		{ path: "src/a.ts", new_lines: "new" },
		{ path: "src/a.ts", old_lines: [], new_lines: "new" },
		{ path: "src/a.ts", old_lines: ["old\nblock"], new_lines: "new" },
		{ path: "src/a.ts", old_lines: "old", new_lines: "new", anchor: "1#BHJ" },
	]) {
		assert.equal(Value.Check(HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA, input), false);
	}
});

test("replace-once preparation canonicalizes both public line forms", () => {
	const prepared = prepareReplaceOnceArguments(
		JSON.stringify({ path: "src/a.ts", old_lines: "old\r\nblock\r\n", new_lines: "" }),
	);
	assert.deepEqual(prepared, {
		path: "src/a.ts",
		old_lines: ["old", "block"],
		new_lines: [""],
	});
	assert.equal(Value.Check(HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA, prepared), true);
});
