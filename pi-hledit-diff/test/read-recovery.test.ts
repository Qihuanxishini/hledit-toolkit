import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import { computeAnchorTag } from "../src/anchor-hash.ts";
import type { HleditRun } from "../src/cli.ts";
import { ReadEvidenceStore } from "../src/read-evidence.ts";
import { recoverMissingReadProof } from "../src/read-recovery.ts";
import { readAnchorsResult } from "../src/read-result.ts";
import type { TextResult } from "../src/result.ts";

for (const knownLines of [9977, 9978]) {
	test(`recovery records each page once and replays the same capacity decision (${knownLines} cached lines)`, async (t) => {
		const cwd = process.cwd();
		const path = resolve(cwd, "recovery-capacity.txt");
		const totalLines = knownLines + 2;
		const revision = `sha256:${"a".repeat(64)}`;
		const row = (line: number) => {
			const text = line > knownLines ? "x".repeat(30_000) : `row ${line}`;
			return { line, anchor: computeAnchorTag(line, text), text };
		};
		const run = (offset: number, count: number): HleditRun => ({
			stdout: JSON.stringify({
				ok: true, revision, totalLines,
				lines: Array.from({ length: count }, (_, index) => row(offset + index)),
				truncated: offset + count <= totalLines,
				...(offset + count <= totalLines ? { nextOffset: offset + count } : {}),
			}),
			stderr: "", exitCode: 0,
		});
		const live = new ReadEvidenceStore();
		const history: Array<{ toolName: string; details: TextResult["details"] }> = [];
		for (let offset = 1; offset <= knownLines; offset += 500) {
			const limit = Math.min(500, knownLines + 1 - offset);
			const result = readAnchorsResult(run(offset, limit), { path, offset, limit });
			assert.equal(result.details.disposition, "succeeded");
			live.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, result.details, cwd);
			history.push({ toolName: HLEDIT_READ_ANCHORS_TOOL, details: result.details });
		}
		const recording = t.mock.method(live, "recordRead");
		const selection = live.selectProof(path, [{
			operation: "delete_range", start_anchor: row(knownLines + 1).anchor, end_anchor: row(totalLines).anchor,
		}], live.getProofId(path));
		assert.ok("failure" in selection);
		const recovered = await recoverMissingReadProof({
			failure: selection.failure, path, evidencePath: path, cwd, signal: undefined,
			run: async (args) => {
				const offset = Number(args[args.indexOf("--offset") + 1]);
				// [喵喵喵]: 两个 30 KiB 源行各占一页；首个补读窗口仍带前两行上下文。
				return run(offset, offset <= knownLines + 1 ? knownLines + 2 - offset : 1);
			},
		});
		assert.ok(recovered);
		assert.equal(recovered.details.recoveredReads?.length, 2);
		live.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, recovered.details, cwd);
		history.push({ toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: recovered.details });

		const replayed = new ReadEvidenceStore();
		replayed.restoreFromBranch({
			cwd,
			sessionManager: { getBranch: () => history.map((entry) => ({
				type: "message", message: { role: "toolResult", ...entry },
			})) },
		} as never);
		assert.equal(recording.mock.callCount(), 2);
		assert.deepEqual(live.anchorTokens(path), replayed.anchorTokens(path));
		assert.equal(live.anchorTokens(path).size, knownLines === 9977 ? totalLines : 1);
		for (const line of [1, knownLines + 1, totalLines]) {
			const changes = [{ operation: "delete_range" as const, start_anchor: row(line).anchor, end_anchor: row(line).anchor }];
			assert.deepEqual(
				live.selectProof(path, changes, recovered.details.proofId),
				replayed.selectProof(path, changes, recovered.details.proofId),
			);
		}
	});
}
