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
		offset: parseIntegerLike(args.offset),
		limit: parseIntegerLike(args.limit),
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
export function decodeFileChangeInput(input: FileChangeDecodeInput): FileChangeInputDecoding {
	if (input.changes.length < 1 || input.changes.length > MAX_FILE_CHANGE_COUNT) {
		return { error: `Atomic batch must contain 1-${MAX_FILE_CHANGE_COUNT} changes.` };
	}

	let replacementBytes = 0;
	let producedLines = 0;
	const changes: CanonicalFileChange[] = [];
	for (const change of input.changes) {
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
