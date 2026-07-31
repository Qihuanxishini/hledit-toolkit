import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import piSnaplineExtension from "../index.ts";
import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "../src/schema.ts";
import type { SnaplineApplyDetails, SnaplineReadDetails } from "../src/tool-details.ts";

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; details: unknown };
type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: Record<string, unknown>,
	) => Promise<ToolResult>;
};
type EventHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

type Harness = {
	api: Record<string, unknown>;
	tools: Map<string, RegisteredTool>;
	events: Map<string, EventHandler[]>;
	commands: Map<string, { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }>;
	active: () => string[];
};

function harness(extraTools: string[] = []): Harness {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, EventHandler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }>();
	let active = [...new Set(["bash", "read", "edit", "write", "grep", ...extraTools])];
	const api = {
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) { commands.set(name, command); },
		on(name: string, callback: EventHandler) {
			const callbacks = events.get(name) ?? [];
			callbacks.push(callback);
			events.set(name, callbacks);
		},
		getActiveTools() { return [...active]; },
		setActiveTools(next: string[]) { active = [...next]; },
		getAllTools() {
			return [...new Set([...tools.keys(), ...extraTools])].map((name) => ({ name, description: "", parameters: {}, sourceInfo: {} }));
		},
	};
	piSnaplineExtension(api as never);
	return { api, tools, events, commands, active: () => [...active] };
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "snapline-extension-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

function context(cwd: string, branch: unknown[] = []) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		cwd,
		hasUI: true,
		model: { input: ["text", "image"] },
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		sessionManager: { getBranch() { return branch; } },
		notifications,
	};
}

async function emit(h: Harness, name: string, event: Record<string, unknown>, ctx: Record<string, unknown>): Promise<void> {
	for (const callback of h.events.get(name) ?? []) {
		const result = await callback(event, ctx);
		if (name === "tool_result" && typeof result === "object" && result !== null && !Array.isArray(result)) {
			Object.assign(event, result);
		}
	}
}

function readDetails(result: ToolResult): SnaplineReadDetails {
	return result.details as SnaplineReadDetails;
}

function applyDetails(result: ToolResult): SnaplineApplyDetails {
	return result.details as SnaplineApplyDetails;
}

test("healthy lifecycle uses unified read, lazily activates apply, and edits through the real CLI", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "one\ntwo\nthree\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	assert.deepEqual(h.active(), ["bash", "write", "grep", SNAPLINE_READ_TOOL]);

	const readTool = h.tools.get(SNAPLINE_READ_TOOL)!;
	const firstRead = await readTool.execute("read-1", { path: "file.txt", offset: 1, limit: 3 }, undefined, undefined, ctx);
	const firstDetails = readDetails(firstRead);
	assert.equal(firstDetails.disposition, "succeeded");
	assert.ok(firstDetails.snapshot);
	assert.match(firstRead.content[0]!.text!, /1:one\n2:two\n3:three/);
	assert.deepEqual(h.active(), ["bash", "write", "grep", SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL]);

	const applyTool = h.tools.get(SNAPLINE_APPLY_TOOL)!;
	const applied = await applyTool.execute("apply-1", {
		path: "file.txt",
		snapshot: firstDetails.snapshot,
		replacements: [{ start: 2, end: 2, text: "TWO" }],
	}, undefined, undefined, ctx);
	assert.equal(applyDetails(applied).disposition, "succeeded");
	assert.equal(applyDetails(applied).contentChanged, true);
	assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), "one\nTWO\nthree\n");
	assert.ok(applyDetails(applied).preview?.lines.some((line) => line.kind === "remove" && line.text === "two"));
	assert.ok(applyDetails(applied).preview?.lines.some((line) => line.kind === "add" && line.text === "TWO"));
});

test("branch replay activates apply immediately from persisted typed details", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "line\n", "utf8");
	const first = harness();
	const firstContext = context(cwd);
	await emit(first, "session_start", {}, firstContext);
	const readResult = await first.tools.get(SNAPLINE_READ_TOOL)!.execute("read", { path: "file.txt", limit: 1 }, undefined, undefined, firstContext);
	const branch = [{
		type: "message",
		message: { role: "toolResult", toolName: SNAPLINE_READ_TOOL, details: readResult.details },
	}];

	const restored = harness();
	const restoredContext = context(cwd, branch);
	await emit(restored, "session_start", {}, restoredContext);
	assert.ok(restored.active().includes(SNAPLINE_APPLY_TOOL));
	const details = readDetails(readResult);
	const noOp = await restored.tools.get(SNAPLINE_APPLY_TOOL)!.execute("apply", {
		path: "file.txt", snapshot: details.snapshot, replacements: [{ start: 1, end: 1, text: "line" }],
	}, undefined, undefined, restoredContext);
	assert.equal(applyDetails(noOp).contentChanged, false);
});

test("native edit result is a global replay barrier", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "line\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read", { path: "file.txt", limit: 1 }, undefined, undefined, ctx);
	assert.ok(h.active().includes(SNAPLINE_APPLY_TOOL));
	await emit(h, "tool_result", { toolName: "edit", isError: false }, ctx);
	await emit(h, "agent_settled", {}, ctx);
	assert.equal(h.active().includes(SNAPLINE_APPLY_TOOL), false);
});

test("runtime health failure defers native fallback until agent settles", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "line\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const controller = new AbortController();
	controller.abort();
	const result = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("aborted-read", { path: "file.txt", limit: 1 }, controller.signal, undefined, ctx);
	assert.equal(readDetails(result).disposition, "unavailable");
	assert.ok(h.active().includes(SNAPLINE_READ_TOOL));
	assert.equal(h.active().includes("read"), false);
	await emit(h, "agent_settled", {}, ctx);
	assert.equal(h.active().includes(SNAPLINE_READ_TOOL), false);
	assert.ok(h.active().includes("read"));
});

test("before_agent_start repairs native read and edit activation without probing the CLI", async (t) => {
	const cwd = await temporaryDirectory(t);
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	(h.api as { setActiveTools(next: string[]): void }).setActiveTools(["bash", "read", "edit", "write", "grep", SNAPLINE_APPLY_TOOL]);
	await emit(h, "before_agent_start", {}, ctx);
	assert.deepEqual(h.active(), ["bash", "write", "grep", SNAPLINE_READ_TOOL]);
});

test("structured Snapline failures set isError while zero-write review remains non-error", async (t) => {
	const cwd = await temporaryDirectory(t);
	const h = harness();
	const ctx = context(cwd);
	const rejected = { toolName: SNAPLINE_READ_TOOL, details: { protocolVersion: 1, operation: "read", disposition: "rejected" }, isError: false };
	await emit(h, "tool_result", rejected, ctx);
	assert.equal(rejected.isError, true);
	const review = { toolName: SNAPLINE_APPLY_TOOL, details: { protocolVersion: 1, operation: "apply", disposition: "needs_review" }, isError: false };
	await emit(h, "tool_result", review, ctx);
	assert.equal(review.isError, false);
});

test("healthy write creates missing files and rejects overwrite", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "existing.txt"), "old", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const writeTool = h.tools.get("write")!;
	await writeTool.execute("write-new", { path: "new.txt", content: "new" }, undefined, undefined, ctx);
	assert.equal(await readFile(path.join(cwd, "new.txt"), "utf8"), "new");
	await assert.rejects(
		() => writeTool.execute("write-existing", { path: "existing.txt", content: "replace" }, undefined, undefined, ctx),
		/only creates missing files/,
	);
	assert.equal(await readFile(path.join(cwd, "existing.txt"), "utf8"), "old");
});

test("legacy Hledit conflict keeps the competing extension's active tools", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "native\n", "utf8");
	const h = harness(["hledit_read_anchors"]);
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	assert.ok(h.active().includes("read"));
	assert.ok(h.active().includes("edit"));
	assert.ok(h.active().includes("hledit_read_anchors"));
	assert.equal(h.active().includes(SNAPLINE_READ_TOOL), false);
	assert.equal(h.active().includes(SNAPLINE_APPLY_TOOL), false);
	(h.api.setActiveTools as (tools: string[]) => void)([...h.active(), SNAPLINE_READ_TOOL, SNAPLINE_APPLY_TOOL]);
	await emit(h, "before_agent_start", {}, ctx);
	assert.ok(h.active().includes("hledit_read_anchors"));
	assert.equal(h.active().includes(SNAPLINE_READ_TOOL), false);
	assert.equal(h.active().includes(SNAPLINE_APPLY_TOOL), false);
	assert.match(ctx.notifications[0]!.message, /legacy Hledit/);
});


test("status command restores healthy mode after a removable legacy conflict", async (t) => {
	const cwd = await temporaryDirectory(t);
	const legacyTools = ["hledit_apply_file_changes"];
	const h = harness(legacyTools);
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	assert.ok(h.active().includes("read"));
	legacyTools.length = 0;
	await h.commands.get("snapline-status")!.handler("", ctx);
	assert.ok(h.active().includes(SNAPLINE_READ_TOOL));
	assert.equal(h.active().includes("read"), false);
	assert.match(ctx.notifications.at(-1)!.message, /Snapline ready/);
});

test("parallel sibling applies serialize and translate untouched coordinates", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "one\ntwo\nthree\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read", { path: "file.txt", limit: 3 }, undefined, undefined, ctx);
	const snapshot = readDetails(readResult).snapshot!;
	const apply = h.tools.get(SNAPLINE_APPLY_TOOL)!;
	const outcomes = await Promise.all([
		apply.execute("apply-first", { path: "file.txt", snapshot, replacements: [{ start: 1, end: 1, text: "ONE" }] }, undefined, undefined, ctx),
		apply.execute("apply-third", { path: "file.txt", snapshot, replacements: [{ start: 3, end: 3, text: "THREE" }] }, undefined, undefined, ctx),
	]);
	assert.ok(outcomes.every((outcome) => applyDetails(outcome).disposition === "succeeded"));
	assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
});

test("parallel sibling conflict fails closed and does not overwrite the first commit", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "one\ntwo\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read", { path: "file.txt", limit: 2 }, undefined, undefined, ctx);
	const snapshot = readDetails(readResult).snapshot!;
	const apply = h.tools.get(SNAPLINE_APPLY_TOOL)!;
	const outcomes = await Promise.all([
		apply.execute("apply-a", { path: "file.txt", snapshot, replacements: [{ start: 2, end: 2, text: "A" }] }, undefined, undefined, ctx),
		apply.execute("apply-b", { path: "file.txt", snapshot, replacements: [{ start: 2, end: 2, text: "B" }] }, undefined, undefined, ctx),
	]);
	const dispositions = outcomes.map((outcome) => applyDetails(outcome).disposition).sort();
	assert.deepEqual(dispositions, ["needs_review", "succeeded"]);
	const committedText = applyDetails(outcomes[0]!).disposition === "succeeded" ? "A" : "B";
	assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), `one\n${committedText}\n`);
});

test("empty existing files enter snapshot mode and can be populated transactionally", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "empty.txt"), "", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read-empty", { path: "empty.txt" }, undefined, undefined, ctx);
	const details = readDetails(readResult);
	assert.equal(details.totalLines, 0);
	assert.ok(details.snapshot);
	assert.ok(h.active().includes(SNAPLINE_APPLY_TOOL));
	const applied = await h.tools.get(SNAPLINE_APPLY_TOOL)!.execute("populate", {
		path: "empty.txt", snapshot: details.snapshot, insertions_before: [{ line: 1, text: "created" }],
	}, undefined, undefined, ctx);
	assert.equal(applyDetails(applied).disposition, "succeeded");
	assert.equal(await readFile(path.join(cwd, "empty.txt"), "utf8"), "created");
});

test("external stale content returns current recovery without replaying the edit", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "source\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read", { path: "file.txt", limit: 1 }, undefined, undefined, ctx);
	await writeFile(path.join(cwd, "file.txt"), "external\n", "utf8");
	const outcome = await h.tools.get(SNAPLINE_APPLY_TOOL)!.execute("stale", {
		path: "file.txt", snapshot: readDetails(readResult).snapshot, replacements: [{ start: 1, end: 1, text: "model" }],
	}, undefined, undefined, ctx);
	assert.equal(applyDetails(outcome).disposition, "needs_review");
	assert.ok(applyDetails(outcome).recovery?.snapshot);
	assert.match(outcome.content[0]!.text!, /1:external/);
	assert.match(outcome.content[0]!.text!, /lines:1:approximate\/1/);
	assert.deepEqual(applyDetails(outcome).recovery?.displayedRanges, [{ start: 1, end: 1, approximate: true }]);
	assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), "external\n");
});

test("isolated carriage returns remain editable line text", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "carriage.txt"), "left\rright\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read-cr", { path: "carriage.txt", limit: 1 }, undefined, undefined, ctx);
	assert.equal(readDetails(readResult).disposition, "succeeded");
	assert.match(readResult.content[0]!.text!, /1:left\rright/);
	const applied = await h.tools.get(SNAPLINE_APPLY_TOOL)!.execute("apply-cr", {
		path: "carriage.txt",
		snapshot: readDetails(readResult).snapshot,
		replacements: [{ start: 1, end: 1, text: "updated" }],
	}, undefined, undefined, ctx);
	assert.equal(applyDetails(applied).disposition, "succeeded");
	assert.equal(await readFile(path.join(cwd, "carriage.txt"), "utf8"), "updated\n");
});

test("image candidates delegate to Pi native image handling without activating apply", async (t) => {
	const cwd = await temporaryDirectory(t);
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	await writeFile(path.join(cwd, "pixel.png"), png);
	const requestedPath = process.platform === "win32"
		? `/${cwd[0]!.toLowerCase()}${cwd.slice(2).replace(/\\/g, "/")}/pixel.png`
		: "pixel.png";
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const result = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("image", { path: requestedPath }, undefined, undefined, ctx);
	assert.ok(result.content.some((entry) => entry.type === "image"));
	assert.equal(h.active().includes(SNAPLINE_APPLY_TOOL), false);
});


test("a doubled @ path edits the literal @-prefixed file, not its neighbor", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "@literal.txt"), "at-prefixed\n", "utf8");
	await writeFile(path.join(cwd, "literal.txt"), "plain\n", "utf8");
	const h = harness();
	const ctx = context(cwd);
	await emit(h, "session_start", {}, ctx);
	const readResult = await h.tools.get(SNAPLINE_READ_TOOL)!.execute("read-at", { path: "@@literal.txt", limit: 1 }, undefined, undefined, ctx);
	assert.match(readResult.content[0]!.text!, /1:at-prefixed/);
	const applied = await h.tools.get(SNAPLINE_APPLY_TOOL)!.execute("apply-at", {
		path: "@@literal.txt",
		snapshot: readDetails(readResult).snapshot,
		replacements: [{ start: 1, end: 1, text: "updated" }],
	}, undefined, undefined, ctx);
	assert.equal(applyDetails(applied).disposition, "succeeded");
	assert.equal(await readFile(path.join(cwd, "@literal.txt"), "utf8"), "updated\n");
	assert.equal(await readFile(path.join(cwd, "literal.txt"), "utf8"), "plain\n");
});
