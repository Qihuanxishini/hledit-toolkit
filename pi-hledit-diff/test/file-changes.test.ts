import assert from "node:assert/strict";
import test from "node:test";

import {
	buildFileChangeRequest,
	fileChangeLineRange,
	findSingleAnchorReplacementError,
	lineFromAnchor,
} from "../src/file-changes.ts";
import type { FileChangeParams } from "../src/schema.ts";

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

test("buildFileChangeRequest omits after for before inserts", () => {
	const request = buildFileChangeRequest({
		path: "src/a.ts",
		changes: [{ operation: "insert", anchor: "6#MN", position: "before", lines: ["one"] }],
	});

	assert.equal(request.stdin, '{"edits":[{"op":"insert","pos":"6#MN","lines":["one"]}]}');
});

test("findSingleAnchorReplacementError blocks accidental block expansion", () => {
	const error = findSingleAnchorReplacementError(
		{
			path: "src/a.ts",
			changes: [{ operation: "replace", anchor: "2#BH", lines: ["two", "inserted"] }],
		},
		"one\ntwo\nthree\n",
	);

	assert.match(error ?? "", /单锚点 replace.*首行重复了原锚点行/);
});

test("findSingleAnchorReplacementError allows explicit ranges and genuine line rewrites", () => {
	assert.equal(
		findSingleAnchorReplacementError(
			{
				path: "src/a.ts",
				changes: [{ operation: "replace", anchor: "2#BH", end_anchor: "3#BB", lines: ["two", "inserted"] }],
			},
			"one\ntwo\nthree\n",
		),
		undefined,
	);
	assert.equal(
		findSingleAnchorReplacementError(
			{
				path: "src/a.ts",
				changes: [{ operation: "replace", anchor: "2#BH", lines: ["TWO", "inserted"] }],
			},
			"one\ntwo\nthree\n",
		),
		undefined,
	);
});

test("fileChangeLineRange reports the anchored span", () => {
	assert.equal(fileChangeLineRange([{ anchor: "10#BH", end_anchor: "12#BB" }, { anchor: "4#JK" }]), "4-12");
	assert.equal(fileChangeLineRange([{ anchor: "4#JK" }]), "4");
	assert.equal(fileChangeLineRange([]), undefined);
});

test("lineFromAnchor reads only valid line prefixes", () => {
	assert.equal(lineFromAnchor("12#Ab9"), 12);
	assert.equal(lineFromAnchor("12"), undefined);
	assert.equal(lineFromAnchor(undefined), undefined);
});
