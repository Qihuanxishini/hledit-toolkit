import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

const PATH_SCHEMA = Type.String({ minLength: 1, description: "Path to the text file." });
const ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "Copy verbatim from the latest hledit_read_anchors result or a successful edit's returned updated-anchor local window. Supply LN#HASH or full LN#HASH:text; prepareArguments removes source text. Use post-edit anchors only inside that window; do not invent placeholders.",
});
const RANGE_START_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "Start anchor included in the edit range. Copy LN#HASH:text verbatim; for a single-line range it must equal end_anchor.",
});
const RANGE_END_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "End anchor included in the edit range. Copy LN#HASH:text verbatim; for a single-line range it must equal start_anchor.",
});
const REPLACEMENT_LINE_SCHEMA = Type.String({ pattern: "^[^\\r\\n]*$" });
const REPLACEMENT_LINES_SCHEMA = Type.Union(
	[
		Type.String({
			description:
			"Preferred form for multiline edits: raw file text separated by newlines. Strings split on CRLF, CR, or LF; one terminal newline ends the final line without adding a blank line; an empty string is one blank line.",
		}),
		Type.Array(REPLACEMENT_LINE_SCHEMA, {
			minItems: 1,
			description: "Compatibility form: every array item is one raw line with no CR/LF. Supply raw content rather than anchor-prefixed or diff-marked text.",
		}),
	],
	{ description: "Exact raw line content used as a content precondition or replacement. For multiline content, prefer a newline-delimited string." },
);

const REPLACE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace_range"] as const, {
			description: "Replace the complete anchor range, including both endpoints. For a single-line replacement, start_anchor and end_anchor must be identical.",
		}),
		start_anchor: RANGE_START_ANCHOR_SCHEMA,
		end_anchor: RANGE_END_ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const DELETE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete_range"] as const, {
			description: "Delete the complete anchor range, including both endpoints. For a single-line deletion, start_anchor and end_anchor must be identical.",
		}),
		start_anchor: RANGE_START_ANCHOR_SCHEMA,
		end_anchor: RANGE_END_ANCHOR_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_BEFORE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_before"] as const, { description: "Insert raw file lines before the anchor line." }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_AFTER_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_after"] as const, { description: "Insert raw file lines after the anchor line." }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum number of lines to return (no more than ${MAX_READ_LIMIT}).` })),
		grep: Type.Optional(Type.String({ description: "Substring filter." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before and after each grep match." })),
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
				description:
					"One complete, non-overlapping atomic batch for one file. Submit an object array; do not JSON.stringify the whole changes array. The plugin tolerates rare upstream serialization artifacts. Range operations require both start_anchor and end_anchor. Any invalid operation or stale anchor rejects the entire batch without writing.",
			},
		),
	},
	STRICT_OBJECT,
);

export const HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		old_lines: REPLACEMENT_LINES_SCHEMA,
		new_lines: REPLACEMENT_LINES_SCHEMA,
	},
	{
		...STRICT_OBJECT,
		description:
			"Atomically replace the one unique contiguous occurrence of old lines in the current file. Use only when old_lines is known and must be unique; zero or multiple matches reject the write. This shortcut does not require a prior anchor read.",
	},
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeInput = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
export type ReplaceOnceInput = Static<typeof HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA>;
type CanonicalFileChange =
	| { operation: "replace_range"; start_anchor: string; end_anchor: string; lines: string[] }
	| { operation: "delete_range"; start_anchor: string; end_anchor: string }
	| { operation: "insert_before"; anchor: string; lines: string[] }
	| { operation: "insert_after"; anchor: string; lines: string[] };
export type FileChangeParams = {
	path: string;
	changes: CanonicalFileChange[];
};
export type ReplaceOnceParams = {
	path: string;
	old_lines: string[];
	new_lines: string[];
};
