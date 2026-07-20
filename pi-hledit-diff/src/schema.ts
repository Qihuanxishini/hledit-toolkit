import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ANCHOR_PATTERN } from "./file-changes.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";

const STRICT_OBJECT = { additionalProperties: false };

const PATH_SCHEMA = Type.String({ minLength: 1, description: "文本文件路径" });
const ANCHOR_SCHEMA = Type.String({
	pattern: ANCHOR_PATTERN,
	description: "从最近一次 hledit_read_anchors 输出中原样复制的 LN#HASH；不得编造 #??、#XX 等占位锚点",
});
const REPLACEMENT_LINES_SCHEMA = Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), {
	minItems: 1,
	description: "仅填写原始文件行；数组中的每一项必须恰好是一行，不能包含锚点前缀或 diff 标记。",
});

const REPLACE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["replace"] as const, {
			description: "替换一个锚点行；提供 end_anchor 时替换含首尾的范围。多行 lines 不会自动消耗后续源文件行；替换代码块必须显式提供 end_anchor",
		}),
		anchor: ANCHOR_SCHEMA,
		end_anchor: Type.Optional(
			Type.String({
				pattern: ANCHOR_PATTERN,
				description: "包含在替换范围内的结束锚点；替换后续现有行时必须与 anchor 放在同一项 replace 中",
			}),
		),
		lines: REPLACEMENT_LINES_SCHEMA,
	},
	STRICT_OBJECT,
);

const DELETE_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["delete"] as const, { description: "删除一个锚点行，或删除包含首尾的锚点范围" }),
		anchor: ANCHOR_SCHEMA,
		end_anchor: Type.Optional(Type.String({ pattern: ANCHOR_PATTERN, description: "包含在删除范围内的结束锚点" })),
	},
	STRICT_OBJECT,
);

const INSERT_CHANGE_SCHEMA = Type.Object(
	{
		operation: StringEnum(["insert"] as const, { description: "在一个锚点处插入原始文件行" }),
		anchor: ANCHOR_SCHEMA,
		position: StringEnum(["before", "after"] as const, { description: "插入到锚点之前或之后" }),
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
		changes: Type.Array(Type.Union([REPLACE_CHANGE_SCHEMA, DELETE_CHANGE_SCHEMA, INSERT_CHANGE_SCHEMA]), {
			minItems: 1,
			description: "同一文件的一组完整、互不冲突的原子修改。不得混入读取操作、占位锚点或未完成的修改；任一项无效或锚点失效都会使整批次零写入。",
		}),
	},
	STRICT_OBJECT,
);

export type ReadAnchorsParams = Static<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA>;
export type FileChangeParams = Static<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA>;
