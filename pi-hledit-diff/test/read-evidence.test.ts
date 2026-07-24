import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
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
	lines: Array<{ line: number; anchor: string; textTruncated?: boolean }>,
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
			text: `line ${line.line}`,
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

	assert.deepEqual(store.selectProof(PATH, replaceRange("2#AAA", "5#AAD")), {
		proof: {
			revision: REVISION_A,
			anchors: ["2#AAA", "3#AAB", "4#AAC", "5#AAD"],
		},
	});
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

	assert.deepEqual(store.selectProof(PATH, [
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

	assert.deepEqual(store.selectProof(PATH, replaceRange("2#AAB", "4#AAD")), {
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
	assert.deepEqual(store.selectProof(PATH, [{ operation: "insert_after", anchor: "4#BBB", lines: ["next"] }]), {
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

	assert.deepEqual(store.selectProof(PATH, replaceRange("2#BBB", "3#BBC")), {
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
