import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import { computeAnchorTag } from "../src/anchor-hash.ts";
import { formatReadProofFailure, ReadEvidenceStore } from "../src/read-evidence.ts";
import type { HleditReadMetadata } from "../src/result.ts";
import type { FileChangeParams } from "../src/schema.ts";

const REVISION_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATH = "/workspace/target.txt";

type ReadMetadataOptions = {
	grep?: string;
	truncated?: boolean;
};

function readMetadata(
	revision: string,
	lines: Array<{ line: number; anchor: string; text?: string; textTruncated?: boolean }>,
	options: ReadMetadataOptions = {},
): HleditReadMetadata {
	const firstLine = lines[0]?.line;
	const lastLine = lines.at(-1)?.line;
	const truncated = options.truncated === true;
	return {
		path: "target.txt",
		revision,
		requested: {
			offset: firstLine ?? 1,
			limit: Math.max(1, lines.length),
			...(options.grep ? { grep: options.grep } : {}),
		},
		actual: {
			...(firstLine !== undefined ? { firstLine } : {}),
			...(lastLine !== undefined ? { lastLine } : {}),
			lineCount: lines.length,
			totalLines: Math.max(lastLine ?? 0, 10),
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
		eof: false,
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
	assert.deepEqual(selection.failure.missingLines, [1]);
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
	assert.deepEqual(spanningSelection.failure.missingLines, [3, 4]);

	const mismatchedAnchor = store.selectProof(PATH, replaceRange("2#ZZZ", "2#ZZZ"));
	assert.ok("failure" in mismatchedAnchor);
	assert.equal(mismatchedAnchor.failure.code, "insufficient_read_proof");
	assert.deepEqual(mismatchedAnchor.failure.missingLines, [2]);
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
	assert.deepEqual(truncatedSelection.failure.missingLines, [5]);

	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 6, anchor: "6#AAF" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [
		{ line: 6, anchor: "6#AAF", textTruncated: true },
	], { grep: "line" }));
	assert.ok("proof" in store.selectProof(PATH, replaceRange("6#AAF", "6#AAF")));
});

test("empty grep reads preserve same-revision proof and discard stale revisions", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [], { grep: "missing" }));
	assert.ok("proof" in store.selectProof(PATH, replaceRange("1#AAA", "1#AAA")));

	store.recordRead(PATH, readMetadata(REVISION_B, [], { grep: "missing" }));
	const selection = store.selectProof(PATH, replaceRange("1#AAA", "1#AAA"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.missingLines, [1]);
});

test("oversized ranges fail without enumerating every requested line", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "9007199254740991#BBB"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.missingLines, Array.from({ length: 20 }, (_, index) => index + 2));
	assert.match(selection.failure.message, /only the first 20 are listed/);
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
	assert.deepEqual(selection.failure.missingLines, Array.from({ length: 20 }, (_, index) => index + 387));
	assert.match(formatReadProofFailure("target.txt", selection.failure), /offset: 385, limit: 33/);
});

// [喵喵喵]: Phase 0 正文 snapshot——精确锁定插件侧 proof failure 的完整拒绝正文，
// 后续正文压缩必须显式更新该基线 (2026-07-25)
test("model body snapshot: plugin-side proof failure with targeted reread", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 3, anchor: "3#AAA" }]));

	const selection = store.selectProof(PATH, replaceRange("3#AAA", "5#CCC"));
	assert.ok("failure" in selection);
	assert.equal(
		formatReadProofFailure("target.txt", selection.failure),
		"Valid read proof does not cover every source line required by this change. Batch was not started and no content was written.\n" +
		"Reason: Read proof is missing lines 4, 5.\n" +
		'Call hledit_read_anchors({ path: "target.txt", offset: 2, limit: 12 }) first, confirm the complete target range, then submit the change.',
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
	const store = new ReadEvidenceStore();
	store.restoreFromBranch({
		cwd: "/workspace",
		sessionManager: { getBranch: () => [readEntry] },
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

test("submitting a pre-edit anchor yields a verified rename hint instead of a blind reread", () => {
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

	// 模型仍提交编辑前的旧行 3 锚点：失败必须直接给出已验证的新锚点。
	const staleAnchor = computeAnchorTag(3, "charlie");
	const renamedAnchor = computeAnchorTag(4, "charlie");
	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: staleAnchor, lines: ["x"] }]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.renamedAnchors, [{ requested: staleAnchor, current: renamedAnchor }]);

	const formatted = formatReadProofFailure("target.txt", selection.failure);
	assert.match(formatted, new RegExp(`${staleAnchor} -> ${renamedAnchor}`));
	assert.match(formatted, /Resubmit after replacing every renamed anchor/);
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
	assert.equal(selection.failure.renamesRestoreProof, undefined);
	// 剩余缺口按更名替换后的坐标计算，不包含已被更名解释的旧区间。
	assert.deepEqual(selection.failure.missingLines, [8, 9]);
	assert.deepEqual(selection.failure.suggestedReadRange, { start: 8, end: 9 });

	const formatted = formatReadProofFailure("target.txt", selection.failure);
	assert.match(formatted, new RegExp(`${staleAnchor} -> ${renamedAnchor}`));
	assert.match(formatted, /required but not sufficient/);
	assert.match(formatted, /offset: 6, limit: 12/);
	assert.doesNotMatch(formatted, /Resubmit after replacing every renamed anchor with its current form, or reread the range/);
});

test("rename hints chain across two successive edits back to the oldest anchor", () => {
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

	// 提交最早一轮读取的锚点：更名表必须链到最新名字，替换后即可通过。
	const oldestAnchor = computeAnchorTag(3, "charlie");
	const latestAnchor = computeAnchorTag(5, "charlie");
	const selection = store.selectProof(PATH, [{ operation: "insert_after", anchor: oldestAnchor, lines: ["x"] }]);
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.renamedAnchors, [{ requested: oldestAnchor, current: latestAnchor }]);
	assert.equal(selection.failure.renamesRestoreProof, true);
	assert.match(formatReadProofFailure("target.txt", selection.failure), /Resubmit after replacing every renamed anchor/);

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
