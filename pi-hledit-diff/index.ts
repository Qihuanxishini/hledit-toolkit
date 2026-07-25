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
	buildAnchoredChangePreview,
	buildReplaceOncePreview,
	emptyChangePreview,
	type VerifiedChangePreview,
} from "./src/change-preview.ts";
import { recordAnchoredFileOperations } from "./src/compaction-files.ts";
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
	fileChangeCheckFailure,
	isFailedHleditResult,
	parseRunObject,
	readAnchorsResult,
	rejectedToolResult,
	replaceOnceResult,
	type HleditEditDelta,
	type TextResult,
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

// 成功响应已由 result.ts 验证；这里统一追加局部锚点上下文与提交绑定的 change preview。
// 不再前后读取完整文件：preview 只由已验证输入构成，外部并发修改不可能混入
//（详见 change-preview.ts 与 D4）。preview 构建失败只降级为 previewError，
// 不得改变已确认成功的 disposition。
function finalizeSuccessfulEditResult(
	result: TextResult,
	run: ReturnType<typeof runHledit> extends Promise<infer Value> ? Value : never,
	normalizedPath: string,
	evidencePath: string,
	changePreview: VerifiedChangePreview | undefined,
): TextResult {
	const parsed = parseRunObject(run)!;
	const updatedAnchorContext = parsed.updatedAnchors as BatchAnchorContext;
	const postEditContext = formatBatchUpdatedAnchorContext(updatedAnchorContext);
	const modelPostEditContext = result.details.contentChanged === false ? undefined : postEditContext.text;

	return {
		...result,
		content: modelPostEditContext ? appendResultText(result, modelPostEditContext) : result.content,
		details: {
			...result.details,
			path: normalizedPath,
			evidencePath,
			revision: result.details.revision as string,
			updatedAnchors: updatedAnchorContext,
			postEditContext: {
				offset: postEditContext.offset,
				limit: postEditContext.limit,
				truncated: postEditContext.truncated,
			},
			...(changePreview
				? { changePreview }
				: { previewError: "A verified change preview could not be built for this edit; the write itself succeeded." }),
		},
	};
}

// 已确认成功的提交绑定 preview；任何构建异常都只降级，不影响 disposition。
function tryBuildChangePreview(result: TextResult, build: () => VerifiedChangePreview | undefined): VerifiedChangePreview | undefined {
	try {
		if (result.details.contentChanged === false) return emptyChangePreview();
		return build();
	} catch {
		return undefined;
	}
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

	const applyWithinQueue = async (): Promise<TextResult> => {
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes);
		if ("failure" in proofSelection) {
			return attachEvidencePath(
				rejectedToolResult(formatReadProofFailure(normalizedPath, proofSelection.failure), {
					code: proofSelection.failure.code,
					message: proofSelection.failure.message,
					...(proofSelection.failure.renamedAnchors ? { renamedAnchors: proofSelection.failure.renamedAnchors } : {}),
					...(proofSelection.failure.renamesRestoreProof ? { renamesRestoreProof: true as const } : {}),
				}),
				normalizedPath,
				evidencePath,
			);
		}
		const request = buildFileChangeRequest(normalizedParams, proofSelection.proof);

		const singleLineRangeExpansionIssue = findSingleLineRangeExpansionIssue(params, proofSelection.consumedLines);
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
		const changePreview = tryBuildChangePreview(result, () =>
			buildAnchoredChangePreview(normalizedParams.changes, proofSelection.consumedLines));
		return finalizeSuccessfulEditResult(result, run, normalizedPath, evidencePath, changePreview);
	};

	// D6：evidence 重映射/失效/记录属于同文件 mutation 的完整操作，必须在队列放行前
	// 完成，保证同文件下一项排队调用的 selectProof 立即看到本次结果。
	return withFileMutationQueue(absolutePath, async () => {
		const result = await applyWithinQueue();
		evidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, result.details, ctx.cwd);
		return result;
	});
}

// 宿主对 schema 细节约束（minLength/minItems）的执行不可控；空 old_lines/new_lines
// 的拒绝是文档契约，必须在插件自己的边界强制执行一次，而不是指望宿主或 CLI 的
// 底层 unmarshal 报错。
function emptyReplaceOnceLinesRejection(params: ReplaceOnceParams): TextResult | undefined {
	const oldLines: unknown = params.old_lines;
	const newLines: unknown = params.new_lines;
	if (Array.isArray(oldLines) && oldLines.length === 0) {
		return rejectedToolResult(
			"Content-match replacement was rejected; no content was written.\nold_lines must contain at least one line of the exact current content.",
			{ code: "invalid", message: "old_lines must contain at least one line." },
		);
	}
	if (newLines === "" || (Array.isArray(newLines) && newLines.length === 0)) {
		return rejectedToolResult(
			'Content-match replacement was rejected; no content was written.\nnew_lines must not be empty: pass [""] to replace the match with one blank line, or use hledit_apply_file_changes with delete_range to delete the block.',
			{ code: "invalid", message: 'new_lines must not be empty; use [""] for one blank line or an anchored delete_range to delete.' },
		);
	}
	return undefined;
}

async function runReplaceOnceWithDiff(
	params: ReplaceOnceParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	evidence: ReadEvidenceStore,
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const evidencePath = await resolveReadEvidencePath(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };
	const contractRejection = emptyReplaceOnceLinesRejection(normalizedParams);
	if (contractRejection) {
		return attachEvidencePath(contractRejection, normalizedPath, evidencePath);
	}

	const replaceOnceWithinQueue = async (): Promise<TextResult> => {
		const request = buildReplaceOnceRequest(normalizedParams);
		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = replaceOnceResult(run, normalizedPath, {
			oldLineCount: normalizedParams.old_lines.length,
			newLineCount: normalizedParams.new_lines.length,
		});
		if (result.details.disposition !== "succeeded") {
			return attachEvidencePath(result, normalizedPath, evidencePath);
		}
		const changePreview = tryBuildChangePreview(result, () => {
			// oldStart 取 CLI 已验证的唯一消费区间起点，不使用未经验证的字段。
			const oldStart = (result.details.editDeltas as HleditEditDelta[] | undefined)?.[0]?.oldStart;
			return oldStart === undefined ? undefined : buildReplaceOncePreview(normalizedParams, oldStart);
		});
		return finalizeSuccessfulEditResult(result, run, normalizedPath, evidencePath, changePreview);
	};

	// D6：与 anchored batch 相同，evidence 更新在队列放行前完成。
	return withFileMutationQueue(absolutePath, async () => {
		const result = await replaceOnceWithinQueue();
		evidence.updateFromToolResult(HLEDIT_REPLACE_ONCE_TOOL, result.details, ctx.cwd);
		return result;
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
		description: "Read a text file and return LN#HASH anchors for stale-safe edits.",
		promptGuidelines: [
			"When editing an existing text file, first read the target with hledit_read_anchors; use ordinary read only for references or before the target is known. Use a small offset/limit for known locations or grep/context to locate code. Only complete returned lines are local read proof; ranges require every source line. Copy LN#HASH:text anchors verbatim into hledit_apply_file_changes.",
		],
		parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
		// provider 侧按 schema 约束采样，从源头消除畸形参数；不支持的模型自动回落普通调用。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
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
		description: "Atomically apply one complete non-overlapping batch of anchored edits to a text file.",
		promptGuidelines: [
			"For a nonempty readable file, use hledit_apply_file_changes once with its complete non-overlapping batch; never overwrite it with write. Use write only for an empty file or when hledit_read_anchors reports source-line truncation. Prefer newline-delimited strings for multiline content.",
			"Copy current LN#HASH:text anchors verbatim. After success, use updated anchors only inside the returned complete, untruncated local window; unchanged anchors outside it remain valid unless shifted. Apply listed verified renames explicitly. On stale, truncation, incomplete context, or insufficient proof, follow the targeted reread guidance; never invent anchors, retry unchanged, or overwrite concurrent changes.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
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
			// evidence 由 runFileChangesWithDiff 在 mutation queue 内更新（单一实时 owner）。
			const result = await runFileChangesWithDiff(params, ctx, signal, readEvidence);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);


	pi.registerTool(({
		name: HLEDIT_REPLACE_ONCE_TOOL,
		label: "Replace Once",
		description: "Atomically replace one unique exact text block without a prior anchor read.",
		promptGuidelines: [
			"Use hledit_replace_once only when complete old_lines must occur exactly once; no anchor read is required. Prefer newline-delimited strings. new_lines rejects an empty string: use [\"\"] for one blank line or hledit_apply_file_changes delete_range for deletion. On rejection, follow candidate/reread guidance; never loosen or retry the same match.",
		],
		parameters: HLEDIT_REPLACE_ONCE_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
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
			// evidence 由 runReplaceOnceWithDiff 在 mutation queue 内更新（单一实时 owner）。
			const result = await runReplaceOnceWithDiff(params, ctx, signal, readEvidence);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);

	pi.on("tool_result", (event) => {
		// D6/2.2：实时结果的 evidence 只由 execute 路径在 mutation queue 内应用一次；
		// branch/session 重放由 restoreFromBranch 负责。此处仅保留失败升级。
		if (isAnchoredEditingTool(event.toolName) && isFailedHleditResult(event.details)) {
			return { isError: true };
		}
	});

	// D7：内置 compaction 文件提取只识别 read/write/edit 工具；被压缩消息中的
	// hledit 工具操作在这里以结构化 details 补充进 fileOps。
	pi.on("session_before_compact", (event) => {
		recordAnchoredFileOperations(
			[...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
			event.preparation.fileOps,
		);
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
