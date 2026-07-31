import { Type, type Static } from "typebox";

const STRICT_OBJECT = { additionalProperties: false } as const;

export const SNAPLINE_READ_TOOL = "snapline_read_file";
export const SNAPLINE_APPLY_TOOL = "snapline_apply_changes";

export const SNAPLINE_READ_DESCRIPTION = "Read a text file and return numbered source plus a path-bound snapshot for safe editing. Images use Pi's native reader.";
export const SNAPLINE_APPLY_DESCRIPTION = "Atomically apply one non-overlapping batch to lines exposed by one snapshot. Keep coordinates with that snapshot; ranges are 1-based and inclusive. Invalid, conflicting, or stale requests write nothing. Text uses \n between logical lines. For an empty snapshot, insert before line 1; its final \n sets the new trailing newline.";

export const DEFAULT_READ_LIMIT = 160;
export const MAX_READ_LIMIT = 2000;
export const SNAPSHOT_ID_PATTERN = "^s_[A-Za-z0-9_-]{16}(?:[A-Za-z0-9_-]{27})?$";

const PATH_SCHEMA = Type.String({ minLength: 1, description: "Text file path." });
const SNAPSHOT_SCHEMA = Type.String({ pattern: SNAPSHOT_ID_PATTERN, description: "Snapshot returned by snapline_read_file." });
const START_SCHEMA = Type.Integer({ minimum: 1, description: "First source line (inclusive)." });
const END_SCHEMA = Type.Integer({ minimum: 1, description: "Last source line (inclusive)." });
const LINE_SCHEMA = Type.Integer({ minimum: 1, description: "Source attachment line." });
const TEXT_SCHEMA = Type.String({ description: "New logical lines separated by \n." });

const REPLACEMENT_SCHEMA = Type.Object(
	{ start: START_SCHEMA, end: END_SCHEMA, text: TEXT_SCHEMA },
	STRICT_OBJECT,
);
const DELETION_SCHEMA = Type.Object(
	{ start: START_SCHEMA, end: END_SCHEMA },
	STRICT_OBJECT,
);
const INSERTION_SCHEMA = Type.Object(
	{ line: LINE_SCHEMA, text: TEXT_SCHEMA },
	STRICT_OBJECT,
);

export const SNAPLINE_READ_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based; default 1)." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: "Maximum lines (default 160; 2,000 max)." })),
	},
	STRICT_OBJECT,
);

export const SNAPLINE_APPLY_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		snapshot: SNAPSHOT_SCHEMA,
		replacements: Type.Optional(Type.Array(REPLACEMENT_SCHEMA, {
			minItems: 1,
			maxItems: 100,
			description: "Replace inclusive source ranges.",
		})),
		deletions: Type.Optional(Type.Array(DELETION_SCHEMA, {
			minItems: 1,
			maxItems: 100,
			description: "Delete inclusive source ranges.",
		})),
		insertions_before: Type.Optional(Type.Array(INSERTION_SCHEMA, {
			minItems: 1,
			maxItems: 100,
			description: "Insert before source lines.",
		})),
		insertions_after: Type.Optional(Type.Array(INSERTION_SCHEMA, {
			minItems: 1,
			maxItems: 100,
			description: "Insert after source lines.",
		})),
	},
	STRICT_OBJECT,
);

export type SnaplineReadParams = Static<typeof SNAPLINE_READ_PARAMS_SCHEMA>;
export type SnaplineApplyParams = Static<typeof SNAPLINE_APPLY_PARAMS_SCHEMA>;
export type SnaplineReplacement = NonNullable<SnaplineApplyParams["replacements"]>[number];
export type SnaplineDeletion = NonNullable<SnaplineApplyParams["deletions"]>[number];
export type SnaplineInsertion = NonNullable<SnaplineApplyParams["insertions_before"]>[number];
