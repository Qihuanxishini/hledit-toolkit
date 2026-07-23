import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import type { TextResult } from "../src/result.ts";

type ExtensionListener = (event: unknown, context: TestContext) => unknown | Promise<unknown>;
type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: TestContext,
	) => Promise<TextResult>;
};
type BranchEntry = {
	type: "message";
	message: {
		role: "toolResult";
		toolName: string;
		details: unknown;
	};
};
type TestContext = {
	cwd: string;
	hasUI: false;
	sessionManager: { getBranch: () => BranchEntry[] };
};

function registerActivationHarness() {
	const tools = new Map<string, RegisteredTool>();
	const listeners = new Map<string, ExtensionListener>();
	let activeTools = ["read", "edit", "bash"];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(eventName: string, listener: ExtensionListener) {
			listeners.set(eventName, listener);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(next: string[]) {
			activeTools = [...next];
		},
	};
	piHleditDiffExtension(pi as never);
	return {
		tools,
		listener(name: string): ExtensionListener {
			const listener = listeners.get(name);
			assert.ok(listener, `missing ${name} listener`);
			return listener;
		},
		activeTools: () => [...activeTools],
	};
}

test("apply activation follows valid evidence on the current session branch", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-activation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	let branch: BranchEntry[] = [];
	const context: TestContext = {
		cwd: directory,
		hasUI: false,
		sessionManager: { getBranch: () => branch },
	};
	const harness = registerActivationHarness();
	await harness.listener("session_start")({}, context);
	assert.deepEqual(harness.activeTools(), ["read", "bash", HLEDIT_READ_ANCHORS_TOOL]);

	const applyTool = harness.tools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(applyTool);
	const prooflessApply = await applyTool.execute(
		"proofless-apply",
		{ path: "target.txt", changes: [{ operation: "delete_range", start_anchor: "1#AAA", end_anchor: "1#AAA" }] } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(prooflessApply.details.error?.code, "insufficient_read_proof");
	assert.match(prooflessApply.content[0]?.text ?? "", /未启动 batch/);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");

	const readTool = harness.tools.get(HLEDIT_READ_ANCHORS_TOOL);
	assert.ok(readTool);
	const failedRead = await readTool.execute(
		"failed-read",
		{ path: "target.txt", offset: 99, limit: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(failedRead.details.disposition, "rejected");
	assert.deepEqual(harness.activeTools(), ["read", "bash", HLEDIT_READ_ANCHORS_TOOL]);

	const successfulRead = await readTool.execute(
		"read",
		{ path: "target.txt", offset: 2, limit: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(successfulRead.details.disposition, "succeeded");
	assert.deepEqual(harness.activeTools(), [
		"read",
		"bash",
		HLEDIT_READ_ANCHORS_TOOL,
		HLEDIT_APPLY_FILE_CHANGES_TOOL,
	]);

	branch = [];
	await harness.listener("session_tree")({}, context);
	assert.deepEqual(harness.activeTools(), ["read", "bash", HLEDIT_READ_ANCHORS_TOOL]);

	branch = [{
		type: "message",
		message: {
			role: "toolResult",
			toolName: HLEDIT_READ_ANCHORS_TOOL,
			details: successfulRead.details,
		},
	}];
	await harness.listener("session_tree")({}, context);
	assert.deepEqual(harness.activeTools(), [
		"read",
		"bash",
		HLEDIT_READ_ANCHORS_TOOL,
		HLEDIT_APPLY_FILE_CHANGES_TOOL,
	]);
});
