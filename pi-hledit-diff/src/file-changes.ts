import type { FileChangeParams, ReplaceOnceParams } from "./schema.ts";

export const ANCHOR_HASH_PATTERN = "[A-Za-z0-9_-]{3}";
export const ANCHOR_PATTERN = `^\\d+#${ANCHOR_HASH_PATTERN}$`;

type CliBatchEdit = {
	op: "replace" | "delete" | "insert";
	pos: string;
	end_pos?: string;
	after?: true;
	lines?: string[];
};

type CliBatchRequest = {
	edits: CliBatchEdit[];
	proof?: HleditBatchReadProof;
};

export type HleditBatchReadProof = {
	revision: string;
	anchors: string[];
};

function buildCliBatchRequest(params: FileChangeParams, proof?: HleditBatchReadProof): CliBatchRequest {
	return {
		edits: params.changes.map((change) => {
			switch (change.operation) {
				case "replace_range":
					return {
						op: "replace",
						pos: change.start_anchor,
						end_pos: change.end_anchor,
						lines: change.lines,
					};
				case "delete_range":
					return {
						op: "delete",
						pos: change.start_anchor,
						end_pos: change.end_anchor,
					};
				case "insert_before":
					return {
						op: "insert",
						pos: change.anchor,
						lines: change.lines,
					};
				case "insert_after":
					return {
						op: "insert",
						pos: change.anchor,
						after: true,
						lines: change.lines,
					};
			}
		}),
		...(proof ? { proof } : {}),
	};
}

function serializeCliBatchRequest(params: FileChangeParams, proof?: HleditBatchReadProof): string {
	return JSON.stringify(buildCliBatchRequest(params, proof));
}

export function buildFileChangeRequest(params: FileChangeParams, proof?: HleditBatchReadProof): { args: string[]; stdin: string } {
	return { args: ["batch", params.path], stdin: serializeCliBatchRequest(params, proof) };
}

export function buildFileChangeCheckRequest(params: FileChangeParams, proof?: HleditBatchReadProof): { args: string[]; stdin: string } {
	return { args: ["batch", "--check", params.path], stdin: serializeCliBatchRequest(params, proof) };
}

export function buildReplaceOnceRequest(params: ReplaceOnceParams): { args: string[]; stdin: string } {
	return {
		args: ["replace-once", params.path],
		stdin: JSON.stringify({ old_lines: params.old_lines, new_lines: params.new_lines }),
	};
}

export function lineFromAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") {
		return undefined;
	}
	const match = anchor.match(/^(\d+)#/);
	if (!match) return undefined;
	const line = Number(match[1]);
	return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

export type NearbyDeleteRangeHint = {
	changeNumber: number;
	startAnchor: string;
	endAnchor: string;
};

export type SingleLineRangeExpansionIssue = {
	code: "single_line_range_expansion";
	changeNumber: number;
	anchor: string;
	outputLineCount: number;
	replacementLines: string[];
	insertLines: string[];
	nearbyDeleteRange?: NearbyDeleteRangeHint;
};

export type VerifiedSingleLineRangeExpansionIssue = SingleLineRangeExpansionIssue & {
	anchorsVerified: true;
};

function hasAdjacentDeleteRange(params: FileChangeParams, replacementIndex: number, replacementLine: number): boolean {
	return params.changes.some((change, index) => {
		if (index === replacementIndex || change.operation !== "delete_range") {
			return false;
		}
		return lineFromAnchor(change.start_anchor) === replacementLine + 1;
	});
}

function findNearbyDeleteRangeHint(
	params: FileChangeParams,
	replacementIndex: number,
	replacementLine: number,
): NearbyDeleteRangeHint | undefined {
	const candidates = params.changes.flatMap((change, index) => {
		if (index === replacementIndex || change.operation !== "delete_range") {
			return [];
		}

		const startLine = lineFromAnchor(change.start_anchor);
		const endLine = lineFromAnchor(change.end_anchor);
		if (startLine !== replacementLine + 2 || endLine === undefined || endLine < startLine) {
			return [];
		}
		return [{ changeNumber: index + 1, startAnchor: change.start_anchor, endAnchor: change.end_anchor }];
	});
	return candidates.length === 1 ? candidates[0] : undefined;
}

export function findSingleLineRangeExpansionIssue(
	params: FileChangeParams,
	content: string,
): SingleLineRangeExpansionIssue | undefined {
	const sourceLines = content.split(/\r\n|\r|\n/);
	for (const [index, change] of params.changes.entries()) {
		if (change.operation !== "replace_range" || change.lines.length <= 1) {
			continue;
		}

		const startLine = lineFromAnchor(change.start_anchor);
		const endLine = lineFromAnchor(change.end_anchor);
		if (startLine === undefined || endLine !== startLine) {
			continue;
		}

		const anchoredText = sourceLines[startLine - 1];
		if (anchoredText === undefined || change.lines[0] !== anchoredText) {
			continue;
		}
		if (hasAdjacentDeleteRange(params, index, startLine)) {
			continue;
		}

		const nearbyDeleteRange = findNearbyDeleteRangeHint(params, index, startLine);
		return {
			code: "single_line_range_expansion",
			changeNumber: index + 1,
			anchor: change.start_anchor,
			outputLineCount: change.lines.length,
			replacementLines: [...change.lines],
			insertLines: change.lines.slice(1),
			...(nearbyDeleteRange ? { nearbyDeleteRange } : {}),
		};
	}
	return undefined;
}

export function formatSingleLineRangeExpansionIssue(issue: VerifiedSingleLineRangeExpansionIssue): string {
	const insertTemplate = JSON.stringify(
		{
			operation: "insert_after",
			anchor: issue.anchor,
			lines: issue.insertLines,
		},
		null,
		2,
	);
	const lines = [
		`Change ${issue.changeNumber} was rejected.`,
		"Received:",
		"- operation: replace_range",
		`- start_anchor: ${issue.anchor}`,
		`- end_anchor: ${issue.anchor} (same as start_anchor)`,
		`- lines: ${issue.outputLineCount}`,
		"This replace_range covers one source line, while its first replacement line repeats that source line. Applying it could retain old code that should have been replaced.",
		"Do not retry with the same parameters.",
	];

	if (issue.nearbyDeleteRange) {
		const hint = issue.nearbyDeleteRange;
		const mergedTemplate = JSON.stringify(
			{
				operation: "replace_range",
				start_anchor: issue.anchor,
				end_anchor: hint.endAnchor,
				lines: issue.replacementLines,
			},
			null,
			2,
		);
		lines.push(
			`Change ${hint.changeNumber} is a delete_range from ${hint.startAnchor} through ${hint.endAnchor}, and this batch's anchors passed --check.`,
			"If that delete_range belongs to the same old code block, merge both changes into this replace_range and remove the delete_range:",
			mergedTemplate,
			"Otherwise, call hledit_read_anchors to read the correct block-end anchor.",
		);
	} else {
		lines.push(
			"To replace an existing code block, call hledit_read_anchors to read its true end, then use that end anchor in this replace_range. No safe placeholder end anchor is available.",
		);
	}

	lines.push(
		"If the intent is to keep the anchored line and append content after it, use this insert_after instead. Its lines omit the repeated anchored line:",
		insertTemplate,
	);
	return lines.join("\n");
}

export function fileChangeLineRanges(changes: unknown): string | undefined {
	if (!Array.isArray(changes)) {
		return undefined;
	}

	const ranges = changes.flatMap((change) => {
		if (typeof change !== "object" || change === null || Array.isArray(change)) {
			return [];
		}
		const record = change as Record<string, unknown>;
		const first = lineFromAnchor(record.start_anchor) ?? lineFromAnchor(record.anchor);
		const last = lineFromAnchor(record.end_anchor);
		if (first === undefined && last === undefined) {
			return [];
		}
		const start = first ?? last!;
		const end = last ?? first!;
		return [start === end ? String(start) : `${start}-${end}`];
	});
	return ranges.length > 0 ? ranges.join(",") : undefined;
}
