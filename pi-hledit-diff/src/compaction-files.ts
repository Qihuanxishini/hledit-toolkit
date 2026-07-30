import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
} from "./active-tools.ts";

// 与宿主 compaction FileOperations 的结构子集对齐（written 由内置 write 工具独占）。
type AnchoredCompactionFileOps = {
	read: Set<string>;
	edited: Set<string>;
};

// Pi 内置 compaction 文件提取只识别名为 read/write/edit 的工具调用参数；两个
// hledit 工具的文件操作必须在 session_before_compact 中补充，否则压缩摘要会
// 丢失 readFiles/modifiedFiles。只信任结构化 tool result 的 disposition 与
// normalized path，不从聊天正文猜测文件状态：
// - 读取成功 → read；
// - apply 成功且内容变更 → edited；
// - 成功 no-op（contentChanged === false，字节未变）→ read；
// - outcome_unknown → edited（保守：可能已写入，压缩后必须按已修改重读）；
// - rejected/unavailable 零写入 → 不记录。
export function recordAnchoredFileOperations(messages: unknown[], fileOps: AnchoredCompactionFileOps): void {
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "toolResult" || typeof candidate.toolName !== "string") continue;
		const details = candidate.details;
		if (typeof details !== "object" || details === null) continue;
		const { disposition, path, contentChanged } = details as Record<string, unknown>;
		if (typeof path !== "string" || path.length === 0) continue;

		if (candidate.toolName === HLEDIT_READ_ANCHORS_TOOL) {
			if (disposition === "succeeded") fileOps.read.add(path);
			continue;
		}
		if (candidate.toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) continue;
		if (disposition === "succeeded") {
			if (contentChanged === false) fileOps.read.add(path);
			else fileOps.edited.add(path);
			continue;
		}
		if (disposition === "outcome_unknown") fileOps.edited.add(path);
	}
}
