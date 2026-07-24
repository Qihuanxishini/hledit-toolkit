import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_REPLACE_ONCE_TOOL } from "../src/active-tools.ts";
import type { TextResult } from "../src/result.ts";

type ToolResultListener = (event: { toolName: string; details: unknown }, context: { cwd: string }) => unknown;
type RegisteredTool = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => unknown;
	execute: (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: undefined, context: { cwd: string }) => Promise<TextResult>;
};

function registerExtensionForTest(): { registeredTools: Map<string, RegisteredTool>; toolResultListener: ToolResultListener } {
	const registeredTools = new Map<string, RegisteredTool>();
	let toolResultListener: ToolResultListener | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand() {},
		on(eventName: string, listener: ToolResultListener) {
			if (eventName === "tool_result") {
				toolResultListener = listener;
			}
		},
	};

	piHleditDiffExtension(pi as never);
	assert.ok(toolResultListener, "extension must register a tool_result listener");
	return { registeredTools, toolResultListener };
}

test("extension registers all editing tools and escalates logical hledit failures", () => {
	const { registeredTools, toolResultListener } = registerExtensionForTest();

	assert.deepEqual([...registeredTools.keys()], [HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_REPLACE_ONCE_TOOL]);
	const context = { cwd: process.cwd() };
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "rejected" } }, context), { isError: true });
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_READ_ANCHORS_TOOL, details: { disposition: "unavailable" } }, context), { isError: true });
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_REPLACE_ONCE_TOOL, details: { disposition: "rejected" } }, context), { isError: true });
	assert.equal(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "succeeded" } }, context), undefined);
	assert.equal(toolResultListener({ toolName: "bash", details: { disposition: "rejected" } }, context), undefined);
});

test("registered tool metadata gives accurate English safeguards", () => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	const replaceOnceTool = registeredTools.get(HLEDIT_REPLACE_ONCE_TOOL);
	assert.ok(readTool?.description && readTool.promptSnippet && readTool.promptGuidelines);
	assert.ok(applyTool?.description && applyTool.promptSnippet && applyTool.promptGuidelines);
	assert.ok(replaceOnceTool?.description && replaceOnceTool.promptSnippet && replaceOnceTool.promptGuidelines);

	assert.equal(readTool.label, "Read for Edit");
	assert.equal(readTool.promptGuidelines.length, 2);
	assert.equal(applyTool.promptGuidelines.length, 3);
	assert.equal(replaceOnceTool.promptGuidelines.length, 3);
	for (const tool of [readTool, applyTool, replaceOnceTool]) {
		assert.ok(tool.description && tool.promptSnippet && tool.promptGuidelines);
		assert.doesNotMatch(tool.description, /[\u4E00-\u9FFF]/u);
		assert.doesNotMatch(tool.promptSnippet, /[\u4E00-\u9FFF]/u);
		assert.ok(tool.promptGuidelines.every((guideline) => !/[\u4E00-\u9FFF]/u.test(guideline)));
	}
	assert.ok(readTool.promptGuidelines.every((guideline) => guideline.includes(HLEDIT_READ_ANCHORS_TOOL)));
	assert.ok(applyTool.promptGuidelines.every((guideline) => guideline.includes(HLEDIT_APPLY_FILE_CHANGES_TOOL)));
	assert.ok(replaceOnceTool.promptGuidelines.every((guideline) => guideline.includes(HLEDIT_REPLACE_ONCE_TOOL)));
	assert.match(readTool.description, /LN#HASH anchors/);
	assert.ok(readTool.promptGuidelines.some((guideline) => guideline.includes("first read") && guideline.includes("ordinary read")));
	assert.ok(readTool.promptGuidelines.some((guideline) => guideline.includes("grep") && guideline.includes("local read proof")));
	assert.ok(applyTool.promptGuidelines.some((guideline) => guideline.includes("never overwrite the whole file with write")));
	assert.ok(applyTool.promptGuidelines.some((guideline) => guideline.includes("newline-delimited string")));
	assert.ok(applyTool.promptGuidelines.some((guideline) => guideline.includes("updated-anchor local window")));
	assert.ok(applyTool.promptGuidelines.some((guideline) => guideline.includes("complete, untruncated local window")));
	assert.ok(replaceOnceTool.promptGuidelines.some((guideline) => guideline.includes("exactly once") && guideline.includes("old_lines")));
	assert.ok(replaceOnceTool.promptGuidelines.some((guideline) => guideline.includes("empty string") && guideline.includes("not deletion")));
});

test("apply tool exposes JSON-string argument preparation to Pi", () => {
	const { registeredTools } = registerExtensionForTest();
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(applyTool?.prepareArguments);

	assert.deepEqual(
		applyTool.prepareArguments({
			path: "target.txt",
			changes: JSON.stringify({ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: "first\nsecond" }),
		}),
		{
			path: "target.txt",
			changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["first", "second"] }],
		},
	);
});


test("replace-once tool normalizes multiline text and rejects ambiguity without writing", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const replaceOnceTool = registeredTools.get(HLEDIT_REPLACE_ONCE_TOOL);
	assert.ok(replaceOnceTool?.prepareArguments);
	assert.deepEqual(replaceOnceTool.prepareArguments({ path: "target.txt", old_lines: "old\nblock\n", new_lines: "new\nblock" }), {
		path: "target.txt",
		old_lines: ["old", "block"],
		new_lines: ["new", "block"],
	});

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-replace-once-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "needle\nother\nneedle\n", "utf8");
	const result = await replaceOnceTool.execute(
		"replace-once",
		{ path: "target.txt", old_lines: ["needle"], new_lines: ["next"] } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);
	assert.equal(result.details.disposition, "rejected");
	assert.equal(result.details.error?.code, "content_ambiguous");
	assert.match(result.content[0]?.text ?? "", /Candidate ranges:[\s\S]*lines 1-1[\s\S]*lines 3-3/);
	assert.equal(await readFile(target, "utf8"), "needle\nother\nneedle\n");
});

test("read tool returns structured ranges and actionable EOF errors", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	assert.ok(readTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "target.txt"), "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	assert.equal(readResult.details.disposition, "succeeded");
	assert.deepEqual(readResult.details.read?.actual, { firstLine: 2, lastLine: 2, lineCount: 1, totalLines: 3 });
	assert.equal(readResult.details.read?.nextOffset, 3);
	assert.match(readResult.content[0]?.text ?? "", /已显示第 2-2 行（文件共 3 行）；继续读取请使用 offset 3/);

	const grepContextResult = await readTool.execute(
		"read",
		{ path: "target.txt", grep: "two", context: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(grepContextResult.details.disposition, "succeeded");
	assert.deepEqual(grepContextResult.details.read?.lines.map((line) => line.text), ["one", "two", "three"]);

	const rangeError = await readTool.execute("read", { path: "target.txt", offset: 4, limit: 1 } as never, undefined, undefined, context);
	assert.equal(rangeError.details.disposition, "rejected");
	assert.equal(rangeError.details.error?.message, "Starting line 4 is outside the file range (3 total lines).");
	assert.equal(rangeError.content[0]?.text.split("\n", 1)[0], "Starting line 4 is outside the file range (3 total lines).");
});

test("read tool accepts a grep result that exactly fills the byte budget at EOF", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	assert.ok(readTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-exact-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// 1#xxx、冒号和换行共 7 bytes，使锚点行恰好填满 CLI 的 50 KiB 预算。
	const line = "x".repeat(50 * 1024 - 7);
	await writeFile(join(directory, "target.txt"), `${line}\n`, "utf8");

	const result = await readTool.execute(
		"read",
		{ path: "target.txt", offset: 1, limit: 2000, grep: "x" } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);

	assert.equal(result.details.disposition, "succeeded");
	assert.deepEqual(result.details.read?.actual, { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 1 });
	assert.equal(result.details.read?.truncated, false);
	assert.equal(result.details.read?.nextOffset, undefined);
	assert.equal(result.details.read?.textTruncated, false);
});

test("apply tool returns inline updated anchors from bundled batch", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "target.txt"), "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	const renderedAnchor = readResult.content[0]?.text.split(/\r?\n/, 1)[0];
	assert.match(renderedAnchor ?? "", /^2#[A-Za-z0-9_-]{3}:two$/);
	const anchor = renderedAnchor!.split(":", 1)[0]!;
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["TWO"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	assert.match(applyResult.content[0]?.text ?? "", /更新后的锚点（仅第/);
	assert.match(applyResult.content[0]?.text ?? "", /TWO/);
	assert.equal(await readFile(join(directory, "target.txt"), "utf8"), "one\nTWO\nthree\n");
});

test("apply tool reports a no-op without touching the target", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-noop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const fixedTime = new Date("2020-09-13T12:26:40.000Z");
	await utimes(target, fixedTime, fixedTime);
	const before = await stat(target);
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["two"] }] } as never,
		undefined,
		undefined,
		context,
	);

	const after = await stat(target);
	assert.equal(applyResult.details.disposition, "succeeded");
	assert.equal(applyResult.details.contentChanged, false);
	assert.match(applyResult.content[0]?.text ?? "", /无需修改/);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("apply tool accepts byte-truncated updated anchor contexts", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-long-context-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const originalLines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}-${"x".repeat(1500)}`);
	await writeFile(target, `${originalLines.join("\n")}\n`, "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 5, limit: 1 } as never, undefined, undefined, context);
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["CHANGED"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	assert.match(applyResult.content[0]?.text ?? "", /锚点上下文已截断/);
	assert.equal((await readFile(target, "utf8")).split(/\r?\n/)[4], "CHANGED");
});

test("apply tool deleting the only line leaves an empty file", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-empty-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "only\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "delete_range", start_anchor: anchor, end_anchor: anchor }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	assert.match(applyResult.content[0]?.text ?? "", /（文件为空）/);
	assert.equal(await readFile(target, "utf8"), "");
});

test("apply tool rejects accidental single-line range expansion with actionable details", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["two", "inserted"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.deepEqual(applyResult.details.error, {
		code: "single_line_range_expansion",
		message: "Change 1 uses replace_range for one source line while repeating that source line. Expand end_anchor or use insert_after; do not retry the same request.",
		hint: "replace_range must cover the complete old code block. For an append-only change, use insert_after and omit the repeated anchor line.",
		changeNumber: 1,
		operation: "replace_range",
		anchor,
		outputLineCount: 2,
	});
	const text = applyResult.content[0]?.text ?? "";
	assert.match(text, /The atomic batch was rejected; no content was written/);
	assert.match(text, /Received:[\s\S]*end_anchor: .*same as start_anchor/);
	assert.match(text, /Do not retry with the same parameters/);
	assert.match(text, /No safe placeholder end anchor is available/);
	assert.doesNotMatch(text, /<from the latest hledit_read_anchors/);
	assert.match(text, /"operation": "insert_after"[\s\S]*"lines": \[[\s\S]*"inserted"/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");
});

test("apply tool rejects an anchor that does not match its read proof before starting batch", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-stale-guard-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "one\ntwo\nthree\n";
	await writeFile(target, original, "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	const currentAnchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(currentAnchor);
	const staleHash = currentAnchor.slice(-3);
	const staleAnchor = `${currentAnchor.slice(0, -3)}${staleHash === "AAB" ? "AAC" : "AAB"}`;
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: staleAnchor, end_anchor: staleAnchor, lines: ["two", "inserted"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.equal(applyResult.details.error?.code, "insufficient_read_proof");
	assert.match(applyResult.content[0]?.text ?? "", /submitted anchor for line 2 does not match/);
	assert.match(applyResult.content[0]?.text ?? "", /Call hledit_read_anchors/);
	assert.doesNotMatch(applyResult.content[0]?.text ?? "", /single_line_range_expansion|Current anchor snapshot/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("apply tool suggests merging a nearby delete range without writing", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-range-hint-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "one\ntwo\nthree\nfour\nfive\nsix\n";
	await writeFile(target, original, "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 5 } as never, undefined, undefined, context);
	const anchors = readResult.details.read?.lines.map((line) => line.anchor);
	assert.equal(anchors?.length, 5);
	const replacementAnchor = anchors![0]!;
	const deleteAnchor = anchors![2]!;
	const deleteEndAnchor = anchors![4]!;
	const applyResult = await applyTool.execute(
		"apply",
		{
			path: "target.txt",
			changes: [
				{ operation: "replace_range", start_anchor: replacementAnchor, end_anchor: replacementAnchor, lines: ["two", "replacement"] },
				{ operation: "delete_range", start_anchor: deleteAnchor, end_anchor: deleteEndAnchor },
			],
		} as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.equal(applyResult.details.error?.relatedChangeNumber, 2);
	assert.equal(applyResult.details.error?.candidateEndAnchor, deleteEndAnchor);
	assert.match(applyResult.content[0]?.text ?? "", /Change 2 is a delete_range from/);
	assert.match(applyResult.content[0]?.text ?? "", /remove the delete_range/);
	assert.equal(await readFile(target, "utf8"), original);
});
