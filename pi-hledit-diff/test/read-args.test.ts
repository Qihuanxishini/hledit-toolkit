import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_READ_LIMIT,
	DEFAULT_SEARCH_LIMIT,
	MAX_READ_LIMIT,
	buildReadArgs,
	buildSearchArgs,
	normalizeReadRequest,
	normalizeSearchRequest,
	normalizeToolPath,
} from "../src/read-args.ts";

test("buildReadArgs protects flag-like paths with the positional separator", () => {
	assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "--limit" })), ["read-range", "--offset", "1", "--limit", String(DEFAULT_READ_LIMIT), "--", "--limit"]);
});

test("buildReadArgs accepts positive integer offset and limit", () => {
	assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts", offset: 10, limit: 20 })), ["read-range", "--offset", "10", "--limit", "20", "--", "src/a.ts"]);
});

test("buildReadArgs ignores invalid offset and clamps oversized limit", () => {
	assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts", offset: 0, limit: MAX_READ_LIMIT + 100 })), ["read-range", "--offset", "1", "--limit", String(MAX_READ_LIMIT), "--", "src/a.ts"]);
});

test("buildSearchArgs applies regex defaults and protects flag-like patterns", () => {
	const request = normalizeSearchRequest({ path: "src/a.ts", pattern: "--literal" });
	assert.deepEqual(buildSearchArgs(request), ["search", "--offset", "1", "--limit", String(DEFAULT_SEARCH_LIMIT), "--", "src/a.ts", "--literal"]);
});

test("buildSearchArgs supports literal matching, context, and ignore_case", () => {
	const request = normalizeSearchRequest({ path: "src/a.ts", pattern: "from ./", literal: true, context: 2, ignore_case: true });
	assert.deepEqual(buildSearchArgs(request), [
		"search", "--offset", "1", "--limit", String(DEFAULT_SEARCH_LIMIT),
		"--literal", "--context", "2", "--ignore-case", "--", "src/a.ts", "from ./",
	]);
});

test("normalizeSearchRequest preserves the exact requested search contract", () => {
	assert.deepEqual(normalizeSearchRequest({ path: "@src/a.ts", pattern: "token", offset: 10, limit: MAX_READ_LIMIT + 10, context: 0 }), {
		path: "src/a.ts",
		offset: 10,
		limit: MAX_READ_LIMIT,
		pattern: "token",
		context: 0,
	});
});

test("normalizeToolPath strips @ prefix", () => {
	assert.equal(normalizeToolPath("@src/a.ts"), "src/a.ts");
});

test("normalizeToolPath converts msys drive paths on Windows", () => {
	const normalized = normalizeToolPath("/c/Users/example/file.ts");
	const expected = process.platform === "win32" ? "c:/Users/example/file.ts" : "/c/Users/example/file.ts";
	assert.equal(normalized, expected);
});
