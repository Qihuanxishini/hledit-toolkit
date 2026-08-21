import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL } from "../src/active-tools.ts";
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

test("extension keeps proof misses recoverable and escalates other hledit failures", () => {
	const { registeredTools, toolResultListener } = registerExtensionForTest();

	assert.deepEqual([...registeredTools.keys()], [HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]);
	const context = { cwd: process.cwd() };
	assert.equal(toolResultListener({
		toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		details: { disposition: "rejected", error: { code: "insufficient_read_proof" } },
	}, context), undefined);
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "rejected" } }, context), { isError: true });
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_READ_ANCHORS_TOOL, details: { disposition: "unavailable" } }, context), { isError: true });
	assert.equal(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "succeeded" } }, context), undefined);
	assert.equal(toolResultListener({ toolName: "bash", details: { disposition: "rejected" } }, context), undefined);
});

test("registered tool metadata stays concise and names each flattened guideline", () => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const searchTool = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool?.description && readTool.promptGuidelines);
	assert.ok(searchTool?.description && searchTool.promptGuidelines);
	assert.ok(applyTool?.description && applyTool.promptGuidelines);

	assert.equal(readTool.label, "Read for Edit");
	assert.equal(readTool.promptGuidelines.length, 2);
	assert.equal(searchTool.promptGuidelines.length, 1);
	assert.equal(applyTool.promptGuidelines.length, 2);
	for (const [tool, toolName] of [
		[readTool, HLEDIT_READ_ANCHORS_TOOL],
		[searchTool, HLEDIT_SEARCH_ANCHORS_TOOL],
		[applyTool, HLEDIT_APPLY_FILE_CHANGES_TOOL],
	] as const) {
		assert.ok(tool.description);
		assert.ok(tool.promptGuidelines);
		assert.equal(tool.promptSnippet, undefined);
		assert.doesNotMatch(tool.description, /[\u4E00-\u9FFF]/u);
		assert.ok(tool.promptGuidelines.every((guideline) => !/[\u4E00-\u9FFF]/u.test(guideline)));
		assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(toolName)), `${toolName} guideline must name its tool`);
	}

	const readGuidelines = readTool.promptGuidelines.join(" ");
	const searchGuidelines = searchTool.promptGuidelines.join(" ");
	const applyGuidelines = applyTool.promptGuidelines.join(" ");
	assert.match(readTool.description, /contiguous text lines[\s\S]*LN#HASH anchors/);
	assert.match(readGuidelines, /successful hledit_search_anchors output[\s\S]*verified updated anchors/);
	assert.match(readGuidelines, /cover every source line[\s\S]*sparse endpoints are not proof/);
	assert.match(readGuidelines, /Copy only LN#HASH tokens[\s\S]*hidden proof carries interior lines/);
	assert.match(searchTool.description, /literal text[\s\S]*RE2 matches/);
	assert.match(searchGuidelines, /locate matching lines[\s\S]*not to inspect broad contiguous text[\s\S]*hledit_read_anchors/);
	assert.match(searchGuidelines, /Zero-match or truncated results do not prove unseen lines/);
	assert.match(applyTool.description, /boundary anchors[\s\S]*complete read proof/);
	assert.match(applyGuidelines, /proof_id from the latest successful hledit_read_anchors or hledit_search_anchors result for that path/);
	assert.match(applyGuidelines, /zero-match search invalidates proof[\s\S]*failed read creates none/);
	assert.match(applyGuidelines, /raw text without LN#HASH prefixes[\s\S]*\\n separates lines[\s\S]*one blank line/);
	assert.match(applyGuidelines, /Never overwrite a nonempty readable file with write/);
	const applySchema = JSON.stringify(applyTool.parameters);
	assert.match(applySchema, /latest successful read\/search result for this path/);
	assert.match(applySchema, /New text; \\\\n separates lines\./i);

	assert.match(searchTool.description, /one text file[\s\S]*not a directory/i);
	assert.match(searchGuidelines, /one file[\s\S]*never a directory[\s\S]*enumerate files first[\s\S]*project-wide search/);
	assert.match(JSON.stringify(searchTool.parameters), /One text file path[\s\S]*not a directory/);
	const protocolCharacters = [readTool, searchTool, applyTool].reduce(
		(total, tool) => total
			+ JSON.stringify(tool.parameters).length
			+ (tool.description?.length ?? 0)
			+ (tool.promptGuidelines ?? []).join("").length,
		0,
	);
	assert.ok(protocolCharacters <= 4600, `registered hledit protocol uses ${protocolCharacters} characters; expected at most 4600`);
});



test("read and search tools return structured ranges and actionable EOF errors", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const searchTool = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL);
	assert.ok(readTool && searchTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "target.txt"), "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	assert.equal(readResult.details.disposition, "succeeded");
	assert.deepEqual(readResult.details.read?.actual, { firstLine: 2, lastLine: 2, lineCount: 1, totalLines: 3 });
	assert.equal(readResult.details.read?.nextOffset, 3);
	assert.match(readResult.content[0]?.text ?? "", /Showing lines 2-2 of 3; continue with offset 3/);

	const searchResult = await searchTool.execute(
		"search",
		{ path: "target.txt", pattern: "two", context: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(searchResult.details.disposition, "succeeded");
	assert.deepEqual(searchResult.details.read?.lines.map((line) => line.text), ["one", "two", "three"]);

	const caseMissResult = await searchTool.execute("search", { path: "target.txt", pattern: "TWO" } as never, undefined, undefined, context);
	assert.equal(caseMissResult.details.disposition, "succeeded");
	assert.equal(caseMissResult.details.read?.actual.lineCount, 0);

	const ignoreCaseResult = await searchTool.execute(
		"search",
		{ path: "target.txt", pattern: "TWO", ignore_case: true } as never,
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

test("search tool accepts a near-limit result at EOF", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const searchTool = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL);
	assert.ok(searchTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-near-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const line = "x".repeat(49 * 1024);
	await writeFile(join(directory, "target.txt"), `${line}\nnot-a-match\n`, "utf8");

	const result = await searchTool.execute(
		"search",
		{ path: "target.txt", pattern: "x", offset: 1, limit: 2000 } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);
	assert.equal(result.details.disposition, "succeeded");
	assert.deepEqual(result.details.read?.actual, { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 2 });
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
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);
	assert.ok(readResult.details.proofId);
	assert.match(readResult.content[0]?.text ?? "", new RegExp(`proof_id: ${readResult.details.proofId}`));
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "TWO" }] } as never,
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
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "two" }] } as never,
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
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "CHANGED" }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	// 字节截断只砍掉上下文行；产出行完整可得时模型正文不得报不完整，
	// 同时 details 仍保留 CLI 的完整截断窗口供 evidence 与 TUI 使用。
	const updatedLine = applyResult.details.updatedAnchors?.lines.find((line) => line.line === 5);
	assert.ok(updatedLine);
	assert.equal(applyResult.content[0]?.text ?? "", `Applied 1 change; line delta: +1 -1.\n\nUpdated anchors:\n${updatedLine.anchor}:CHANGED`);
	assert.equal(applyResult.details.updatedAnchors?.truncated, true);
	assert.ok((applyResult.details.updatedAnchors?.lines.length ?? 0) > 1);
	assert.equal((await readFile(target, "utf8")).split(/\r?\n/)[4], "CHANGED");
});

test("apply tool lists only produced lines for a wide multi-change batch", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-wide-batch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, `${Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n")}\n`, "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 200 } as never, undefined, undefined, context);
	const anchorAt = (line: number) => readResult.details.read?.lines.find((entry) => entry.line === line)?.anchor;
	const first = anchorAt(10);
	const last = anchorAt(180);
	assert.ok(first && last);

	const applyResult = await applyTool.execute(
		"apply",
		{
			path: "target.txt",
			proof_id: readResult.details.proofId,
			changes: [
				{ operation: "replace_range", start_anchor: first, end_anchor: first, lines: "FIRST" },
				{ operation: "replace_range", start_anchor: last, end_anchor: last, lines: "LAST" },
			],
		} as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	const resultText = applyResult.content[0]?.text ?? "";
	// CLI 窗口从 firstChanged 起取一整段，跨度大时只能覆盖首个变更：
	// 模型正文只得到该变更的产出行，不得混入任何未变更的上下文行。
	assert.match(resultText, /^Applied 2 changes; line delta: \+2 -2\.\n\nUpdated anchors:\n10#[A-Za-z0-9_-]{3}:FIRST\n/);
	assert.match(resultText, /Updated anchors are incomplete/);
	assert.doesNotMatch(resultText, /:line \d+/);
	assert.ok(resultText.length < 250);

	// details 仍保留 CLI 完整窗口（含上下文行）供 evidence 与 TUI 使用。
	assert.ok((applyResult.details.updatedAnchors?.lines.length ?? 0) > 1);
	const written = (await readFile(target, "utf8")).split(/\r?\n/);
	assert.equal(written[9], "FIRST");
	assert.equal(written[179], "LAST");
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
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "delete_range", start_anchor: anchor, end_anchor: anchor }] } as never,
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
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "two\ninserted" }] } as never,
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

test("apply tool rejects an anchor token pasted into lines instead of writing it to disk", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	const anchor = readResult.details.read?.lines[0]?.anchor;
	assert.ok(anchor);

	// 模型把 read 输出的 "LN#HASH:text" 展示格式整行抄进了替换内容。
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: `${anchor}:const b = 20;` }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.deepEqual(applyResult.details.error, {
		code: "anchor_token_in_lines",
		message: `Change 1 pasted the anchor token ${anchor} into lines; strip the prefix instead of rereading.`,
		changeNumber: 1,
	});
	const text = applyResult.content[0]?.text ?? "";
	assert.match(text, /The atomic batch was rejected; no content was written/);
	assert.match(text, new RegExp(`Line 1 of lines begins with ${anchor}:`));
	assert.match(text, /Rereading the file cannot resolve this/);
	assert.equal(await readFile(target, "utf8"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
});

test("apply tool rejects a reversed anchor range with a swap instruction instead of a reread loop", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const first = readResult.details.read?.lines[0]?.anchor;
	const third = readResult.details.read?.lines[2]?.anchor;
	assert.ok(first && third);

	const reversed = { path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: third, end_anchor: first, lines: "merged" }] };
	const applyResult = await applyTool.execute("apply", reversed as never, undefined, undefined, context);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.deepEqual(applyResult.details.error, {
		code: "reversed_anchor_range",
		message: `Change 1 submitted start_anchor ${third} below end_anchor ${first}; swap them instead of rereading.`,
		changeNumber: 1,
	});
	const text = applyResult.content[0]?.text ?? "";
	assert.match(text, new RegExp(`Swap them: set start_anchor to ${first} and end_anchor to ${third}`));
	// 旧行为会返回 insufficient_read_proof 并要求重读，而重读后重发会复现同一错误。
	assert.doesNotMatch(text, /Call hledit_read_anchors/);
	assert.doesNotMatch(text, /resubmit the original hledit_apply_file_changes call/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");

	// 交换后无需重读即可成功，证明拒绝未损失已有证据。
	const fixed = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: first, end_anchor: third, lines: "merged" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(fixed.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "merged\n");
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
		{ path: "target.txt", proof_id: readResult.details.proofId, changes: [{ operation: "replace_range", start_anchor: staleAnchor, end_anchor: staleAnchor, lines: "two\ninserted" }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.equal(applyResult.details.error?.code, "insufficient_read_proof");
	assert.equal(applyResult.details.recoveredRead?.lines.find((line) => line.line === 2)?.anchor, currentAnchor);
	assert.equal((applyResult.details.error as Record<string, unknown> | undefined)?.recoveredRead, undefined);
	assert.match(applyResult.content[0]?.text ?? "", /submitted anchor for line 2 does not match/);
	assert.match(applyResult.content[0]?.text ?? "", /targeted missing range was read and recorded/);
	assert.match(applyResult.content[0]?.text ?? "", new RegExp(`${currentAnchor}:two`));
	assert.doesNotMatch(applyResult.content[0]?.text ?? "", /single_line_range_expansion|Current anchor snapshot/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("proof recovery stops on source-line truncation", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-source-truncated-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = `${"x".repeat(60_000)}\n`;
	await writeFile(target, original, "utf8");
	const context = { cwd: directory };
	const read = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const anchor = read.details.read?.lines[0]?.anchor;
	assert.ok(anchor);

	const apply = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "short" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(apply.details.disposition, "rejected");
	assert.equal(apply.details.error?.code, "source_line_truncated");
	assert.equal(apply.details.recoveredRead, undefined);
	assert.match(apply.content[0]?.text ?? "", /Do not resubmit this hledit_apply_file_changes call/);
	assert.doesNotMatch(apply.content[0]?.text ?? "", /Review the current source.*resubmit the batch/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("apply without proof_id rejects before trying to recover a missing target", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-recovery-error-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await applyTool.execute(
		"apply",
		{ path: "missing.txt", changes: [{ operation: "replace_range", start_anchor: "1#AAA", end_anchor: "1#AAA", lines: "short" }] } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);
	assert.equal(result.details.disposition, "rejected");
	assert.equal(result.details.error?.code, "invalid_proof_id");
	assert.match(result.content[0]?.text ?? "", /missing proof_id/);
});

test("multi-page proof recovery completes internally before apply is retried", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-proof-pages-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, `${Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`).join("\n")}\n`, "utf8");
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 3_000, limit: 1 } as never, undefined, undefined, context);
	const startAnchor = first.details.read?.lines[0]?.anchor;
	const endAnchor = last.details.read?.lines[0]?.anchor;
	assert.ok(startAnchor && endAnchor);

	const apply = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: last.details.proofId, changes: [{ operation: "replace_range", start_anchor: startAnchor, end_anchor: endAnchor, lines: "replacement" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(apply.details.disposition, "rejected");
	assert.equal(apply.details.error?.code, "insufficient_read_proof");
	assert.ok((apply.details.recoveredReads?.length ?? 0) > 1);
	assert.equal(apply.details.recoveredRead?.nextOffset, 3_000);
	assert.match(apply.content[0]?.text ?? "", /read and recorded in \d+ page\(s\)/);
	assert.match(apply.content[0]?.text ?? "", /Review the current source.*resubmit the batch/);
	assert.doesNotMatch(apply.content[0]?.text ?? "", /Do not resubmit apply before then/);
});

test("multi-page proof continuation completes without rereading the payload", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-proof-pages-complete-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, `${Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`).join("\n")}\n`, "utf8");
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 3_000, limit: 1 } as never, undefined, undefined, context);
	const startAnchor = first.details.read?.lines[0]?.anchor;
	const endAnchor = last.details.read?.lines[0]?.anchor;
	assert.ok(startAnchor && endAnchor);
	const params = { path: "target.txt", proof_id: last.details.proofId, changes: [{ operation: "replace_range", start_anchor: startAnchor, end_anchor: endAnchor, lines: "replacement" }] };
	const initial = await applyTool.execute("apply-1", params as never, undefined, undefined, context);
	assert.equal(initial.details.disposition, "rejected");
	assert.ok((initial.details.recoveredReads?.length ?? 0) > 1);
	const proofId = initial.details.proofId;
	assert.ok(proofId);
	const final = await applyTool.execute("apply-2", { ...params, proof_id: proofId } as never, undefined, undefined, context);
	assert.equal(final.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "replacement\n");
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
			proof_id: readResult.details.proofId,
			changes: [
				{ operation: "replace_range", start_anchor: replacementAnchor, end_anchor: replacementAnchor, lines: "two\nreplacement" },
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
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "B" }] } as never,
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
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "insert_after", anchor: anchorAt(1), lines: "inserted" }] } as never,
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
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: staleAnchor, end_anchor: staleAnchor, lines: "THREE" }] } as never,
		undefined,
		undefined,
		context,
	);
	const [insertResult, replaceResult] = await Promise.all([insertPromise, replacePromise]);

	assert.equal(insertResult.details.disposition, "succeeded");
	assert.equal(replaceResult.details.disposition, "succeeded");
	const resolvedAnchors = replaceResult.details.resolvedAnchors as Array<{ requested: string; current: string }>;
	assert.deepEqual(resolvedAnchors.map((rename) => rename.requested), [staleAnchor]);
	assert.match(resolvedAnchors[0]?.current ?? "", /^4#/);
	assert.equal(await readFile(target, "utf8"), "one\ninserted\ntwo\nTHREE\nfour\n");
});


test("path aliases share the canonical apply queue", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-alias-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const alias = join(directory, "alias.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	try {
		await symlink(target, alias, "file");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
			t.skip(`symlink unavailable: ${code}`);
			return;
		}
		throw error;
	}
	const context = { cwd: directory };
	const read = await readTool.execute("read-alias", { path: "alias.txt" } as never, undefined, undefined, context);
	assert.equal(read.details.disposition, "succeeded");
	const anchorAt = (line: number) => {
		const anchor = read.details.read?.lines.find((entry) => entry.line === line)?.anchor;
		assert.ok(anchor);
		return anchor;
	};

	const insertPromise = applyTool.execute(
		"apply-target",
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "insert_after", anchor: anchorAt(1), lines: "inserted" }] } as never,
		undefined,
		undefined,
		context,
	);
	await new Promise((resolveTick) => setImmediate(resolveTick));
	const staleAnchor = anchorAt(3);
	const replacePromise = applyTool.execute(
		"apply-alias",
		{ path: "alias.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: staleAnchor, end_anchor: staleAnchor, lines: "THREE" }] } as never,
		undefined,
		undefined,
		context,
	);
	const [insertResult, replaceResult] = await Promise.all([insertPromise, replacePromise]);

	assert.equal(insertResult.details.disposition, "succeeded");
	assert.equal(replaceResult.details.disposition, "succeeded");
	assert.deepEqual(replaceResult.details.resolvedAnchors?.map((rename) => rename.requested), [staleAnchor]);
	assert.equal(await readFile(target, "utf8"), "one\ninserted\ntwo\nTHREE\n");
});

test("reused pre-edit anchor tokens are rejected without modifying the newly inserted line", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-reused-token-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "before\nneedle\nafter\n", "utf8");
	const context = { cwd: directory };

	const initialRead = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const oldAnchor = initialRead.details.read?.lines.find((line) => line.line === 2)?.anchor;
	assert.ok(oldAnchor);
	const inserted = await applyTool.execute(
		"insert-identical",
		{ path: "target.txt", proof_id: initialRead.details.proofId, changes: [{ operation: "insert_before", anchor: oldAnchor, lines: "needle" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(inserted.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "before\nneedle\nneedle\nafter\n");

	const ambiguous = await applyTool.execute(
		"reuse-old-anchor",
		{ path: "target.txt", proof_id: initialRead.details.proofId, changes: [{ operation: "replace_range", start_anchor: oldAnchor, end_anchor: oldAnchor, lines: "CHANGED" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(ambiguous.details.disposition, "rejected");
	assert.equal(ambiguous.details.error?.code, "insufficient_read_proof");
	assert.match(ambiguous.details.error?.message ?? "", /lost its unique identity after a verified edit/);
	assert.match(ambiguous.content[0]?.text ?? "", /plugin will not guess/);
	assert.equal(await readFile(target, "utf8"), "before\nneedle\nneedle\nafter\n");

	const explicitRead = await readTool.execute("read-current", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	assert.equal(explicitRead.details.read?.lines[0]?.anchor, oldAnchor);
	const currentEdit = await applyTool.execute(
		"edit-current-line",
		{ path: "target.txt", proof_id: explicitRead.details.proofId, changes: [{ operation: "replace_range", start_anchor: oldAnchor, end_anchor: oldAnchor, lines: "CHANGED" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(currentEdit.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "before\nCHANGED\nneedle\nafter\n");
});


test("consumed anchor tokens reused by a shifted duplicate require an explicit reread", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-consumed-token-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "before\nneedle\nneedle\nafter\n", "utf8");
	const context = { cwd: directory };

	const initialRead = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const consumedAnchor = initialRead.details.read?.lines.find((line) => line.line === 2)?.anchor;
	assert.ok(consumedAnchor);
	const deleted = await applyTool.execute(
		"delete-first-duplicate",
		{ path: "target.txt", proof_id: initialRead.details.proofId, changes: [{ operation: "delete_range", start_anchor: consumedAnchor, end_anchor: consumedAnchor }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(deleted.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "before\nneedle\nafter\n");

	const ambiguous = await applyTool.execute(
		"reuse-consumed-anchor",
		{ path: "target.txt", proof_id: initialRead.details.proofId, changes: [{ operation: "replace_range", start_anchor: consumedAnchor, end_anchor: consumedAnchor, lines: "CHANGED" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(ambiguous.details.disposition, "rejected");
	assert.equal(ambiguous.details.error?.code, "insufficient_read_proof");
	assert.match(ambiguous.details.error?.message ?? "", /lost its unique identity after a verified edit/);
	assert.equal(await readFile(target, "utf8"), "before\nneedle\nafter\n");

	const explicitRead = await readTool.execute("read-current", { path: "target.txt", offset: 2, limit: 1 } as never, undefined, undefined, context);
	assert.equal(explicitRead.details.read?.lines[0]?.anchor, consumedAnchor);
	const currentEdit = await applyTool.execute(
		"edit-current-duplicate",
		{ path: "target.txt", proof_id: explicitRead.details.proofId, changes: [{ operation: "replace_range", start_anchor: consumedAnchor, end_anchor: consumedAnchor, lines: "CHANGED" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(currentEdit.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), "before\nCHANGED\nafter\n");
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
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, { disposition: "unavailable", path: "src/unavailable.ts" }),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, {
						disposition: "rejected",
						path: "src/recovered-read.ts",
						error: { code: "insufficient_read_proof", message: "read recovered" },
						recoveredRead: {
							path: "src/recovered-read.ts",
							revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							requested: { offset: 1, limit: 1 },
							actual: { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 2 },
							lines: [{ line: 1, anchor: "1#AAA", text: "read", textTruncated: false }],
							truncated: true,
							nextOffset: 2,
							textTruncated: false,
							eof: false,
						},
					}),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, {
						disposition: "rejected",
						path: "src/malformed-recovery.ts",
						error: { code: "insufficient_read_proof", message: "malformed" },
						recoveredRead: {},
					}),
					{ role: "assistant", content: [] },
				],
				turnPrefixMessages: [
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, { disposition: "outcome_unknown", path: "src/maybe-modified.ts" }),
				],
				fileOps,
			},
		} as never,
		{ cwd: process.cwd() } as never,
	);

	assert.deepEqual([...fileOps.read].sort(), ["src/noop.ts", "src/read-only.ts", "src/recovered-read.ts"]);
	assert.equal(fileOps.read.has("src/malformed-recovery.ts"), false);
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
			proof_id: read.details.proofId,
			changes: [
				{ operation: "replace_range", start_anchor: anchorAt(2), end_anchor: anchorAt(2), lines: "TWO\nTWO2" },
				{ operation: "insert_after", anchor: anchorAt(4), lines: "N" },
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
			{ kind: "remove", oldLine: 2, text: "two", changeIndex: 0 },
			{ kind: "add", newLine: 2, text: "TWO", changeIndex: 0 },
			{ kind: "add", newLine: 3, text: "TWO2", changeIndex: 0 },
			{ kind: "add", newLine: 6, text: "N", changeIndex: 1 },
			{ kind: "remove", oldLine: 5, text: "five", changeIndex: 2 },
		],
	});
	assert.equal("diff" in result.details, false);
	assert.equal("patch" in result.details, false);
	assert.equal("previewError" in result.details, false);
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nTWO2\nthree\nfour\nN\nsix\n");
});

test("no-op apply carries an empty commit-bound preview", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

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
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "two" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(noop.details.disposition, "succeeded");
	assert.equal(noop.details.contentChanged, false);
	assert.deepEqual(noop.details.changePreview, { lines: [], truncated: false });
});
