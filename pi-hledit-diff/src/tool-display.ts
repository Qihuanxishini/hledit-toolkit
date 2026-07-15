const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

export type RuntimeToolDefinition = {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	renderShell?: unknown;
	[key: string]: unknown;
};

export type ToolDisplayAdapter = {
	id?: string;
	toolName?: string;
	kind?: "read" | "edit" | "mcp" | "generic";
	overrideExistingRenderers?: boolean;
	getPath?: (args: unknown) => string | undefined;
	getEditLineCount?: (args: unknown) => number;
};

type ToolDisplayApi = {
	version: 1;
	decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
};

type GlobalWithToolDisplayApi = typeof globalThis & {
	[TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
	[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: Array<{
		tool: RuntimeToolDefinition;
		adapter?: ToolDisplayAdapter;
	}>;
};

function getToolDisplayApi(): ToolDisplayApi | undefined {
	const api = (globalThis as GlobalWithToolDisplayApi)[TOOL_DISPLAY_API_KEY];
	if (api?.version !== 1 || typeof api.decorateTool !== "function") {
		return undefined;
	}
	return api;
}

function queueToolDisplayDecoration(tool: RuntimeToolDefinition, adapter: ToolDisplayAdapter): void {
	const globalWithApi = globalThis as GlobalWithToolDisplayApi;
	const existing = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
	const queue = Array.isArray(existing) ? existing : [];
	queue.push({ tool, adapter });
	globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = queue;
}

export function decorateToolForDisplay<T extends RuntimeToolDefinition>(tool: T, adapter: ToolDisplayAdapter): T {
	const api = getToolDisplayApi();
	if (!api) {
		queueToolDisplayDecoration(tool, adapter);
		return tool;
	}

	try {
		return api.decorateTool(tool, adapter);
	} catch {
		return tool;
	}
}
