import {
	CHANGE_ACTIONS,
	MAX_FILE_CHANGE_COUNT,
	MAX_REPLACEMENT_LINE_COUNT,
	MAX_REPLACEMENT_TEXT_BYTES,
	type CanonicalFileChange,
	type ChangeAction,
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

const ACTION_ALLOWED_FIELDS: Record<ChangeAction, readonly string[]> = {
	replace: ["action", "anchor", "end_anchor", "lines"],
	insert_before: ["action", "anchor", "lines"],
	insert_after: ["action", "anchor", "lines"],
};

function changeInputRejection(args: unknown): string | undefined {
	if (!isRecord(args)) return "The apply request must be an object.";

	if (
		Object.hasOwn(args, "replace_ranges") ||
		Object.hasOwn(args, "delete_ranges") ||
		Object.hasOwn(args, "insert_before") ||
		Object.hasOwn(args, "insert_after")
	) {
		return "Grouped arrays (replace_ranges, delete_ranges, etc.) are no longer supported. Use a single 'changes' array with action: 'replace', 'insert_before', or 'insert_after'.";
	}

	const changes = args.changes;
	if (!Array.isArray(changes)) {
		return "changes must be an array of change objects.";
	}
	if (changes.length < 1 || changes.length > MAX_FILE_CHANGE_COUNT) {
		return `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} items in changes.`;
	}

	for (const [index, item] of changes.entries()) {
		const label = `changes[${index}]`;
		if (!isRecord(item)) return `${label} must be an object.`;

		const action = item.action;
		if (typeof action !== "string" || !CHANGE_ACTIONS.includes(action as ChangeAction)) {
			return `${label}.action must be one of ${CHANGE_ACTIONS.map((a) => `'${a}'`).join(", ")}.`;
		}

		if (typeof item.anchor !== "string") {
			return `${label}.anchor must be a string anchor token.`;
		}

		const allowedFields = ACTION_ALLOWED_FIELDS[action as ChangeAction];
		const unexpected = Object.keys(item).filter((field) => !allowedFields.includes(field));
		if (unexpected.length > 0) {
			return `${label} (${action}) was rejected: must not carry ${unexpected.join(" and ")}. Use only ${allowedFields.join(", ")}.`;
		}

		if (action === "replace") {
			if (item.end_anchor !== undefined && typeof item.end_anchor !== "string") {
				return `${label}.end_anchor must be a string anchor token when provided.`;
			}
			if (item.lines !== undefined && typeof item.lines !== "string") {
				return `${label}.lines must be a raw text string when provided; omit or pass \"\" to delete.`;
			}
		} else {
			if (typeof item.lines !== "string" || item.lines.length === 0) {
				return `${label} (${action}) requires a non-empty lines string.`;
			}
		}
	}

	return undefined;
}

// [喵喵喵]: prepareArguments 早于宿主类型转换；只诊断，不补值、删字段或改变编辑语义。
export function prepareFileChangeArguments(args: unknown): FileChangeInput {
	const rejection = changeInputRejection(args);
	if (rejection) throw new Error(`${rejection} No edit was executed; fix the arguments, not the read proof.`);
	return args as FileChangeInput;
}

type ReplacementMeasure = { lines: string[] } | { error: string };
export function decodeFileChangeInput(input: FileChangeDecodeInput): FileChangeInputDecoding {
	const rejection = changeInputRejection(input);
	if (rejection) return { error: rejection };

	let replacementBytes = 0;
	let producedLines = 0;
	const changes: CanonicalFileChange[] = [];

	// [喵喵喵]: replace 与 insert 共享同一套替换文本记账（1 MiB / 输出行上限），规则只在此处定义一次。
	const measureReplacement = (text: string): ReplacementMeasure => {
		const lines = text.split(/\r?\n/);
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
		return { lines };
	};

	for (const [index, item] of input.changes.entries()) {
		if (item.action === "replace") {
			const start_anchor = item.anchor;
			const end_anchor = item.end_anchor ?? item.anchor;
			// [喵喵喵]: lines 缺失或为空字符串即代表删除，映射为 0 行 replacement。
			if (item.lines === undefined || item.lines === "") {
				changes.push({ operation: "replace", start_anchor, end_anchor, lines: [] });
				continue;
			}
			const measured = measureReplacement(item.lines);
			if ("error" in measured) return { error: measured.error };
			changes.push({ operation: "replace", start_anchor, end_anchor, lines: measured.lines });
		} else {
			// [喵喵喵]: 插入的 lines 必填且非空由前置诊断保证；此处再收窄一次，不用非空断言。
			if (item.lines === undefined) {
				return { error: `changes[${index}] (${item.action}) requires a non-empty lines string.` };
			}
			const measured = measureReplacement(item.lines);
			if ("error" in measured) return { error: measured.error };
			changes.push({ operation: item.action, anchor: item.anchor, lines: measured.lines });
		}
	}

	return { params: { path: input.path, ...(input.proof_id ? { proof_id: input.proof_id } : {}), changes } };
}
