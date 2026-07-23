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

test("anchored editing tools stay active regardless of current read evidence", async (t) => {
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
	const expectedActiveTools = ["read", "bash", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL];
	await harness.listener("session_start")({}, context);
	assert.deepEqual(harness.activeTools(), expectedActiveTools);

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
	assert.deepEqual(harness.activeTools(), expectedActiveTools);

	const successfulRead = await readTool.execute(
		"read",
		{ path: "target.txt", offset: 2, limit: 1 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(successfulRead.details.disposition, "succeeded");
	assert.deepEqual(harness.activeTools(), expectedActiveTools);
	const currentAnchor = successfulRead.details.read?.lines[0]?.anchor;
	assert.ok(currentAnchor);
	const noOpApplyParams = {
		path: "target.txt",
		changes: [{ operation: "replace_range", start_anchor: currentAnchor, end_anchor: currentAnchor, lines: ["two"] }],
	} as never;

	branch = [];
	await harness.listener("session_tree")({}, context);
	assert.deepEqual(harness.activeTools(), expectedActiveTools);
	const clearedBranchApply = await applyTool.execute(
		"apply-with-cleared-branch",
		noOpApplyParams,
		undefined,
		undefined,
		context,
	);
	assert.equal(clearedBranchApply.details.error?.code, "insufficient_read_proof");
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");

	branch = [{
		type: "message",
		message: {
			role: "toolResult",
			toolName: HLEDIT_READ_ANCHORS_TOOL,
			details: successfulRead.details,
		},
	}];
	await harness.listener("session_tree")({}, context);
	assert.deepEqual(harness.activeTools(), expectedActiveTools);
	const restoredBranchApply = await applyTool.execute(
		"apply-with-restored-branch",
		noOpApplyParams,
		undefined,
		undefined,
		context,
	);
	assert.equal(restoredBranchApply.details.disposition, "succeeded");
	assert.equal(restoredBranchApply.details.contentChanged, false);
	assert.equal(await readFile(target, "utf8"), "one\ntwo\nthree\n");
});
