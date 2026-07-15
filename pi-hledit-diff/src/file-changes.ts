import type { FileChangeParams } from "./schema.ts";

export const ANCHOR_PATTERN = "^\\d+#[A-Za-z0-9]+$";

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
