import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT, MAX_SEARCH_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

export const MAX_FILE_CHANGE_COUNT = 200;
export const MAX_REPLACEMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_REPLACEMENT_LINE_COUNT = 20_000;

const PATH_SCHEMA = Type.String({ minLength: 1, description: "Text file path." });
const ANCHOR_SCHEMA = Type.String({ pattern: ANCHOR_PATTERN });
const REPLACEMENT_TEXT_SCHEMA = Type.String({
	maxLength: MAX_REPLACEMENT_TEXT_BYTES,
	// 完整换行语义只在 apply 的 promptGuidelines 里定义一次；这里保留最短就近提示，
	// 因为该 description 会在 3 个 union 分支各内联一次，直接抬高每次请求的协议开销。
	description: "New text; \\n separates lines.",
});

const REPLACE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace_range"] as const),
		start_anchor: ANCHOR_SCHEMA,
		end_anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_TEXT_SCHEMA,
	},
	STRICT_OBJECT,
);

const DELETE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete_range"] as const),
		start_anchor: ANCHOR_SCHEMA,
		end_anchor: ANCHOR_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_BEFORE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_before"] as const),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_TEXT_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_AFTER_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_after"] as const),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_TEXT_SCHEMA,
	},
	STRICT_OBJECT,
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum contiguous lines (${MAX_READ_LIMIT} max).` })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		pattern: Type.String({ minLength: 1, description: "RE2 regular expression; use literal:true for exact text." }),
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First source line to search (1-based)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `Maximum matching/context lines (${MAX_SEARCH_LIMIT} max).` })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as exact text instead of a regular expression." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Lines around each match." })),
		ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive pattern matching." })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		proof_id: Type.String({ minLength: 1, description: "Proof id from the latest successful read/search result for this path." }),
		changes: Type.Array(
			Type.Union([REPLACE_RANGE_CHANGE_SCHEMA, DELETE_RANGE_CHANGE_SCHEMA, INSERT_BEFORE_CHANGE_SCHEMA, INSERT_AFTER_CHANGE_SCHEMA]),
			{
				minItems: 1,
				maxItems: MAX_FILE_CHANGE_COUNT,
				description: "Complete non-overlapping atomic batch.",
			},
		),
	},
	STRICT_OBJECT,
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type SearchAnchorsParams = Static<typeof HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeInput = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
export type CanonicalFileChange =
	| { operation: "replace_range"; start_anchor: string; end_anchor: string; lines: string[] }
	| { operation: "delete_range"; start_anchor: string; end_anchor: string }
	| { operation: "insert_before"; anchor: string; lines: string[] }
	| { operation: "insert_after"; anchor: string; lines: string[] };
export type FileChangeParams = {
	path: string;
	proof_id?: string;
	changes: CanonicalFileChange[];
};
