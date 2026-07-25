import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_REPLACE_ONCE_TOOL } from "../src/active-tools.ts";
import type { TextResult } from "../src/result.ts";

type ToolResultListener = (event: { toolName: string; details: unknown }, context: { cwd: string }) => unknown;
type ExtensionEventListener = (event: never, context: never) => unknown;
type RegisteredTool = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	prepareArguments?: (args: unknown) => unknown;
	execute: (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: undefined, context: { cwd: string }) => Promise<TextResult>;
};

function registerExtensionForTest(): {
	registeredTools: Map<string, RegisteredTool>;
	toolResultListener: ToolResultListener;
	eventListeners: Map<string, ExtensionEventListener>;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const eventListeners = new Map<string, ExtensionEventListener>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand() {},
		on(eventName: string, listener: ExtensionEventListener) {
			eventListeners.set(eventName, listener);
		},
	};

	piHleditDiffExtension(pi as never);
	const toolResultListener = eventListeners.get("tool_result") as ToolResultListener | undefined;
	assert.ok(toolResultListener, "extension must register a tool_result listener");
	return { registeredTools, toolResultListener, eventListeners };
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

test("registered tool metadata stays concise without losing English safeguards", () => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	const replaceOnceTool = registeredTools.get(HLEDIT_REPLACE_ONCE_TOOL);
	assert.ok(readTool?.description && readTool.promptGuidelines);
	assert.ok(applyTool?.description && applyTool.promptGuidelines);
	assert.ok(replaceOnceTool?.description && replaceOnceTool.promptGuidelines);

	assert.equal(readTool.label, "Read for Edit");
	assert.equal(readTool.promptGuidelines.length, 1);
	assert.equal(applyTool.promptGuidelines.length, 2);
	assert.equal(replaceOnceTool.promptGuidelines.length, 1);
	for (const tool of [readTool, applyTool, replaceOnceTool]) {
		assert.ok(tool.description);
		assert.ok(tool.promptGuidelines);
		assert.equal(tool.promptSnippet, undefined);
		assert.doesNotMatch(tool.description, /[\u4E00-\u9FFF]/u);
		assert.ok(tool.promptGuidelines.every((guideline) => !/[\u4E00-\u9FFF]/u.test(guideline)));
	}

	const readGuidelines = readTool.promptGuidelines.join(" ");
	const applyGuidelines = applyTool.promptGuidelines.join(" ");
	const replaceOnceGuidelines = replaceOnceTool.promptGuidelines.join(" ");
	assert.match(readTool.description, /LN#HASH anchors/);
	assert.match(readGuidelines, /first read[\s\S]*ordinary read/);
	assert.match(readGuidelines, /grep\/context[\s\S]*local read proof/);
	assert.match(applyGuidelines, /never overwrite[\s\S]*with write/);
	assert.match(applyGuidelines, /empty file/);
	assert.match(applyGuidelines, /newline-delimited strings/);
	assert.match(applyGuidelines, /complete, untruncated local window/);
	assert.match(applyGuidelines, /verified renames/);
	assert.match(applyGuidelines, /stale[\s\S]*targeted reread/);
	assert.match(replaceOnceGuidelines, /old_lines[\s\S]*exactly once/);
	assert.match(replaceOnceGuidelines, /new_lines rejects an empty string[\s\S]*delete_range/);

	const protocolCharacters = [readTool, applyTool, replaceOnceTool].reduce(
		(total, tool) => total
			+ JSON.stringify(tool.parameters).length
			+ (tool.description?.length ?? 0)
			+ (tool.promptGuidelines ?? []).join("").length,
		0,
	);
	assert.ok(protocolCharacters <= 8000, `registered hledit protocol uses ${protocolCharacters} characters; expected at most 8000`);
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
	assert.match(readResult.content[0]?.text ?? "", /Showing lines 2-2 of 3; continue with offset 3/);

	const grepContextResult = await readTool.execute(
		"read",
		{ path: "target.txt", grep: "two", context: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(grepContextResult.details.disposition, "succeeded");
	assert.deepEqual(grepContextResult.details.read?.lines.map((line) => line.text), ["one", "two", "three"]);

	const caseMissResult = await readTool.execute("read", { path: "target.txt", grep: "TWO" } as never, undefined, undefined, context);
	assert.equal(caseMissResult.details.disposition, "succeeded");
	assert.equal(caseMissResult.details.read?.actual.lineCount, 0);

	const ignoreCaseResult = await readTool.execute(
		"read",
		{ path: "target.txt", grep: "TWO", ignore_case: true } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(ignoreCaseResult.details.disposition, "succeeded");
	assert.deepEqual(ignoreCaseResult.details.read?.lines.map((line) => line.text), ["two"]);
	assert.equal(ignoreCaseResult.details.read?.requested.ignoreCase, true);

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
	const resultText = applyResult.content[0]?.text ?? "";
	assert.match(resultText, /^Applied 1 change; line delta: \+1 -1\.\n\nUpdated anchors:\n/);
	assert.match(resultText, /TWO/);
	assert.equal(resultText.match(/^Updated anchors:$/gm)?.length, 1);
	assert.ok(resultText.length < 250);
	assert.doesNotMatch(resultText, /Later changes inside this window/);
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
	assert.match(applyResult.content[0]?.text ?? "", /No changes were needed/);
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
	assert.match(applyResult.content[0]?.text ?? "", /Anchor window truncated/);
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
	assert.match(applyResult.content[0]?.text ?? "", /\(the file is empty\)/);
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
	assert.match(text, /Received: replace_range .* through .*; 2 output lines/);
	assert.match(text, /Do not retry with the same parameters/);
	assert.match(text, /No safe placeholder end anchor is available/);
	assert.match(text, /change operation to insert_after/);
	assert.match(text, /remove the first line from lines/);
	assert.doesNotMatch(text, /"lines"/);
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
	assert.match(applyResult.content[0]?.text ?? "", new RegExp(`set change 1 end_anchor to ${deleteEndAnchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(applyResult.content[0]?.text ?? "", /remove change 2/);
	assert.doesNotMatch(applyResult.content[0]?.text ?? "", /"lines"/);
	assert.equal(await readFile(target, "utf8"), original);
});

// 宿主对 schema 细节约束（minLength/minItems）的执行不可控；空 lines 契约必须由
// 插件自身边界兜住，且保证零写入。
test("replace-once tool enforces the empty lines contract even without host schema validation", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const replaceOnceTool = registeredTools.get(HLEDIT_REPLACE_ONCE_TOOL);
	assert.ok(replaceOnceTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-empty-contract-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\n", "utf8");
	const context = { cwd: directory };

	const emptyString = await replaceOnceTool.execute(
		"call",
		{ path: "target.txt", old_lines: ["one"], new_lines: "" } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(emptyString.details.disposition, "rejected");
	assert.equal(emptyString.details.error?.code, "invalid");
	assert.match(emptyString.content[0]?.text ?? "", /\[""\]/);
	assert.match(emptyString.content[0]?.text ?? "", /delete_range/);

	const emptyArray = await replaceOnceTool.execute(
		"call",
		{ path: "target.txt", old_lines: ["one"], new_lines: [] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(emptyArray.details.disposition, "rejected");

	const emptyOld = await replaceOnceTool.execute(
		"call",
		{ path: "target.txt", old_lines: [], new_lines: ["x"] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(emptyOld.details.disposition, "rejected");

	assert.equal(await readFile(target, "utf8"), "one\ntwo\n");
});

// [喵喵喵]: Phase 3 起 CLI 逐行保留 terminator：混合行尾文件只改目标行，
// 未触及行的行尾字节保持原样，不再整文件归一化，也不再返回 mixed warning (2026-07-25)
test("apply tool preserves untouched terminators in a mixed line ending file", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-mixed-eol-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "a\r\nb\nc\r\nd\n", "utf8");
	const context = { cwd: directory };

	const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	assert.equal(read.details.disposition, "succeeded");
	const anchor = read.details.read?.lines.find((line) => line.text === "b")?.anchor;
	assert.ok(anchor);

	const result = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["B"] }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(result.details.disposition, "succeeded");
	assert.doesNotMatch(result.content[0]?.text ?? "", /line endings|Warnings:/);
	assert.equal(result.details.warnings, undefined);
	assert.equal(await readFile(target, "utf8"), "a\r\nB\nc\r\nd\n");
});

// [喵喵喵]: Phase 2.1/2.2 回归——evidence 更新在 mutation queue 内完成且只应用一次；
// 排队的同文件后续调用必须立即看到前一项的重映射结果 (2026-07-25)
test("queued same-file apply sees the previous apply's remapped evidence", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-queue-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\nfour\n", "utf8");
	const context = { cwd: directory };

	const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	assert.equal(read.details.disposition, "succeeded");
	const anchorAt = (line: number) => {
		const anchor = read.details.read?.lines.find((entry) => entry.line === line)?.anchor;
		assert.ok(anchor);
		return anchor;
	};

	// 先发起 insert（会把第 3 行平移到第 4 行），随后在其 CLI 仍在运行时排队第二个 apply。
	const insertPromise = applyTool.execute(
		"apply-insert",
		{ path: "target.txt", changes: [{ operation: "insert_after", anchor: anchorAt(1), lines: ["inserted"] }] } as never,
		undefined,
		undefined,
		context,
	);
	// 两个 macrotask 保证 insert 先注册进 mutation queue，但远不足以让其 CLI 进程完成。
	await new Promise((resolveTick) => setImmediate(resolveTick));
	await new Promise((resolveTick) => setImmediate(resolveTick));
	const staleAnchor = anchorAt(3);
	const replacePromise = applyTool.execute(
		"apply-replace",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: staleAnchor, end_anchor: staleAnchor, lines: ["THREE"] }] } as never,
		undefined,
		undefined,
		context,
	);
	const [insertResult, replaceResult] = await Promise.all([insertPromise, replacePromise]);

	assert.equal(insertResult.details.disposition, "succeeded");
	// 第二项必须在插件侧拿到基于新 evidence 的更名指引，而不是把旧 proof 发给 CLI 换回 stale。
	assert.equal(replaceResult.details.disposition, "rejected");
	assert.equal(replaceResult.details.error?.code, "insufficient_read_proof");
	assert.equal(replaceResult.details.error?.renamesRestoreProof, true);
	const renames = replaceResult.details.error?.renamedAnchors as Array<{ requested: string; current: string }>;
	assert.equal(renames?.length, 1);
	assert.equal(renames[0]?.requested, staleAnchor);
	assert.match(renames[0]?.current ?? "", /^4#/);
	assert.match(replaceResult.content[0]?.text ?? "", /Resubmit after replacing every renamed anchor/);
	assert.equal(await readFile(target, "utf8"), "one\ninserted\ntwo\nthree\nfour\n");
});

// [喵喵喵]: Phase 2.3 回归——session_before_compact 从结构化 tool result 补充
// readFiles/modifiedFiles；零写入拒绝不得记为已修改 (2026-07-25)
test("session_before_compact records anchored file operations from structured results", () => {
	const { eventListeners } = registerExtensionForTest();
	const compactListener = eventListeners.get("session_before_compact");
	assert.ok(compactListener, "extension must register a session_before_compact listener");

	const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	const toolResult = (toolName: string, details: Record<string, unknown>) => ({
		role: "toolResult",
		toolCallId: "call",
		toolName,
		content: [],
		details,
		isError: false,
		timestamp: 0,
	});
	compactListener(
		{
			type: "session_before_compact",
			preparation: {
				messagesToSummarize: [
					toolResult(HLEDIT_READ_ANCHORS_TOOL, { disposition: "succeeded", path: "src/read-only.ts" }),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, { disposition: "succeeded", contentChanged: true, path: "src/edited.ts" }),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, { disposition: "succeeded", contentChanged: false, path: "src/noop.ts" }),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, { disposition: "rejected", path: "src/rejected.ts" }),
					toolResult(HLEDIT_REPLACE_ONCE_TOOL, { disposition: "unavailable", path: "src/unavailable.ts" }),
					{ role: "assistant", content: [] },
				],
				turnPrefixMessages: [
					toolResult(HLEDIT_REPLACE_ONCE_TOOL, { disposition: "outcome_unknown", path: "src/maybe-modified.ts" }),
				],
				fileOps,
			},
		} as never,
		{ cwd: process.cwd() } as never,
	);

	assert.deepEqual([...fileOps.read].sort(), ["src/noop.ts", "src/read-only.ts"]);
	assert.deepEqual([...fileOps.edited].sort(), ["src/edited.ts", "src/maybe-modified.ts"]);
	assert.deepEqual([...fileOps.written], []);
});

// [喵喵喵]: Phase 4 回归——成功结果携带提交绑定的结构化 changePreview，
// 不再保存等价的全文件 diff/patch，也不再前后读取完整文件 (2026-07-25)
test("apply tool attaches a commit-bound change preview instead of a full-file diff", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-preview-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
	const context = { cwd: directory };

	const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	assert.equal(read.details.disposition, "succeeded");
	const anchorAt = (line: number) => {
		const anchor = read.details.read?.lines.find((entry) => entry.line === line)?.anchor;
		assert.ok(anchor);
		return anchor;
	};

	const result = await applyTool.execute(
		"apply",
		{
			path: "target.txt",
			changes: [
				{ operation: "replace_range", start_anchor: anchorAt(2), end_anchor: anchorAt(2), lines: ["TWO", "TWO2"] },
				{ operation: "insert_after", anchor: anchorAt(4), lines: ["N"] },
				{ operation: "delete_range", start_anchor: anchorAt(5), end_anchor: anchorAt(5) },
			],
		} as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(result.details.disposition, "succeeded");
	assert.deepEqual(result.details.changePreview, {
		truncated: false,
		lines: [
			{ kind: "remove", oldLine: 2, text: "two" },
			{ kind: "add", newLine: 2, text: "TWO" },
			{ kind: "add", newLine: 3, text: "TWO2" },
			{ kind: "add", newLine: 6, text: "N" },
			{ kind: "remove", oldLine: 5, text: "five" },
		],
	});
	assert.equal("diff" in result.details, false);
	assert.equal("patch" in result.details, false);
	assert.equal("previewError" in result.details, false);
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nTWO2\nthree\nfour\nN\nsix\n");
});

test("no-op apply and replace-once carry commit-bound previews", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	const replaceOnceTool = registeredTools.get(HLEDIT_REPLACE_ONCE_TOOL);
	assert.ok(readTool && applyTool && replaceOnceTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-preview-noop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const anchor = read.details.read?.lines.find((entry) => entry.line === 2)?.anchor;
	assert.ok(anchor);

	const noop = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: ["two"] }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(noop.details.disposition, "succeeded");
	assert.equal(noop.details.contentChanged, false);
	assert.deepEqual(noop.details.changePreview, { lines: [], truncated: false });

	const replaced = await replaceOnceTool.execute(
		"replace-once",
		{ path: "target.txt", old_lines: ["two"], new_lines: ["TWO"] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(replaced.details.disposition, "succeeded");
	assert.deepEqual(replaced.details.changePreview, {
		truncated: false,
		lines: [
			{ kind: "remove", oldLine: 2, text: "two" },
			{ kind: "add", newLine: 2, text: "TWO" },
		],
	});
	assert.equal("diff" in replaced.details, false);
	assert.equal("patch" in replaced.details, false);
});
