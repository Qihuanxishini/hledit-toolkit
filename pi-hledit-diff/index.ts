import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	isAnchoredEditingTool,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import { buildFileChangeRequest, findSingleAnchorReplacementError } from "./src/file-changes.ts";
import { formatBatchUpdatedAnchorContext, type BatchUpdatedAnchorContext } from "./src/post-edit-context.ts";
import { prepareFileChangeArguments, prepareReadAnchorsArguments } from "./src/prepare-arguments.ts";
import { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
import {
	buildDiffDetails,
	isFailedHleditResult,
	parseRunObject,
	readUtf8File,
	textResult,
	toolFailureResult,
	type TextResult,
} from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
	HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
	type FileChangeParams,
	type ReadAnchorsParams,
} from "./src/schema.ts";
import {
	renderFileChangesResult,
	renderHleditCall,
	renderReadAnchorsResult,
	type RenderTheme,
	type ToolRenderContextLike,
} from "./src/render.ts";

export { buildFileChangeRequest } from "./src/file-changes.ts";
export { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
export type { FileChangeParams, ReadAnchorsParams } from "./src/schema.ts";

function appendResultText(result: TextResult, text: string | undefined): TextResult["content"] {
	if (!text) {
		return result.content;
	}
	const [first, ...rest] = result.content;
	if (first?.type === "text" && typeof first.text === "string") {
		return [{ ...first, text: `${first.text}\n\n${text}` }, ...rest];
	}
	return [{ type: "text", text }, ...result.content];
}

async function runFileChangesWithDiff(
	params: FileChangeParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const request = buildFileChangeRequest({ ...params, path: normalizedPath });

	return withFileMutationQueue(absolutePath, async () => {
		const before = await readUtf8File(absolutePath);
		if ("error" in before) {
			return toolFailureResult(`Changes were not applied: unable to read ${normalizedPath} before editing: ${before.error}`);
		}

		const singleAnchorReplacementError = findSingleAnchorReplacementError(params, before.content);
		if (singleAnchorReplacementError) {
			return toolFailureResult(
				`Atomic batch rejected; zero changes were applied.\n${singleAnchorReplacementError}`,
				"rejected",
			);
		}

		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = textResult(run, "apply_file_changes", { path: normalizedPath });
		if (result.details.disposition !== "succeeded") {
			return result;
		}

		const parsed = parseRunObject(run)!;
		// textResult 已在外部 CLI 边界验证 updatedAnchors；内部链路直接信任该不变量。
		const updatedAnchorContext = parsed.updatedAnchors as BatchUpdatedAnchorContext;
		const postEditContext = formatBatchUpdatedAnchorContext(updatedAnchorContext);
		const postEditDetails = {
			postEditContext: {
				offset: postEditContext.offset,
				limit: postEditContext.limit,
				truncated: postEditContext.truncated,
			},
		};

		const after = await readUtf8File(absolutePath);
		if ("error" in after) {
			return {
				...result,
				content: appendResultText(result, `${postEditContext.text}\n\nChanges were applied, but the diff is unavailable: ${after.error}`),
				details: {
					...result.details,
					...postEditDetails,
					diffError: `unable to read ${normalizedPath} after editing: ${after.error}`,
				},
			};
		}

		return {
			...result,
			content: appendResultText(result, postEditContext.text),
			details: {
				...result.details,
				...buildDiffDetails(normalizedPath, before.content, after.content, parsed),
				...postEditDetails,
			},
		};
	});
}

export default function piHleditDiffExtension(pi: ExtensionAPI): void {
	let warnedHleditUnavailable = false;

	pi.registerTool(({
		name: HLEDIT_READ_ANCHORS_TOOL,
		label: "Read Anchors",
		description: "Read a text file and return stale-safe LN#HASH anchors for a later change.",
		promptSnippet: "Read text-file anchors before applying anchored changes",
		promptGuidelines: [
			"Call hledit_read_anchors immediately before changing a text file; copy LN#HASH anchors exactly and never invent them.",
			"When the location is known, read only the affected range with offset and limit. In output like 51#BJ:text, the anchor is only 51#BJ.",
		],
		parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
		prepareArguments: prepareReadAnchorsArguments,
		renderCall(args: unknown, theme: RenderTheme) {
			return renderHleditCall("read_anchors", args, theme);
		},
		renderResult(result: TextResult, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderReadAnchorsResult(result, options, theme, context);
		},
		async execute(
			_toolCallId: string,
			params: ReadAnchorsParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<TextResult> {
			return textResult(await runHledit(buildReadArgs(params), undefined, ctx.cwd, signal), "read_anchors", { path: normalizeToolPath(params.path) });
		},
	}) as never);

	pi.registerTool(({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		label: "Apply File Changes",
		description: "Apply one atomic set of non-conflicting stale-safe changes to one text file.",
		promptSnippet: "Atomically apply anchored changes to one text file",
		promptGuidelines: [
			"Use hledit_apply_file_changes once for all complete, non-conflicting changes in one file. Its lines arrays contain raw file text only, never anchors or diff markers.",
			"A replace without end_anchor consumes exactly one source line even when lines contains multiple output lines. To replace an existing block, always supply the inclusive end_anchor.",
			"Never include placeholder anchors such as #??/#XX, operation:read, or unfinished changes. Read anchors in a separate hledit_read_anchors call first.",
			"Delete uses { operation: \"delete\", anchor, end_anchor? } without lines. Insert requires { operation: \"insert\", anchor, position: \"before\" | \"after\", lines }.",
			"The batch is atomic: any invalid, conflicting, or stale item means zero writes. After stale, reread the affected range and do not reuse pre-mutation anchors.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		prepareArguments: prepareFileChangeArguments,
		renderCall(args: unknown, theme: RenderTheme) {
			return renderHleditCall("apply_file_changes", args, theme);
		},
		renderResult(result: TextResult, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderFileChangesResult(result, options, theme, context);
		},
		async execute(
			_toolCallId: string,
			params: FileChangeParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<TextResult> {
			return runFileChangesWithDiff(params, ctx, signal);
		},
	}) as never);

	pi.on("tool_result", (event) => {
		if (isAnchoredEditingTool(event.toolName) && isFailedHleditResult(event.details)) {
			return { isError: true };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
		const capabilities = parseHleditCapabilities(run);
		const activeTools = pi.getActiveTools();
		const preferredTools = capabilities ? preferAnchoredEditingTools(activeTools) : preferBuiltInEditFallback(activeTools);
		if (preferredTools.join("\0") !== activeTools.join("\0")) {
			pi.setActiveTools(preferredTools);
		}
		if (capabilities) {
			warnedHleditUnavailable = false;
			return;
		}
		if (!warnedHleditUnavailable) {
			const message = `hledit unavailable; kept Pi's built-in edit tool active. Run /hledit-status for details.\n\n${HLEDIT_INSTALL_HINT}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
			warnedHleditUnavailable = true;
		}
	});

	pi.registerCommand("hledit-status", {
		description: "Check the configured hledit binary",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
			const bin = resolveHleditBin();
			const capabilities = parseHleditCapabilities(run);
			if (capabilities) {
				ctx.ui.notify(`hledit ready: ${bin} (${capabilities.version}; batch insert-after; inline updated anchors)`, "info");
			} else if (run.exitCode === 0) {
				ctx.ui.notify(`hledit incompatible: ${bin} does not report required batch insert-after and inline updated-anchor capabilities.\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`hledit failed: ${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
