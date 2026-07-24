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
	HLEDIT_REPLACE_ONCE_TOOL,
	isAnchoredEditingTool,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	buildReplaceOnceRequest,
	findSingleLineRangeExpansionIssue,
	formatSingleLineRangeExpansionIssue,
} from "./src/file-changes.ts";
import { formatBatchUpdatedAnchorContext, type BatchAnchorContext } from "./src/post-edit-context.ts";
import { prepareFileChangeArguments, prepareReadAnchorsArguments, prepareReplaceOnceArguments } from "./src/prepare-arguments.ts";
import { formatReadProofFailure, ReadEvidenceStore, resolveReadEvidencePath } from "./src/read-evidence.ts";
import { buildReadArgs, normalizeReadRequest, normalizeToolPath } from "./src/read-args.ts";
import {
	applyFileChangesResult,
	buildDiffDetails,
	fileChangeCheckFailure,
	isFailedHleditResult,
	parseRunObject,
	readAnchorsResult,
	readUtf8File,
	rejectedToolResult,
	replaceOnceResult,
	type TextResult,
	unavailableToolResult,
} from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
	HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
	HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA,
	type FileChangeParams,
	type ReadAnchorsParams,
	type ReplaceOnceParams,
} from "./src/schema.ts";
import {
	renderFileChangesResult,
	renderHleditCall,
	renderReadAnchorsResult,
	type RenderTheme,
	type ToolRenderContextLike,
} from "./src/render.ts";

export { buildFileChangeRequest, buildReplaceOnceRequest } from "./src/file-changes.ts";
export { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
export type { FileChangeParams, ReadAnchorsParams, ReplaceOnceParams } from "./src/schema.ts";

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

function attachEvidencePath(result: TextResult, normalizedPath: string, evidencePath: string): TextResult {
	return {
		...result,
		details: { ...result.details, path: normalizedPath, evidencePath },
	};
}

// 成功响应已由 result.ts 验证；这里统一追加局部锚点上下文和写后 diff。
async function finalizeSuccessfulEditResult(
	result: TextResult,
	run: ReturnType<typeof runHledit> extends Promise<infer Value> ? Value : never,
	beforeContent: string,
	normalizedPath: string,
	absolutePath: string,
	evidencePath: string,
): Promise<TextResult> {
	const parsed = parseRunObject(run)!;
	const updatedAnchorContext = parsed.updatedAnchors as BatchAnchorContext;
	const postEditContext = formatBatchUpdatedAnchorContext(updatedAnchorContext);
	const postEditDetails = {
		path: normalizedPath,
		evidencePath,
		revision: result.details.revision as string,
		updatedAnchors: updatedAnchorContext,
		postEditContext: {
			offset: postEditContext.offset,
			limit: postEditContext.limit,
			truncated: postEditContext.truncated,
		},
	};
	const modelPostEditContext = result.details.contentChanged === false ? undefined : postEditContext.text;

	const after = await readUtf8File(absolutePath);
	if ("error" in after) {
		return attachEvidencePath({
			...result,
			content: appendResultText(
				result,
				modelPostEditContext
					? `${modelPostEditContext}\n\nThe edit was applied, but rereading the file to generate a diff failed.`
					: "The edit was verified as a no-op, but rereading the file to generate a diff failed.",
			),
			details: {
				...result.details,
				...postEditDetails,
				diffError: `The edit was applied, but ${normalizedPath} could not be reread to generate a diff.`,
				diffErrorRaw: after.error,
			},
		}, normalizedPath, evidencePath);
	}

	return attachEvidencePath({
		...result,
		content: modelPostEditContext ? appendResultText(result, modelPostEditContext) : result.content,
		details: {
			...result.details,
			...buildDiffDetails(normalizedPath, beforeContent, after.content, parsed),
			...postEditDetails,
		},
	}, normalizedPath, evidencePath);
}

async function runFileChangesWithDiff(
	params: FileChangeParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	evidence: ReadEvidenceStore,
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const evidencePath = await resolveReadEvidencePath(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };
	const applyContext = { path: normalizedPath, changes: normalizedParams.changes, operation: "anchored_batch" as const };

	return withFileMutationQueue(absolutePath, async () => {
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes);
		if ("failure" in proofSelection) {
			return attachEvidencePath(
				rejectedToolResult(formatReadProofFailure(normalizedPath, proofSelection.failure), {
					code: proofSelection.failure.code,
					message: proofSelection.failure.message,
				}),
				normalizedPath,
				evidencePath,
			);
		}
		const request = buildFileChangeRequest(normalizedParams, proofSelection.proof);
		const before = await readUtf8File(absolutePath);
		if ("error" in before) {
			return attachEvidencePath(unavailableToolResult(`The target could not be read before editing, so no change was started. Check ${normalizedPath}, its permissions, and its text encoding.`), normalizedPath, evidencePath);
		}

		const singleLineRangeExpansionIssue = findSingleLineRangeExpansionIssue(params, before.content);
		if (singleLineRangeExpansionIssue) {
			const checkRequest = buildFileChangeCheckRequest(normalizedParams, proofSelection.proof);
			const checkRun = await runHledit(checkRequest.args, checkRequest.stdin, ctx.cwd, signal);
			const checkFailure = fileChangeCheckFailure(checkRun, applyContext);
			if (checkFailure) {
				return attachEvidencePath(checkFailure, normalizedPath, evidencePath);
			}

			const verifiedIssue = { ...singleLineRangeExpansionIssue, anchorsVerified: true as const };
			const nearbyDeleteRange = verifiedIssue.nearbyDeleteRange;
			return attachEvidencePath(
				rejectedToolResult(
					`The atomic batch was rejected; no content was written.\n${formatSingleLineRangeExpansionIssue(verifiedIssue)}`,
					{
						code: verifiedIssue.code,
						message: `Change ${verifiedIssue.changeNumber} uses replace_range for one source line while repeating that source line. Expand end_anchor or use insert_after; do not retry the same request.`,
						hint: "replace_range must cover the complete old code block. For an append-only change, use insert_after and omit the repeated anchor line.",
						changeNumber: verifiedIssue.changeNumber,
						operation: "replace_range",
						anchor: verifiedIssue.anchor,
						outputLineCount: verifiedIssue.outputLineCount,
						...(nearbyDeleteRange
							? {
								relatedChangeNumber: nearbyDeleteRange.changeNumber,
								candidateEndAnchor: nearbyDeleteRange.endAnchor,
							}
							: {}),
					},
				),
				normalizedPath,
				evidencePath,
			);
		}

		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = applyFileChangesResult(run, applyContext);
		if (result.details.disposition !== "succeeded") {
			return attachEvidencePath(result, normalizedPath, evidencePath);
		}
		return finalizeSuccessfulEditResult(result, run, before.content, normalizedPath, absolutePath, evidencePath);
	});
}

async function runReplaceOnceWithDiff(
	params: ReplaceOnceParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const evidencePath = await resolveReadEvidencePath(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };

	return withFileMutationQueue(absolutePath, async () => {
		const before = await readUtf8File(absolutePath);
		if ("error" in before) {
			return attachEvidencePath(unavailableToolResult(`The target could not be read before editing, so no change was started. Check ${normalizedPath}, its permissions, and its text encoding.`), normalizedPath, evidencePath);
		}

		const request = buildReplaceOnceRequest(normalizedParams);
		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = replaceOnceResult(run, normalizedPath);
		if (result.details.disposition !== "succeeded") {
			return attachEvidencePath(result, normalizedPath, evidencePath);
		}
		return finalizeSuccessfulEditResult(result, run, before.content, normalizedPath, absolutePath, evidencePath);
	});
}

export default function piHleditDiffExtension(pi: ExtensionAPI): void {
	let warnedHleditUnavailable = false;
	let hleditCapabilitiesAvailable = false;
	const readEvidence = new ReadEvidenceStore();
	const synchronizeAnchoredTools = () => {
		if (!hleditCapabilitiesAvailable) return;
		const activeTools = pi.getActiveTools();
		const preferredTools = preferAnchoredEditingTools(activeTools);
		if (preferredTools.join("\0") !== activeTools.join("\0")) pi.setActiveTools(preferredTools);
	};

	pi.registerTool(({
		name: HLEDIT_READ_ANCHORS_TOOL,
		label: "Read for Edit",
		description: "Read a text file and return LN#HASH anchors for subsequent stale-safe edits.",
		promptSnippet: "Read fresh anchors before editing text",
		promptGuidelines: [
			"When a task explicitly requires editing an existing text file, make the first read of the intended target with hledit_read_anchors. Use ordinary read only for reference files or exploration before the edit target is known.",
			"Use hledit_read_anchors with offset and limit for a known location; use grep and context to locate an edit in a known file. Only returned lines without source-line truncation establish local read proof. Range edits must cover every original line, and LN#HASH:text anchors must be copied verbatim into hledit_apply_file_changes.",
		],
		parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
		prepareArguments: prepareReadAnchorsArguments,
		renderCall(args: unknown, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderHleditCall("read_anchors", args, theme, context);
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
			const request = normalizeReadRequest(params);
			const result = readAnchorsResult(await runHledit(buildReadArgs(request), undefined, ctx.cwd, signal), request);
			const evidencePath = await resolveReadEvidencePath(ctx.cwd, request.path);
			const resultWithPath = { ...result, details: { ...result.details, path: request.path, evidencePath } };
			readEvidence.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, resultWithPath.details, ctx.cwd);
			synchronizeAnchoredTools();
			return resultWithPath;
		},
	}) as never);

	pi.registerTool(({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		label: "Apply File Changes",
		description: "Atomically apply one complete, non-overlapping batch of stale-safe edits to a text file.",
		promptSnippet: "Atomically apply anchored edits to one file",
		promptGuidelines: [
			"For existing text files, use hledit_apply_file_changes; never overwrite the whole file with write. Submit one complete, non-overlapping batch per file. For multiline replacements or inserts, prefer a newline-delimited string for lines; arrays remain suitable for a few sparse lines.",
			"For hledit_apply_file_changes, copy anchor, start_anchor, and end_anchor verbatim as LN#HASH:text from either the latest hledit_read_anchors result or a successful edit's returned updated-anchor local window. Use post-edit anchors only inside that returned window; do not alter, invent, or submit placeholder anchors.",
			"If hledit_apply_file_changes returns stale, use returned current anchors only when their complete, untruncated local window covers the whole intended target and range; otherwise call hledit_read_anchors. After truncation, an incomplete snapshot, or insufficient proof, make the targeted read requested by the failure. Never repair anchors automatically, retry unchanged input, or overwrite concurrent changes.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		prepareArguments: prepareFileChangeArguments,
		renderCall(args: unknown, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderHleditCall("apply_file_changes", args, theme, context);
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
			const result = await runFileChangesWithDiff(params, ctx, signal, readEvidence);
			readEvidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, result.details, ctx.cwd);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);


	pi.registerTool(({
		name: HLEDIT_REPLACE_ONCE_TOOL,
		label: "Replace Once",
		description: "Atomically replace one unique, exact contiguous block of text without a prior anchor read.",
		promptSnippet: "Replace one unique exact text block",
		promptGuidelines: [
			"Use hledit_replace_once only when old_lines is the complete, known old text and must occur exactly once in the current file. It uses current exact content as its precondition and does not require hledit_read_anchors first.",
			"For hledit_replace_once multiline old_lines and new_lines, prefer newline-delimited strings. An empty string is one blank line, not deletion. Zero or multiple matches reject the write.",
			"After hledit_replace_once is rejected, do not loosen the match or retry unchanged. Use the English candidate-range or reread guidance, then use hledit_read_anchors and an anchored edit when a target needs disambiguation.",
		],
		parameters: HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA,
		prepareArguments: prepareReplaceOnceArguments,
		renderCall(args: unknown, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderHleditCall("replace_once", args, theme, context);
		},
		renderResult(result: TextResult, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderFileChangesResult(result, options, theme, context);
		},
		async execute(
			_toolCallId: string,
			params: ReplaceOnceParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<TextResult> {
			const result = await runReplaceOnceWithDiff(params, ctx, signal);
			readEvidence.updateFromToolResult(HLEDIT_REPLACE_ONCE_TOOL, result.details, ctx.cwd);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);

	pi.on("tool_result", (event, ctx) => {
		if (isAnchoredEditingTool(event.toolName)) {
			readEvidence.updateFromToolResult(event.toolName, event.details, ctx.cwd);
			synchronizeAnchoredTools();
		}
		if (isAnchoredEditingTool(event.toolName) && isFailedHleditResult(event.details)) {
			return { isError: true };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
		const capabilities = parseHleditCapabilities(run);
		hleditCapabilitiesAvailable = capabilities !== undefined;
		if (capabilities) {
			readEvidence.restoreFromBranch(ctx);
			synchronizeAnchoredTools();
			warnedHleditUnavailable = false;
			return;
		}
		readEvidence.clear();
		const activeTools = pi.getActiveTools();
		const preferredTools = preferBuiltInEditFallback(activeTools);
		if (preferredTools.join("\0") !== activeTools.join("\0")) pi.setActiveTools(preferredTools);
		if (!warnedHleditUnavailable) {
			const message = `hledit is unavailable, so Pi's built-in edit tool remains active. Run /hledit-status for details.\n\n${HLEDIT_INSTALL_HINT}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
			warnedHleditUnavailable = true;
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!hleditCapabilitiesAvailable) return;
		readEvidence.restoreFromBranch(ctx);
		synchronizeAnchoredTools();
	});

	pi.registerCommand("hledit-status", {
		description: "检查随扩展附带的 hledit CLI 状态",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
			const bin = resolveHleditBin();
			const capabilities = parseHleditCapabilities(run);
			if (capabilities) {
				ctx.ui.notify(`hledit 已就绪：${bin}（版本 ${capabilities.version}；支持结构化范围读取、读取证明和提交前 revision 复检）`, "info");
			} else if (run.exitCode === 0) {
				ctx.ui.notify(`Incompatible hledit version: ${bin} does not declare the required structured read and atomic batch capabilities.\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`Could not start hledit: ${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
