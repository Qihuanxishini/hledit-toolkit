import {
	MAX_FILE_CHANGE_COUNT,
	MAX_REPLACEMENT_LINE_COUNT,
	MAX_REPLACEMENT_TEXT_BYTES,
	type CanonicalFileChange,
	type FileChangeInput,
	type FileChangeParams,
	type ReadAnchorsParams,
	type SearchAnchorsParams,
} from "./schema.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


function parseIntegerLike(value: unknown): unknown {
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return value;
}

// [喵喵喵]: 仅转换无歧义的整数表示；保留非法数值供宿主 schema 拒绝，不替调用方改请求。

export function prepareReadAnchorsArguments(args: unknown): ReadAnchorsParams {
	if (!isRecord(args)) return args as ReadAnchorsParams;
	return {
		...args,
		...(Array.isArray(args.windows) ? { windows: args.windows.map((window) => isRecord(window)
			? { ...window, offset: parseIntegerLike(window.offset), limit: parseIntegerLike(window.limit) }
			: window) } : {}),
	} as ReadAnchorsParams;
}

export function prepareSearchAnchorsArguments(args: unknown): SearchAnchorsParams {
	if (!isRecord(args)) return args as SearchAnchorsParams;
	return {
		...args,
		offset: parseIntegerLike(args.offset),
		limit: parseIntegerLike(args.limit),
		context: parseIntegerLike(args.context),
	} as SearchAnchorsParams;
}
export type FileChangeInputDecoding =
	| { params: FileChangeParams }
	| { error: string };

type FileChangeDecodeInput = Omit<FileChangeInput, "proof_id"> & { proof_id?: string };
type ChangeFieldKey = "start_anchor" | "end_anchor" | "anchor" | "lines";

type ChangeFieldRule = {
	required: readonly ChangeFieldKey[];
	forbidden: readonly ChangeFieldKey[];
	guidance: string;
};

const INSERT_FIELD_RULE: ChangeFieldRule = {
	required: ["anchor", "lines"],
	forbidden: ["start_anchor", "end_anchor"],
	guidance: "Use anchor and lines; start_anchor and end_anchor belong to replace_range and delete_range.",
};

// [喵喵喵]: 宿主先校验类型并把可选 null 还原为缺省；此表只约束 operation 与字段组合。
const CHANGE_FIELD_RULES: Record<CanonicalFileChange["operation"], ChangeFieldRule> = {
	replace_range: {
		required: ["start_anchor", "end_anchor", "lines"], forbidden: ["anchor"],
		guidance: "Use start_anchor and end_anchor, repeating the same token for a single-line replacement; anchor is for inserts only.",
	},
	delete_range: {
		required: ["start_anchor", "end_anchor"], forbidden: ["anchor", "lines"],
		guidance: "Use start_anchor and end_anchor; delete_range must not carry anchor or lines (to replace content use replace_range).",
	},
	insert_before: INSERT_FIELD_RULE,
	insert_after: INSERT_FIELD_RULE,
};

function changeFieldRejection(operation: CanonicalFileChange["operation"], fields: Partial<Record<ChangeFieldKey, unknown>>): string | undefined {
	const rules = CHANGE_FIELD_RULES[operation];
	const missing = rules.required.filter((field) => fields[field] === undefined);
	const unexpected = rules.forbidden.filter((field) => fields[field] !== undefined);
	if (missing.length === 0 && unexpected.length === 0) return undefined;
	const problems = [
		...(missing.length > 0 ? [`${operation} requires ${missing.join(" and ")}`] : []),
		...(unexpected.length > 0 ? [`${operation} must not carry ${unexpected.join(" and ")}`] : []),
	];
	return `${problems.join("; ")}. ${rules.guidance}`;
}

export function decodeFileChangeInput(input: FileChangeDecodeInput): FileChangeInputDecoding {
	if (input.changes.length < 1 || input.changes.length > MAX_FILE_CHANGE_COUNT) {
		return { error: `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} changes.` };
	}

	let replacementBytes = 0;
	let producedLines = 0;
	const changes: CanonicalFileChange[] = [];
	for (const [changeIndex, change] of input.changes.entries()) {
		const rejection = changeFieldRejection(change.operation, change);
		if (rejection) {
			return { error: `Change ${changeIndex + 1} was rejected: ${rejection}` };
		}
		// 宿主保证字段类型，组合检查保证必填字段存在；动态规则表不会自动收窄 TypeScript 类型。
		if (change.operation === "delete_range") {
			changes.push({ operation: "delete_range", start_anchor: change.start_anchor!, end_anchor: change.end_anchor! });
			continue;
		}
		// [喵喵喵]: 与 CLI 文件解析一致：孤立 CR 是正文，只有 LF/CRLF 分隔行。(2026-09-05)
		const lines = change.lines!.split(/\r?\n/);
		// 一个尾换行只终止末行；空字符串仍代表一行空文本。
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		for (const [index, line] of lines.entries()) {
			replacementBytes += Buffer.byteLength(line, "utf8");
			if (index > 0) replacementBytes++;
		}
		if (replacementBytes > MAX_REPLACEMENT_TEXT_BYTES) {
			return { error: "Replacement text exceeds the 1 MiB canonical UTF-8 limit." };
		}
		producedLines += lines.length;
		if (producedLines > MAX_REPLACEMENT_LINE_COUNT) {
			return { error: `Replacement output exceeds ${MAX_REPLACEMENT_LINE_COUNT} lines.` };
		}
		changes.push({ ...change, lines } as CanonicalFileChange);
	}
	return { params: { path: input.path, ...(input.proof_id ? { proof_id: input.proof_id } : {}), changes } };
}
