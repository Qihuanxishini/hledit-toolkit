import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { waitForSnaplineProcess } from "../src/cli.ts";

function nodeChild(script: string) {
	return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
}

function wait(child: ReturnType<typeof nodeChild>, options: Partial<Parameters<typeof waitForSnaplineProcess>[2]> = {}) {
	return waitForSnaplineProcess(child, undefined, {
		executablePath: process.execPath,
		signal: undefined,
		maxOutputBytes: 1024,
		timeoutMs: 2000,
		terminationGraceMs: 50,
		...options,
	});
}

test("process wrapper captures bounded stdout and stderr after confirmed exit", async () => {
	const result = await wait(nodeChild("process.stdout.write('out'); process.stderr.write('err')"));
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, "out");
	assert.equal(result.stderr, "err");
	assert.equal(result.started, true);
});

test("process wrapper terminates output overflow and waits for process exit", async () => {
	const child = nodeChild("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)");
	const result = await wait(child, { maxOutputBytes: 128 });
	assert.equal(result.exitCode, 1);
	assert.match(result.stdout, /output exceeded 128 bytes/);
	assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("process wrapper terminates timeout and cancellation", async () => {
	const timeoutChild = nodeChild("setInterval(() => {}, 1000)");
	const timedOut = await wait(timeoutChild, { timeoutMs: 25 });
	assert.equal(timedOut.exitCode, 1);
	assert.match(timedOut.stdout, /did not finish/);
	assert.notEqual(timeoutChild.exitCode ?? timeoutChild.signalCode, null);

	const controller = new AbortController();
	const abortChild = nodeChild("setInterval(() => {}, 1000)");
	setTimeout(() => controller.abort(), 20);
	const aborted = await wait(abortChild, { signal: controller.signal });
	assert.equal(aborted.exitCode, 1);
	assert.match(aborted.stdout, /cancelled/);
	assert.notEqual(abortChild.exitCode ?? abortChild.signalCode, null);
});

test("spawn failure is classified as not started", async () => {
	const child = spawn("definitely-missing-snapline-executable", [], { stdio: ["pipe", "pipe", "pipe"] });
	const result = await waitForSnaplineProcess(child, undefined, {
		executablePath: "definitely-missing-snapline-executable",
		signal: undefined,
		maxOutputBytes: 1024,
		timeoutMs: 1000,
		terminationGraceMs: 10,
	});
	assert.equal(result.exitCode, 1);
	assert.equal(result.started, false);
	assert.match(result.stdout, /Could not start Snapline/);
});
