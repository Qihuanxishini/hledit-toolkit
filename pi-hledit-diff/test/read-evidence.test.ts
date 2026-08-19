import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import { computeAnchorTag } from "../src/anchor-hash.ts";
import {
	formatReadProofFailure,
	MAX_EVIDENCE_BYTES_PER_FILE,
	MAX_EVIDENCE_RECORDS_PER_FILE,
	ReadEvidenceStore,
} from "../src/read-evidence.ts";
import type { HleditReadMetadata } from "../src/result.ts";
import type { FileChangeParams } from "../src/schema.ts";

const REVISION_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REVISION_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REVISION_D = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const PATH = "/workspace/target.txt";

type ReadMetadataOptions = {
	grep?: string;
	truncated?: boolean;
	totalLines?: number;
};

function readMetadata(
	revision: string,
	lines: Array<{ line: number; anchor: string; text?: string; textTruncated?: boolean }>,
	options: ReadMetadataOptions = {},
): HleditReadMetadata {
	const firstLine = lines[0]?.line;
	const lastLine = lines.at(-1)?.line;
	const grep = options.grep;
	const totalLines = options.totalLines ?? Math.max(lastLine ?? 0, 10);
	const truncated = options.truncated === true;
	return {
		path: "target.txt",
		revision,
		requested: {
			offset: firstLine ?? 1,
			limit: Math.max(1, lines.length),
			...(grep ? { grep } : {}),
		},
		actual: {
			...(firstLine !== undefined ? { firstLine } : {}),
			...(lastLine !== undefined ? { lastLine } : {}),
			lineCount: lines.length,
			totalLines,
		},
		lines: lines.map((line) => ({
			line: line.line,
			anchor: line.anchor,
			text: line.text ?? `line ${line.line}`,
			textTruncated: line.textTruncated === true,
		})),
		truncated,
		...(truncated && lastLine !== undefined ? { nextOffset: lastLine + 1 } : {}),
		textTruncated: lines.some((line) => line.textTruncated === true),
		eof: grep === undefined && !truncated && lastLine === totalLines,
	};
}

function replaceRange(startAnchor: string, endAnchor: string): FileChangeParams["changes"] {
	return [{ operation: "replace_range", start_anchor: startAnchor, end_anchor: endAnchor, lines: ["replacement"] }];
}

// 成功 selection 自 Phase 4 起附带 consumedLines（内部消费行证据）；proof 断言
// 只核对 proof 本身，失败断言保持整体 deepEqual。
function assertProofSelection(
	selection: ReturnType<ReadEvidenceStore["selectProof"]>,
	expected: Record<string, unknown>,
): void {
	if ("proof" in expected) {
		assert.ok("proof" in selection, `expected proof selection, got ${JSON.stringify(selection)}`);
		assert.deepEqual({ proof: selection.proof }, expected);
		return;
	}
	assert.deepEqual(selection, expected);
}

function applyDetails(
	disposition: "succeeded" | "rejected" | "unavailable" | "outcome_unknown",
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { disposition, evidencePath: PATH, ...extra };
}

test("ReadEvidenceStore merges unfiltered windows from the same revision", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 2, anchor: "2#AAA" },
		{ line: 3, anchor: "3#AAB" },
	]));
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 4, anchor: "4#AAC" },
		{ line: 5, anchor: "5#AAD" },
	]));

	const selection = store.selectProof(PATH, replaceRange("2#AAA", "5#AAD"));
	assertProofSelection(selection, {
		proof: {
			revision: REVISION_A,
			anchors: ["2#AAA", "3#AAB", "4#AAC", "5#AAD"],
		},
	});
	// Phase 4.1：成功 selection 返回每个消费行的行号/锚点/文本，供护栏与 change preview 使用。
	assert.ok("proof" in selection);
	assert.deepEqual([...selection.consumedLines.values()], [
		{ line: 2, anchor: "2#AAA", text: "line 2" },
		{ line: 3, anchor: "3#AAB", text: "line 3" },
		{ line: 4, anchor: "4#AAC", text: "line 4" },
		{ line: 5, anchor: "5#AAD", text: "line 5" },
	]);
});

test("ReadEvidenceStore discards prior windows when revision changes", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.recordRead(PATH, readMetadata(REVISION_B, [{ line: 2, anchor: "2#BBB" }]));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "2#BBB"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.reportedMissingLines, [1]);
});

test("grep rows establish partial proof without bridging gaps", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 2, anchor: "2#AAB" },
		{ line: 5, anchor: "5#AAE" },
	], { grep: "line" }));

	assertProofSelection(store.selectProof(PATH, [
		{ operation: "replace_range", start_anchor: "2#AAB", end_anchor: "2#AAB", lines: ["two"] },
		{ operation: "insert_after", anchor: "5#AAE", lines: ["six"] },
	]), {
		proof: { revision: REVISION_A, anchors: ["2#AAB", "5#AAE"] },
	});

	const spanningSelection = store.selectProof(PATH, replaceRange("2#AAB", "5#AAE"));
	assert.ok("failure" in spanningSelection);
	assert.equal(spanningSelection.failure.code, "insufficient_read_proof");
	assert.deepEqual(spanningSelection.failure.reportedMissingLines, [3, 4]);

	const mismatchedAnchor = store.selectProof(PATH, replaceRange("2#ZZZ", "2#ZZZ"));
	assert.ok("failure" in mismatchedAnchor);
	assert.equal(mismatchedAnchor.failure.code, "insufficient_read_proof");
	assert.deepEqual(mismatchedAnchor.failure.reportedMissingLines, [2]);
});

// 同一物理行可被多个 change 引用；每个提交锚点都必须独立验证，不能按行号覆盖。
test("proof validation checks every endpoint submitted for the same line", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAB" }]));

	const selection = store.selectProof(PATH, [
		{ operation: "insert_before", anchor: "2#ZZZ", lines: ["before"] },
		{ operation: "insert_after", anchor: "2#AAB", lines: ["after"] },
	]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.reportedMissingLines, [2]);
	assert.match(selection.failure.message, /submitted anchor for line 2 does not match/);
});

test("grep context merges with unfiltered proof from the same revision", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAB" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 3, anchor: "3#AAC" },
		{ line: 4, anchor: "4#AAD" },
	], { grep: "line" }));

	assertProofSelection(store.selectProof(PATH, replaceRange("2#AAB", "4#AAD")), {
		proof: { revision: REVISION_A, anchors: ["2#AAB", "3#AAC", "4#AAD"] },
	});
});

test("grep pagination records complete rows but excludes text-truncated rows", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 4, anchor: "4#AAD" },
		{ line: 5, anchor: "5#AAE", textTruncated: true },
	], { grep: "line", truncated: true }));

	assert.ok("proof" in store.selectProof(PATH, replaceRange("4#AAD", "4#AAD")));
	const truncatedSelection = store.selectProof(PATH, replaceRange("5#AAE", "5#AAE"));
	assert.ok("failure" in truncatedSelection);
	assert.deepEqual(truncatedSelection.failure.reportedMissingLines, [5]);

	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 6, anchor: "6#AAF" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 6, anchor: "6#AAF", textTruncated: true },
	], { grep: "line" }));
	assert.ok("proof" in store.selectProof(PATH, replaceRange("6#AAF", "6#AAF")));
});

test("empty grep reads invalidate existing proof for that path", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [], { grep: "missing" }));
	const sameRevisionSelection = store.selectProof(PATH, replaceRange("1#AAA", "1#AAA"));
	assert.ok("failure" in sameRevisionSelection);
	assert.deepEqual(sameRevisionSelection.failure.reportedMissingLines, [1]);

	store.recordRead(PATH, readMetadata(REVISION_B, [], { grep: "missing" }));
	const selection = store.selectProof(PATH, replaceRange("1#AAA", "1#AAA"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.reportedMissingLines, [1]);
});

test("oversized ranges fail without enumerating every requested line", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "9007199254740991#BBB"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.reportedMissingLines, Array.from({ length: 20 }, (_, index) => index + 2));
	assert.deepEqual(selection.failure.proofGap, {
		start: 2,
		end: 9007199254740991,
		changeNumber: 1,
		operation: "replace_range",
		requiredStart: 1,
		requiredEnd: 9007199254740991,
	});
	assert.match(selection.failure.message, /missing lines 2-9007199254740991/);
	assert.doesNotMatch(selection.failure.message, /first 20/);
	const guidance = formatReadProofFailure("target.txt", selection.failure);
	assert.match(guidance, /offset: 1, limit: 2000/);
	assert.match(guidance, /then continue with nextOffset until line 9007199254740991 is covered/);
});

test("proof failure guidance covers the complete first missing range", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 3, anchor: "3#AAA" }]));

	const selection = store.selectProof(PATH, [
		{ operation: "replace_range", start_anchor: "3#AAA", end_anchor: "3#AAA", lines: ["three"] },
		{ operation: "replace_range", start_anchor: "387#BBB", end_anchor: "415#CCC", lines: ["section"] },
	]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.reportedMissingLines, Array.from({ length: 20 }, (_, index) => index + 387));
	assert.deepEqual(selection.failure.proofGap, {
		start: 387,
		end: 415,
		changeNumber: 2,
		operation: "replace_range",
		requiredStart: 387,
		requiredEnd: 415,
	});
	assert.match(selection.failure.message, /Change 2 \(replace_range 387-415\)/);
	assert.match(formatReadProofFailure("target.txt", selection.failure), /offset: 385, limit: 33/);
});

// [喵喵喵]: 一次补读覆盖同一 change 的全部未读跨度，避免 sparse evidence
// 造成多轮 apply → 补读循环。(2026-07-28)
test("proof guidance covers every unresolved gap in the affected change", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: "1#AAA" },
		{ line: 10, anchor: "10#AAB" },
		{ line: 20, anchor: "20#AAC" },
	], { grep: "line" }));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "20#AAC"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.proofGap, {
		start: 2,
		end: 9,
		changeNumber: 1,
		operation: "replace_range",
		requiredStart: 1,
		requiredEnd: 20,
	});
	assert.deepEqual(selection.failure.suggestedReadRange, { start: 2, end: 19 });
	assert.match(formatReadProofFailure("target.txt", selection.failure), /offset: 1, limit: 21/);
});

test("proof gap keeps the original change number when changes are out of file order", () => {
	const store = new ReadEvidenceStore();
	const selection = store.selectProof(PATH, [
		{ operation: "replace_range", start_anchor: "10#AAA", end_anchor: "20#AAB", lines: ["later"] },
		{ operation: "delete_range", start_anchor: "1#AAC", end_anchor: "9#AAD" },
	]);

	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.proofGap, {
		start: 1,
		end: 9,
		changeNumber: 2,
		operation: "delete_range",
		requiredStart: 1,
		requiredEnd: 9,
	});
	assert.deepEqual(selection.failure.reportedMissingLines, Array.from({ length: 9 }, (_, index) => index + 1));
	assert.deepEqual(selection.failure.suggestedReadRange, { start: 1, end: 9 });
});

test("proof recovery prefers a spanning range over a boundary insert", () => {
	const store = new ReadEvidenceStore();
	const selection = store.selectProof(PATH, [
		{ operation: "insert_before", anchor: "2#AAA", lines: ["prefix"] },
		{ operation: "replace_range", start_anchor: "2#AAA", end_anchor: "5#AAB", lines: ["body"] },
	]);

	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.proofGap, {
		start: 2,
		end: 5,
		changeNumber: 2,
		operation: "replace_range",
		requiredStart: 2,
		requiredEnd: 5,
	});
	assert.deepEqual(selection.failure.reportedMissingLines, [2, 3, 4, 5]);
	assert.deepEqual(selection.failure.suggestedReadRange, { start: 2, end: 5 });
});

test("proof failure identifies the affected operation and continuous gap in a disjoint batch", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 9, anchor: "9#AAA" },
		...Array.from({ length: 9 }, (_, index) => ({ line: 138 + index, anchor: `${138 + index}#AAA` })),
		{ line: 263, anchor: "263#AAA" },
		...Array.from({ length: 21 }, (_, index) => ({ line: 1044 + index, anchor: `${1044 + index}#AAA` })),
	], { grep: "line" }));

	const selection = store.selectProof(PATH, [
		{ operation: "insert_after", anchor: "9#AAA", lines: ["inserted"] },
		{ operation: "replace_range", start_anchor: "138#AAA", end_anchor: "263#AAA", lines: ["section"] },
		{ operation: "delete_range", start_anchor: "1044#AAA", end_anchor: "1064#AAA" },
	]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.proofGap, {
		start: 147,
		end: 262,
		changeNumber: 2,
		operation: "replace_range",
		requiredStart: 138,
		requiredEnd: 263,
	});
	assert.equal(
		selection.failure.message,
		"Change 2 (replace_range 138-263) requires complete read proof for every source line in the inclusive range; missing lines 147-262. Endpoint anchors alone are insufficient.",
	);
	const guidance = formatReadProofFailure("target.txt", selection.failure);
	assert.match(guidance, /offset: 145, limit: 120/);
	assert.match(guidance, /resubmit the original hledit_apply_file_changes call/);
	assert.doesNotMatch(guidance, /147, 148, 149/);
});

// [喵喵喵]: proof failure 正文锁定首个受影响 change、连续缺口和下一步补读，
// 防止模型把最多 20 个 details 行号误当作完整缺口。(2026-07-28)
test("model body snapshot: plugin-side proof failure with targeted reread", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 3, anchor: "3#AAA" }]));

	const selection = store.selectProof(PATH, replaceRange("3#AAA", "5#CCC"));
	assert.ok("failure" in selection);
	assert.equal(
		formatReadProofFailure("target.txt", selection.failure),
		"Valid read proof does not cover every source line required by this change. Batch was not started and no content was written.\n" +
		"Reason: Change 1 (replace_range 3-5) requires complete read proof for every source line in the inclusive range; missing lines 4-5. Endpoint anchors alone are insufficient.\n" +
		'Call hledit_read_anchors({ path: "target.txt", offset: 2, limit: 12 }) first and confirm all required source lines for change 1 through line 5.\n' +
		"After the read succeeds, resubmit the original hledit_apply_file_changes call.",
	);
});

test("successful apply replaces old evidence with updated anchors", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		updatedAnchors: {
			lines: [{ line: 4, anchor: "4#BBB", text: "changed", textTruncated: false }],
			offset: 4,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]));
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: "4#BBB", lines: ["next"] }]), {
		proof: { revision: REVISION_B, anchors: ["4#BBB"] },
	});
});

test("uncertain apply invalidates evidence while a local rejection preserves it", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: { code: "single_line_range_expansion", message: "local guard" },
	}), "/workspace");
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]));

	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("outcome_unknown"), "/workspace");
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]));
});

test("an unavailable apply keeps evidence because the target was never written", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("unavailable"), "/workspace");
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]), {
		proof: { revision: REVISION_A, anchors: ["1#AAA"] },
	});
});

test("failed read calls preserve existing evidence", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, {
		disposition: "rejected",
		evidencePath: PATH,
		error: { code: "range", message: "outside file" },
	}, "/workspace");
	store.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, {
		disposition: "unavailable",
		evidencePath: PATH,
	}, "/workspace");

	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]), {
		proof: { revision: REVISION_A, anchors: ["1#AAA"] },
	});
});

test("a same-revision no-op apply merges its window instead of shrinking evidence", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: "1#AAA" },
		{ line: 2, anchor: "2#AAB" },
		{ line: 3, anchor: "3#AAC" },
		{ line: 4, anchor: "4#AAD" },
		{ line: 5, anchor: "5#AAE" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_A,
		contentChanged: false,
		updatedAnchors: {
			lines: [{ line: 3, anchor: "3#AAC", text: "line 3", textTruncated: false }],
			offset: 3,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	// 远离窗口的旧证据在同 revision 下仍然字节级有效，必须保留。
	assertProofSelection(store.selectProof(PATH, replaceRange("1#AAA", "2#AAB")), {
		proof: { revision: REVISION_A, anchors: ["1#AAA", "2#AAB"] },
	});
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: "5#AAE", lines: ["next"] }]), {
		proof: { revision: REVISION_A, anchors: ["5#AAE"] },
	});
});

test("complete stale context becomes evidence for its current revision", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: {
			code: "stale",
			message: "stale",
			currentRevision: REVISION_B,
			currentAnchors: {
				lines: [
					{ line: 2, anchor: "2#BBB", text: "changed", textTruncated: false },
					{ line: 3, anchor: "3#BBC", text: "three", textTruncated: false },
				],
				offset: 2,
				limit: 2,
				desiredLimit: 2,
				truncated: false,
			},
		},
	}), "/workspace");

	assertProofSelection(store.selectProof(PATH, replaceRange("2#BBB", "3#BBC")), {
		proof: { revision: REVISION_B, anchors: ["2#BBB", "3#BBC"] },
	});
});


test("a same-revision stale rejection preserves existing evidence when its snapshot is truncated", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: {
			code: "stale",
			message: "stale",
			currentRevision: REVISION_A,
			currentAnchors: {
				lines: [{ line: 2, anchor: "2#AAA", text: "line 2", textTruncated: false }],
				offset: 2,
				limit: 1,
				desiredLimit: 2,
				truncated: true,
			},
		},
	}), "/workspace");

	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "2#AAA", lines: ["x"] }]));
});

test("truncated stale context invalidates old evidence without creating new proof", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: {
			code: "stale",
			message: "stale",
			currentRevision: REVISION_B,
			currentAnchors: {
				lines: [{ line: 2, anchor: "2#BBB", text: "changed", textTruncated: false }],
				offset: 2,
				limit: 1,
				desiredLimit: 2,
				truncated: true,
			},
		},
	}), "/workspace");

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "2#BBB", lines: ["next"] }]));
});

test("branch restoration replays only tool results present on the current branch", () => {
	const read = readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }], { grep: "one" });
	const readEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: HLEDIT_READ_ANCHORS_TOOL,
			details: { disposition: "succeeded", evidencePath: PATH, read },
		},
	};
	const failedReadEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: HLEDIT_READ_ANCHORS_TOOL,
			details: { disposition: "rejected", evidencePath: PATH, error: { code: "range", message: "outside file" } },
		},
	};
	const store = new ReadEvidenceStore();
	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: { getBranch: () => [readEntry, failedReadEntry] },
	} as never);
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]));

	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => [
				readEntry,
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL,
						details: applyDetails("outcome_unknown"),
					},
				},
			],
		},
	} as never);
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["next"] }]));
});

test("branch restoration replays targeted proof recovered by a rejected apply", () => {
	const recoveredRead = readMetadata(REVISION_A, [{ line: 2, anchor: "2#BBB" }], { truncated: true });
	const store = new ReadEvidenceStore();
	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => [{
				type: "message",
				message: {
					role: "toolResult",
					toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL,
					details: applyDetails("rejected", {
						path: "target.txt",
						error: { code: "insufficient_read_proof", message: "read recovered" },
						recoveredRead,
					}),
				},
			}],
		},
	} as never);

	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: "2#BBB", lines: ["next"] }]), {
		proof: { revision: REVISION_A, anchors: ["2#BBB"] },
	});
});

test("malformed recovered reads do not restore proof", () => {
	const recoveredRead = readMetadata(REVISION_A, [{ line: 2, anchor: "2#BBB" }], { truncated: true });
	const store = new ReadEvidenceStore();
	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => [{
				type: "message",
				message: {
					role: "toolResult",
					toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL,
					details: applyDetails("rejected", {
						path: "target.txt",
						error: { code: "insufficient_read_proof", message: "malformed" },
						recoveredRead: { ...recoveredRead, lines: [{}] },
					}),
				},
			}],
		},
	} as never);
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "2#BBB", lines: ["next"] }]));
});

test("path-mismatched recovered reads do not restore proof", () => {
	const store = new ReadEvidenceStore();
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		path: "other.txt",
		error: { code: "insufficient_read_proof", message: "mismatched" },
		recoveredRead: readMetadata(REVISION_A, [{ line: 2, anchor: "2#BBB" }], { truncated: true }),
	}), "/workspace");
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "2#BBB", lines: ["next"] }]));
});

test("a successful apply remaps out-of-range evidence to shifted line numbers", () => {
	const store = new ReadEvidenceStore();
	const texts = new Map<number, string>([
		[1, "alpha"],
		[2, "bravo"],
		[3, "charlie"],
		[4, ""],
		[5, "echo"],
	]);
	store.recordRead(PATH, readMetadata(REVISION_A, [...texts].map(([line, text]) => ({
		line,
		anchor: computeAnchorTag(line, text),
		text,
	}))));

	// 第 2 行替换为两行：行 3-5 平移 +1；结构行（旧行 4 空行）hash 也随行号重算。
	const newWindowLines = [
		{ line: 2, anchor: computeAnchorTag(2, "BRAVO-1"), text: "BRAVO-1", textTruncated: false },
		{ line: 3, anchor: computeAnchorTag(3, "BRAVO-2"), text: "BRAVO-2", textTruncated: false },
	];
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 1 }],
		updatedAnchors: { lines: newWindowLines, offset: 2, limit: 2, desiredLimit: 2, truncated: false },
	}), "/workspace");

	// 未受影响的行 1 原样保留；旧行 3/5 平移到 4/6；旧行 4（空行，结构行）hash 重算。
	const shiftedCharlie = computeAnchorTag(4, "charlie");
	const shiftedBlank = computeAnchorTag(5, "");
	const shiftedEcho = computeAnchorTag(6, "echo");
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: computeAnchorTag(1, "alpha"), lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [computeAnchorTag(1, "alpha")] },
	});
	assertProofSelection(store.selectProof(PATH, replaceRange(shiftedCharlie, shiftedBlank)), {
		proof: { revision: REVISION_B, anchors: [shiftedCharlie, shiftedBlank] },
	});
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: shiftedEcho, lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [shiftedEcho] },
	});
	// 窗口行与平移行同处一份证据。
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: newWindowLines[0]!.anchor, lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [newWindowLines[0]!.anchor] },
	});
});

test("submitting a pre-edit anchor uses a verified rename without rereading", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "alpha"), text: "alpha" },
		{ line: 2, anchor: computeAnchorTag(2, "bravo"), text: "bravo" },
		{ line: 3, anchor: computeAnchorTag(3, "charlie"), text: "charlie" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: computeAnchorTag(2, "BRAVO-1"), text: "BRAVO-1", textTruncated: false },
				{ line: 3, anchor: computeAnchorTag(3, "BRAVO-2"), text: "BRAVO-2", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");

	// 模型提交编辑前的旧行 3 锚点：唯一更名且完整 proof 仍成立时直接规范化。
	const staleAnchor = computeAnchorTag(3, "charlie");
	const renamedAnchor = computeAnchorTag(4, "charlie");
	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: staleAnchor, lines: ["x"] }]);
	assert.ok("proof" in selection);
	assert.deepEqual(selection.proof, { revision: REVISION_B, anchors: [renamedAnchor] });
	assert.deepEqual(selection.normalizedChanges, [{ operation: "insert_after", anchor: renamedAnchor, lines: ["x"] }]);
	assert.deepEqual(selection.renamedAnchors, [{ requested: staleAnchor, current: renamedAnchor }]);
});

test("a rename hint does not hide an unrelated proof gap in the same batch", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "alpha"), text: "alpha" },
		{ line: 2, anchor: computeAnchorTag(2, "bravo"), text: "bravo" },
		{ line: 3, anchor: computeAnchorTag(3, "charlie"), text: "charlie" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: computeAnchorTag(2, "BRAVO-1"), text: "BRAVO-1", textTruncated: false },
				{ line: 3, anchor: computeAnchorTag(3, "BRAVO-2"), text: "BRAVO-2", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");

	// 同一批次：一个可由更名解释的旧锚点 + 一个从未读取的远端范围。
	// 纯更名指引会诱导一次注定失败的重提交；必须同时给出剩余缺口的定向重读。
	const staleAnchor = computeAnchorTag(3, "charlie");
	const renamedAnchor = computeAnchorTag(4, "charlie");
	const selection = store.selectProof(PATH, [
		{ operation: "insert_after", anchor: staleAnchor, lines: ["x"] },
		{ operation: "replace_range", start_anchor: computeAnchorTag(8, "hotel"), end_anchor: computeAnchorTag(9, "india"), lines: ["y"] },
	]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.renamedAnchors, [{ requested: staleAnchor, current: renamedAnchor }]);
	// 剩余缺口按更名替换后的坐标计算，不包含已被更名解释的旧区间。
	assert.deepEqual(selection.failure.reportedMissingLines, [8, 9]);
	assert.deepEqual(selection.failure.suggestedReadRange, { start: 8, end: 9 });

	const formatted = formatReadProofFailure("target.txt", selection.failure);
	assert.match(formatted, new RegExp(`${staleAnchor} -> ${renamedAnchor}`));
	assert.match(formatted, /required but not sufficient/);
	assert.match(formatted, /offset: 6, limit: 12/);
	assert.doesNotMatch(formatted, /Resubmit after replacing every renamed anchor with its current form, or reread the range/);
	assert.match(formatted, /resubmit the original hledit_apply_file_changes call with every listed anchor rename applied/);
});

test("verified rename chains normalize to the latest anchor", () => {
	const REVISION_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "alpha"), text: "alpha" },
		{ line: 2, anchor: computeAnchorTag(2, "bravo"), text: "bravo" },
		{ line: 3, anchor: computeAnchorTag(3, "charlie"), text: "charlie" },
	]));
	// 编辑 1：第 2 行替换为两行（charlie 3 -> 4）。
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: computeAnchorTag(2, "BRAVO-1"), text: "BRAVO-1", textTruncated: false },
				{ line: 3, anchor: computeAnchorTag(3, "BRAVO-2"), text: "BRAVO-2", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");
	// 编辑 2：文件顶部插入一行（charlie 4 -> 5）。
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_C,
		editDeltas: [{ oldStart: 1, oldEnd: 0, delta: 1 }],
		updatedAnchors: {
			lines: [{ line: 1, anchor: computeAnchorTag(1, "HEADER"), text: "HEADER", textTruncated: false }],
			offset: 1,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	// 提交最早一轮读取的锚点：唯一更名链直接规范化到最新名字。
	const oldestAnchor = computeAnchorTag(3, "charlie");
	const latestAnchor = computeAnchorTag(5, "charlie");
	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: oldestAnchor, lines: ["x"] }]);
	assert.ok("proof" in selection);
	assert.deepEqual(selection.proof, { revision: REVISION_C, anchors: [latestAnchor] });
	assert.deepEqual(selection.normalizedChanges, [{ operation: "insert_after", anchor: latestAnchor, lines: ["x"] }]);
	assert.deepEqual(selection.renamedAnchors, [{ requested: oldestAnchor, current: latestAnchor }]);

	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: latestAnchor, lines: ["x"] }]), {
		proof: { revision: REVISION_C, anchors: [latestAnchor] },
	});
});

test("evidence consumed by the edit is dropped and never remapped", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "alpha"), text: "alpha" },
		{ line: 2, anchor: computeAnchorTag(2, "bravo"), text: "bravo" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 0 }],
		updatedAnchors: {
			lines: [{ line: 2, anchor: computeAnchorTag(2, "BRAVO"), text: "BRAVO", textTruncated: false }],
			offset: 2,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	// 旧行 2 的证据必须被窗口的新内容取代，而不是把旧锚点平移过来。
	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: computeAnchorTag(2, "bravo"), lines: ["x"] }]);
	assert.ok("failure" in selection);
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: computeAnchorTag(2, "BRAVO"), lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [computeAnchorTag(2, "BRAVO")] },
	});
});

test("a success without edit deltas falls back to window-only evidence", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "alpha"), text: "alpha" },
		{ line: 9, anchor: computeAnchorTag(9, "iota"), text: "iota" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		updatedAnchors: {
			lines: [{ line: 1, anchor: computeAnchorTag(1, "ALPHA"), text: "ALPHA", textTruncated: false }],
			offset: 1,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: computeAnchorTag(9, "iota"), lines: ["x"] }]));
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: computeAnchorTag(1, "ALPHA"), lines: ["x"] }]));
});


test("reused rename tokens are rejected until an explicit read establishes current identity", () => {
	const store = new ReadEvidenceStore();
	const beforeAnchor = computeAnchorTag(1, "before");
	const reusedAnchor = computeAnchorTag(2, "needle");
	const shiftedAnchor = computeAnchorTag(3, "needle");
	const afterAnchor = computeAnchorTag(3, "after");
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: beforeAnchor, text: "before" },
		{ line: 2, anchor: reusedAnchor, text: "needle" },
		{ line: 3, anchor: afterAnchor, text: "after" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 1, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: reusedAnchor, text: "needle", textTruncated: false },
				{ line: 3, anchor: shiftedAnchor, text: "needle", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");

	const ambiguous = store.selectProof(PATH, [{ operation: "insert_after", anchor: reusedAnchor, lines: ["x"] }]);
	assert.ok("failure" in ambiguous);
	assert.match(ambiguous.failure.message, /lost its unique identity after a verified edit/);
	assert.equal(ambiguous.failure.renamedAnchors, undefined);
	assert.match(formatReadProofFailure("target.txt", ambiguous.failure), /Explicitly reread the target/);
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: shiftedAnchor, lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [shiftedAnchor] },
	});

	store.recordRead(PATH, readMetadata(REVISION_B, [{ line: 2, anchor: reusedAnchor, text: "needle" }]));
	assertProofSelection(store.selectProof(PATH, [{ operation: "insert_after", anchor: reusedAnchor, lines: ["x"] }]), {
		proof: { revision: REVISION_B, anchors: [reusedAnchor] },
	});
});


test("a consumed token reused by a shifted duplicate is rejected until reread", () => {
	const store = new ReadEvidenceStore();
	const consumedAnchor = computeAnchorTag(2, "needle");
	const duplicateAnchor = computeAnchorTag(3, "needle");
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 2, anchor: consumedAnchor, text: "needle" },
		{ line: 3, anchor: duplicateAnchor, text: "needle" },
	]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: -1 }],
		updatedAnchors: {
			lines: [{ line: 2, anchor: consumedAnchor, text: "needle", textTruncated: false }],
			offset: 2,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	const ambiguous = store.selectProof(PATH, [{ operation: "insert_after", anchor: consumedAnchor, lines: ["x"] }]);
	assert.ok("failure" in ambiguous);
	assert.match(ambiguous.failure.message, /lost its unique identity after a verified edit/);

	store.recordRead(PATH, readMetadata(REVISION_B, [{ line: 2, anchor: consumedAnchor, text: "needle" }]));
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: consumedAnchor, lines: ["x"] }]));
});


test("a consumed rename alias stays ambiguous across delayed token reuse", () => {
	const store = new ReadEvidenceStore();
	const originalAnchor = computeAnchorTag(2, "needle");
	const shiftedAnchor = computeAnchorTag(3, "needle");
	const insertedAnchor = computeAnchorTag(2, "inserted");
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "before"), text: "before" },
		{ line: 2, anchor: originalAnchor, text: "needle" },
		{ line: 3, anchor: computeAnchorTag(3, "after"), text: "after" },
	]));

	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 1, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: insertedAnchor, text: "inserted", textTruncated: false },
				{ line: 3, anchor: shiftedAnchor, text: "needle", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_C,
		editDeltas: [{ oldStart: 3, oldEnd: 3, delta: -1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: insertedAnchor, text: "inserted", textTruncated: false },
				{ line: 3, anchor: computeAnchorTag(3, "after"), text: "after", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_D,
		editDeltas: [{ oldStart: 2, oldEnd: 2, delta: 0 }],
		updatedAnchors: {
			lines: [{ line: 2, anchor: originalAnchor, text: "needle", textTruncated: false }],
			offset: 2,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: originalAnchor, lines: ["x"] }]));
	store.recordRead(PATH, readMetadata(REVISION_D, [{ line: 2, anchor: originalAnchor, text: "needle" }]));
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: originalAnchor, lines: ["x"] }]));
});

test("branch replay reconstructs reused-token ambiguity", () => {
	const reusedAnchor = computeAnchorTag(2, "needle");
	const shiftedAnchor = computeAnchorTag(3, "needle");
	const read = readMetadata(REVISION_A, [
		{ line: 1, anchor: computeAnchorTag(1, "before"), text: "before" },
		{ line: 2, anchor: reusedAnchor, text: "needle" },
		{ line: 3, anchor: computeAnchorTag(3, "after"), text: "after" },
	], { truncated: true });
	const apply = applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 2, oldEnd: 1, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: 2, anchor: reusedAnchor, text: "needle", textTruncated: false },
				{ line: 3, anchor: shiftedAnchor, text: "needle", textTruncated: false },
			],
			offset: 2,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	});
	const store = new ReadEvidenceStore();
	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "toolResult", toolName: HLEDIT_READ_ANCHORS_TOOL, details: { disposition: "succeeded", evidencePath: PATH, read } } },
				{ type: "message", message: { role: "toolResult", toolName: HLEDIT_APPLY_FILE_CHANGES_TOOL, details: apply } },
			],
		},
	} as never);

	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: reusedAnchor, lines: ["x"] }]);
	assert.ok("failure" in selection);
	assert.match(selection.failure.message, /lost its unique identity after a verified edit/);
});

test("a differing currentRevision invalidates evidence while a same-revision rejection preserves it", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: { code: "invalid", message: "zero write", currentRevision: REVISION_A },
	}), "/workspace");
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));

	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: { code: "invalid", message: "zero write", currentRevision: REVISION_B },
	}), "/workspace");
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
});

test("source_changed_before_commit invalidates evidence even when its revision matches", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("rejected", {
		error: { code: "source_changed_before_commit", message: "changed", currentRevision: REVISION_A },
	}), "/workspace");
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
});

test("per-file record overflow keeps only the triggering fresh window", () => {
	const store = new ReadEvidenceStore();
	const oldLines = Array.from({ length: MAX_EVIDENCE_RECORDS_PER_FILE - 1 }, (_, index) => ({
		line: index + 1,
		anchor: `${index + 1}#AAA`,
	}));
	store.recordRead(PATH, readMetadata(REVISION_A, oldLines));
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: MAX_EVIDENCE_RECORDS_PER_FILE, anchor: `${MAX_EVIDENCE_RECORDS_PER_FILE}#AAB` },
		{ line: MAX_EVIDENCE_RECORDS_PER_FILE + 1, anchor: `${MAX_EVIDENCE_RECORDS_PER_FILE + 1}#AAC` },
	]));

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
	assertProofSelection(store.selectProof(PATH, replaceRange(
		`${MAX_EVIDENCE_RECORDS_PER_FILE}#AAB`,
		`${MAX_EVIDENCE_RECORDS_PER_FILE + 1}#AAC`,
	)), {
		proof: {
			revision: REVISION_A,
			anchors: [`${MAX_EVIDENCE_RECORDS_PER_FILE}#AAB`, `${MAX_EVIDENCE_RECORDS_PER_FILE + 1}#AAC`],
		},
	});
});


test("updated-anchor overflow cannot erase a reused-token ambiguity", () => {
	const store = new ReadEvidenceStore();
	const originalLine = MAX_EVIDENCE_RECORDS_PER_FILE - 1;
	const lines = Array.from({ length: originalLine }, (_, index) => {
		const line = index + 1;
		const text = line === originalLine ? "needle" : `line ${line}`;
		return { line, anchor: computeAnchorTag(line, text), text };
	});
	const reusedAnchor = computeAnchorTag(originalLine, "needle");
	const shiftedAnchor = computeAnchorTag(originalLine + 1, "needle");
	store.recordRead(PATH, readMetadata(REVISION_A, lines));

	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: originalLine, oldEnd: originalLine - 1, delta: 1 }],
		updatedAnchors: {
			lines: [
				{ line: originalLine, anchor: reusedAnchor, text: "needle", textTruncated: false },
				{ line: originalLine + 1, anchor: shiftedAnchor, text: "needle", textTruncated: false },
			],
			offset: originalLine,
			limit: 2,
			desiredLimit: 2,
			truncated: false,
		},
	}), "/workspace");

	// 容量降级不能把 updatedAnchors 误当成显式重读，否则旧 token 会重新获得当前语义。
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: reusedAnchor, lines: ["x"] }]));
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: shiftedAnchor, lines: ["x"] }]));

	store.recordRead(PATH, readMetadata(REVISION_B, [
		{ line: originalLine, anchor: reusedAnchor, text: "needle" },
	]));
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: reusedAnchor, lines: ["x"] }]));
});


test("remap overflow cannot be repopulated from updated anchors", () => {
	const store = new ReadEvidenceStore();
	const lineCount = 6_000;
	const lines = Array.from({ length: lineCount }, (_, index) => {
		const line = index + 1;
		const text = `line ${line}`;
		return { line, anchor: computeAnchorTag(line, text), text };
	});
	const insertedAnchor = computeAnchorTag(1, "header");
	store.recordRead(PATH, readMetadata(REVISION_A, lines));
	store.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, applyDetails("succeeded", {
		revision: REVISION_B,
		editDeltas: [{ oldStart: 1, oldEnd: 0, delta: 1 }],
		updatedAnchors: {
			lines: [{ line: 1, anchor: insertedAnchor, text: "header", textTruncated: false }],
			offset: 1,
			limit: 1,
			desiredLimit: 1,
			truncated: false,
		},
	}), "/workspace");

	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: insertedAnchor, lines: ["x"] }]));
	store.recordRead(PATH, readMetadata(REVISION_B, [{ line: 1, anchor: insertedAnchor, text: "header" }]));
	assert.ok("proof" in store.selectProof(PATH, [{ operation: "insert_after", anchor: insertedAnchor, lines: ["x"] }]));
});

test("an oversized UTF-8 fresh window leaves no evidence", () => {
	const store = new ReadEvidenceStore();
	const oversizedText = "界".repeat(Math.floor(MAX_EVIDENCE_BYTES_PER_FILE / 3) + 1);
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA", text: oversizedText }]));
	assert.ok("failure" in store.selectProof(PATH, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
});

test("session record overflow evicts whole files deterministically in tool-result order", () => {
	const lineCount = 9_000;
	const reads = Array.from({ length: 6 }, (_, fileIndex) => {
		const path = `/workspace/target-${fileIndex}.txt`;
		const lines = Array.from({ length: lineCount }, (_, index) => ({ line: index + 1, anchor: `${index + 1}#AAA` }));
		return { path, read: readMetadata(REVISION_A, lines, { totalLines: lineCount }) };
	});
	const assertEvictionState = (store: ReadEvidenceStore) => {
		assert.ok("failure" in store.selectProof(reads[0]!.path, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
		assert.ok("proof" in store.selectProof(reads[1]!.path, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
		assert.ok("proof" in store.selectProof(reads[5]!.path, [{ operation: "insert_after", anchor: "1#AAA", lines: ["x"] }]));
	};

	const live = new ReadEvidenceStore();
	for (const entry of reads) live.recordRead(entry.path, entry.read);
	assertEvictionState(live);

	const replayed = new ReadEvidenceStore();
	replayed.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => reads.map((entry) => ({
				type: "message",
				message: {
					role: "toolResult",
					toolName: HLEDIT_READ_ANCHORS_TOOL,
					details: { disposition: "succeeded", evidencePath: entry.path, read: entry.read },
				},
			})),
		},
	} as never);
	assertEvictionState(replayed);
});
