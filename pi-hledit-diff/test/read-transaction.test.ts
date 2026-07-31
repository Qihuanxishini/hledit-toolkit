import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL } from "../src/active-tools.ts";
import { ReadEvidenceStore } from "../src/read-evidence.ts";
import { runReadAnchorsTransaction, type HleditReadRunner } from "../src/read-transaction.ts";

const REVISION_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("read CLI validation and evidence update hold the canonical file queue", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-read-transaction-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const otherTarget = join(directory, "other.txt");
	await writeFile(target, "old\n", "utf8");
	await writeFile(otherTarget, "other\n", "utf8");

	let markRunnerStarted!: () => void;
	const runnerStarted = new Promise<void>((resolve) => {
		markRunnerStarted = resolve;
	});
	let finishRunner!: (run: Awaited<ReturnType<HleditReadRunner>>) => void;
	const runnerResult = new Promise<Awaited<ReturnType<HleditReadRunner>>>((resolve) => {
		finishRunner = resolve;
	});
	const controlledRunner: HleditReadRunner = async () => {
		markRunnerStarted();
		return runnerResult;
	};

	const evidence = new ReadEvidenceStore();
	const readPromise = runReadAnchorsTransaction(
		{ path: "target.txt", offset: 1, limit: 1 },
		directory,
		undefined,
		evidence,
		controlledRunner,
	);
	await runnerStarted;

	let sameFileMutationStarted = false;
	const sameFileMutation = withFileMutationQueue(target, async () => {
		sameFileMutationStarted = true;
		evidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, {
			disposition: "succeeded",
			evidencePath: target,
			revision: REVISION_B,
			updatedAnchors: {
				lines: [{ line: 1, anchor: "1#BBB", text: "new", textTruncated: false }],
				offset: 1,
				limit: 1,
				desiredLimit: 1,
				truncated: false,
			},
		}, directory);
	});
	let otherFileMutationStarted = false;
	await withFileMutationQueue(otherTarget, async () => {
		otherFileMutationStarted = true;
	});
	assert.equal(otherFileMutationStarted, true);
	assert.equal(sameFileMutationStarted, false);

	finishRunner({
		stdout: JSON.stringify({
			ok: true,
			revision: REVISION_A,
			totalLines: 1,
			lines: [{ line: 1, anchor: "1#AAA", text: "old" }],
			truncated: false,
		}),
		stderr: "",
		exitCode: 0,
	});
	const readResult = await readPromise;
	assert.equal(readResult.details.disposition, "succeeded");
	await sameFileMutation;
	assert.equal(sameFileMutationStarted, true);

	assert.ok("failure" in evidence.selectProof(target, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
	const current = evidence.selectProof(target, [{ operation: "insert_after", anchor: "1#BBB", lines: ["x"] }]);
	assert.ok("proof" in current);
	assert.equal(current.proof.revision, REVISION_B);
});
