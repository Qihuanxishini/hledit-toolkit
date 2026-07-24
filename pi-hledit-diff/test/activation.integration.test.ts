import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piHleditDiffExtension from "../index.ts";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_REPLACE_ONCE_TOOL } from "../src/active-tools.ts";
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
	const expectedActiveTools = ["read", "bash", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_REPLACE_ONCE_TOOL];
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
	assert.match(prooflessApply.content[0]?.text ?? "", /Batch was not started/);
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

test("grep reads provide partial proof without a second range read", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-grep-proof-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const partialTarget = join(directory, "partial.txt");
	const contextTarget = join(directory, "context.txt");
	await writeFile(partialTarget, "before\nhit\nafter\n", "utf8");
	await writeFile(contextTarget, "before\nhit\nafter\n", "utf8");

	const context: TestContext = {
		cwd: directory,
		hasUI: false,
		sessionManager: { getBranch: () => [] },
	};
	const harness = registerActivationHarness();
	await harness.listener("session_start")({}, context);
	const readTool = harness.tools.get(HLEDIT_READ_ANCHORS_TOOL);
	const applyTool = harness.tools.get(HLEDIT_APPLY_FILE_CHANGES_TOOL);
	assert.ok(readTool);
	assert.ok(applyTool);

	const partialRead = await readTool.execute(
		"grep-partial",
		{ path: "partial.txt", grep: "hit", context: 0 } as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(partialRead.details.disposition, "succeeded");
	assert.equal(partialRead.details.read?.lines.length, 1);
	const hitAnchor = partialRead.details.read?.lines[0]?.anchor;
	assert.ok(hitAnchor);

	const uncoveredApply = await applyTool.execute(
		"grep-uncovered-range",
		{
			path: "partial.txt",
			changes: [{ operation: "replace_range", start_anchor: "1#AAA", end_anchor: hitAnchor, lines: ["changed"] }],
		} as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(uncoveredApply.details.error?.code, "insufficient_read_proof");
	assert.match(uncoveredApply.content[0]?.text ?? "", /Batch was not started/);
	assert.equal(await readFile(partialTarget, "utf8"), "before\nhit\nafter\n");

	const singleLineApply = await applyTool.execute(
		"grep-covered-line",
		{
			path: "partial.txt",
			changes: [{ operation: "replace_range", start_anchor: hitAnchor, end_anchor: hitAnchor, lines: ["changed"] }],
		} as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(singleLineApply.details.disposition, "succeeded");
	assert.equal(await readFile(partialTarget, "utf8"), "before\nchanged\nafter\n");

	const contextRead = await readTool.execute(
		"grep-with-context",
		{ path: "context.txt", grep: "hit", context: 1 } as never,
		undefined,
		undefined,
		context,
	);
	const contextLines = contextRead.details.read?.lines;
	assert.equal(contextLines?.length, 3);
	const firstAnchor = contextLines?.[0]?.anchor;
	const lastAnchor = contextLines?.[2]?.anchor;
	assert.ok(firstAnchor);
	assert.ok(lastAnchor);

	const contextApply = await applyTool.execute(
		"grep-covered-range",
		{
			path: "context.txt",
			changes: [{ operation: "replace_range", start_anchor: firstAnchor, end_anchor: lastAnchor, lines: ["rewritten"] }],
		} as never,
		undefined,
		undefined,
		context,
	);
	assert.equal(contextApply.details.disposition, "succeeded");
	assert.equal(await readFile(contextTarget, "utf8"), "rewritten\n");
});
