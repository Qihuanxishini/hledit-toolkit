import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./anchor.ts";
import { DEFAULT_SEARCH_LIMIT, MAX_READ_LIMIT, MAX_SEARCH_LIMIT, MAX_READ_WINDOWS } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

export const MAX_FILE_CHANGE_COUNT = 200;
export const MAX_REPLACEMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_REPLACEMENT_LINE_COUNT = 20_000;

const PATH_SCHEMA = Type.String({ minLength: 1, description: "One text file path; not a directory." });

export const CHANGE_ACTIONS = ["replace", "insert_before", "insert_after"] as const;
export type ChangeAction = typeof CHANGE_ACTIONS[number];

// [喵喵喵]: 所有动作共用必填字段；可变长度 anchors 表达点/区间，避免严格化把可选 end 字段强加给插入。
const CHANGE_ITEM_SCHEMA = Type.Object({
	action: Type.Unsafe<ChangeAction>({
		type: "string",
		enum: CHANGE_ACTIONS,
		description: "'replace' (for range replacement or deletion), 'insert_before', or 'insert_after'.",
	}),
	anchors: Type.Array(Type.String({ pattern: ANCHOR_PATTERN }), {
		minItems: 1, maxItems: 2,
		description: "One LN#HASH for inserts or single-line replace; [start, end] for a multi-line inclusive range. Do not repeat a single-line anchor.",
	}),
	lines: Type.String({ description: "Raw text (\\n separated). Use \"\" for deletion, \"\\n\" for one blank line. Inserts require non-empty text." }),
}, STRICT_OBJECT);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		windows: Type.Array(Type.Object({
			offset: Type.Integer({ minimum: 1 }),
			limit: Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT }),
		}, STRICT_OBJECT), {
			minItems: 1, maxItems: MAX_READ_WINDOWS,
			description: "Same-file ranges; use one entry for a single range. offset is 1-based; limit is a line count. Multiple windows share a 2000-line/96 KiB budget.",
		}),
	},
	STRICT_OBJECT,
);

export const HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		pattern: Type.String({ minLength: 1, description: "RE2 regex by default; use literal:true for verbatim substring matching. No lookaround or backreferences." }),
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First returned source line, 1-based (default 1), not a match index." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `Maximum matching/context lines (default ${DEFAULT_SEARCH_LIMIT}).` })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as plain text, not regex (default false)." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before/after each match (default 0)." })),
		ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive matching (default false)." })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		proof_id: Type.String({ minLength: 1, description: "Proof for these anchors' file and generation." }),
		changes: Type.Array(CHANGE_ITEM_SCHEMA, {
			minItems: 1,
			maxItems: MAX_FILE_CHANGE_COUNT,
			description: "Ordered array of 1-200 file changes in pre-edit coordinates.",
		}),
	},
	STRICT_OBJECT,
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type SearchAnchorsParams = Static<typeof HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeInput = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
export type CanonicalFileChange =
	| { operation: "replace"; start_anchor: string; end_anchor: string; lines: string[] }
	| { operation: "insert_before"; anchor: string; lines: string[] }
	| { operation: "insert_after"; anchor: string; lines: string[] };
export type FileChangeParams = {
	path: string;
	proof_id?: string;
	changes: CanonicalFileChange[];
};
