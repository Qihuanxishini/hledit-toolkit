import assert from "node:assert/strict";
import test from "node:test";

import { buildFileChangeRequest, fileChangeLineRange, lineFromAnchor } from "../src/file-changes.ts";
import type { FileChangeParams } from "../src/schema.ts";

test("buildFileChangeRequest translates every supported change", () => {
	const params: FileChangeParams = {
		path: "src/a.ts",
		changes: [
			{ operation: "replace", anchor: "1#AA", end_anchor: "2#BB", lines: ["next"] },
			{ operation: "delete", anchor: "4#CC" },
			{ operation: "insert", anchor: "6#DD", position: "after", lines: ["one", "two"] },
		],
	};

	assert.deepEqual(buildFileChangeRequest(params), {
		args: ["batch", "src/a.ts"],
		stdin: JSON.stringify({
			edits: [
				{ op: "replace", pos: "1#AA", end_pos: "2#BB", lines: ["next"] },
				{ op: "delete", pos: "4#CC", lines: [] },
				{ op: "insert", pos: "6#DD", after: true, lines: ["one", "two"] },
			],
		}),
	});
});

test("buildFileChangeRequest omits after for before inserts", () => {
	const request = buildFileChangeRequest({
		path: "src/a.ts",
		changes: [{ operation: "insert", anchor: "6#DD", position: "before", lines: ["one"] }],
	});

	assert.equal(request.stdin, '{"edits":[{"op":"insert","pos":"6#DD","lines":["one"]}]}');
});

test("fileChangeLineRange reports the anchored span", () => {
	assert.equal(fileChangeLineRange([{ anchor: "10#AA", end_anchor: "12#BB" }, { anchor: "4#CC" }]), "4-12");
	assert.equal(fileChangeLineRange([{ anchor: "4#CC" }]), "4");
	assert.equal(fileChangeLineRange([]), undefined);
});

test("lineFromAnchor reads only valid line prefixes", () => {
	assert.equal(lineFromAnchor("12#Ab9"), 12);
	assert.equal(lineFromAnchor("12"), undefined);
	assert.equal(lineFromAnchor(undefined), undefined);
});
