import assert from "node:assert/strict";
import test from "node:test";

import { prepareSnaplineReadArguments } from "../src/read-arguments.ts";

test("read argument preparation repairs only bounded numeric ranges", () => {
	assert.deepEqual(
		prepareSnaplineReadArguments({ path: "@file.txt", offset: 0, limit: -1 }),
		{ path: "@file.txt", offset: 1, limit: 160 },
	);
	assert.deepEqual(
		prepareSnaplineReadArguments({ path: "file.txt", offset: 9, limit: 5000 }),
		{ path: "file.txt", offset: 9, limit: 2000 },
	);
});

test("read argument preparation leaves invalid types and unknown fields for schema rejection", () => {
	assert.deepEqual(
		prepareSnaplineReadArguments({ path: "file.txt", offset: "1", limit: 1.5, legacy: true }),
		{ path: "file.txt", offset: "1", limit: 1.5, legacy: true },
	);
});
