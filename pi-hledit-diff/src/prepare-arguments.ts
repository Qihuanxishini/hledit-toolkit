import {
	FILE_CHANGE_GROUPS,
	MAX_FILE_CHANGE_COUNT,
	MAX_REPLACEMENT_LINE_COUNT,
	MAX_REPLACEMENT_TEXT_BYTES,
	type CanonicalFileChange,
	type FileChangeGroup,
	type FileChangeInput,
	type FileChangeParams,
} from "./schema.ts";

export type FileChangeInputDecoding =
	| { params: FileChangeParams }
	| { error: string };

type FileChangeDecodeInput = Omit<FileChangeInput, "proof_id"> & { proof_id?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GROUP_FIELDS: Record<FileChangeGroup, readonly string[]> = {
	replace_ranges: ["start_anchor", "end_anchor", "lines"],
	delete_ranges: ["start_anchor", "end_anchor"],
	insert_before: ["anchor", "lines"],
	insert_after: ["anchor", "lines"],
};

function groupedInputRejection(args: unknown): string | undefined {
	if (!isRecord(args)) return "The apply request must be an object.";
	if (Object.hasOwn(args, "changes")) {
		return "changes is no longer accepted. Use replace_ranges, delete_ranges, insert_before and insert_after arrays without operation fields; use [] for unused groups.";
	}
	let total = 0;
	for (const group of FILE_CHANGE_GROUPS) {
		const items = args[group];
		if (!Array.isArray(items)) return `${group} must be an array; use [] when unused (do not omit it or pass null).`;
		total += items.length;
		if (total > MAX_FILE_CHANGE_COUNT) return `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} items across all four groups.`;
		const fields = GROUP_FIELDS[group];
		for (const [index, item] of items.entries()) {
			const label = `${group}[${index}]`;
			if (!isRecord(item)) return `${label} must be an object with ${fields.join(", ")}.`;
			const missing = fields.filter((field) => item[field] === undefined || item[field] === null);
			const unexpected = Object.keys(item).filter((field) => !fields.includes(field));
			if (missing.length || unexpected.length) {
				return `${label} was rejected: ${[
					...(missing.length ? [`requires ${missing.join(" and ")}`] : []),
					...(unexpected.length ? [`must not carry ${unexpected.join(" and ")}`] : []),
				].join("; ")}. Use only ${fields.join(", ")}; the group selects the operation.`;
			}
			for (const field of fields) {
				if (typeof item[field] !== "string") return `${label}.${field} must be a string${field === "lines" ? " of raw text, not an array" : ""}.`;
			}
		}
	}
	if (total < 1) return `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} items across all four groups.`;
	return undefined;
}

// [喵喵喵]: prepareArguments 早于宿主类型转换；只诊断，不补值、删字段或改变编辑语义。
export function prepareFileChangeArguments(args: unknown): FileChangeInput {
	const rejection = groupedInputRejection(args);
	if (rejection) throw new Error(`${rejection} No edit was executed; fix the arguments, not the read proof.`);
	return args as FileChangeInput;
}

export function decodeFileChangeInput(input: FileChangeDecodeInput): FileChangeInputDecoding {
	const rejection = groupedInputRejection(input);
	if (rejection) return { error: rejection };

	let replacementBytes = 0;
	let producedLines = 0;
	const changes: CanonicalFileChange[] = [];
	// [喵喵喵]: 显式映射方向，避免同形 insert 被误映射；分组仅改变编号，不改变 CLI 的物理排序。
	const submitted = [
		...input.replace_ranges.map((item) => ({ ...item, operation: "replace_range" as const })),
		...input.delete_ranges.map((item) => ({ ...item, operation: "delete_range" as const })),
		...input.insert_before.map((item) => ({ ...item, operation: "insert_before" as const })),
		...input.insert_after.map((item) => ({ ...item, operation: "insert_after" as const })),
	];
	for (const change of submitted) {
		if (change.operation === "delete_range") {
			changes.push(change);
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

export function formatFileChangeInputMap(input: FileChangeInput): string {
	let changeNumber = 1;
	const groups = FILE_CHANGE_GROUPS.flatMap((group) => {
		const count = input[group].length;
		if (!count) return [];
		const start = changeNumber;
		changeNumber += count;
		return [count === 1 ? `change ${start}=${group}[0]` : `changes ${start}-${changeNumber - 1}=${group}[0-${count - 1}]`];
	});
	return `Input mapping (0-based indexes): ${groups.join("; ")}.`;
}
