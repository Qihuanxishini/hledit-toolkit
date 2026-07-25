import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_INSTALL_HINT } from "../src/cli.ts";
import {
    applyFileChangesResult,
    buildDiffDetails,
    fileChangeCheckFailure,
    isFailedHleditResult,
    parseRunObject,
    readAnchorsResult,
    rejectedToolResult,
    replaceOnceResult,
    unavailableToolResult,
} from "../src/result.ts";

const REVISION = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

test("parseRunObject parses stdout JSON before stderr", () => {
    assert.deepEqual(parseRunObject({ stdout: '{"ok":true,"firstChangedLine":2}', stderr: '{"ok":false}', exitCode: 0 }), {
        ok: true,
        firstChangedLine: 2,
    });
});

test("readAnchorsResult exposes actual range, total lines, and continuation", () => {
    const result = readAnchorsResult(
        {
            stdout: JSON.stringify({ ok: true, revision: REVISION, totalLines: 5, lines: [{ line: 2, anchor: "2#BHJ", text: "two" }, { line: 3, anchor: "3#BJL", text: "three" }], truncated: true, nextOffset: 4 }),
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 2, limit: 2 },
    );

    assert.equal(result.content[0]?.text, "2#BHJ:two\n3#BJL:three\n-- Showing lines 2-3 of 5; continue with offset 4 --");
    assert.equal(result.details.disposition, "succeeded");
    assert.deepEqual(result.details.read?.requested, { offset: 2, limit: 2 });
    assert.deepEqual(result.details.read?.actual, { firstLine: 2, lastLine: 3, lineCount: 2, totalLines: 5 });
    assert.equal(result.details.read?.nextOffset, 4);
    assert.equal(result.details.read?.eof, false);
});

test("readAnchorsResult marks a completed range as EOF", () => {
    const result = readAnchorsResult(
        {
            stdout: JSON.stringify({ ok: true, revision: REVISION, totalLines: 5, lines: [{ line: 4, anchor: "4#BKM", text: "four" }, { line: 5, anchor: "5#BMN", text: "five" }], truncated: false }),
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 4, limit: 20 },
    );

    assert.match(result.content[0]?.text ?? "", /Showing lines 4-5 of 5; end of file/);
    assert.equal(result.details.read?.eof, true);
    assert.equal(result.details.read?.nextOffset, undefined);
});

test("readAnchorsResult returns actionable structured range errors", () => {
    const result = readAnchorsResult(
        {
            stdout: '{"ok":false,"error":"range","message":"offset 600 exceeds file length 599","requestedOffset":600,"totalLines":599}',
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 600, limit: 40 },
    );

    assert.equal(result.content[0]?.text, "Starting line 600 is outside the file range (599 total lines).\nSuggestion: Set offset to an integer from 1 through 599.\nError code: range");
    assert.deepEqual(result.details, {
        disposition: "rejected",
        path: "src/a.ts",
        error: {
            code: "range",
            message: "Starting line 600 is outside the file range (599 total lines).",
			rawMessage: "offset 600 exceeds file length 599",
            hint: "Set offset to an integer from 1 through 599.",
            requestedOffset: 600,
            totalLines: 599,
        },
    });
    assert.equal(isFailedHleditResult(result.details), true);
});

test("readAnchorsResult localizes invalid UTF-8 errors", () => {
	const result = readAnchorsResult(
		{ stdout: '{"ok":false,"error":"encoding","message":"file is not valid UTF-8"}', stderr: "", exitCode: 0 },
		{ path: "src/a.ts", offset: 1, limit: 20 },
	);

	assert.equal(result.content[0]?.text, "The target is not valid UTF-8 text; reading was rejected to protect the original bytes.\nError code: encoding");
	assert.deepEqual(result.details.error, {
		code: "encoding",
		message: "The target is not valid UTF-8 text; reading was rejected to protect the original bytes.",
		rawMessage: "file is not valid UTF-8",
	});
});

test("readAnchorsResult distinguishes source-line truncation from pagination", () => {
    const result = readAnchorsResult(
        {
            stdout: JSON.stringify({ ok: true, revision: REVISION, totalLines: 2, lines: [{ line: 1, anchor: "1#BHJ", text: "prefix… [truncated]", textTruncated: true }], truncated: true }),
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 1, limit: 2 },
    );

    assert.equal(result.details.read?.textTruncated, true);
    assert.equal(result.details.read?.nextOffset, undefined);
    assert.match(result.content[0]?.text ?? "", /rereading line ranges cannot recover the omitted in-line text/);
});

test("readAnchorsResult rejects non-sequential unfiltered output", () => {
    const result = readAnchorsResult(
        {
            stdout: JSON.stringify({ ok: true, revision: REVISION, totalLines: 5, lines: [{ line: 2, anchor: "2#BHJ", text: "two" }, { line: 4, anchor: "4#BKM", text: "four" }], truncated: true, nextOffset: 5 }),
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 2, limit: 2 },
    );

    assert.equal(result.details.disposition, "unavailable");
    assert.match(result.content[0]?.text ?? "", /incompatible response/);
});

test("readAnchorsResult formats a complete empty filtered result", () => {
    const result = readAnchorsResult(
        { stdout: JSON.stringify({ ok: true, revision: REVISION, totalLines: 5, lines: [], truncated: false }), stderr: "", exitCode: 0 },
        { path: "src/a.ts", offset: 1, limit: 20, grep: "missing", context: 2 },
    );

    assert.equal(result.content[0]?.text, '-- No lines containing "missing" were found (5 lines total) --');
    assert.deepEqual(result.details.read?.actual, { lineCount: 0, totalLines: 5 });
    assert.deepEqual(result.details.read?.requested, { offset: 1, limit: 20, grep: "missing", context: 2 });
});

test("applyFileChangesResult summarizes successful file changes", () => {
    const result = applyFileChangesResult({
        stdout: JSON.stringify({ ok: true, revision: REVISION, editsApplied: 2, contentChanged: true, firstChangedLine: 3, lastChangedLine: 5, linesAdded: 4, linesDeleted: 1, editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 2 }, { oldStart: 5, oldEnd: 4, delta: 1 }], updatedAnchors: { lines: [{ line: 3, anchor: "3#BHJ", text: "changed" }], offset: 3, limit: 1, desiredLimit: 1, truncated: false } }),
        stderr: "",
        exitCode: 0,
    });

    assert.equal(result.content[0]?.text, "Changes were applied.\nOperations applied: 2\nAffected lines: 3-5\nLine delta: +4 -1");
    assert.deepEqual(result.details, {
        disposition: "succeeded",
        revision: REVISION,
        editsApplied: 2,
        contentChanged: true,
        firstChangedLine: 3,
        lastChangedLine: 5,
        linesAdded: 4,
        linesDeleted: 1,
        editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 2 }, { oldStart: 5, oldEnd: 4, delta: 1 }],
    });
    assert.equal(isFailedHleditResult(result.details), false);
});

test("applyFileChangesResult reports a successful no-op", () => {
    const result = applyFileChangesResult({
        stdout: JSON.stringify({ ok: true, revision: REVISION, editsApplied: 1, contentChanged: false, firstChangedLine: 3, lastChangedLine: 3, linesAdded: 1, linesDeleted: 1, editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 0 }], updatedAnchors: { lines: [{ line: 3, anchor: "3#BHJ", text: "unchanged" }], offset: 3, limit: 1, desiredLimit: 1, truncated: false } }),
        stderr: "",
        exitCode: 0,
    });

    assert.equal(result.content[0]?.text, "No changes were needed; the original anchors are still valid.");
    assert.equal(result.details.disposition, "succeeded");
    assert.equal(result.details.contentChanged, false);
});

test("applyFileChangesResult preserves post-write durability warnings", () => {
    const result = applyFileChangesResult({
        stdout: JSON.stringify({ ok: true, revision: REVISION, editsApplied: 1, contentChanged: true, linesAdded: 1, linesDeleted: 1, warnings: ["file was replaced, but directory metadata could not be synchronized: access denied"], editDeltas: [{ oldStart: 1, oldEnd: 1, delta: 0 }], updatedAnchors: { lines: [{ line: 1, anchor: "1#BHJ", text: "changed" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false } }),
        stderr: "",
        exitCode: 0,
    });

    assert.equal(result.content[0]?.text, "Changes were applied.\nOperations applied: 1\nLine delta: +1 -1\nWarnings:\n- The file content was replaced, but directory metadata could not be synchronized; durability may be reduced in extreme scenarios such as power loss.");
    assert.deepEqual(result.details.warnings, ["The file content was replaced, but directory metadata could not be synchronized; durability may be reduced in extreme scenarios such as power loss."]);
    assert.deepEqual(result.details.rawWarnings, ["file was replaced, but directory metadata could not be synchronized: access denied"]);
});

test("applyFileChangesResult warns that an unverified success may have changed the file", () => {
	const result = applyFileChangesResult({ stdout: "unexpected output", stderr: "", exitCode: 0 });
	const text = result.content[0]?.text ?? "";

	assert.match(text, /incompatible success response/);
	assert.match(text, /file may have changed/);
	assert.match(text, /call hledit_read_anchors/);
	assert.doesNotMatch(text, /^No write was attempted/);
    assert.deepEqual(result.details, { disposition: "outcome_unknown" });
	assert.equal(isFailedHleditResult(result.details), true);
});

test("applyFileChangesResult marks a started failed batch as outcome unknown", () => {
  const result = applyFileChangesResult({ stdout: "hledit timed out", stderr: "", exitCode: 1, started: true });
  assert.equal(result.details.disposition, "outcome_unknown");
  assert.match(result.content[0]?.text ?? "", /write outcome is unknown/);
  assert.match(result.content[0]?.text ?? "", /Do not retry/);
});

test("applyFileChangesResult marks a batch that never started as unavailable", () => {
  const result = applyFileChangesResult({ stdout: "", stderr: "spawn failed", exitCode: 1, started: false });
  assert.equal(result.details.disposition, "unavailable");
  assert.equal(result.content[0]?.text, "spawn failed");
});

test("applyFileChangesResult requires editsApplied and updatedAnchors", () => {
    const missing = applyFileChangesResult({ stdout: '{"ok":true}', stderr: "", exitCode: 0 });
    const invalid = applyFileChangesResult({ stdout: '{"ok":true,"editsApplied":-1}', stderr: "", exitCode: 0 });
    const missingAnchors = applyFileChangesResult({ stdout: '{"ok":true,"editsApplied":1}', stderr: "", exitCode: 0 });

    assert.deepEqual(missing.details, { disposition: "outcome_unknown" });
    assert.deepEqual(invalid.details, { disposition: "outcome_unknown", editsApplied: -1 });
    assert.deepEqual(missingAnchors.details, { disposition: "outcome_unknown", editsApplied: 1 });
    assert.match(missingAnchors.content[0]?.text ?? "", /valid updatedAnchors/);
});

test("applyFileChangesResult rejects internally inconsistent editDeltas", () => {
	const base = {
		ok: true,
		revision: REVISION,
		contentChanged: true,
		linesAdded: 4,
		linesDeleted: 1,
		updatedAnchors: { lines: [{ line: 3, anchor: "3#BHJ", text: "changed" }], offset: 3, limit: 1, desiredLimit: 1, truncated: false },
	};
	const run = (payload: Record<string, unknown>) =>
		applyFileChangesResult({ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 });

	const countMismatch = run({ ...base, editsApplied: 2, editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 3 }] });
	assert.equal(countMismatch.details.disposition, "outcome_unknown");
	assert.match(countMismatch.content[0]?.text ?? "", /editDeltas consistent with the request/);

	const sumMismatch = run({ ...base, editsApplied: 1, editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 1 }] });
	assert.equal(sumMismatch.details.disposition, "outcome_unknown");

	const missingLineCounts = run({
		ok: true,
		revision: REVISION,
		contentChanged: true,
		editsApplied: 1,
		editDeltas: [{ oldStart: 3, oldEnd: 3, delta: 3 }],
		updatedAnchors: base.updatedAnchors,
	});
	assert.equal(missingLineCounts.details.disposition, "outcome_unknown");

	const outOfOrder = run({ ...base, editsApplied: 2, editDeltas: [{ oldStart: 5, oldEnd: 6, delta: 2 }, { oldStart: 3, oldEnd: 3, delta: 1 }] });
	assert.equal(outOfOrder.details.disposition, "outcome_unknown");

	const overlapping = run({ ...base, editsApplied: 2, editDeltas: [{ oldStart: 3, oldEnd: 5, delta: 2 }, { oldStart: 4, oldEnd: 6, delta: 1 }] });
	assert.equal(overlapping.details.disposition, "outcome_unknown");

	const unsafeInteger = run({ ...base, editsApplied: 1, editDeltas: [{ oldStart: 9007199254740993, oldEnd: 9007199254740993, delta: 3 }] });
	assert.equal(unsafeInteger.details.disposition, "outcome_unknown");
});

test("applyFileChangesResult verifies editDeltas against the anchored batch request", () => {
	const context = {
		path: "src/a.ts",
		operation: "anchored_batch" as const,
		changes: [
			{ operation: "insert_after" as const, anchor: "2#BHJ", lines: ["x", "y"] },
			{ operation: "replace_range" as const, start_anchor: "5#BKM", end_anchor: "6#BLN", lines: ["z"] },
		],
	};
	const payload = (editDeltas: Array<Record<string, unknown>>, editsApplied = 2) => JSON.stringify({
		ok: true,
		revision: REVISION,
		editsApplied,
		contentChanged: true,
		linesAdded: 3,
		linesDeleted: 2,
		editDeltas,
		updatedAnchors: { lines: [{ line: 3, anchor: "3#BHJ", text: "x" }], offset: 3, limit: 1, desiredLimit: 1, truncated: false },
	});

	// CLI 物理顺序：insert_after 2 → 空区间 [3,2]；replace [5,6] 1 行 → delta -1。
	const consistent = applyFileChangesResult(
		{ stdout: payload([{ oldStart: 3, oldEnd: 2, delta: 2 }, { oldStart: 5, oldEnd: 6, delta: -1 }]), stderr: "", exitCode: 0 },
		context,
	);
	assert.equal(consistent.details.disposition, "succeeded");

	const wrongInterval = applyFileChangesResult(
		{ stdout: payload([{ oldStart: 3, oldEnd: 2, delta: 2 }, { oldStart: 7, oldEnd: 8, delta: -1 }]), stderr: "", exitCode: 0 },
		context,
	);
	assert.equal(wrongInterval.details.disposition, "outcome_unknown");
	assert.match(wrongInterval.content[0]?.text ?? "", /editDeltas consistent with the request/);

	const missingChange = applyFileChangesResult(
		{ stdout: payload([{ oldStart: 3, oldEnd: 2, delta: 1 }], 1), stderr: "", exitCode: 0 },
		context,
	);
	assert.equal(missingChange.details.disposition, "outcome_unknown");
});

test("replaceOnceResult verifies the single delta against request line counts", () => {
	const payload = (delta: Record<string, unknown>) => JSON.stringify({
		ok: true,
		revision: REVISION,
		editsApplied: 1,
		contentChanged: true,
		linesAdded: 3,
		linesDeleted: 2,
		editDeltas: [delta],
		updatedAnchors: { lines: [{ line: 4, anchor: "4#BHJ", text: "new" }], offset: 4, limit: 1, desiredLimit: 1, truncated: false },
	});
	const counts = { oldLineCount: 2, newLineCount: 3 };

	const consistent = replaceOnceResult({ stdout: payload({ oldStart: 4, oldEnd: 5, delta: 1 }), stderr: "", exitCode: 0 }, "src/a.ts", counts);
	assert.equal(consistent.details.disposition, "succeeded");

	const wrongSpan = replaceOnceResult({ stdout: payload({ oldStart: 4, oldEnd: 4, delta: 1 }), stderr: "", exitCode: 0 }, "src/a.ts", counts);
	assert.equal(wrongSpan.details.disposition, "outcome_unknown");
	assert.match(wrongSpan.content[0]?.text ?? "", /editDeltas consistent with the request/);
});

test("replaceOnceResult requires exactly one applied edit", () => {
	const result = replaceOnceResult({
		stdout: JSON.stringify({
			ok: true,
			revision: REVISION,
			editsApplied: 0,
			contentChanged: false,
			updatedAnchors: { lines: [{ line: 1, anchor: "1#BHJ", text: "unchanged" }], offset: 1, limit: 1, desiredLimit: 1, truncated: false },
		}),
		stderr: "",
		exitCode: 0,
	}, "src/a.ts");

	assert.equal(result.details.disposition, "outcome_unknown");
	assert.match(result.content[0]?.text ?? "", /incompatible success response/);
});

test("fileChangeCheckFailure accepts only an explicit validate-only success", () => {
	const valid = fileChangeCheckFailure({
		stdout: JSON.stringify({ ok: true, revision: REVISION, checked: true, editsApplied: 1, contentChanged: true }),
		stderr: "",
		exitCode: 0,
	});
	const incompatible = fileChangeCheckFailure({
		stdout: JSON.stringify({ ok: true, revision: REVISION, editsApplied: 1, contentChanged: true }),
		stderr: "",
		exitCode: 0,
	});

	assert.equal(valid, undefined);
	assert.equal(incompatible?.details.disposition, "unavailable");
	assert.match(incompatible?.content[0]?.text ?? "", /incompatible --check response/);
	assert.match(incompatible?.content[0]?.text ?? "", /hledit_read_anchors/);
});

test("applyFileChangesResult localizes proof and pre-commit revision rejections", () => {
	const insufficient = applyFileChangesResult({
		stdout: JSON.stringify({ ok: false, error: "insufficient_read_proof", message: "edit 0 requires read proof for line 3", currentRevision: REVISION }),
		stderr: "",
		exitCode: 0,
	});
	assert.equal(insufficient.details.disposition, "rejected");
	assert.equal(insufficient.details.error?.code, "insufficient_read_proof");
	assert.match(insufficient.content[0]?.text ?? "", /Read proof does not cover/);

	const changed = applyFileChangesResult({
		stdout: JSON.stringify({ ok: false, error: "source_changed_before_commit", message: "source changed before commit", currentRevision: REVISION }),
		stderr: "",
		exitCode: 0,
	});
	assert.equal(changed.details.disposition, "rejected");
	assert.equal(changed.details.currentRevision, REVISION);
	assert.equal(changed.details.error?.currentRevision, REVISION);
	assert.match(changed.content[0]?.text ?? "", /The target changed before atomic commit/);
	assert.match(changed.content[0]?.text ?? "", /^The atomic batch was rejected; no content was written/);
});

test("applyFileChangesResult falls back to rereading when a stale snapshot is unavailable", () => {
    const result = applyFileChangesResult(
        { stdout: '{"ok":false,"error":"stale","message":"edit 0: anchor stale","failed":0,"remaps":[{"requested":"2#BHJ","current":"2#BBK"}]}', stderr: "", exitCode: 0 },
        { path: "src/a.ts" },
    );

    assert.match(result.content[0]?.text ?? "", /^The atomic batch was rejected; no content was written\.\nReason: Change 1 uses a stale anchor\.\nError code: stale/m);
    assert.match(result.content[0]?.text ?? "", /2#BHJ -> 2#BBK/);
    assert.match(result.content[0]?.text ?? "", /Before retrying, call hledit_read_anchors\(\{ path: "src\/a\.ts", offset: 1, limit: 12 \}\)/);
    assert.deepEqual(result.details, {
		disposition: "rejected",
		path: "src/a.ts",
		error: { code: "stale", message: "Change 1 uses a stale anchor.", rawMessage: "edit 0: anchor stale" },
	});
    assert.equal(isFailedHleditResult(result.details), true);
});

test("applyFileChangesResult exposes validated stale snapshot context", () => {
	const currentAnchors = {
		lines: [
			{ line: 1, anchor: "1#BHJ", text: "one" },
			{ line: 2, anchor: "2#BBK", text: "modified" },
			{ line: 3, anchor: "3#BJL", text: "three" },
		],
		offset: 1,
		limit: 3,
		desiredLimit: 5,
		truncated: false,
	};
	const result = applyFileChangesResult(
		{
			stdout: JSON.stringify({
				ok: false,
				error: "stale",
				message: "edit 0: anchor stale",
				failed: 0,
				remaps: [
					{ requested: "2#BHJ", current: "2#BBK" },
					{ requested: "2#BHJ", current: "2#BBK" },
				],
				currentAnchors,
			}),
			stderr: "",
			exitCode: 0,
		},
		{
			path: "src/a.ts",
			changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["next"] }],
		},
	);
	const text = result.content[0]?.text ?? "";

	assert.match(text, /2#BBK:modified/);
	assert.match(text, /never retries or overwrites concurrent changes/);
	assert.match(text, /explicitly replace start_anchor\/end_anchor with 2#BBK/);
	assert.doesNotMatch(text, /Before retrying, call hledit_read_anchors/);
	assert.match(text, /Field: start_anchor\/end_anchor/);
	assert.match(text, /Submitted anchor: 2#BHJ/);
	assert.match(text, /Current line at the same number: 2#BBK:modified/);
	assert.match(text, /never repairs anchors or retries a batch/);
	assert.equal(text.match(/2#BHJ -> 2#BBK/g)?.length ?? 0, 0);
	assert.deepEqual(result.details.error?.staleAnchors, [
		{
			changeNumber: 1,
			fields: ["start_anchor", "end_anchor"],
			requestedAnchor: "2#BHJ",
			currentAnchor: "2#BBK",
			currentText: "modified",
		},
	]);
	assert.deepEqual(result.details.error?.currentAnchors, {
		...currentAnchors,
		lines: currentAnchors.lines.map((line) => ({ ...line, textTruncated: false })),
	});
});

test("applyFileChangesResult surfaces the hardlink rejection reason", () => {
	const rawMessage = 'refusing atomic write to "target.txt": file has 2 hard links; preserving link identity would require a non-atomic in-place write';
	const result = applyFileChangesResult({
		stdout: JSON.stringify({ ok: false, error: "io", message: rawMessage }),
		stderr: "",
		exitCode: 0,
	});

	assert.match(result.content[0]?.text ?? "", /The target has 2 hard links/);
	assert.match(result.content[0]?.text ?? "", /preserving link identity/);
	assert.deepEqual(result.details.error, {
		code: "io",
		message: "The target has 2 hard links. The write was rejected because preserving link identity would require a non-atomic update.",
		rawMessage,
	});
});

test("applyFileChangesResult localizes unknown batch fields", () => {
	const rawMessage = 'invalid batch request: json: unknown field "linez"';
	const result = applyFileChangesResult({
		stdout: JSON.stringify({ ok: false, error: "invalid", message: rawMessage, failed: -1 }),
		stderr: "",
		exitCode: 0,
	});

	assert.match(result.content[0]?.text ?? "", /batch JSON contains unsupported field "linez"/);
	assert.deepEqual(result.details.error, {
		code: "invalid",
		message: 'The batch JSON contains unsupported field "linez". Check the field spelling.',
		rawMessage,
	});
});

test("readAnchorsResult identifies unavailable CLI runs", () => {
    const result = readAnchorsResult(
        { stdout: "", stderr: "", exitCode: 1 },
        { path: "src/a.ts", offset: 1, limit: 20 },
    );

    assert.equal(result.content[0]?.text, HLEDIT_INSTALL_HINT);
    assert.deepEqual(result.details, { disposition: "unavailable", path: "src/a.ts" });
});

test("failure result constructors preserve disposition and structured errors", () => {
	const rejected = rejectedToolResult("修改未执行：请求无效", {
		code: "single_line_range_expansion",
		message: "单行 replace_range 可能保留旧代码。",
		changeNumber: 1,
		operation: "replace_range",
		anchor: "2#BHJ",
		outputLineCount: 2,
	});

	assert.deepEqual(rejected.details, {
		disposition: "rejected",
		error: {
			code: "single_line_range_expansion",
			message: "单行 replace_range 可能保留旧代码。",
			changeNumber: 1,
			operation: "replace_range",
			anchor: "2#BHJ",
			outputLineCount: 2,
		},
	});
	assert.equal(isFailedHleditResult(rejected.details), true);
	assert.deepEqual(unavailableToolResult("CLI 不可用").details, { disposition: "unavailable" });
});

test("buildDiffDetails prefers CLI firstChangedLine over generated diff", () => {
    const details = buildDiffDetails("a.txt", "one\ntwo\n", "one\nTWO\n", { firstChangedLine: 10, linesAdded: 1 });

    assert.equal(details.firstChangedLine, 10);
    assert.equal(details.linesAdded, 1);
    assert.equal(typeof details.diff, "string");
    assert.equal(typeof details.patch, "string");
});
