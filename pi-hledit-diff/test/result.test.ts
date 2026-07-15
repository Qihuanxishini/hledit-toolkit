import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_INSTALL_HINT } from "../src/cli.ts";
import { buildDiffDetails, isFailedHleditResult, parseRunObject, textResult, toolFailureResult } from "../src/result.ts";

test("parseRunObject parses stdout JSON before stderr", () => {
	assert.deepEqual(parseRunObject({ stdout: '{"ok":true,"firstChangedLine":2}', stderr: '{"ok":false}', exitCode: 0 }), {
		ok: true,
		firstChangedLine: 2,
	});
});

test("textResult summarizes successful file changes", () => {
	const result = textResult(
		{
			stdout: '{"ok":true,"editsApplied":2,"firstChangedLine":3,"lastChangedLine":5,"linesAdded":4,"linesDeleted":1,"updatedAnchors":{"lines":[{"line":3,"anchor":"3#AA","text":"changed"}],"offset":3,"limit":1,"desiredLimit":1,"truncated":false}}',
			stderr: "",
			exitCode: 0,
		},
		"apply_file_changes",
	);

	assert.equal(result.content[0]?.text, "Changes applied.\nChanges applied: 2\nChanged lines: 3-5\nLines: +4 -1");
	assert.deepEqual(result.details, {
		disposition: "succeeded",
		editsApplied: 2,
		firstChangedLine: 3,
		lastChangedLine: 5,
		linesAdded: 4,
		linesDeleted: 1,
	});
	assert.equal(isFailedHleditResult(result.details), false);
});

test("textResult rejects unstructured apply success responses", () => {
	const result = textResult({ stdout: "unexpected output", stderr: "", exitCode: 0 }, "apply_file_changes");

	assert.match(result.content[0]?.text ?? "", /incompatible success response/);
	assert.deepEqual(result.details, { disposition: "unavailable" });
	assert.equal(isFailedHleditResult(result.details), true);
});

test("textResult requires editsApplied and updatedAnchors", () => {
	const missing = textResult({ stdout: '{"ok":true}', stderr: "", exitCode: 0 }, "apply_file_changes");
	const invalid = textResult({ stdout: '{"ok":true,"editsApplied":-1}', stderr: "", exitCode: 0 }, "apply_file_changes");
	const missingAnchors = textResult({ stdout: '{"ok":true,"editsApplied":1}', stderr: "", exitCode: 0 }, "apply_file_changes");

	assert.deepEqual(missing.details, { disposition: "unavailable" });
	assert.deepEqual(invalid.details, { disposition: "unavailable", editsApplied: -1 });
	assert.deepEqual(missingAnchors.details, { disposition: "unavailable", editsApplied: 1 });
	assert.match(missingAnchors.content[0]?.text ?? "", /valid updatedAnchors/);
});

test("textResult gives stale changes a mandatory reread instruction", () => {
	const result = textResult(
		{ stdout: '{"ok":false,"error":"stale","message":"edit 0: anchor stale","remaps":[{"requested":"2#AA","current":"2#BB"}]}', stderr: "", exitCode: 0 },
		"apply_file_changes",
		{ path: "src/a.ts" },
	);

	assert.match(result.content[0]?.text ?? "", /^Changes were not applied\.\nError: stale/m);
	assert.match(result.content[0]?.text ?? "", /2#AA -> 2#BB/);
	assert.match(result.content[0]?.text ?? "", /Call hledit_read_anchors\(\{ path: "src\/a\.ts", offset: 1, limit: 12 \}\) before retrying/);
	assert.deepEqual(result.details, { disposition: "rejected" });
	assert.equal(isFailedHleditResult(result.details), true);
});

test("textResult identifies unavailable CLI runs", () => {
	const result = textResult({ stdout: "", stderr: "", exitCode: 1 }, "read_anchors");

	assert.equal(result.content[0]?.text, HLEDIT_INSTALL_HINT);
	assert.deepEqual(result.details, { disposition: "unavailable" });
});

test("toolFailureResult carries a framework-visible rejected disposition", () => {
	const result = toolFailureResult("Changes were not applied: invalid request", "rejected");

	assert.deepEqual(result.details, { disposition: "rejected" });
	assert.equal(isFailedHleditResult(result.details), true);
});

test("buildDiffDetails prefers CLI firstChangedLine over generated diff", () => {
	const details = buildDiffDetails("a.txt", "one\ntwo\n", "one\nTWO\n", { firstChangedLine: 10, linesAdded: 1 });

	assert.equal(details.firstChangedLine, 10);
	assert.equal(details.linesAdded, 1);
	assert.equal(typeof details.diff, "string");
	assert.equal(typeof details.patch, "string");
});
