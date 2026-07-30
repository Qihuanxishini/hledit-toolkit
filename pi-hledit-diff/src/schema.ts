import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

const PATH_SCHEMA = Type.String({ minLength: 1, description: "Text file path." });
const ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "Current LN#HASH token copied from a complete read or verified updated-anchor line. Paste only the token, without :text. Never invent anchors.",
});
const RANGE_START_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "First included line token. Ensure current evidence covers every source line through end_anchor; interior proof is carried automatically. For one line, use the same anchor as end_anchor.",
});
const RANGE_END_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "Last included line token. Endpoint tokens alone do not prove unread intermediate lines. For one line, use the same anchor as start_anchor.",
});
const REPLACEMENT_LINE_SCHEMA = Type.String({ pattern: "^[^\\r\\n]*$" });
const REPLACEMENT_LINES_SCHEMA = Type.Union(
	[
		Type.String({
			description: "Newline-delimited raw text. One final newline terminates the last line; an empty string means one blank line.",
		}),
		Type.Array(REPLACEMENT_LINE_SCHEMA, {
			minItems: 1,
			description: "One raw line per item, without CR/LF. Use a real JSON array.",
		}),
	],
	{ description: "Raw lines; prefer a newline-delimited string for multiline text." },
);

const REPLACE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace_range"] as const, { description: "Replace the inclusive anchor range." }),
		start_anchor: RANGE_START_ANCHOR_SCHEMA,
		end_anchor: RANGE_END_ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const DELETE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete_range"] as const, { description: "Delete the inclusive anchor range." }),
		start_anchor: RANGE_START_ANCHOR_SCHEMA,
		end_anchor: RANGE_END_ANCHOR_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_BEFORE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_before"] as const, { description: "Insert lines before the anchor." }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_AFTER_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_after"] as const, { description: "Insert lines after the anchor." }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum lines (${MAX_READ_LIMIT} max).` })),
		grep: Type.Optional(Type.String({ description: "Substring filter." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Lines around each grep match." })),
		ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive grep." })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		changes: Type.Array(
			Type.Union([REPLACE_RANGE_CHANGE_SCHEMA, DELETE_RANGE_CHANGE_SCHEMA, INSERT_BEFORE_CHANGE_SCHEMA, INSERT_AFTER_CHANGE_SCHEMA]),
			{
				minItems: 1,
				description: "One complete non-overlapping atomic batch. Use an object array, not JSON text; any invalid or stale change rejects the whole batch.",
			},
		),
	},
	STRICT_OBJECT,
);


export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeInput = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
type CanonicalFileChange =
	| { operation: "replace_range"; start_anchor: string; end_anchor: string; lines: string[] }
	| { operation: "delete_range"; start_anchor: string; end_anchor: string }
	| { operation: "insert_before"; anchor: string; lines: string[] }
	| { operation: "insert_after"; anchor: string; lines: string[] };
export type FileChangeParams = {
	path: string;
	changes: CanonicalFileChange[];
};
