import assert from "node:assert/strict";
import test from "node:test";

import { MAX_READ_LIMIT, buildReadArgs, normalizeToolPath } from "../src/read-args.ts";

test("buildReadArgs applies bounded defaults", () => {
	assert.deepEqual(buildReadArgs({ path: "src/a.ts" }), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(MAX_READ_LIMIT)]);
});

test("buildReadArgs accepts positive integer offset and limit", () => {
	assert.deepEqual(buildReadArgs({ path: "src/a.ts", offset: 10, limit: 20 }), ["read-range", "src/a.ts", "--offset", "10", "--limit", "20"]);
});

test("buildReadArgs ignores invalid offset and clamps oversized limit", () => {
	assert.deepEqual(buildReadArgs({ path: "src/a.ts", offset: 0, limit: MAX_READ_LIMIT + 100 }), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(MAX_READ_LIMIT)]);
});

test("buildReadArgs passes grep filters", () => {
	assert.deepEqual(buildReadArgs({ path: "src/a.ts", grep: "function" }), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(MAX_READ_LIMIT), "--grep", "function"]);
});

test("normalizeToolPath strips @ prefix", () => {
	assert.equal(normalizeToolPath("@src/a.ts"), "src/a.ts");
});

test("normalizeToolPath converts msys drive paths on Windows", () => {
	const normalized = normalizeToolPath("/c/Users/example/file.ts");
	const expected = process.platform === "win32" ? "c:/Users/example/file.ts" : "/c/Users/example/file.ts";
	assert.equal(normalized, expected);
});
