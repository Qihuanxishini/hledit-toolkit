import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	assert.match(applyResult.content[0]?.text ?? "", /Updated anchors:/);
	assert.match(applyResult.content[0]?.text ?? "", /TWO/);
	assert.equal(await readFile(join(directory, "target.txt"), "utf8"), "one\nTWO\nthree\n");
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
	assert.match(applyResult.content[0]?.text ?? "", /Atomic batch rejected; zero changes were applied/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");
});
