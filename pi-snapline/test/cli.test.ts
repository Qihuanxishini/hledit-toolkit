import assert from "node:assert/strict";
import test from "node:test";

import { parseSnaplineCapabilities, type SnaplineRun } from "../src/cli.ts";

const capabilities = {
	ok: true,
	product: "snapline",
	version: "1.0.0",
	wireProtocol: 1,
	rawRevision: "sha256",
	multiWindowRead: true,
	boundedBinaryPreflight: true,
	groupedAtomicApply: true,
	completeReadProof: true,
	preCommitRevisionCheck: true,
	structuredEditEffects: true,
	structuredRecoveryContexts: true,
};

function run(stdout: string, exitCode = 0): SnaplineRun {
	return { stdout, stderr: "", exitCode, started: true };
}

test("strictly accepts Snapline 1.x wire-protocol-1 capabilities", () => {
	assert.deepEqual(parseSnaplineCapabilities(run(JSON.stringify(capabilities))), {
		product: "snapline",
		version: "1.0.0",
		wireProtocol: 1,
		rawRevision: "sha256",
		multiWindowRead: true,
		boundedBinaryPreflight: true,
		groupedAtomicApply: true,
		completeReadProof: true,
		preCommitRevisionCheck: true,
		structuredEditEffects: true,
		structuredRecoveryContexts: true,
	});
});

test("rejects incompatible, partial, and extended capabilities", () => {
	assert.equal(parseSnaplineCapabilities(run(JSON.stringify({ ...capabilities, version: "2.0.0" }))), undefined);
	assert.equal(parseSnaplineCapabilities(run(JSON.stringify({ ...capabilities, completeReadProof: false }))), undefined);
	assert.equal(parseSnaplineCapabilities(run(JSON.stringify({ ...capabilities, extra: true }))), undefined);
	const { structuredRecoveryContexts: _removed, ...partial } = capabilities;
	assert.equal(parseSnaplineCapabilities(run(JSON.stringify(partial))), undefined);
	assert.equal(parseSnaplineCapabilities(run("not json")), undefined);
	assert.equal(parseSnaplineCapabilities(run(JSON.stringify(capabilities), 1)), undefined);
});
