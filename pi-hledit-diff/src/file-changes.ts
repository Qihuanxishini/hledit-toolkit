import type { FileChangeParams } from "./schema.ts";

export const ANCHOR_HASH_PATTERN = "[BHJKMNPQRSTVWXYZ]{2}";
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

export function buildFileChangeRequest(params: FileChangeParams): { args: string[]; stdin: string } {
	const request: CliBatchRequest = {
		edits: params.changes.map((change) => {
			switch (change.operation) {
				case "replace":
					return {
						op: "replace",
						pos: change.anchor,
						...(change.end_anchor ? { end_pos: change.end_anchor } : {}),
						lines: change.lines,
					};
				case "delete":
					return {
						op: "delete",
						pos: change.anchor,
						...(change.end_anchor ? { end_pos: change.end_anchor } : {}),
						lines: [],
					};
				case "insert":
					return {
						op: "insert",
						pos: change.anchor,
						after: change.position === "after" ? true : undefined,
						lines: change.lines,
					};
			}
		}),
	};

	return {
		args: ["batch", params.path],
		stdin: JSON.stringify(request),
	};
}

export function lineFromAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") {
		return undefined;
	}
	const match = anchor.match(/^(\d+)#/);
	return match ? Number(match[1]) : undefined;
}

export function findSingleAnchorReplacementError(
	params: FileChangeParams,
	content: string,
): string | undefined {
	const sourceLines = content.split(/\r\n|\r|\n/);
	for (const [index, change] of params.changes.entries()) {
		if (change.operation !== "replace" || change.end_anchor || change.lines.length <= 1) {
			continue;
		}

		const line = lineFromAnchor(change.anchor);
		const anchoredText = line === undefined ? undefined : sourceLines[line - 1];
		if (anchoredText !== undefined && change.lines[0] === anchoredText) {
			return (
				`第 ${index + 1} 项修改使用单锚点 replace，但 lines 的首行重复了原锚点行，同时又追加了更多行。` +
				"若要替换现有代码块，请提供包含首尾的 end_anchor；若要保留锚点行，请改用 insert 并明确 before 或 after。"
			);
		}
	}
	return undefined;
}

export function fileChangeLineRange(changes: unknown): string | undefined {
	if (!Array.isArray(changes)) {
		return undefined;
	}

	const lines = changes.flatMap((change) => {
		if (typeof change !== "object" || change === null || Array.isArray(change)) {
			return [];
		}
		const record = change as Record<string, unknown>;
		return [lineFromAnchor(record.anchor), lineFromAnchor(record.end_anchor)].filter(
			(line): line is number => line !== undefined,
		);
	});
	if (lines.length === 0) {
		return undefined;
	}

	const first = Math.min(...lines);
	const last = Math.max(...lines);
	return first === last ? String(first) : `${first}-${last}`;
}
