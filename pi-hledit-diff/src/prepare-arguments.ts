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

const CHANGE_FIELDS = ["action", "anchors", "lines"];

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

		const unexpected = Object.keys(item).filter((field) => !CHANGE_FIELDS.includes(field));
		if (unexpected.length > 0) {
			return `${label} (${action}) was rejected: must not carry ${unexpected.join(" and ")}. Use only ${CHANGE_FIELDS.join(", ")}.`;
		}
		if (!Array.isArray(item.anchors) || item.anchors.length < 1 || item.anchors.length > 2) {
			return `${label}.anchors must be an array of 1-2 anchor tokens.`;
		}
		for (const [anchorIndex, anchor] of item.anchors.entries()) {
			if (typeof anchor !== "string") return `${label}.anchors[${anchorIndex}] must be a string anchor token.`;
		}
		if (action !== "replace" && item.anchors.length !== 1) {
			return `${label} (${action}) requires exactly one anchor in anchors.`;
		}
		// [喵喵喵]: 单行只用一个端点，使 canonical 结果能够准确回指公开参数，而无需另存输入形状。
		if (item.anchors.length === 2 && item.anchors[0] === item.anchors[1]) {
			return `${label}.anchors repeats the same token; use one anchor for a single-line replace.`;
		}
		if (typeof item.lines !== "string") {
			return `${label}.lines must be a raw text string; use \"\" to delete.`;
		}
		if (action !== "replace" && item.lines.length === 0) {
			return `${label} (${action}) requires a non-empty lines string.`;
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
	const measureReplacement = (index: number, text: string): ReplacementMeasure => {
		const lines = text.split(/\r?\n/);
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		for (const [lineIndex, line] of lines.entries()) {
			replacementBytes += Buffer.byteLength(line, "utf8");
			if (lineIndex > 0) replacementBytes++;
		}
		if (replacementBytes > MAX_REPLACEMENT_TEXT_BYTES) {
			return { error: `changes[${index}] pushes the batch past the 1 MiB canonical UTF-8 replacement limit (cumulative across all changes).` };
		}
		producedLines += lines.length;
		if (producedLines > MAX_REPLACEMENT_LINE_COUNT) {
			return { error: `changes[${index}] pushes the batch past the ${MAX_REPLACEMENT_LINE_COUNT}-line replacement limit (cumulative across all changes).` };
		}
		return { lines };
	};

	for (const [index, item] of input.changes.entries()) {
		if (item.action === "replace") {
			const start_anchor = item.anchors[0]!;
			const end_anchor = item.anchors[1] ?? start_anchor;
			// [喵喵喵]: 空字符串表示删除，映射为 0 行 replacement；缺失 lines 已在入口拒绝。
			if (item.lines === "") {
				changes.push({ operation: "replace", start_anchor, end_anchor, lines: [] });
				continue;
			}
			const measured = measureReplacement(index, item.lines);
			if ("error" in measured) return { error: measured.error };
			changes.push({ operation: "replace", start_anchor, end_anchor, lines: measured.lines });
		} else {
			const measured = measureReplacement(index, item.lines);
			if ("error" in measured) return { error: measured.error };
			changes.push({ operation: item.action, anchor: item.anchors[0]!, lines: measured.lines });
		}
	}

	return { params: { path: input.path, ...(input.proof_id ? { proof_id: input.proof_id } : {}), changes } };
}
