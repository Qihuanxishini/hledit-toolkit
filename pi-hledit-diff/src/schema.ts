import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

const PATH_SCHEMA = Type.String({ minLength: 1, description: "文本文件路径" });
const ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "从最近一次 hledit_read_anchors 输出中原样复制；可填写 LN#HASH 或完整 LN#HASH:text，prepareArguments 会移除源码文本；不得编造占位锚点",
});
const RANGE_START_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "包含在修改范围内的起始锚点；可原样复制 LN#HASH:text；单行范围与 end_anchor 使用同一个锚点",
});
const RANGE_END_ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "包含在修改范围内的结束锚点；可原样复制 LN#HASH:text；单行范围与 start_anchor 使用同一个锚点",
});
const REPLACEMENT_LINES_SCHEMA = Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), {
	minItems: 1,
	description: "仅填写原始文件行；数组中的每一项必须恰好是一行，不能包含锚点前缀或 diff 标记。",
});

const REPLACE_RANGE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace_range"] as const, {
			description: "替换包含首尾的完整锚点范围；替换单行时 start_anchor 与 end_anchor 必须相同",
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
			description: "删除包含首尾的完整锚点范围；删除单行时 start_anchor 与 end_anchor 必须相同",
		}),
		start_anchor: RANGE_START_ANCHOR_SCHEMA,
		end_anchor: RANGE_END_ANCHOR_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_BEFORE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_before"] as const, { description: "在锚点行之前插入原始文件行" }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const INSERT_AFTER_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert_after"] as const, { description: "在锚点行之后插入原始文件行" }),
		anchor: ANCHOR_SCHEMA,
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

export const HLEDIT_READ_ANCHORS_PARAMS_SCHEMA = Type.Object(
	{
		path: PATH_SCHEMA,
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "从第几行开始读取（从 1 计数）" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: `最多返回多少行（不超过 ${MAX_READ_LIMIT}）` })),
		grep: Type.Optional(Type.String({ description: "子字符串过滤条件" })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "每个 grep 匹配项前后附带的上下文行数" })),
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
					"同一文件的一组完整、互不冲突的原子修改。范围操作必须同时提供 start_anchor 与 end_anchor；任一项无效或锚点失效都会使整批次零写入。",
			},
		),
	},
	STRICT_OBJECT,
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeParams = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
