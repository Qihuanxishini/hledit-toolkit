import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolAnnotations, ToolExposure } from "@earendil-works/pi-coding-agent";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL } from "../src/active-tools.ts";
import { formatReadMetadata } from "../src/read-result.ts";
import type { TextResult } from "../src/result.ts";
import { MAX_RECOVERY_TEXT_BYTES } from "../src/read-recovery.ts";

type ExtensionEventListener = (event: never, context: never) => unknown;
type RegisteredTool = {
	name: string;
	exposure?: ToolExposure;
	annotations?: ToolAnnotations;
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
	eventListeners: Map<string, ExtensionEventListener>;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const eventListeners = new Map<string, ExtensionEventListener>();
	let activeTools = ["read", "edit", "bash"];
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand() {},
		on(eventName: string, listener: ExtensionEventListener) {
			eventListeners.set(eventName, listener);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(next: string[]) {
			activeTools = [...next];
		},
	};

	piHleditDiffExtension(pi as never);
	return { registeredTools, eventListeners };
}

test("anchored tools declare model-only exposure and local read/write hints", () => {
	const { registeredTools, eventListeners } = registerExtensionForTest();
	assert.deepEqual([...registeredTools.keys()], [HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]);
	for (const tool of registeredTools.values()) {
		assert.equal(tool.exposure, "model-only");
		assert.deepEqual(tool.annotations, tool.name === HLEDIT_APPLY_FILE_CHANGES_TOOL
			? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
			: { readOnlyHint: true, openWorldHint: false });
	}
	assert.equal(eventListeners.has("tool_result"), false);
});

test("apply returns native errors for invalid input and missing proof", async () => {
	const { registeredTools } = registerExtensionForTest();
	const apply = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	for (const params of [
		{ path: "target.txt", changes: [] },
		{ path: "target.txt", changes: [{ operation: "delete_range", start_anchor: "1#abc", end_anchor: "1#abc" }] },
	]) {
		const result = await apply.execute("invalid", params as never, undefined, undefined, { cwd: process.cwd() });
		assert.equal(result.isError, true);
		assert.equal(result.details.disposition, "rejected");
	}
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
	assert.match(searchTool.description, /literal text[\s\S]*RE2 matches/);
	assert.match(searchGuidelines, /locate matching lines[\s\S]*not to inspect broad contiguous text[\s\S]*hledit_read_anchors/);
	assert.match(searchGuidelines, /Only returned complete, non-truncated lines provide proof[\s\S]*read any range gaps/);
	assert.match(applyTool.description, /non-overlapping inclusive ranges[\s\S]*complete read proof/);
	assert.match(applyGuidelines, /latest proof_id returned for that path[\s\S]*current LN#HASH tokens[\s\S]*any proof_id issued for the file's current revision is accepted/);
	assert.match(applyGuidelines, /failed read creates no proof/);
	assert.match(applyGuidelines, /raw text without LN#HASH prefixes[\s\S]*\\n separates lines[\s\S]*one blank line/);
	assert.match(applyGuidelines, /For targeted edits[\s\S]*write only for a new\/empty file[\s\S]*complete-file rewrite/);
	const applySchema = JSON.stringify(applyTool.parameters);
	assert.match(applySchema, /Current proof_id returned for this path[\s\S]*latest read\/search/);
	assert.ok(applySchema.includes(JSON.stringify("Raw text; \\n separates lines; no LN#HASH prefixes.")));

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
	assert.ok(protocolCharacters <= 4400, `registered hledit protocol uses ${protocolCharacters} characters; expected at most 4400`);
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
	assert.equal(readResult.isError, false);
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
	assert.equal(searchResult.isError, false);
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
	assert.equal(rangeError.isError, true);
	assert.equal(rangeError.details.error?.message, "Starting line 4 is outside the file range (3 total lines).");
	assert.equal(rangeError.content[0]?.text.split("\n", 1)[0], "Starting line 4 is outside the file range (3 total lines).");
});

test("read and search continue after an oversized source line", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-long-line-page-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "target.txt"), `${"x".repeat(70_000)}\nother\nlater\n`);
	for (const name of [HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL]) {
		const tool = registeredTools.get(name)!;
		const params = { path: "target.txt", offset: 1, limit: 10, ...(name === HLEDIT_SEARCH_ANCHORS_TOOL ? { pattern: "x|later" } : {}) };
		const first = await tool.execute("first", params as never, undefined, undefined, { cwd: directory });
		assert.equal(first.details.disposition, "succeeded");
		assert.equal(first.details.read?.textTruncated, true);
		assert.equal(first.details.read?.nextOffset, 2);
		assert.match(first.content[0]!.text, /continue with offset 2/);
		const next = await tool.execute("next", { ...params, offset: first.details.read!.nextOffset } as never, undefined, undefined, { cwd: directory });
		assert.equal(next.details.disposition, "succeeded");
		assert.equal(next.details.read?.textTruncated, false);
		assert.equal(next.details.read?.lines.at(-1)?.text, "later");
		assert.equal(next.details.read?.nextOffset, undefined);
	}
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

test("search tool explains RE2 rejections instead of echoing a bare error code", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const searchTool = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL);
	assert.ok(searchTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-search-pattern-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "target.txt"), "alpha\nbravo\n", "utf8");

	// RE2 没有 lookahead，这是模型最高频的正则错误；正文必须给出可操作的替代路径。
	const invalid = await searchTool.execute(
		"search",
		{ path: "target.txt", pattern: "alpha(?=x)" } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);
	assert.equal(invalid.details.disposition, "rejected");
	assert.equal(invalid.details.error?.code, "pattern");
	assert.equal(invalid.isError, true);
	assert.match(invalid.details.error?.message ?? "", /not a valid RE2 regular expression/);
	assert.match(invalid.details.error?.hint ?? "", /lookahead, lookbehind, or backreferences/);
	assert.match(invalid.details.error?.hint ?? "", /literal:true/);
	const invalidText = invalid.content[0]?.text ?? "";
	assert.match(invalidText, /Suggestion: /);
	assert.doesNotMatch(invalidText, /^hledit rejected this read \(error code: pattern\)\.$/m);

	const broad = await searchTool.execute(
		"search",
		{ path: "target.txt", pattern: ".*" } as never,
		undefined,
		undefined,
		{ cwd: directory },
	);
	assert.equal(broad.details.disposition, "rejected");
	assert.equal(broad.details.error?.code, "broad_pattern");
	assert.match(broad.details.error?.message ?? "", /unconstrained wildcard/);
	assert.match(broad.details.error?.hint ?? "", /hledit_read_anchors/);
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
	assert.equal(applyResult.isError, false);
	const resultText = applyResult.content[0]?.text ?? "";
	assert.match(resultText, /^Applied 1 change; line delta: \+1 -1\.\n\nUpdated anchors:\n/);
	assert.match(resultText, /TWO/);
	assert.equal(applyResult.details.proofId, readResult.details.proofId);
	assert.equal(resultText.split("\n").at(-1), `proof_id: ${readResult.details.proofId}`);
	assert.equal(resultText.match(/^Updated anchors:$/gm)?.length, 1);
	assert.ok(resultText.length < 250);
	assert.doesNotMatch(resultText, /Later changes inside this span/);
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
	assert.equal(applyResult.details.proofId, readResult.details.proofId);
	assert.equal(applyResult.content[0]?.text.split("\n").at(-1), `proof_id: ${readResult.details.proofId}`);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("apply tool returns a complete produced span for a long-line file", async (t) => {
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
	// span 只覆盖产出行，不再携带上下文：长行文件的单行替换也能完整返回。
	const spans = applyResult.details.updatedAnchorSpans;
	assert.equal(spans?.length, 1);
	const updatedLine = spans?.[0]?.lines.find((line) => line.line === 5);
	assert.ok(updatedLine);
	assert.equal(applyResult.content[0]?.text ?? "", `Applied 1 change; line delta: +1 -1.\n\nUpdated anchors:\n${updatedLine.anchor}:CHANGED\n\nproof_id: ${readResult.details.proofId}`);
	assert.equal(spans?.[0]?.truncated, false);
	assert.equal(spans?.[0]?.lines.length, 1);
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
	// 每个变更各得一个产出 span：相距很远的两处修改都返回新锚点，且不混入未变更的上下文行。
	assert.match(resultText, /^Applied 2 changes; line delta: \+2 -2\.\n\nUpdated anchors:\n10#[A-Za-z0-9_-]{3}:FIRST\n180#[A-Za-z0-9_-]{3}:LAST\n/);
	assert.doesNotMatch(resultText, /Updated anchors are incomplete/);
	assert.doesNotMatch(resultText, /:line \d+/);
	assert.ok(resultText.length < 250);

	assert.equal(applyResult.details.updatedAnchorSpans?.length, 2);
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
	// 纯删除没有产出 span：模型正文不含 anchor 块，details 记录空 span列表。
	assert.doesNotMatch(applyResult.content[0]?.text ?? "", /Updated anchors/);
	assert.deepEqual(applyResult.details.updatedAnchorSpans, []);
	assert.equal(applyResult.details.proofId, undefined);
	assert.doesNotMatch(applyResult.content[0]?.text ?? "", /^proof_id:/m);
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
	assert.equal(applyResult.isError, true);
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

test("apply tool rejects read output pasted into an insert even when the tokens were not submitted as anchors", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	await writeFile(target, original, "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const [first, second, third] = readResult.details.read!.lines;
	const applyResult = await applyTool.execute(
		"apply",
		{
			path: "target.txt", proof_id: readResult.details.proofId,
			changes: [{ operation: "insert_after", anchor: first!.anchor, lines: `${second!.anchor}:${second!.text}\n${third!.anchor}:${third!.text}` }],
		} as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.equal(applyResult.details.error?.code, "anchor_token_in_lines");
	assert.match(applyResult.content[0]?.text ?? "", new RegExp(`Line 1 of lines begins with ${second!.anchor}:`));
	assert.equal(await readFile(target, "utf8"), original);
});

test("zero-match search keeps same-revision proof and echoes the current proof_id", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const searchTool = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && searchTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const readResult = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const proofId = readResult.details.proofId;
	assert.ok(proofId);
	const searchResult = await searchTool.execute("search", { path: "target.txt", pattern: "missing", literal: true } as never, undefined, undefined, context);
	assert.equal(searchResult.details.disposition, "succeeded");
	assert.equal(searchResult.details.proofId, proofId);
	assert.equal(searchResult.content[0]?.text.split("\n")[0], `proof_id: ${proofId}`);

	const anchor = readResult.details.read!.lines[1]!.anchor;
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "TWO" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(applyResult.details.disposition, "succeeded", JSON.stringify(applyResult.details.error));
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nthree\n");

	// 文件已变：零命中搜索带来新 revision，旧证据随之失效。
	await writeFile(target, "one\nTWO\nthree\nfour\n", "utf8");
	const staleSearch = await searchTool.execute("search", { path: "target.txt", pattern: "missing", literal: true } as never, undefined, undefined, context);
	assert.equal(staleSearch.details.proofId, undefined);
	assert.doesNotMatch(staleSearch.content[0]?.text ?? "", /^proof_id:/m);
});

test("apply tool accepts any proof_id issued for the current revision and names the current one otherwise", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");
	const context = { cwd: directory };

	const page1 = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 2 } as never, undefined, undefined, context);
	const page2 = await readTool.execute("read", { path: "target.txt", offset: 3, limit: 1 } as never, undefined, undefined, context);
	assert.notEqual(page1.details.proofId, page2.details.proofId);
	const anchor = page2.details.read!.lines[0]!.anchor;
	const applyWithFirstPage = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: page1.details.proofId, changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "THREE" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(applyWithFirstPage.details.disposition, "succeeded", JSON.stringify(applyWithFirstPage.details.error));
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nTHREE\n");

	await writeFile(target, "one\ntwo\nTHREE\nfour\n", "utf8");
	const fresh = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const expired = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: page1.details.proofId, changes: [{ operation: "replace_range", start_anchor: fresh.details.read!.lines[3]!.anchor, end_anchor: fresh.details.read!.lines[3]!.anchor, lines: "FOUR" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(expired.details.error?.code, "invalid_proof_id");
	assert.match(expired.content[0]?.text ?? "", new RegExp(`Use proof_id: ${fresh.details.proofId}`));
	assert.doesNotMatch(expired.content[0]?.text ?? "", /hledit_read_anchors|offset:/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nTHREE\nfour\n");
});


test("revision snapshots support explicit continuation both live and after branch replay", async (t) => {
	for (const replay of [false, true]) {
		await t.test(replay ? "branch replay" : "live evidence", async (t) => {
			let extension = registerExtensionForTest();
			const readTool = extension.registeredTools.get(HLEDIT_READ_ANCHORS_TOOL)!;
			let applyTool = extension.registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
			const directory = await mkdtemp(join(tmpdir(), "pi-hledit-revision-"));
			t.after(() => rm(directory, { recursive: true, force: true }));
			const target = join(directory, "target.txt");
			const lines = Array.from({ length: 11002 }, (_, index) => `line-${index + 1}`);
			await writeFile(target, lines.join("\n") + "\n");
			const context = { cwd: directory };
			const read = await readTool.execute("read", { path: "target.txt", offset: 11000, limit: 1 } as never, undefined, undefined, context);
			const anchor = read.details.read!.lines[0]!.anchor;
			lines[0] = "external change";
			const changed = lines.join("\n") + "\n";
			await writeFile(target, changed);
			const changes = [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: "updated target" }];
			const stale = await applyTool.execute("stale", { path: "target.txt", proof_id: read.details.proofId, changes } as never, undefined, undefined, context);
			assert.equal(stale.details.error?.code, "stale");
			assert.match(stale.content[0]!.text, /file revision changed/);
			assert.doesNotMatch(stale.content[0]!.text, /Change 1 uses a stale anchor|Before retrying, call hledit_read_anchors/);
			assert.ok(stale.details.error!.currentAnchors!.offset >= 10998);
			assert.equal(stale.details.error!.currentAnchors!.truncated, false);
			assert.equal(stale.details.recoveredReads, undefined);
			assert.ok(stale.details.proofId);
			assert.notEqual(stale.details.proofId, read.details.proofId);
			assert.match(stale.content[0]!.text, new RegExp(`proof_id: ${stale.details.proofId}$`));
			assert.equal(await readFile(target, "utf8"), changed);
			if (replay) {
				extension = registerExtensionForTest();
				applyTool = extension.registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
				const branch = JSON.parse(JSON.stringify([{ type: "message", message: { role: "toolResult", toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: stale.details } }]));
				await extension.eventListeners.get("session_start")!({ reason: "startup" } as never, { ...context, hasUI: false, sessionManager: { getBranch: () => branch } } as never);
			}
			const continuation = await applyTool.execute("continue", { path: "target.txt", proof_id: stale.details.proofId, changes } as never, undefined, undefined, context);
			assert.equal(continuation.details.disposition, "succeeded", JSON.stringify(continuation.details.error));
			lines[10999] = "updated target";
			assert.equal(await readFile(target, "utf8"), lines.join("\n") + "\n");
		});
	}
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
	assert.equal(applyResult.isError, false);
	assert.equal(applyResult.details.recoveredReads?.[0]?.lines.find((line) => line.line === 2)?.anchor, currentAnchor);
	assert.equal((applyResult.details.error as Record<string, unknown> | undefined)?.recoveredReads, undefined);
	assert.match(applyResult.content[0]?.text ?? "", /submitted anchor for line 2 does not match/);
	assert.match(applyResult.content[0]?.text ?? "", /batch recovery plan was read and recorded/);
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
	assert.equal(apply.details.recoveredReads, undefined);
	assert.match(apply.content[0]?.text ?? "", /Do not resubmit this hledit_apply_file_changes call/);
	assert.doesNotMatch(apply.content[0]?.text ?? "", /Review the displayed source.*resubmit the batch/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("truncated recovery preserves its source budget and proof across session replay", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL)!;
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-truncated-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = `top\n${"x".repeat(49 * 1024)}\n${"中🙂".repeat(16_000)}\nbottom\n`;
	await writeFile(target, original);
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 4, limit: 1 } as never, undefined, undefined, context);
	const apply = await applyTool.execute("apply", {
		path: "target.txt", proof_id: last.details.proofId,
		changes: [{ operation: "replace_range", start_anchor: first.details.read!.lines[0]!.anchor, end_anchor: last.details.read!.lines[0]!.anchor, lines: "replacement" }],
	} as never, undefined, undefined, context);
	assert.equal(apply.details.error?.code, "source_line_truncated");
	assert.equal(apply.details.recoveredReads?.length, 1);
	assert.deepEqual(apply.details.recoveredReads?.[0]?.lines.map((line) => line.line), [2]);
	const text = apply.content[0]!.text;
	const proofId = /^proof_id: (\S+)$/m.exec(text)?.[1];
	assert.ok(proofId);
	assert.equal(proofId, apply.details.proofId);
	assert.deepEqual(text.split("\n").filter((line) => line.startsWith("proof_id:")), [`proof_id: ${proofId}`]);
	const sourceStart = text.indexOf(formatReadMetadata(apply.details.recoveredReads![0]!, undefined, "recovery"));
	assert.ok(sourceStart >= 0);
	assert.ok(Buffer.byteLength(text.slice(sourceStart), "utf8") <= MAX_RECOVERY_TEXT_BYTES);
	assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
	assert.match(text, /Do not resubmit this hledit_apply_file_changes call/);
	assert.equal(await readFile(target, "utf8"), original);

	// [喵喵喵]: 新实例先初始化空分支，再通过 session_tree 恢复，确保续编只能依赖重放的证据。
	const restored = registerExtensionForTest();
	const restoredApply = restored.registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	const emptyContext = { ...context, hasUI: false, sessionManager: { getBranch: () => [] } };
	await restored.eventListeners.get("session_start")!({ reason: "startup" } as never, emptyContext as never);
	const retained = apply.details.recoveredReads![0]!.lines.find((line) => line.line === 2)!;
	const continuationParams = {
		path: "target.txt", proof_id: proofId,
		changes: [{ operation: "replace_range", start_anchor: retained.anchor, end_anchor: retained.anchor, lines: "short" }],
	};
	const beforeReplay = await restoredApply.execute("before-replay", continuationParams as never, undefined, undefined, emptyContext);
	assert.equal(beforeReplay.details.error?.code, "invalid_proof_id");
	assert.equal(await readFile(target, "utf8"), original);

	const branch = JSON.parse(JSON.stringify([
		{ type: "message", message: { role: "toolResult", toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: apply.details } },
	]));
	const restoredContext = { ...context, hasUI: false, sessionManager: { getBranch: () => branch } };
	await restored.eventListeners.get("session_tree")!({} as never, restoredContext as never);
	const continuation = await restoredApply.execute("continue", continuationParams as never, undefined, undefined, restoredContext);
	assert.equal(continuation.details.disposition, "succeeded");
	assert.equal(continuation.details.proofId, proofId);
	assert.equal(await readFile(target, "utf8"), original.replace("x".repeat(49 * 1024), "short"));
});

test("successive single-line edits preserve proof identity and lone carriage returns", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL)!;
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-proof-continuation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "a\rb\nkeep\n");
	const context = { cwd: directory };
	const read = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	let anchor = read.details.read!.lines[0]!.anchor;
	for (const lines of ["a\rB", "a\rC"]) {
		const result = await applyTool.execute("apply", {
			path: "target.txt", proof_id: read.details.proofId,
			changes: [{ operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines }],
		} as never, undefined, undefined, context);
		assert.equal(result.details.disposition, "succeeded", JSON.stringify(result.details.error));
		assert.equal(await readFile(target, "utf8"), `${lines}\nkeep\n`);
		anchor = result.details.updatedAnchorSpans![0]!.lines.find((line) => line.line === 1)!.anchor;
	}
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
	// 1,100 行落在补读跨度预算内，但 CLI 每页 50 KiB 的截断仍会把它拆成多页。
	await writeFile(target, `${Array.from({ length: 1_100 }, (_, index) => `line-${index + 1}`).join("\n")}\n`, "utf8");
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 1_100, limit: 1 } as never, undefined, undefined, context);
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
	assert.equal(apply.details.recoveredReads?.at(-1)?.nextOffset, 1_100);
	const recoveryText = apply.content[0]?.text ?? "";
	assert.match(recoveryText, /read and recorded in \d+ page\(s\)/);
	assert.match(recoveryText, /Review the displayed source.*resubmit the batch/);
	assert.doesNotMatch(recoveryText, /Do not resubmit apply before then/);
	// 多页补读只有一个权威 proof id；逐页重复输出会让调用方抄到已经作废的那个。
	const proofIdLines = recoveryText.split("\n").filter((line) => line.startsWith("proof_id:"));
	assert.ok(apply.details.proofId);
	assert.deepEqual(proofIdLines, [`proof_id: ${apply.details.proofId}`]);
});

test("an oversized proof gap is refused without reading anything back", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-proof-oversized-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = `${Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
	await writeFile(target, original, "utf8");
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
	assert.equal(apply.details.error?.code, "proof_recovery_budget_exceeded");
	assert.equal(apply.details.recoveredReads, undefined);
	const text = apply.content[0]?.text ?? "";
	assert.match(text, /spans 2998 lines, above the 1200-line automatic recovery budget/);
	assert.match(text, /No recovery read was started/);
	assert.match(text, /Call hledit_read_anchors\(\{ path: "target\.txt", offset: \d+, limit: \d+ \}\)/);
	assert.match(text, /current anchors and the latest proof_id/);
	// 关键：拒绝的正文里不得夹带任何源码行，否则预算就白设了。
	assert.doesNotMatch(text, /^\d+#[A-Za-z0-9_-]{3}:/m);
	assert.equal(await readFile(target, "utf8"), original);
});

test("proof recovery stops at its byte budget and keeps the pages it already read", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(applyTool && readTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-proof-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	// 行数在跨度预算内，但每行 200 字节让 CLI 每页只能装下约 190 行，正文字节先触顶。
	const original = `${Array.from({ length: 1_200 }, (_, index) => `${index + 1}-${"x".repeat(200)}`).join("\n")}\n`;
	await writeFile(target, original, "utf8");
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 1_200, limit: 1 } as never, undefined, undefined, context);
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
	assert.equal(apply.details.error?.code, "proof_recovery_budget_exceeded");
	const pageCount = apply.details.recoveredReads?.length ?? 0;
	assert.ok(pageCount > 0 && pageCount <= 4);
	const renderedRecoveryBytes = (apply.details.recoveredReads ?? [])
		.map((read) => formatReadMetadata(read, undefined, "recovery"))
		.join("\n");
	assert.ok(
		Buffer.byteLength(renderedRecoveryBytes, "utf8") <= MAX_RECOVERY_TEXT_BYTES,
		`recovered source must stay within ${MAX_RECOVERY_TEXT_BYTES}-byte budget`,
	);
	assert.match(apply.content[0]?.text ?? "", /Automatic recovery stopped at its text budget/);
	assert.match(apply.content[0]?.text ?? "", /retained page\(s\) are recorded below; recovery is incomplete/);
	assert.ok(apply.details.proofId);
	assert.equal(/^proof_id: (\S+)$/m.exec(apply.content[0]?.text ?? "")?.[1], apply.details.proofId);
	assert.match(apply.content[0]?.text ?? "", /current anchors and the latest proof_id/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("a failed recovery read surfaces the read error instead of a proof gap", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-recovery-read-failed-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\nfour\nfive\n", "utf8");
	const context = { cwd: directory };
	const read = await readTool.execute("read", { path: "target.txt", offset: 1, limit: 2 } as never, undefined, undefined, context);
	const startAnchor = read.details.read?.lines[0]?.anchor;
	assert.ok(startAnchor);

	// 证据只覆盖 1-2 行；补读 3-5 行时目标已经不在了。
	await rm(target);
	const apply = await applyTool.execute(
		"apply",
		{ path: "target.txt", proof_id: read.details.proofId, changes: [{ operation: "replace_range", start_anchor: startAnchor, end_anchor: "5#AAA", lines: "replacement" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(apply.details.disposition, "rejected");
	assert.equal(apply.details.error?.code, "proof_recovery_read_failed");
	assert.equal(apply.details.recoveryReadError?.disposition, "rejected");
	assert.equal(apply.details.recoveryReadError?.error?.code, "io");
	assert.match(apply.content[0]?.text ?? "", /Resolve the read error below before resubmitting/);
});

test("multi-page proof continuation completes without rereading the payload", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool && applyTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-proof-pages-complete-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, `${Array.from({ length: 1_100 }, (_, index) => `line-${index + 1}`).join("\n")}\n`, "utf8");
	const context = { cwd: directory };
	const first = await readTool.execute("first", { path: "target.txt", offset: 1, limit: 1 } as never, undefined, undefined, context);
	const last = await readTool.execute("last", { path: "target.txt", offset: 1_100, limit: 1 } as never, undefined, undefined, context);
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
						recoveredReads: [{
							path: "src/recovered-read.ts",
							revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							requested: { offset: 1, limit: 1 },
							actual: { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 2 },
							lines: [{ line: 1, anchor: "1#AAA", text: "read", textTruncated: false }],
							truncated: true,
							nextOffset: 2,
							textTruncated: false,
							eof: false,
						}],
					}),
					toolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, {
						disposition: "rejected",
						path: "src/malformed-recovery.ts",
						error: { code: "insufficient_read_proof", message: "malformed" },
						recoveredReads: [{}],
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


test("text boundary edits return anchors usable without an intervening read", async (t) => {
	for (const fixture of [
		{ name: "blank replacement", source: "old", text: "", insert: false, expected: "\n" },
		{ name: "blank append", source: "old", text: "", insert: true, expected: "old\n\n" },
		{ name: "trailing CR", source: "old\nkeep\n", text: "new\r", insert: false, expected: "new\r\r\nkeep\n" },
		{ name: "BOM and literal FEFF", source: "\uFEFFold", text: "\uFEFFnew", insert: false, expected: "\uFEFF\uFEFFnew" },
	]) {
		await t.test(fixture.name, async (t) => {
			const { registeredTools } = registerExtensionForTest();
			const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL)!;
			const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
			const directory = await mkdtemp(join(tmpdir(), "pi-hledit-text-boundary-"));
			t.after(() => rm(directory, { recursive: true, force: true }));
			const target = join(directory, "target.txt");
			await writeFile(target, fixture.source, "utf8");
			const context = { cwd: directory };
			const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
			const anchor = read.details.read!.lines[0]!.anchor;
			const change = fixture.insert
				? { operation: "insert_after", anchor, lines: fixture.text }
				: { operation: "replace_range", start_anchor: anchor, end_anchor: anchor, lines: fixture.text };
			const applied = await applyTool.execute("apply", {
				path: "target.txt", proof_id: read.details.proofId, changes: [change],
			} as never, undefined, undefined, context);
			assert.equal(applied.details.disposition, "succeeded", applied.content[0]?.text);
			assert.equal(await readFile(target, "utf8"), fixture.expected);
			const updated = applied.details.updatedAnchorSpans![0]!.lines[0]!;
			assert.equal(updated.text, fixture.text);
			assert.ok(applied.details.proofId);
			const next = await applyTool.execute("continue", {
				path: "target.txt", proof_id: applied.details.proofId,
				changes: [{ operation: "replace_range", start_anchor: updated.anchor, end_anchor: updated.anchor, lines: "verified" }],
			} as never, undefined, undefined, context);
			assert.equal(next.details.disposition, "succeeded", next.content[0]?.text);
			const reread = await readTool.execute("verify", { path: "target.txt" } as never, undefined, undefined, context);
			assert.equal(reread.details.read!.lines[updated.line - 1]!.text, "verified");
		});
	}
});

test("text boundary rejections preserve the file and provide input-specific guidance", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL)!;
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-text-rejection-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "old\nkeep\n", "utf8");
	const context = { cwd: directory };
	const read = await readTool.execute("read", { path: "target.txt" } as never, undefined, undefined, context);
	const first = read.details.read!.lines[0]!.anchor;
	const second = read.details.read!.lines[1]!.anchor;
	const nul = await applyTool.execute("nul", {
		path: "target.txt", proof_id: read.details.proofId, changes: [
			{ operation: "replace_range", start_anchor: first, end_anchor: first, lines: "changed" },
			{ operation: "replace_range", start_anchor: second, end_anchor: second, lines: "new\u0000text" },
		],
	} as never, undefined, undefined, context);
	assert.equal(nul.details.disposition, "rejected");
	assert.match(nul.content[0]?.text ?? "", /Change 2 contains a NUL character/);
	assert.equal(await readFile(target, "utf8"), "old\nkeep\n");
	const bom = await applyTool.execute("bom", {
		path: "target.txt", proof_id: read.details.proofId,
		changes: [{ operation: "replace_range", start_anchor: first, end_anchor: first, lines: "\uFEFFnew" }],
	} as never, undefined, undefined, context);
	assert.equal(bom.details.disposition, "rejected");
	assert.match(bom.content[0]?.text ?? "", /reinterpret leading U\+FEFF text as a UTF-8 BOM/);
	assert.equal(await readFile(target, "utf8"), "old\nkeep\n");
});

// [喵喵喵]: 两个远端 change 同时缺行；验证一次恢复后整批可重提，而非逐块拒绝。
test("disjoint changes recover all missing ranges before an explicit batch retry", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const search = registeredTools.get(HLEDIT_SEARCH_ANCHORS_TOOL)!;
	const apply = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL)!;
	const directory = await mkdtemp(join(process.cwd(), ".batch-recovery-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const original = Array.from({ length: 1600 }, (_, i) => `row-${i + 1}`);
	const target = join(directory, "target.txt");
	await writeFile(target, original.join("\n") + "\n");
	const context = { cwd: directory };
	const read = await search.execute("search", { path: "target.txt", pattern: "^row-(1|3|4|1598|1600)$" } as never, undefined, undefined, context);
	const anchor = (n: number) => read.details.read!.lines.find((line) => line.line === n)!.anchor;
	const changes = [
		{ operation: "replace_range", start_anchor: anchor(1), end_anchor: anchor(4), lines: "first" },
		{ operation: "replace_range", start_anchor: anchor(1598), end_anchor: anchor(1600), lines: "last" },
	];
	const recovered = await apply.execute("recover", { path: "target.txt", proof_id: read.details.proofId, changes } as never, undefined, undefined, context);
	assert.equal(recovered.details.disposition, "rejected");
	assert.deepEqual(recovered.details.recoveredReads?.flatMap((page) => page.lines.map((line) => line.line)), [2, 1599]);
	assert.doesNotMatch(recovered.content[0]!.text, /continue with offset/);
	assert.equal(await readFile(target, "utf8"), original.join("\n") + "\n");
	const result = await apply.execute("retry", { path: "target.txt", proof_id: recovered.details.proofId, changes } as never, undefined, undefined, context);
	assert.equal(result.details.disposition, "succeeded");
	assert.equal(await readFile(target, "utf8"), ["first", ...original.slice(4, 1597), "last"].join("\n") + "\n");
});
