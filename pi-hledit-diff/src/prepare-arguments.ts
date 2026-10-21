import { anchorTokenLine } from "./anchor.ts";
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
const MAX_INPUT_DIAGNOSTICS = 8;

// [喵喵喵]: 限额拒绝在 CLI 之前返回，需与其它拒绝路径一致地声明零写入并给出下一步。
const LIMIT_REJECTION_TAIL = " No edit was executed; split the batch into smaller requests and retry.";

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

	// [喵喵喵]: 汇总独立字段错误，避免删掉额外字段后才发现锚点格式错误；只诊断，不修参。
	const issues: string[] = [];
	for (const [index, item] of changes.entries()) {
		const label = `changes[${index}]`;
		if (!isRecord(item)) {
			issues.push(`${label} must be an object.`);
		} else {
			const action = item.action;
			const validAction = typeof action === "string" && CHANGE_ACTIONS.includes(action as ChangeAction);
			if (!validAction) {
				issues.push(`${label}.action must be one of ${CHANGE_ACTIONS.map((a) => `'${a}'`).join(", ")}.`);
			}

			const unexpected = Object.keys(item).filter((field) => !CHANGE_FIELDS.includes(field));
			if (unexpected.length > 0) {
				issues.push(`${label} (${validAction ? action : "invalid action"}) was rejected: must not carry ${unexpected.slice(0, MAX_INPUT_DIAGNOSTICS).join(" and ")}${unexpected.length > MAX_INPUT_DIAGNOSTICS ? " or other unexpected fields" : ""}. Use only ${CHANGE_FIELDS.join(", ")}.`);
			}
			if (!Array.isArray(item.anchors) || item.anchors.length < 1 || item.anchors.length > 2) {
				issues.push(`${label}.anchors must be an array of 1-2 anchor tokens. Use [anchor] for a single line or insert, or [start, end] for a replace range; do not enumerate interior lines.`);
			} else {
				for (const [anchorIndex, anchor] of item.anchors.entries()) {
					if (typeof anchor !== "string") {
						issues.push(`${label}.anchors[${anchorIndex}] must be a string anchor token.`);
					} else if (anchorTokenLine(anchor) === undefined) {
						issues.push(`${label}.anchors[${anchorIndex}] must be one complete LN#HASH token copied from read output. For a replace range, use two separate array elements [start, end], not a joined string; do not guess hashes.`);
					}
				}
				if (validAction && action !== "replace" && item.anchors.length !== 1) {
					issues.push(`${label} (${action}) requires exactly one anchor in anchors.`);
				}
			}
			if (typeof item.lines !== "string") {
				issues.push(validAction && action !== "replace"
					? `${label}.lines must be a raw text string; ${action} requires non-empty text.`
					: `${label}.lines must be a raw text string; use \"\" to delete with replace.`);
			} else if (validAction && action !== "replace" && item.lines.length === 0) {
				issues.push(`${label} (${action}) requires a non-empty lines string.`);
			}
		}
		if (issues.length > MAX_INPUT_DIAGNOSTICS) break;
	}

	return issues.length === 0 ? undefined : issues.slice(0, MAX_INPUT_DIAGNOSTICS).join(" ") +
		(issues.length > MAX_INPUT_DIAGNOSTICS ? " Additional argument errors were omitted; fix these and resubmit." : "");
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
			return { error: `changes[${index}] pushes the batch past the 1 MiB canonical UTF-8 replacement limit (cumulative across all changes).${LIMIT_REJECTION_TAIL}` };
		}
		producedLines += lines.length;
		if (producedLines > MAX_REPLACEMENT_LINE_COUNT) {
			return { error: `changes[${index}] pushes the batch past the ${MAX_REPLACEMENT_LINE_COUNT}-line replacement limit (cumulative across all changes).${LIMIT_REJECTION_TAIL}` };
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
