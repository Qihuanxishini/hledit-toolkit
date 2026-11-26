import { isAnchoredEditTool, isAnchoredReadTool } from "./active-tools.ts";
import { parseRecoveredReads } from "./read-result.ts";
import { parseWindowsReadMetadata } from "./read-windows.ts";

// 与宿主 compaction FileOperations 的结构子集对齐（written 由内置 write 工具独占）。
type AnchoredCompactionFileOps = {
	read: Set<string>;
	edited: Set<string>;
};

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue | undefined =>
	typeof value === "object" && value !== null ? value as RecordValue : undefined;

function anchoredResult(message: RecordValue): RecordValue | undefined {
	const name = message.toolName;
	if (message.role !== "toolResult" || typeof name !== "string"
		|| (!isAnchoredReadTool(name) && !isAnchoredEditTool(name))) return undefined;
	const details = asRecord(message.details);
	if (!details || ((name === "read" || name === "edit") && details.evidenceVersion !== 2)) return undefined;
	return details;
}

function recordResult(name: string, details: RecordValue, fileOps: AnchoredCompactionFileOps): void {
	const { disposition, path, contentChanged } = details;
	if (typeof path !== "string" || path.length === 0) return;
	if (isAnchoredReadTool(name)) {
		if (disposition === "succeeded") fileOps.read.add(path);
		else {
			const windowsRead = parseWindowsReadMetadata(details.windowsRead);
			if (windowsRead?.path === path && windowsRead.windows.some((window) => window.lines.length > 0)) fileOps.read.add(path);
		}
		return;
	}
	if (parseRecoveredReads(details).length > 0) fileOps.read.add(path);
	if (disposition === "succeeded") {
		if (contentChanged === true) fileOps.edited.add(path);
		else if (contentChanged === false) fileOps.read.add(path);
	} else if (disposition === "outcome_unknown") fileOps.edited.add(path);
}

// [喵喵喵]: 宿主先按调用名预登记；只撤销能与本插件结果配对的贡献，再合并实际结果。
// 同路径的原生/嵌套调用和上一轮压缩记录必须保留，不能对 rejected 简单 delete(path)。
export function recordAnchoredFileOperations(messages: unknown[], fileOps: AnchoredCompactionFileOps, previousDetails?: unknown): void {
	const results = new Map<string, { name: string; details: RecordValue }>();
	const records = messages.map(asRecord).filter((message): message is RecordValue => message !== undefined);
	for (const message of records) {
		const details = anchoredResult(message);
		if (details && typeof message.toolCallId === "string") results.set(message.toolCallId, { name: message.toolName as string, details });
	}

	const removed: AnchoredCompactionFileOps = { read: new Set(), edited: new Set() };
	const retained: AnchoredCompactionFileOps = { read: new Set(), edited: new Set() };
	const previous = asRecord(previousDetails);
	for (const path of Array.isArray(previous?.readFiles) ? previous.readFiles : []) if (typeof path === "string") retained.read.add(path);
	for (const path of Array.isArray(previous?.modifiedFiles) ? previous.modifiedFiles : []) if (typeof path === "string") retained.edited.add(path);

	const recordCall = (call: RecordValue, nested: boolean) => {
		const args = asRecord(call.arguments);
		if (typeof args?.path !== "string" || !args.path || (call.name !== "read" && call.name !== "edit")) return;
		const result = typeof call.id === "string" ? results.get(call.id) : undefined;
		const target = !nested && result?.name === call.name ? removed : retained;
		(call.name === "read" ? target.read : target.edited).add(args.path);
	};
	for (const message of records) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				const call = asRecord(block);
				if (call?.type === "toolCall") recordCall(call, false);
			}
		} else if (message.role === "toolResult") {
			const nestedCalls = asRecord(message.nestedCalls)?.calls;
			if (Array.isArray(nestedCalls)) for (const call of nestedCalls) {
				const record = asRecord(call);
				if (record) recordCall(record, true);
			}
		}
	}
	for (const key of ["read", "edited"] as const) {
		for (const path of removed[key]) if (!retained[key].has(path)) fileOps[key].delete(path);
	}
	for (const message of records) {
		const details = anchoredResult(message);
		if (details) recordResult(message.toolName as string, details, fileOps);
	}
}
