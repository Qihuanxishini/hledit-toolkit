import type { FileChangeParams } from "./schema.ts";

export const ANCHOR_HASH_PATTERN = "[A-Za-z0-9_-]{3}";
export const ANCHOR_PATTERN = `^\\d+#${ANCHOR_HASH_PATTERN}$`;

type CliBatchEdit = {
	op: "replace" | "delete" | "insert";
	pos: string;
	end_pos?: string;
	after?: true;
	lines: string[];
};

type CliBatchRequest = {
	edits: CliBatchEdit[];
};

function buildCliBatchRequest(params: FileChangeParams): CliBatchRequest {
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
						lines: [],
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
	};
}

function serializeCliBatchRequest(params: FileChangeParams): string {
	return JSON.stringify(buildCliBatchRequest(params));
}

export function buildFileChangeRequest(params: FileChangeParams): { args: string[]; stdin: string } {
	return { args: ["batch", params.path], stdin: serializeCliBatchRequest(params) };
}

export function buildFileChangeCheckRequest(params: FileChangeParams): { args: string[]; stdin: string } {
	return { args: ["batch", "--check", params.path], stdin: serializeCliBatchRequest(params) };
}

export function lineFromAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") {
		return undefined;
	}
	const match = anchor.match(/^(\d+)#/);
	return match ? Number(match[1]) : undefined;
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
		`第 ${issue.changeNumber} 项修改被拒绝。`,
		"实际收到：",
		"- operation: replace_range",
		`- start_anchor: ${issue.anchor}`,
		`- end_anchor: ${issue.anchor}（与 start_anchor 相同）`,
		`- lines: ${issue.outputLineCount} 行`,
		"该 replace_range 只覆盖一个源文件行；本次 lines 首行又重复了该行，执行可能保留本应被替换的后续旧代码。",
		"禁止使用相同参数重试。",
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
			`检测到同批次第 ${hint.changeNumber} 项 delete_range 覆盖 ${hint.startAnchor} 到 ${hint.endAnchor}，且本批次锚点已通过 --check 验证。`,
			"若该 delete_range 属于同一个待替换旧代码块，优先将两项合并为以下 replace_range，并移除原 delete_range：",
			mergedTemplate,
			"若不是同一代码块，请重新调用 hledit_read_anchors 读取正确的块尾锚点。",
		);
	} else {
		lines.push(
			"若要替换现有代码块，请先调用 hledit_read_anchors 读取块尾，再将真实块尾写入同一项 replace_range 的 end_anchor；当前没有可安全使用的结束锚点，因此不提供占位锚点。",
		);
	}

	lines.push(
		"若本意是保留锚点行并在其后新增内容，可直接改用以下 insert_after；其中 lines 已移除重复的锚点行：",
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
