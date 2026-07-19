import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import type { TextResult } from "../src/result.ts";

type ToolResultListener = (event: { toolName: string; details: unknown }) => unknown;
type RegisteredTool = {
	name: string;
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

test("extension registers both tools and escalates logical hledit failures", () => {
	const { registeredTools, toolResultListener } = registerExtensionForTest();

	assert.deepEqual([...registeredTools.keys()], [HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]);
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "rejected" } }), { isError: true });
	assert.deepEqual(toolResultListener({ toolName: HLEDIT_READ_ANCHORS_TOOL, details: { disposition: "unavailable" } }), { isError: true });
	assert.equal(toolResultListener({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: { disposition: "succeeded" } }), undefined);
	assert.equal(toolResultListener({ toolName: "bash", details: { disposition: "rejected" } }), undefined);
});

test("apply tool exposes JSON-string argument preparation to Pi", () => {
	const { registeredTools } = registerExtensionForTest();
	const applyTool = registeredTools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(applyTool?.prepareArguments);

	assert.deepEqual(
		applyTool.prepareArguments({
			path: "target.txt",
			changes: JSON.stringify({ operation: "replace", anchor: "1#BH", lines: "first\nsecond" }),
		}),
		{
			path: "target.txt",
			changes: [{ operation: "replace", anchor: "1#BH", lines: ["first", "second"] }],
		},
	);
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
	assert.equal(rangeError.details.error?.message, "起始行 4 超出文件范围（文件共 3 行）。");
	assert.equal(rangeError.content[0]?.text.split("\n", 1)[0], "起始行 4 超出文件范围（文件共 3 行）。");
});

test("read tool accepts a grep result that exactly fills the byte budget at EOF", async (t) => {
	const { registeredTools } = registerExtensionForTest();
	const readTool = registeredTools.get(HLEDIT_READ_ANCHORS_TOOL);
	assert.ok(readTool);

	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-extension-exact-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// 1#XX、冒号和换行共 6 bytes，使锚点行恰好填满 CLI 的 50 KiB 预算。
	const line = "x".repeat(50 * 1024 - 6);
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
	assert.match(renderedAnchor ?? "", /^2#[A-Za-z0-9]+:two$/);
	const anchor = renderedAnchor!.split(":", 1)[0]!;
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace", anchor, lines: ["TWO"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	assert.match(applyResult.content[0]?.text ?? "", /更新后的锚点：/);
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
		{ path: "target.txt", changes: [{ operation: "replace", anchor, lines: ["two"] }] } as never,
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
		{ path: "target.txt", changes: [{ operation: "replace", anchor, lines: ["CHANGED"] }] } as never,
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
		{ path: "target.txt", changes: [{ operation: "delete", anchor }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "succeeded");
	assert.match(applyResult.content[0]?.text ?? "", /（文件为空）/);
	assert.equal(await readFile(target, "utf8"), "");
});

test("apply tool rejects accidental single-anchor block expansion without writing", async (t) => {
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
	const renderedAnchor = readResult.content[0]?.text.split(/\r?\n/, 1)[0];
	const anchor = renderedAnchor!.split(":", 1)[0]!;
	const applyResult = await applyTool.execute(
		"apply",
		{ path: "target.txt", changes: [{ operation: "replace", anchor, lines: ["two", "inserted"] }] } as never,
		undefined,
		undefined,
		context,
	);

	assert.equal(applyResult.details.disposition, "rejected");
	assert.match(applyResult.content[0]?.text ?? "", /原子批次已拒绝，未写入任何内容/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");
});
