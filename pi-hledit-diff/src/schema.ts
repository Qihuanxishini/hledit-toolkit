import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

const PATH_SCHEMA = Type.String({ minLength: 1, description: "Text file path" });
const ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "Exact LN#HASH copied from the latest hledit_read_anchors output; never use placeholders such as #?? or #XX",
});
const REPLACEMENT_LINES_SCHEMA = Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), {
	minItems: 1,
	description: "Raw file lines only: each array element is exactly one line, without anchor prefixes or diff markers.",
});

const REPLACE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace"] as const, {
			description: "Replace exactly one anchored line, or an inclusive range when end_anchor is supplied; multiple output lines do not consume following source lines",
		}),
		anchor: ANCHOR_SCHEMA,
		end_anchor: Type.Optional(
			Type.String({
				pattern: ANCHOR_PATTERN,
				description: "Inclusive range end; required when existing following source lines must also be replaced",
			}),
		),
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const DELETE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete"] as const, { description: "Delete one anchor or an inclusive anchor range" }),
		anchor: ANCHOR_SCHEMA,
		end_anchor: Type.Optional(Type.String({ pattern: ANCHOR_PATTERN, description: "Inclusive end anchor for a range deletion" })),
	},
	STRICT_OBJECT,
);

const INSERT_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert"] as const, { description: "Insert raw file lines at one anchor" }),
		anchor: ANCHOR_SCHEMA,
		position: StringEnum(["before", "after"] as const, { description: "Place lines before or after the anchor" }),
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed starting line" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum lines to return (<= ${MAX_READ_LIMIT})` })),
		grep: Type.Optional(Type.String({ description: "Substring filter" })),
	},
	STRICT_OBJECT,
);

export const HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		changes: Type.Array(Type.Union([REPLACE_CHANGE_SCHEMA, DELETE_CHANGE_SCHEMA, INSERT_CHANGE_SCHEMA]), {
			minItems: 1,
			description: "Complete, non-conflicting changes for one atomic batch. Never include read operations, placeholders, or unfinished changes; one invalid or stale item rejects the entire batch with zero writes.",
		}),
	},
	STRICT_OBJECT,
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeParams = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
