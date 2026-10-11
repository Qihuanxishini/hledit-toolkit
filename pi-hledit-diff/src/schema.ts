import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./anchor.ts";
import { DEFAULT_SEARCH_LIMIT, MAX_READ_LIMIT, MAX_SEARCH_LIMIT, MAX_READ_WINDOWS } from "./read-args.ts";

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

// [喵喵喵]: 平面对象兼容 Pi 的 strict schema 转换，并避免对象 union 的跨分支错误噪声。
// 操作相关的字段组合由 decodeFileChangeInput 校验；类型、格式与额外字段仍由宿主 schema 拒绝。
const CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(
			["replace_range", "delete_range", "insert_before", "insert_after"] as const,
			{
				description:
					"replace_range / delete_range use inclusive start_anchor + end_anchor (repeat the same token for a single line); insert_before / insert_after use anchor. replace_range and both inserts require lines; delete_range takes none."
			},
		),
		start_anchor: Type.Optional(ANCHOR_SCHEMA),
		end_anchor: Type.Optional(ANCHOR_SCHEMA),
		anchor: Type.Optional(ANCHOR_SCHEMA),
		lines: Type.Optional(REPLACEMENT_TEXT_SCHEMA),
	},
	{
		...STRICT_OBJECT,
		description: "One edit in pre-edit coordinates; field pairs are operation-specific. replace_range rewrites the whole range, may retain source text and change line count; inserts add text beside the anchor without copying it.",
	},
);

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
		changes: Type.Array(
			CHANGE_SCHEMA,
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
