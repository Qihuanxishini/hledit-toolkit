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
	preferAnchoredReadTool,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	findSingleLineRangeExpansionIssue,
	formatSingleLineRangeExpansionIssue,
} from "./src/file-changes.ts";
import { formatBatchUpdatedAnchorContext, type BatchAnchorContext } from "./src/post-edit-context.ts";
import { prepareFileChangeArguments, prepareReadAnchorsArguments } from "./src/prepare-arguments.ts";
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
	type TextResult,
	unavailableToolResult,
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
	evidence: ReadEvidenceStore,
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const evidencePath = await resolveReadEvidencePath(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };
	const applyContext = { path: normalizedPath, changes: normalizedParams.changes };
	const attachEvidencePath = (result: TextResult): TextResult => ({
		...result,
		details: { ...result.details, path: normalizedPath, evidencePath },
	});

	return withFileMutationQueue(absolutePath, async () => {
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes);
		if ("failure" in proofSelection) {
			return attachEvidencePath(
				rejectedToolResult(formatReadProofFailure(normalizedPath, proofSelection.failure), {
					code: proofSelection.failure.code,
					message: proofSelection.failure.message,
				}),
			);
		}
		const request = buildFileChangeRequest(normalizedParams, proofSelection.proof);
		const before = await readUtf8File(absolutePath);
		if ("error" in before) {
			return attachEvidencePath(unavailableToolResult(`修改前无法读取 ${normalizedPath}，因此未执行任何修改。请检查路径、权限和文件编码。`));
		}

		const singleLineRangeExpansionIssue = findSingleLineRangeExpansionIssue(params, before.content);
		if (singleLineRangeExpansionIssue) {
			const checkRequest = buildFileChangeCheckRequest(normalizedParams, proofSelection.proof);
			const checkRun = await runHledit(checkRequest.args, checkRequest.stdin, ctx.cwd, signal);
			const checkFailure = fileChangeCheckFailure(checkRun, applyContext);
			if (checkFailure) {
				return attachEvidencePath(checkFailure);
			}

			const verifiedIssue = { ...singleLineRangeExpansionIssue, anchorsVerified: true as const };
			const nearbyDeleteRange = verifiedIssue.nearbyDeleteRange;
			return attachEvidencePath(
				rejectedToolResult(
					`原子批次已拒绝，未写入任何内容。\n${formatSingleLineRangeExpansionIssue(verifiedIssue)}`,
					{
						code: verifiedIssue.code,
						message: `第 ${verifiedIssue.changeNumber} 项 replace_range 仅覆盖一行且重复原行；请扩大 end_anchor 或改用 insert_after，禁止原样重试。`,
						hint: "replace_range 必须完整覆盖待替换旧代码；仅追加内容时应使用 insert_after 并移除重复的锚点行。",
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
			);
		}

		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = applyFileChangesResult(run, applyContext);
		if (result.details.disposition !== "succeeded") {
			return attachEvidencePath(result);
		}

		const parsed = parseRunObject(run)!;
		// applyFileChangesResult 已在外部 CLI 边界验证 updatedAnchors；内部链路直接信任该不变量。
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
						? `${modelPostEditContext}\n\n修改已应用，但重新读取文件以生成差异时失败。`
						: "修改已验证为 no-op，但重新读取文件以生成差异时失败。",
				),
				details: {
					...result.details,
					...postEditDetails,
					diffError: `修改已应用，但无法重新读取 ${normalizedPath} 以生成差异。`,
					diffErrorRaw: after.error,
				},
			});
		}

		return attachEvidencePath({
			...result,
			content: modelPostEditContext ? appendResultText(result, modelPostEditContext) : result.content,
			details: {
				...result.details,
				...buildDiffDetails(normalizedPath, before.content, after.content, parsed),
				...postEditDetails,
			},
		});
	});
}

export default function piHleditDiffExtension(pi: ExtensionAPI): void {
	let warnedHleditUnavailable = false;
	let hleditCapabilitiesAvailable = false;
	const readEvidence = new ReadEvidenceStore();
	const synchronizeAnchoredTools = () => {
		if (!hleditCapabilitiesAvailable) return;
		const activeTools = pi.getActiveTools();
		const preferredTools = readEvidence.hasEvidence()
			? preferAnchoredEditingTools(activeTools)
			: preferAnchoredReadTool(activeTools);
		if (preferredTools.join("\0") !== activeTools.join("\0")) pi.setActiveTools(preferredTools);
	};

	pi.registerTool(({
		name: HLEDIT_READ_ANCHORS_TOOL,
		label: "Read Anchors",
		description: "读取文本文件，并返回可用于后续 stale-safe 修改的 LN#HASH 锚点。",
		promptSnippet: "修改文本文件前读取最新锚点",
		promptGuidelines: [
			"修改文本文件前立即调用 hledit_read_anchors；必须原样复制 LN#HASH，绝不能编造锚点。",
			"hledit_read_anchors 在位置已知时只使用 offset 和 limit 读取受影响范围。可将输出中的 LN#HASH:text 整段原样填入 hledit_apply_file_changes 的锚点字段，插件会移除冒号后的源码文本；不得修改 LN#HASH。",
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
		description: "对一个文本文件原子应用一组互不冲突的 stale-safe 修改。",
		promptSnippet: "原子应用一个文件的锚点修改",
		promptGuidelines: [
			"对同一文件的一组完整、互不冲突的修改，只调用一次 hledit_apply_file_changes。lines 只能包含原始文件文本，不能带锚点或 diff 标记。",
			"hledit_apply_file_changes 的 anchor、start_anchor 和 end_anchor 可原样复制 hledit_read_anchors 输出的 LN#HASH:text；插件会移除冒号后的源码文本，绝不能修改或编造 LN#HASH。",
			"hledit_apply_file_changes 的 replace_range 和 delete_range 必须同时提供 start_anchor 与 end_anchor；单行范围使用同一个锚点作为首尾。",
			"hledit_apply_file_changes 使用 insert_before 或 insert_after 插入内容；不得使用含 position 模式字段的 insert。",
			"hledit_apply_file_changes 因单行 replace_range 扩展被拒绝后不得原样重试；替换代码块时扩大 end_anchor，保留锚点行时改用 insert_after 且不要重复锚点行。",
			"hledit_apply_file_changes 中不得出现 #??/#XX 等占位锚点、operation:read 或未完成的修改；必须先单独调用 hledit_read_anchors。",
			"hledit_apply_file_changes 是原子批次：任一项无效、冲突或锚点失效都会零写入。stale 返回的当前锚点快照只能供核对；不得自动重试或覆盖并发修改。只有确认快照窗口仍覆盖原定目标及完整范围时，才可使用其中的新锚点；快照缺失、截断或无法确认范围时必须重新读取。",
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
			const message = `hledit 当前不可用，已保留 Pi 内置 edit 工具。可运行 /hledit-status 查看详情。\n\n${HLEDIT_INSTALL_HINT}`;
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
				ctx.ui.notify(`hledit 版本不兼容：${bin} 未声明所需的结构化读取和原子批次能力。\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`hledit 启动失败：${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
