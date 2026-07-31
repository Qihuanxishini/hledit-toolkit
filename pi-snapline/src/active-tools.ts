import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "./schema.ts";

const LEGACY_EDIT_TOOL_NAMES = new Set([
	"hledit",
	"hledit_read_anchors",
	"hledit_apply_file_changes",
]);

function uniqueToolNames(toolNames: readonly string[]): string[] {
	return [...new Set(toolNames)];
}

export function preferSnaplineTools(activeTools: readonly string[], applyActive: boolean): string[] {
	const retained = activeTools.filter((toolName) =>
		toolName !== "read" &&
		toolName !== "edit" &&
		toolName !== SNAPLINE_READ_TOOL &&
		toolName !== SNAPLINE_APPLY_TOOL &&
		!LEGACY_EDIT_TOOL_NAMES.has(toolName),
	);
	return uniqueToolNames([
		...retained,
		SNAPLINE_READ_TOOL,
		...(applyActive ? [SNAPLINE_APPLY_TOOL] : []),
	]);
}

export function activateSnaplineApply(activeTools: readonly string[]): string[] {
	return activeTools.includes(SNAPLINE_APPLY_TOOL)
		? [...activeTools]
		: [...activeTools, SNAPLINE_APPLY_TOOL];
}

export function preferNativeFallbackTools(activeTools: readonly string[]): string[] {
	const retained = activeTools.filter((toolName) =>
		toolName !== SNAPLINE_READ_TOOL &&
		toolName !== SNAPLINE_APPLY_TOOL,
	);
	return uniqueToolNames([...retained, "read", "edit"]);
}

export function preferLegacyConflictTools(activeTools: readonly string[]): string[] {
	return uniqueToolNames(activeTools.filter((toolName) =>
		toolName !== SNAPLINE_READ_TOOL && toolName !== SNAPLINE_APPLY_TOOL,
	));
}

export function hasLegacyHleditConflict(allToolNames: readonly string[]): boolean {
	return allToolNames.some((toolName) => LEGACY_EDIT_TOOL_NAMES.has(toolName));
}

export function isSnaplineTool(toolName: string): boolean {
	return toolName === SNAPLINE_READ_TOOL || toolName === SNAPLINE_APPLY_TOOL;
}
