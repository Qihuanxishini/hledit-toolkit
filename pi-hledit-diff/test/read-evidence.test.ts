import assert from "node:assert/strict";
import test from "node:test";

import { HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL } from "../src/active-tools.ts";
import { ReadEvidenceStore } from "../src/read-evidence.ts";
import type { HleditReadMetadata } from "../src/result.ts";
import type { FileChangeParams } from "../src/schema.ts";

const REVISION_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATH = "/workspace/target.txt";

function readMetadata(
	revision: string,
	lines: Array<{ line: number; anchor: string; textTruncated?: boolean }>,
	grep?: string,
): HleditReadMetadata {
	const firstLine = lines[0]?.line;
	const lastLine = lines.at(-1)?.line;
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
			totalLines: Math.max(lastLine ?? 0, 10),
		},
		lines: lines.map((line) => ({
			line: line.line,
			anchor: line.anchor,
			text: `line ${line.line}`,
			textTruncated: line.textTruncated === true,
		})),
		truncated: false,
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

test("grep and text-truncated output do not establish write proof", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 2, anchor: "2#AAB" }], "line"));
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 3, anchor: "3#AAC", textTruncated: true }]));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "3#AAC"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.missingLines, [2, 3]);
});

test("oversized ranges fail without enumerating every requested line", () => {
	const store = new ReadEvidenceStore();
	store.recordRead(PATH, readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]));

	const selection = store.selectProof(PATH, replaceRange("1#AAA", "9007199254740991#BBB"));
	assert.ok("failure" in selection);
	assert.deepEqual(selection.failure.missingLines, Array.from({ length: 20 }, (_, index) => index + 2));
	assert.match(selection.failure.message, /仅列出前 20 行/);
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
	const read = readMetadata(REVISION_A, [{ line: 1, anchor: "1#AAA" }]);
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
