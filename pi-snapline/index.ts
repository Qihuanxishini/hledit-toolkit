import {
	createReadToolDefinition,
	createWriteToolDefinition,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ReadToolDetails,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

import {
	activateSnaplineApply,
	hasLegacyHleditConflict,
	preferLegacyConflictTools,
	preferNativeFallbackTools,
	preferSnaplineTools,
} from "./src/active-tools.ts";
import { runSnaplineApplyTransaction } from "./src/apply-transaction.ts";
import { parseSnaplineCapabilities, resolveSnaplineBin, runSnapline, SNAPLINE_INSTALL_HINT } from "./src/cli.ts";
import { recordSnaplineFileOperations } from "./src/compaction-files.ts";
import { guardedCreateFile } from "./src/guarded-write.ts";
import { prepareSnaplineReadArguments } from "./src/read-arguments.ts";
import { runSnaplineReadTransaction } from "./src/read-transaction.ts";
import { restoreSnapshotLedgerFromBranch } from "./src/replay.ts";
import {
	renderSnaplineApplyResult,
	renderSnaplineCall,
	renderSnaplineReadResult,
	type RenderTheme,
	type ToolRenderContextLike,
} from "./src/render.ts";
import {
	SNAPLINE_APPLY_DESCRIPTION,
	SNAPLINE_APPLY_PARAMS_SCHEMA,
	SNAPLINE_APPLY_TOOL,
	SNAPLINE_READ_DESCRIPTION,
	SNAPLINE_READ_PARAMS_SCHEMA,
	SNAPLINE_READ_TOOL,
	type SnaplineApplyParams,
	type SnaplineReadParams,
} from "./src/schema.ts";
import { SnapshotLedger } from "./src/snapshot-ledger.ts";
import { textToolResult, type SnaplineApplyDetails, type SnaplineReadDetails } from "./src/tool-details.ts";

export {
	SNAPLINE_APPLY_DESCRIPTION,
	SNAPLINE_APPLY_PARAMS_SCHEMA,
	SNAPLINE_APPLY_TOOL,
	SNAPLINE_READ_DESCRIPTION,
	SNAPLINE_READ_PARAMS_SCHEMA,
	SNAPLINE_READ_TOOL,
} from "./src/schema.ts";
export type { SnaplineApplyParams, SnaplineReadParams } from "./src/schema.ts";

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnaplineReadDetails(value: unknown): value is SnaplineReadDetails {
	return isRecord(value) && value.protocolVersion === 1 && value.operation === "read";
}

function snaplineResultIsError(toolName: string, details: unknown): boolean | undefined {
	if (!isRecord(details) || details.protocolVersion !== 1 || typeof details.disposition !== "string") return undefined;
	if (toolName === SNAPLINE_READ_TOOL && details.operation === "read") return details.disposition !== "succeeded";
	if (toolName === SNAPLINE_APPLY_TOOL && details.operation === "apply") {
		return details.disposition !== "succeeded" && details.disposition !== "needs_review";
	}
	return undefined;
}

function externalMutationMayHaveChanged(toolName: string, isError: boolean, details: unknown): boolean {
	if (toolName !== "write" && toolName !== "edit" && toolName !== "hledit" && toolName !== "hledit_apply_file_changes") return false;
	if (!isError) return true;
	if (toolName === "write" || toolName === "edit") return true;
	return isRecord(details) && details.disposition === "outcome_unknown";
}

export default function piSnaplineExtension(pi: ExtensionAPI): void {
	const ledger = new SnapshotLedger();
	let mode: "healthy" | "fallback" | "conflict" = "fallback";
	let pendingFallbackMessage: string | undefined;
	let warnedUnavailable = false;
	let warnedConflict = false;
	let applyActive = false;

	const setActiveTools = (next: string[]) => {
		const active = pi.getActiveTools();
		if (!sameToolSet(active, next)) pi.setActiveTools(next);
	};
	const synchronizeHealthyTools = () => {
		if (mode !== "healthy") return;
		applyActive = ledger.hasEditableSnapshot();
		setActiveTools(preferSnaplineTools(pi.getActiveTools(), applyActive));
	};
	const activateApplyAdditively = () => {
		if (mode !== "healthy" || applyActive || !ledger.hasEditableSnapshot()) return;
		applyActive = true;
		const active = pi.getActiveTools();
		const next = activateSnaplineApply(active);
		if (!sameToolSet(active, next)) pi.setActiveTools(next);
	};
	const enterFallback = (message: string, ctx?: ExtensionContext) => {
		mode = "fallback";
		pendingFallbackMessage = undefined;
		applyActive = false;
		ledger.clear();
		setActiveTools(preferNativeFallbackTools(pi.getActiveTools()));
		if (!warnedUnavailable) {
			const notice = `${message}\n\n${SNAPLINE_INSTALL_HINT}`;
			if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
			else console.warn(notice);
			warnedUnavailable = true;
		}
	};
	const enterConflict = (message: string, ctx?: ExtensionContext) => {
		mode = "conflict";
		pendingFallbackMessage = undefined;
		applyActive = false;
		ledger.clear();
		setActiveTools(preferLegacyConflictTools(pi.getActiveTools()));
		if (!warnedConflict) {
			if (ctx?.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
			warnedConflict = true;
		}
	};
	const scheduleFallback = (message: string) => {
		pendingFallbackMessage ??= message;
	};
	const restoreHealthyBranch = (ctx: ExtensionContext) => {
		ledger.clear();
		restoreSnapshotLedgerFromBranch(ctx.sessionManager.getBranch(), ledger);
		mode = "healthy";
		pendingFallbackMessage = undefined;
		warnedUnavailable = false;
		warnedConflict = false;
		synchronizeHealthyTools();
	};

	pi.registerTool({
		name: SNAPLINE_READ_TOOL,
		label: "Snapline Read",
		description: SNAPLINE_READ_DESCRIPTION,
		parameters: SNAPLINE_READ_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: prepareSnaplineReadArguments,
		renderCall(args: SnaplineReadParams, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderSnaplineCall("read", args, theme, context);
		},
		renderResult(result, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			if (isSnaplineReadDetails(result.details)) return renderSnaplineReadResult(result as never, options, theme, context);
			const nativeRenderer = createReadToolDefinition(context.cwd ?? process.cwd()).renderResult;
			return nativeRenderer ? nativeRenderer(result as never, options, theme as never, context as never) : renderSnaplineReadResult(result as never, options, theme, context);
		},
		async execute(
			toolCallId: string,
			params: SnaplineReadParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<ReadToolDetails | SnaplineReadDetails | undefined> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<ReadToolDetails | SnaplineReadDetails | undefined>> {
			if (mode !== "healthy") {
				return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate as never, ctx);
			}
			const outcome = await runSnaplineReadTransaction(params, ctx.cwd, signal, ledger, runSnapline);
			if (outcome.kind === "image_candidate") {
				const nativeResult = await createReadToolDefinition(ctx.cwd).execute(
					toolCallId,
					{ ...params, path: outcome.canonicalTargetPath },
					signal,
					onUpdate as never,
					ctx,
				);
				if (nativeResult.content.some((content) => content.type === "image")) return nativeResult;
				return textToolResult(`Snapline detected an image candidate, but Pi's native reader did not produce image content.\n\n${nativeResult.content.filter((content) => content.type === "text").map((content) => content.text).join("\n")}`, {
					protocolVersion: 1,
					operation: "read",
					disposition: "rejected",
					path: params.path,
					canonicalFileKey: outcome.canonicalFileKey,
					canonicalTargetPath: outcome.canonicalTargetPath,
					error: { code: "unsupported_image", message: "Pi's native reader did not produce image content." },
				});
			}
			if (outcome.healthFailure) scheduleFallback("Snapline became unavailable; Pi will restore native read and edit after the current agent run settles.");
			else if (outcome.result.details.disposition === "succeeded") activateApplyAdditively();
			return outcome.result;
		},
	});

	pi.registerTool({
		name: SNAPLINE_APPLY_TOOL,
		label: "Snapline Apply",
		description: SNAPLINE_APPLY_DESCRIPTION,
		parameters: SNAPLINE_APPLY_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args: SnaplineApplyParams, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderSnaplineCall("apply", args, theme, context);
		},
		renderResult(result, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderSnaplineApplyResult(result as never, options, theme, context);
		},
		async execute(
			_toolCallId: string,
			params: SnaplineApplyParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<SnaplineApplyDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SnaplineApplyDetails>> {
			if (mode !== "healthy") {
				const details: SnaplineApplyDetails = {
					protocolVersion: 1,
					operation: "apply",
					disposition: "unavailable",
					path: params.path,
					contentChanged: false,
					error: { code: "snapline_unavailable", message: "Snapline is not in healthy mode." },
				};
				return textToolResult("Snapline apply is unavailable in native fallback mode. Read the file with the active native tool before editing.", details);
			}
			const outcome = await runSnaplineApplyTransaction(params, ctx.cwd, signal, ledger, runSnapline);
			if (outcome.healthFailure) scheduleFallback("Snapline health validation failed; Pi will restore native read and edit after the current agent run settles.");
			return outcome.result;
		},
	});

	const nativeWrite = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...nativeWrite,
		description: "Write a new file. In Snapline healthy mode the target must not exist; existing files require snapshot editing. Native fallback restores ordinary overwrite behavior.",
		promptSnippet: "Create a new file",
		promptGuidelines: ["When Snapline is healthy, use write only for a path that does not exist; read and modify existing files with Snapline."],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (mode === "healthy") return guardedCreateFile(params, ctx.cwd, signal, ledger);
			return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.on("tool_result", (event) => {
		const patchedIsError = snaplineResultIsError(event.toolName, event.details);
		if (!(event.toolName === "write" && mode === "healthy") && externalMutationMayHaveChanged(event.toolName, event.isError, event.details)) {
			ledger.clear();
			applyActive = false;
		}
		return patchedIsError === undefined || patchedIsError === event.isError ? undefined : { isError: patchedIsError };
	});

	pi.on("session_before_compact", (event) => {
		recordSnaplineFileOperations(
			[...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
			event.preparation.fileOps,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		ledger.clear();
		pendingFallbackMessage = undefined;
		warnedUnavailable = false;
		warnedConflict = false;
		applyActive = false;
		if (hasLegacyHleditConflict(pi.getAllTools().map((tool) => tool.name))) {
			enterConflict("A legacy Hledit extension is also registered. Disable one extension before enabling Snapline.", ctx);
			return;
		}
		const run = await runSnapline(["capabilities"], undefined, ctx.cwd, undefined);
		const capabilities = parseSnaplineCapabilities(run);
		if (!capabilities) {
			enterFallback("Snapline is unavailable or incompatible, so Pi kept native read and edit active.", ctx);
			return;
		}
		restoreHealthyBranch(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (mode === "healthy" && pendingFallbackMessage === undefined) restoreHealthyBranch(ctx);
	});

	pi.on("before_agent_start", () => {
		if (mode === "healthy" && pendingFallbackMessage === undefined) {
			setActiveTools(preferSnaplineTools(pi.getActiveTools(), applyActive));
		} else if (mode === "fallback") {
			setActiveTools(preferNativeFallbackTools(pi.getActiveTools()));
		} else if (mode === "conflict") {
			setActiveTools(preferLegacyConflictTools(pi.getActiveTools()));
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (pendingFallbackMessage !== undefined) {
			enterFallback(pendingFallbackMessage, ctx);
			return;
		}
		if (mode === "healthy") synchronizeHealthyTools();
	});

	pi.on("session_shutdown", () => {
		ledger.clear();
		pendingFallbackMessage = undefined;
		applyActive = false;
	});

	pi.registerCommand("snapline-status", {
		description: "检查 bundled Snapline CLI 并恢复健康模式",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const executablePath = resolveSnaplineBin();
			if (hasLegacyHleditConflict(pi.getAllTools().map((tool) => tool.name))) {
				enterConflict("Snapline cannot enter healthy mode while a legacy Hledit extension is registered.", ctx);
				return;
			}
			const run = await runSnapline(["capabilities"], undefined, ctx.cwd, undefined);
			const capabilities = parseSnaplineCapabilities(run);
			if (!capabilities) {
				enterFallback(`Snapline capability validation failed for ${executablePath}.`, ctx);
				return;
			}
			restoreHealthyBranch(ctx);
			ctx.ui.notify(`Snapline ready: ${executablePath} (version ${capabilities.version}, wire protocol 1).`, "info");
		},
	});
}
