export const HLEDIT_READ_ANCHORS_TOOL = "hledit_read_anchors";
export const HLEDIT_APPLY_FILE_CHANGES_TOOL = "hledit_apply_file_changes";

const HLEDIT_TOOL_NAMES = new Set(["edit", "hledit", HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL]);

export function preferAnchoredReadTool(activeTools: string[]): string[] {
	const withoutReplacedTools = activeTools.filter((toolName) => !HLEDIT_TOOL_NAMES.has(toolName));
	return [...withoutReplacedTools, HLEDIT_READ_ANCHORS_TOOL];
}

export function preferAnchoredEditingTools(activeTools: string[]): string[] {
	const withoutReplacedTools = activeTools.filter((toolName) => !HLEDIT_TOOL_NAMES.has(toolName));
	return [...withoutReplacedTools, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_APPLY_FILE_CHANGES_TOOL];
}

export function preferBuiltInEditFallback(activeTools: string[]): string[] {
	const fallbackTools: string[] = [];
	let hasBuiltInEdit = false;
	for (const toolName of activeTools) {
		if (toolName === "hledit" || isAnchoredEditingTool(toolName)) {
			continue;
		}
		if (toolName === "edit") {
			if (!hasBuiltInEdit) {
				fallbackTools.push(toolName);
				hasBuiltInEdit = true;
			}
			continue;
		}
		fallbackTools.push(toolName);
	}
	return hasBuiltInEdit ? fallbackTools : [...fallbackTools, "edit"];
}

export function isAnchoredEditingTool(toolName: string): boolean {
	return toolName === HLEDIT_READ_ANCHORS_TOOL || toolName === HLEDIT_APPLY_FILE_CHANGES_TOOL;
}
