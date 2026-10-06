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
				// [喵喵喵]: 两个 30 KiB 源行各占一页，精确窗口不再重读已知上下文。
				return run(offset, 1);
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

for (const scenario of ["nearby", "budget", "changed-before", "changed-between"] as const) {
	test(`batch recovery preserves bounded same-revision evidence: ${scenario}`, async () => {
		const cwd = process.cwd();
		const path = resolve(cwd, "batch-recovery.txt");
		const revision = `sha256:${"a".repeat(64)}`;
		const changed = `sha256:${"b".repeat(64)}`;
		const starts = scenario === "nearby" ? [1, 4, 7, 10, 13] : scenario === "budget" ? [1, 101, 201, 301, 401] : [1, 101];
		const row = (line: number) => ({ line, anchor: computeAnchorTag(line, `row ${line}`), text: `row ${line}` });
		const run = (numbers: number[], rev: string): HleditRun => ({
			stdout: JSON.stringify({ ok: true, revision: rev, totalLines: 503, lines: numbers.map(row),
				truncated: true, nextOffset: numbers.at(-1)! + 1, totalMatches: numbers.length }),
			stderr: "", exitCode: 0,
		});
		const initial = readAnchorsResult(run(starts.flatMap((n) => [n, n + 2]), revision),
			{ path, offset: 1, limit: 100, pattern: "row" });
		const live = new ReadEvidenceStore();
		live.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, initial.details, cwd);
		const changes = starts.map((n) => ({ operation: "delete_range" as const, start_anchor: row(n).anchor, end_anchor: row(n + 2).anchor }));
		const selected = live.selectProof(path, changes, initial.details.proofId);
		assert.ok("failure" in selected);
		let calls = 0;
		const recovered = await recoverMissingReadProof({
			failure: selected.failure, path, evidencePath: path, cwd, signal: undefined,
			run: async (args) => {
				calls += 1;
				const offset = Number(args[args.indexOf("--offset") + 1]);
				const limit = Number(args[args.indexOf("--limit") + 1]);
				return run(Array.from({ length: limit }, (_, i) => offset + i), scenario === "changed-before" || (scenario === "changed-between" && calls === 2) ? changed : revision);
			},
		});
		assert.ok(recovered);
		live.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, recovered.details, cwd);
		const replay = new ReadEvidenceStore();
		replay.restoreFromBranch({ cwd, sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "toolResult", toolName: HLEDIT_READ_ANCHORS_TOOL, details: initial.details } },
			{ type: "message", message: { role: "toolResult", toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: recovered.details } },
		] } } as never);
		assert.deepEqual(live.anchorTokens(path), replay.anchorTokens(path));
		assert.equal(live.getProofId(path), replay.getProofId(path));
		if (scenario === "nearby") {
			assert.equal(calls, 1);
			assert.equal(recovered.details.recoveredReads?.[0]?.lines.length, 13);
			assert.ok("proof" in live.selectProof(path, changes, recovered.details.proofId));
		} else if (scenario === "budget") {
			assert.equal(calls, 4);
			assert.equal(recovered.details.error?.code, "proof_recovery_budget_exceeded");
			assert.deepEqual(recovered.details.recoveredReads?.flatMap((read) => read.lines.map((line) => line.line)), [2, 102, 202, 302]);
			assert.match(recovered.content[0]!.text, /Remaining read windows: line 402/);
			const remaining = live.selectProof(path, changes, recovered.details.proofId);
			assert.ok("failure" in remaining);
			assert.deepEqual(remaining.failure.recoveryRanges, [{ start: 402, end: 402 }]);
		} else {
			assert.equal(calls, scenario === "changed-before" ? 1 : 2);
			assert.equal(recovered.details.error?.code, "proof_recovery_source_changed");
			assert.equal(recovered.details.recoveredReads, undefined);
			assert.equal(recovered.details.proofId, undefined);
			assert.equal(live.getProofId(path), undefined);
			assert.doesNotMatch(recovered.content[0]!.text, /\d+#[A-Za-z0-9_-]{3}:/);
		}
	});
}
