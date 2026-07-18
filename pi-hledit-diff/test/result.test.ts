import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_INSTALL_HINT } from "../src/cli.ts";
import {
    applyFileChangesResult,
    buildDiffDetails,
    isFailedHleditResult,
    parseRunObject,
    readAnchorsResult,
    toolFailureResult,
} from "../src/result.ts";

test("parseRunObject parses stdout JSON before stderr", () => {
    assert.deepEqual(parseRunObject({ stdout: '{"ok":true,"firstChangedLine":2}', stderr: '{"ok":false}', exitCode: 0 }), {
        ok: true,
        firstChangedLine: 2,
    });
});

test("readAnchorsResult exposes actual range, total lines, and continuation", () => {
    const result = readAnchorsResult(
        {
            stdout: '{"ok":true,"totalLines":5,"lines":[{"line":2,"anchor":"2#BH","text":"two"},{"line":3,"anchor":"3#BJ","text":"three"}],"truncated":true,"nextOffset":4}',
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 2, limit: 2 },
    );

    assert.equal(result.content[0]?.text, "2#BH:two\n3#BJ:three\n-- showing lines 2-3 of 5; use offset 4 to continue --");
    assert.equal(result.details.disposition, "succeeded");
    assert.deepEqual(result.details.read?.requested, { offset: 2, limit: 2 });
    assert.deepEqual(result.details.read?.actual, { firstLine: 2, lastLine: 3, lineCount: 2, totalLines: 5 });
    assert.equal(result.details.read?.nextOffset, 4);
    assert.equal(result.details.read?.eof, false);
});

test("readAnchorsResult marks a completed range as EOF", () => {
    const result = readAnchorsResult(
        {
            stdout: '{"ok":true,"totalLines":5,"lines":[{"line":4,"anchor":"4#BK","text":"four"},{"line":5,"anchor":"5#BM","text":"five"}],"truncated":false}',
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 4, limit: 20 },
    );

    assert.match(result.content[0]?.text ?? "", /showing lines 4-5 of 5; end of file/);
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

    assert.equal(result.content[0]?.text, "offset 600 exceeds file length 599\nHint: Use an offset between 1 and 599.\nError: range");
    assert.deepEqual(result.details, {
        disposition: "rejected",
        error: {
            code: "range",
            message: "offset 600 exceeds file length 599",
            hint: "Use an offset between 1 and 599.",
            requestedOffset: 600,
            totalLines: 599,
        },
    });
    assert.equal(isFailedHleditResult(result.details), true);
});

test("readAnchorsResult distinguishes source-line truncation from pagination", () => {
    const result = readAnchorsResult(
        {
            stdout: '{"ok":true,"totalLines":2,"lines":[{"line":1,"anchor":"1#BH","text":"prefix… [truncated]","textTruncated":true}],"truncated":true}',
            stderr: "",
            exitCode: 0,
        },
        { path: "src/a.ts", offset: 1, limit: 2 },
    );

    assert.equal(result.details.read?.textTruncated, true);
    assert.equal(result.details.read?.nextOffset, undefined);
    assert.match(result.content[0]?.text ?? "", /no line-offset continuation is available/);
});

test("readAnchorsResult rejects non-sequential unfiltered output", () => {
    const result = readAnchorsResult(
        {
            stdout: '{"ok":true,"totalLines":5,"lines":[{"line":2,"anchor":"2#BH","text":"two"},{"line":4,"anchor":"4#BK","text":"four"}],"truncated":true,"nextOffset":5}',
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
        { stdout: '{"ok":true,"totalLines":5,"lines":[],"truncated":false}', stderr: "", exitCode: 0 },
        { path: "src/a.ts", offset: 1, limit: 20, grep: "missing" },
    );

    assert.equal(result.content[0]?.text, '-- no lines containing "missing" in 5 total lines --');
    assert.deepEqual(result.details.read?.actual, { lineCount: 0, totalLines: 5 });
});

test("applyFileChangesResult summarizes successful file changes", () => {
    const result = applyFileChangesResult({
        stdout: '{"ok":true,"editsApplied":2,"firstChangedLine":3,"lastChangedLine":5,"linesAdded":4,"linesDeleted":1,"updatedAnchors":{"lines":[{"line":3,"anchor":"3#BH","text":"changed"}],"offset":3,"limit":1,"desiredLimit":1,"truncated":false}}',
        stderr: "",
        exitCode: 0,
    });

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

test("applyFileChangesResult warns that an unverified success may have changed the file", () => {
	const result = applyFileChangesResult({ stdout: "unexpected output", stderr: "", exitCode: 0 });
	const text = result.content[0]?.text ?? "";

	assert.match(text, /incompatible success response/);
	assert.match(text, /file may have changed/);
	assert.match(text, /call hledit_read_anchors/);
	assert.doesNotMatch(text, /^Changes were not applied/);
	assert.deepEqual(result.details, { disposition: "unavailable" });
	assert.equal(isFailedHleditResult(result.details), true);
});

test("applyFileChangesResult requires editsApplied and updatedAnchors", () => {
    const missing = applyFileChangesResult({ stdout: '{"ok":true}', stderr: "", exitCode: 0 });
    const invalid = applyFileChangesResult({ stdout: '{"ok":true,"editsApplied":-1}', stderr: "", exitCode: 0 });
    const missingAnchors = applyFileChangesResult({ stdout: '{"ok":true,"editsApplied":1}', stderr: "", exitCode: 0 });

    assert.deepEqual(missing.details, { disposition: "unavailable" });
    assert.deepEqual(invalid.details, { disposition: "unavailable", editsApplied: -1 });
    assert.deepEqual(missingAnchors.details, { disposition: "unavailable", editsApplied: 1 });
    assert.match(missingAnchors.content[0]?.text ?? "", /valid updatedAnchors/);
});

test("applyFileChangesResult gives stale changes a mandatory reread instruction", () => {
    const result = applyFileChangesResult(
        { stdout: '{"ok":false,"error":"stale","message":"edit 0: anchor stale","remaps":[{"requested":"2#BH","current":"2#BB"}]}', stderr: "", exitCode: 0 },
        { path: "src/a.ts" },
    );

    assert.match(result.content[0]?.text ?? "", /^Atomic batch rejected; zero changes were applied\.\nError: stale/m);
    assert.match(result.content[0]?.text ?? "", /2#BH -> 2#BB/);
    assert.match(result.content[0]?.text ?? "", /Call hledit_read_anchors\(\{ path: "src\/a\.ts", offset: 1, limit: 12 \}\) before retrying/);
    assert.deepEqual(result.details, { disposition: "rejected" });
    assert.equal(isFailedHleditResult(result.details), true);
});

test("readAnchorsResult identifies unavailable CLI runs", () => {
    const result = readAnchorsResult(
        { stdout: "", stderr: "", exitCode: 1 },
        { path: "src/a.ts", offset: 1, limit: 20 },
    );

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
