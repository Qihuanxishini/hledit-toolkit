import {
	MAX_FILE_CHANGE_COUNT,
	MAX_REPLACEMENT_LINE_COUNT,
	MAX_REPLACEMENT_TEXT_BYTES,
	type CanonicalFileChange,
	type FileChangeInput,
	type FileChangeParams,
} from "./schema.ts";

export type FileChangeInputDecoding =
	| { params: FileChangeParams }
	| { error: string };

type FileChangeDecodeInput = Omit<FileChangeInput, "proof_id"> & { proof_id?: string };
type ChangeFieldKey = "start_anchor" | "end_anchor" | "anchor" | "lines";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

// [喵喵喵]: 分支 schema 负责完整约束；此表只让明确的字段组合错误在 union 校验前得到单条诊断。
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

function changeFieldRejection(change: unknown): string | undefined {
	if (!isRecord(change) || typeof change.operation !== "string" || !Object.hasOwn(CHANGE_FIELD_RULES, change.operation)) return undefined;
	const operation = change.operation as CanonicalFileChange["operation"];
	const rules = CHANGE_FIELD_RULES[operation];
	const missing = rules.required.filter((field) => change[field] === undefined || change[field] === null);
	const unexpected = rules.forbidden.filter((field) => change[field] !== undefined);
	if (missing.length === 0 && unexpected.length === 0) return undefined;
	const problems = [
		...(missing.length > 0 ? [`${operation} requires ${missing.join(" and ")}`] : []),
		...(unexpected.length > 0 ? [`${operation} must not carry ${unexpected.join(" and ")}`] : []),
	];
	return `${problems.join("; ")}. ${rules.guidance}`;
}

// [喵喵喵]: prepareArguments 早于宿主类型转换；只诊断，不补值、删字段或改变编辑语义。
export function prepareFileChangeArguments(args: unknown): FileChangeInput {
	if (isRecord(args) && Array.isArray(args.changes)) {
		for (const [index, change] of args.changes.entries()) {
			const rejection = changeFieldRejection(change);
			if (rejection) throw new Error(`Change ${index + 1} was rejected: ${rejection}`);
		}
	}
	return args as FileChangeInput;
}

export function decodeFileChangeInput(input: FileChangeDecodeInput): FileChangeInputDecoding {
	if (input.changes.length < 1 || input.changes.length > MAX_FILE_CHANGE_COUNT) {
		return { error: `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} changes.` };
	}

	let replacementBytes = 0;
	let producedLines = 0;
	const changes: CanonicalFileChange[] = [];
	for (const [changeIndex, change] of input.changes.entries()) {
		const rejection = changeFieldRejection(change);
		if (rejection) {
			return { error: `Change ${changeIndex + 1} was rejected: ${rejection}` };
		}
		if (change.operation === "delete_range") {
			changes.push({ operation: "delete_range", start_anchor: change.start_anchor, end_anchor: change.end_anchor });
			continue;
		}
		// [喵喵喵]: 与 CLI 文件解析一致：孤立 CR 是正文，只有 LF/CRLF 分隔行。(2026-09-05)
		const lines = change.lines.split(/\r?\n/);
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
		changes.push({ ...change, lines });
	}
	return { params: { path: input.path, ...(input.proof_id ? { proof_id: input.proof_id } : {}), changes } };
}
