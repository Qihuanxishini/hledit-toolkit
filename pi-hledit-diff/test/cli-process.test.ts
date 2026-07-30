import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { waitForHleditProcess } from "../src/cli.ts";

type ControlledChild = ChildProcessWithoutNullStreams & {
	killCalls: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
};

function controlledChild(killResult = true): ControlledChild {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		pid: 1234,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		killCalls: 0,
		kill() {
			this.killCalls += 1;
			return killResult;
		},
	});
	return child as unknown as ControlledChild;
}

function wait(child: ControlledChild, signal?: AbortSignal, overrides: { maxOutputBytes?: number; timeoutMs?: number; graceMs?: number; forceTerminate?: () => void } = {}) {
	return waitForHleditProcess(child, undefined, {
		executablePath: "hledit.exe",
		signal,
		maxOutputBytes: overrides.maxOutputBytes ?? 1024,
		timeoutMs: overrides.timeoutMs ?? 10_000,
		terminationGraceMs: overrides.graceMs ?? 10,
		...(overrides.forceTerminate ? { forceTerminate: overrides.forceTerminate } : {}),
	});
}

function emitExit(child: ControlledChild, signalCode: NodeJS.Signals = "SIGTERM"): void {
	child.signalCode = signalCode;
	child.emit("exit", null, signalCode);
}

test("normal completion waits for close so stdout and stderr are complete", async () => {
	const child = controlledChild();
	const runPromise = wait(child);
	child.emit("spawn");
	(child.stdout as PassThrough).write("out");
	(child.stderr as PassThrough).write("err");
	child.exitCode = 0;
	child.emit("exit", 0, null);

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	(child.stdout as PassThrough).write("put");
	(child.stderr as PassThrough).write("or");
	child.emit("close", 0, null);
	assert.deepEqual(await runPromise, { stdout: "output", stderr: "error", exitCode: 0, started: true });
});

test("an error before spawn proves that no process started", async () => {
	const child = controlledChild();
	const runPromise = wait(child);
	child.emit("error", new Error("ENOENT"));

	const run = await runPromise;
	assert.equal(run.started, false);
	assert.equal(run.exitCode, 1);
	assert.match(run.stdout, /Could not start hledit/);
	assert.equal(run.stderr, "ENOENT");
});


test("an error after spawn is diagnostic and cannot release the process early", async () => {
	const child = controlledChild();
	const runPromise = wait(child);
	child.emit("spawn");
	child.emit("error", new Error("late process error"));

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	child.exitCode = 1;
	child.emit("exit", 1, null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	child.emit("close", 1, null);
	const run = await runPromise;
	assert.equal(run.started, true);
	assert.equal(run.exitCode, 1);
	assert.match(run.stderr, /process error after start: late process error/);
});


test("a synchronous stdin failure follows the exit-confirmed termination path", async () => {
	const child = controlledChild();
	child.stdin.end = (() => {
		throw new Error("stdin closed");
	}) as typeof child.stdin.end;
	const runPromise = wait(child);
	child.emit("spawn");
	assert.equal(child.killCalls, 1);

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	emitExit(child);
	const run = await runPromise;
	assert.match(run.stdout, /Could not send input/);
	assert.equal(run.stderr, "stdin closed");
	assert.equal(run.started, true);
});

test("abort waits for exit confirmation and does not depend on close", async () => {
	const child = controlledChild();
	const controller = new AbortController();
	const runPromise = wait(child, controller.signal);
	child.emit("spawn");
	controller.abort();
	assert.equal(child.killCalls, 1);

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	emitExit(child);
	const run = await runPromise;
	assert.equal(run.stdout, "hledit execution was cancelled.");
	assert.equal(run.started, true);
	assert.equal(child.stdout.destroyed, true);
	assert.equal(child.stderr.destroyed, true);
});


test("termination also accepts close as process-exit confirmation", async () => {
	const child = controlledChild();
	const controller = new AbortController();
	const runPromise = wait(child, controller.signal);
	child.emit("spawn");
	controller.abort();
	child.emit("close", null, "SIGTERM");

	const run = await runPromise;
	assert.equal(run.stdout, "hledit execution was cancelled.");
	assert.equal(run.started, true);
	assert.equal(child.stdin.destroyed, true);
});

test("failed graceful kill escalates but still waits for confirmed exit", async () => {
	const child = controlledChild(false);
	const controller = new AbortController();
	let forceCalls = 0;
	const runPromise = wait(child, controller.signal, {
		graceMs: 1,
		forceTerminate: () => {
			forceCalls += 1;
		},
	});
	child.emit("spawn");
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(forceCalls, 1);

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	emitExit(child, "SIGKILL");
	const run = await runPromise;
	assert.match(run.stderr, /Graceful termination request returned false/);
	assert.equal(run.started, true);
});


test("timeout uses the same exit-confirmed termination path", async () => {
	const child = controlledChild();
	const runPromise = wait(child, undefined, { timeoutMs: 1, graceMs: 20 });
	child.emit("spawn");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(child.killCalls, 1);

	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	emitExit(child);
	const run = await runPromise;
	assert.match(run.stdout, /did not finish within 0.001 seconds/);
	assert.equal(run.started, true);
});

test("output overflow requests termination and ignores late stream data", async () => {
	const child = controlledChild();
	const runPromise = wait(child, undefined, { maxOutputBytes: 4 });
	child.emit("spawn");
	(child.stdout as PassThrough).write("12345");
	(child.stdout as PassThrough).write("late");
	emitExit(child);

	const run = await runPromise;
	assert.match(run.stdout, /output exceeded 4 bytes/);
	assert.doesNotMatch(run.stdout, /late/);
	assert.equal(run.started, true);
});
