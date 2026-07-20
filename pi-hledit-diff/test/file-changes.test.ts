import assert from "node:assert/strict";
import test from "node:test";

import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	fileChangeLineRanges,
	findSingleAnchorReplacementIssue,
	formatSingleAnchorReplacementIssue,
	lineFromAnchor,
} from "../src/file-changes.ts";
import type { FileChangeParams } from "../src/schema.ts";

function verifiedIssue(issue: ReturnType<typeof findSingleAnchorReplacementIssue>) {
	assert.ok(issue);
	return { ...issue, anchorsVerified: true as const };
}

test("buildFileChangeRequest translates every supported change", () => {
	const params: FileChangeParams = {
		path: "src/a.ts",
		changes: [
			{ operation: "replace", anchor: "1#BH", end_anchor: "2#BB", lines: ["next"] },
			{ operation: "delete", anchor: "4#JK" },
			{ operation: "insert", anchor: "6#MN", position: "after", lines: ["one", "two"] },
		],
	};

	assert.deepEqual(buildFileChangeRequest(params), {
		args: ["batch", "src/a.ts"],
		stdin: JSON.stringify({
			edits: [
				{ op: "replace", pos: "1#BH", end_pos: "2#BB", lines: ["next"] },
				{ op: "delete", pos: "4#JK", lines: [] },
				{ op: "insert", pos: "6#MN", after: true, lines: ["one", "two"] },
			],
		}),
	});
});

test("buildFileChangeCheckRequest adds validate-only mode", () => {
	const request = buildFileChangeCheckRequest({
		path: "src/a.ts",
		changes: [{ operation: "replace", anchor: "1#BH", lines: ["next"] }],
	});

	assert.deepEqual(request.args, ["batch", "--check", "src/a.ts"]);
	assert.equal(request.stdin, '{"edits":[{"op":"replace","pos":"1#BH","lines":["next"]}]}');
});

test("buildFileChangeRequest omits after for before inserts", () => {
	const request = buildFileChangeRequest({
		path: "src/a.ts",
		changes: [{ operation: "insert", anchor: "6#MN", position: "before", lines: ["one"] }],
	});

	assert.equal(request.stdin, '{"edits":[{"op":"insert","pos":"6#MN","lines":["one"]}]}');
});

test("findSingleAnchorReplacementIssue returns actionable structured guidance", () => {
	const issue = findSingleAnchorReplacementIssue(
		{
			path: "src/a.ts",
			changes: [{ operation: "replace", anchor: "2#BH", lines: ["two", "inserted"] }],
		},
		"one\ntwo\nthree\n",
	);

	assert.deepEqual(issue, {
		code: "single_anchor_block_expansion",
		changeNumber: 1,
		anchor: "2#BH",
		outputLineCount: 2,
		missingField: "end_anchor",
		replacementLines: ["two", "inserted"],
		insertLines: ["inserted"],
	});
	const text = formatSingleAnchorReplacementIssue(verifiedIssue(issue));
	assert.match(text, /实际收到：[\s\S]*end_anchor: 未提供/);
	assert.match(text, /禁止使用相同参数重试/);
	assert.match(text, /当前没有可安全使用的结束锚点/);
	assert.doesNotMatch(text, /<从最新 hledit_read_anchors/);
	assert.match(text, /"operation": "insert"[\s\S]*"lines": \[[\s\S]*"inserted"/);
});

test("findSingleAnchorReplacementIssue points out a nearby delete range", () => {
	const issue = findSingleAnchorReplacementIssue(
		{
			path: "src/a.ts",
			changes: [
				{ operation: "replace", anchor: "2#BH", lines: ["two", "replacement"] },
				{ operation: "delete", anchor: "4#JK", end_anchor: "6#MN" },
			],
		},
		"one\ntwo\nthree\nfour\nfive\nsix\n",
	);

	assert.deepEqual(issue?.nearbyDeleteRange, {
		changeNumber: 2,
		anchor: "4#JK",
		endAnchor: "6#MN",
	});
	const text = formatSingleAnchorReplacementIssue(verifiedIssue(issue));
	assert.match(text, /第 2 项 delete 覆盖 4#JK 到 6#MN/);
	assert.match(text, /"end_anchor": "6#MN"/);
	assert.match(text, /移除原 delete/);
});

test("findSingleAnchorReplacementIssue does not guess between multiple nearby delete ranges", () => {
	const issue = findSingleAnchorReplacementIssue(
		{
			path: "src/a.ts",
			changes: [
				{ operation: "replace", anchor: "2#BH", lines: ["two", "replacement"] },
				{ operation: "delete", anchor: "3#BB", end_anchor: "3#BB" },
				{ operation: "delete", anchor: "4#JK", end_anchor: "5#KM" },
			],
		},
		"one\ntwo\nthree\nfour\nfive\n",
	);

	assert.equal(issue?.nearbyDeleteRange, undefined);
	assert.doesNotMatch(formatSingleAnchorReplacementIssue(verifiedIssue(issue)), /检测到同批次/);
});

test("findSingleAnchorReplacementIssue allows explicit ranges and genuine line rewrites", () => {
	assert.equal(
		findSingleAnchorReplacementIssue(
			{
				path: "src/a.ts",
				changes: [{ operation: "replace", anchor: "2#BH", end_anchor: "3#BB", lines: ["two", "inserted"] }],
			},
			"one\ntwo\nthree\n",
		),
		undefined,
	);
	assert.equal(
		findSingleAnchorReplacementIssue(
			{
				path: "src/a.ts",
				changes: [{ operation: "replace", anchor: "2#BH", lines: ["TWO", "inserted"] }],
			},
			"one\ntwo\nthree\n",
		),
		undefined,
	);
});

test("fileChangeLineRanges preserves each operation range", () => {
	assert.equal(fileChangeLineRanges([{ anchor: "10#BH", end_anchor: "12#BB" }, { anchor: "4#JK" }]), "10-12,4");
	assert.equal(fileChangeLineRanges([{ anchor: "4#JK" }]), "4");
	assert.equal(fileChangeLineRanges([]), undefined);
});

test("lineFromAnchor reads only valid line prefixes", () => {
	assert.equal(lineFromAnchor("12#Ab9"), 12);
	assert.equal(lineFromAnchor("12"), undefined);
	assert.equal(lineFromAnchor(undefined), undefined);
});
