import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./anchor.ts";
import { DEFAULT_READ_LIMIT, DEFAULT_SEARCH_LIMIT, MAX_READ_LIMIT, MAX_SEARCH_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

export const MAX_FILE_CHANGE_COUNT = 200;
export const MAX_REPLACEMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_REPLACEMENT_LINE_COUNT = 20_000;

const PATH_SCHEMA = Type.String({ minLength: 1, description: "One text file path; not a directory." });
const ANCHOR_SCHEMA = Type.String({ pattern: ANCHOR_PATTERN, description: "This proof's exact LN#HASH token." });
const REPLACEMENT_TEXT_SCHEMA = Type.String({
	// [喵喵喵]: 单项不设字符上限；UTF-8 字节数与 batch 聚合限制由 execute 边界精确校验。
	description: "Raw text; \\n separates lines; no LN#HASH prefixes.",
});

const REPLACE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace_range"] as const),
		start_anchor: ANCHOR_SCHEMA,
		end_anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_TEXT_SCHEMA,
	},
	{
		...STRICT_OBJECT,
		description: "Replace the inclusive start_anchor/end_anchor range with lines. Use the same token twice for one line; select the entire intended source range.",
	},
);

const DELETE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete_range"] as const),
		start_anchor: ANCHOR_SCHEMA,
		end_anchor: ANCHOR_SCHEMA,
	},
	{
		...STRICT_OBJECT,
		description: "Delete the inclusive start_anchor/end_anchor range; use the same token twice for one line. Omit lines.",
	},
);

// [喵喵喵]: 两个 insert 变体除 operation 取值外字段完全相同，合并为一个 variant——
// required 集合与 additionalProperties 约束不变，模型看到的 schema 不再重复同一份定义。
const INSERT_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_before", "insert_after"] as const),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_TEXT_SCHEMA,
	},
	{
		...STRICT_OBJECT,
		description: "Insert only new text before/after anchor; the anchor and existing text remain. Do not repeat anchor/context lines unless the duplicate is intended.",
	},
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based; default 1)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum contiguous lines (default ${DEFAULT_READ_LIMIT}; max ${MAX_READ_LIMIT}).` })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		pattern: Type.String({ minLength: 1, description: "RE2 regex by default; use literal:true for verbatim substring matching. No lookaround or backreferences." }),
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First returned source line, 1-based (default 1), not a match index." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `Maximum matching/context source lines (default ${DEFAULT_SEARCH_LIMIT}; max ${MAX_SEARCH_LIMIT}).` })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as plain text, not regex (default false)." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before/after each match (default 0)." })),
		ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive matching (default false)." })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		proof_id: Type.String({ minLength: 1, description: "Proof for these anchors' file and generation. Do not mix generations." }),
		changes: Type.Array(
			Type.Union([REPLACE_RANGE_CHANGE_SCHEMA, DELETE_RANGE_CHANGE_SCHEMA, INSERT_CHANGE_SCHEMA]),
			{
				minItems: 1,
				maxItems: MAX_FILE_CHANGE_COUNT,
				description: "One atomic batch in pre-edit coordinates. No overlapping ranges, insertions inside consumed ranges, or duplicate insertion boundaries.",
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
