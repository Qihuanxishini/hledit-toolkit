export const HLEDIT_READ_TOOL = "read";
export const HLEDIT_READ_ANCHORS_TOOL = "read_windows";
export const HLEDIT_SEARCH_ANCHORS_TOOL = "hledit_search_anchors";
export const HLEDIT_APPLY_FILE_CHANGES_TOOL = "edit";

const RETIRED_TOOLS = new Set(["hledit", "hledit_read_anchors", "hledit_apply_file_changes"]);

export function preferAnchoredEditingTools(activeTools: string[], availableTools: readonly string[]): string[] {
	return [...new Set([
		...activeTools.filter((name) => !RETIRED_TOOLS.has(name)),
		...[HLEDIT_READ_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]
			.filter((name) => availableTools.includes(name)),
	])];
}

// [喵喵喵]: 旧名称仅用于恢复历史事件，不注册为可调用别名。
export function isAnchoredReadTool(name: string): boolean {
	return name === HLEDIT_READ_TOOL || name === HLEDIT_READ_ANCHORS_TOOL || name === HLEDIT_SEARCH_ANCHORS_TOOL || name === "hledit_read_anchors";
}

export function isAnchoredEditTool(name: string): boolean {
	return name === HLEDIT_APPLY_FILE_CHANGES_TOOL || name === "hledit_apply_file_changes";
}
