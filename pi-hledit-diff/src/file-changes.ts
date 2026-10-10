import { ANCHOR_LINE_PREFIX, lineFromAnchor } from "./anchor.ts";
import { rejectedToolResult, type TextResult } from "./result.ts";
import type { FileChangeParams } from "./schema.ts";

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

export function buildFileChangeRequest(params: FileChangeParams, proof?: HleditBatchReadProof): { args: string[]; stdin: string } {
	return { args: ["batch", "--", params.path], stdin: JSON.stringify(buildCliBatchRequest(params, proof)) };
}

// 请求层自洽性校验。schema 只保证字段类型合法，read proof 只校验与文件快照的一致
// 性；这里检查一个类型合法的 change 是否自相矛盾。这类问题重读文件永远无法修复，
// 必须由模型改自己的参数，所以要在 selectProof 之前拦下——否则会给出"去重读再重发"
// 的指令，而重发必然复现同一错误，形成恢复死循环。

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

// knownAnchors 只需提供当前证据的成员查询：模型把 read 输出整段贴进 insert 的 lines 时，
// 行首 token 是依附行之后的行，不在本次提交的锚点里，只有对照证据才能拦住。
export function findChangeShapeIssue(params: FileChangeParams, knownAnchors?: Pick<ReadonlySet<string>, "has">): ChangeShapeIssue | undefined {
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
			// 只有当行首 token 是本次提交过或当前证据中的 anchor 时才判定为误贴 read 输出：
			// 真实源码里出现恰好等于现存 anchor 的行首 token 需要 hash 自碰撞，可忽略。
			const anchorToken = ANCHOR_LINE_PREFIX.exec(text)?.[1];
			if (anchorToken !== undefined && (submittedAnchors.has(anchorToken) || knownAnchors?.has(anchorToken))) {
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

export function changeShapeIssueResult(issue: ChangeShapeIssue): TextResult {
	return rejectedToolResult(`The atomic batch was rejected; no content was written.\n${formatChangeShapeIssue(issue)}`, {
		code: issue.code,
		message: issue.code === "reversed_anchor_range"
			? `Change ${issue.changeNumber} submitted start_anchor ${issue.startAnchor} below end_anchor ${issue.endAnchor}; swap them instead of rereading.`
			: `Change ${issue.changeNumber} pasted the anchor token ${issue.anchorToken} into lines; strip the prefix instead of rereading.`,
		changeNumber: issue.changeNumber,
	});
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
