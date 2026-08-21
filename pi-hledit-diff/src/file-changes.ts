import type { FileChangeParams } from "./schema.ts";

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
	return { args: ["batch", "--", params.path], stdin: serializeCliBatchRequest(params, proof) };
}

export function buildFileChangeCheckRequest(params: FileChangeParams, proof?: HleditBatchReadProof): { args: string[]; stdin: string } {
	return { args: ["batch", "--check", "--", params.path], stdin: serializeCliBatchRequest(params, proof) };
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

// 请求层自洽性校验。schema 只保证字段类型合法，read proof 只校验与文件快照的一致
// 性；这里检查一个类型合法的 change 是否自相矛盾。这类问题重读文件永远无法修复，
// 必须由模型改自己的参数，所以要在 selectProof 之前拦下——否则会给出"去重读再重发"
// 的指令，而重发必然复现同一错误，形成恢复死循环。
const ANCHOR_LINE_PREFIX_PATTERN = new RegExp(`^(\\d+#${ANCHOR_HASH_PATTERN}):`);

export type ChangeShapeIssue =
	| {
		code: "reversed_anchor_range";
		changeNumber: number;
		operation: "replace_range" | "delete_range";
		startAnchor: string;
		endAnchor: string;
	}
	| {
		code: "anchor_token_in_lines";
		changeNumber: number;
		replacementLineNumber: number;
		anchorToken: string;
	};

function submittedAnchorTokens(changes: FileChangeParams["changes"]): Set<string> {
	const tokens = new Set<string>();
	for (const change of changes) {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			tokens.add(change.anchor);
			continue;
		}
		tokens.add(change.start_anchor);
		tokens.add(change.end_anchor);
	}
	return tokens;
}

export function findChangeShapeIssue(params: FileChangeParams): ChangeShapeIssue | undefined {
	const submittedAnchors = submittedAnchorTokens(params.changes);
	for (const [index, change] of params.changes.entries()) {
		const changeNumber = index + 1;
		if (change.operation === "replace_range" || change.operation === "delete_range") {
			const startLine = lineFromAnchor(change.start_anchor);
			const endLine = lineFromAnchor(change.end_anchor);
			if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
				return {
					code: "reversed_anchor_range",
					changeNumber,
					operation: change.operation,
					startAnchor: change.start_anchor,
					endAnchor: change.end_anchor,
				};
			}
		}
		if (change.operation === "delete_range") continue;

		for (const [lineIndex, text] of change.lines.entries()) {
			// 只有当行首 token 正是本次请求提交过的 anchor 时才判定为误贴 read 输出：
			// 真实源码里出现恰好等于当前 anchor 的行首 token 需要 hash 自碰撞，可忽略。
			const anchorToken = ANCHOR_LINE_PREFIX_PATTERN.exec(text)?.[1];
			if (anchorToken !== undefined && submittedAnchors.has(anchorToken)) {
				return { code: "anchor_token_in_lines", changeNumber, replacementLineNumber: lineIndex + 1, anchorToken };
			}
		}
	}
	return undefined;
}

export function formatChangeShapeIssue(issue: ChangeShapeIssue): string {
	if (issue.code === "reversed_anchor_range") {
		return [
			`Change ${issue.changeNumber} was rejected.`,
			`Received: ${issue.operation} from start_anchor ${issue.startAnchor} through end_anchor ${issue.endAnchor}, which runs backwards.`,
			"start_anchor must not be below end_anchor in the file.",
			`Swap them: set start_anchor to ${issue.endAnchor} and end_anchor to ${issue.startAnchor}.`,
			"Rereading the file cannot resolve this; fix the anchor order and resubmit.",
		].join("\n");
	}
	return [
		`Change ${issue.changeNumber} was rejected.`,
		`Line ${issue.replacementLineNumber} of lines begins with ${issue.anchorToken}:, which is hledit_read_anchors display syntax, not file content.`,
		`Writing it would put the literal text ${issue.anchorToken}: into the file.`,
		`Remove the leading ${issue.anchorToken}: from that line; lines carries file content only, and anchors belong in the anchor fields.`,
		"Rereading the file cannot resolve this; fix lines and resubmit.",
	].join("\n");
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

// 锚点行文本来自同 revision 的消费行证据（selectProof 已保证覆盖每个消费行），
// 不再读取完整文件——这与 CLI 实际校验的快照一致，也移除了对 Node 前置读取的依赖。
export function findSingleLineRangeExpansionIssue(
	params: FileChangeParams,
	consumedLineText: ReadonlyMap<number, { text: string }>,
): SingleLineRangeExpansionIssue | undefined {
	for (const [index, change] of params.changes.entries()) {
		if (change.operation !== "replace_range" || change.lines.length <= 1) {
			continue;
		}

		const startLine = lineFromAnchor(change.start_anchor);
		const endLine = lineFromAnchor(change.end_anchor);
		if (startLine === undefined || endLine !== startLine) {
			continue;
		}

		const anchoredText = consumedLineText.get(startLine)?.text;
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
			...(nearbyDeleteRange ? { nearbyDeleteRange } : {}),
		};
	}
	return undefined;
}

export function formatSingleLineRangeExpansionIssue(issue: VerifiedSingleLineRangeExpansionIssue): string {
	const remainingLineCount = issue.outputLineCount - 1;
	const remainingLineLabel = remainingLineCount === 1 ? "line" : "lines";
	const lines = [
		`Change ${issue.changeNumber} was rejected.`,
		`Received: replace_range ${issue.anchor} through ${issue.anchor}; ${issue.outputLineCount} output lines.`,
		"This range covers one source line and repeats it as the first output line, which could leave old code behind.",
		"Do not retry with the same parameters.",
	];

	if (issue.nearbyDeleteRange) {
		const hint = issue.nearbyDeleteRange;
		lines.push(
			`Change ${hint.changeNumber} is a delete_range from ${hint.startAnchor} through ${hint.endAnchor}; the batch anchors passed --check.`,
			"If it belongs to the same old block:",
			`- set change ${issue.changeNumber} end_anchor to ${hint.endAnchor}`,
			`- remove change ${hint.changeNumber}`,
			`- keep change ${issue.changeNumber} lines unchanged`,
			"Otherwise, call hledit_read_anchors for the correct block-end anchor.",
		);
	} else {
		lines.push(
			"To replace a larger block:",
			"- call hledit_read_anchors for the true block-end anchor",
			`- set change ${issue.changeNumber} end_anchor to that verified anchor`,
			`- keep change ${issue.changeNumber} lines unchanged`,
			"No safe placeholder end anchor is available.",
		);
	}

	lines.push(
		`To keep ${issue.anchor} and append the remaining ${remainingLineCount} ${remainingLineLabel}:`,
		"- change operation to insert_after",
		`- replace start_anchor/end_anchor with anchor: ${issue.anchor}`,
		`- remove the first line from lines; keep the remaining ${remainingLineCount} ${remainingLineLabel} unchanged`,
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
