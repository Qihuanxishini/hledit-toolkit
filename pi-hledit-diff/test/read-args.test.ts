import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, buildReadArgs, normalizeReadRequest, normalizeToolPath } from "../src/read-args.ts";

test("buildReadArgs applies bounded defaults", () => {
    assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts" })), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(DEFAULT_READ_LIMIT), "--json"]);
});

test("buildReadArgs accepts positive integer offset and limit", () => {
    assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts", offset: 10, limit: 20 })), ["read-range", "src/a.ts", "--offset", "10", "--limit", "20", "--json"]);
});

test("buildReadArgs ignores invalid offset and clamps oversized limit", () => {
    assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts", offset: 0, limit: MAX_READ_LIMIT + 100 })), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(MAX_READ_LIMIT), "--json"]);
});

test("buildReadArgs passes grep filters and context", () => {
    assert.deepEqual(buildReadArgs(normalizeReadRequest({ path: "src/a.ts", grep: "function", context: 2 })), ["read-range", "src/a.ts", "--offset", "1", "--limit", String(DEFAULT_READ_LIMIT), "--json", "--grep", "function", "--context", "2"]);
});

// 回归：ignore_case 必须经过 normalizeReadRequest → buildReadArgs 的生产路径到达 CLI。
test("buildReadArgs forwards ignore_case only for grep reads", () => {
    assert.deepEqual(
        buildReadArgs(normalizeReadRequest({ path: "src/a.ts", grep: "token", ignore_case: true })),
        ["read-range", "src/a.ts", "--offset", "1", "--limit", String(DEFAULT_READ_LIMIT), "--json", "--grep", "token", "--ignore-case"],
    );
    assert.deepEqual(
        buildReadArgs(normalizeReadRequest({ path: "src/a.ts", ignore_case: true })),
        ["read-range", "src/a.ts", "--offset", "1", "--limit", String(DEFAULT_READ_LIMIT), "--json"],
    );
});

test("normalizeReadRequest exposes the exact requested range", () => {
    assert.deepEqual(normalizeReadRequest({ path: "@src/a.ts", offset: 10, limit: MAX_READ_LIMIT + 10, grep: "token", context: 0 }), {
        path: "src/a.ts",
        offset: 10,
        limit: MAX_READ_LIMIT,
        grep: "token",
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
