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
import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	findSingleAnchorReplacementIssue,
	formatSingleAnchorReplacementIssue,
} from "./src/file-changes.ts";
import { formatBatchUpdatedAnchorContext, type BatchAnchorContext } from "./src/post-edit-context.ts";
import { prepareFileChangeArguments, prepareReadAnchorsArguments } from "./src/prepare-arguments.ts";
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
): Promise<TextResult> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolve(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };
	const request = buildFileChangeRequest(normalizedParams);

	return withFileMutationQueue(absolutePath, async () => {
		const before = await readUtf8File(absolutePath);
		if ("error" in before) {
			return unavailableToolResult(`修改前无法读取 ${normalizedPath}，因此未执行任何修改。请检查路径、权限和文件编码。`);
		}

		const singleAnchorReplacementIssue = findSingleAnchorReplacementIssue(params, before.content);
		if (singleAnchorReplacementIssue) {
			const checkRequest = buildFileChangeCheckRequest(normalizedParams);
			const checkRun = await runHledit(checkRequest.args, checkRequest.stdin, ctx.cwd, signal);
			const checkFailure = fileChangeCheckFailure(checkRun, { path: normalizedPath });
			if (checkFailure) {
				return checkFailure;
			}

			const verifiedIssue = { ...singleAnchorReplacementIssue, anchorsVerified: true as const };
			const nearbyDeleteRange = verifiedIssue.nearbyDeleteRange;
			return rejectedToolResult(
				`原子批次已拒绝，未写入任何内容。\n${formatSingleAnchorReplacementIssue(verifiedIssue)}`,
				{
					code: verifiedIssue.code,
					message: `第 ${verifiedIssue.changeNumber} 项单锚点 replace 缺少 end_anchor；请改为范围 replace 或 insert after，禁止原样重试。`,
					hint: "单锚点 replace 只消费一行；块替换必须提供 end_anchor，追加内容时应移除重复锚点行。",
					changeNumber: verifiedIssue.changeNumber,
					operation: "replace",
					anchor: verifiedIssue.anchor,
					missingField: verifiedIssue.missingField,
					outputLineCount: verifiedIssue.outputLineCount,
					...(nearbyDeleteRange
						? {
							relatedChangeNumber: nearbyDeleteRange.changeNumber,
							candidateEndAnchor: nearbyDeleteRange.endAnchor,
						}
						: {}),
				},
			);
		}

		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = applyFileChangesResult(run, { path: normalizedPath });
		if (result.details.disposition !== "succeeded") {
			return result;
		}

		const parsed = parseRunObject(run)!;
		// applyFileChangesResult 已在外部 CLI 边界验证 updatedAnchors；内部链路直接信任该不变量。
		const updatedAnchorContext = parsed.updatedAnchors as BatchAnchorContext;
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
				content: appendResultText(result, `${postEditContext.text}\n\n修改已应用，但重新读取文件以生成差异时失败。`),
				details: {
					...result.details,
					...postEditDetails,
					diffError: `修改已应用，但无法重新读取 ${normalizedPath} 以生成差异。`,
					diffErrorRaw: after.error,
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
		description: "读取文本文件，并返回可用于后续 stale-safe 修改的 LN#HASH 锚点。",
		promptSnippet: "修改文本文件前读取最新锚点",
		promptGuidelines: [
			"修改文本文件前立即调用 hledit_read_anchors；必须原样复制 LN#HASH，绝不能编造锚点。",
			"hledit_read_anchors 在位置已知时只使用 offset 和 limit 读取受影响范围。输出 51#aB3:text 中，锚点仅为 51#aB3。",
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
			return readAnchorsResult(await runHledit(buildReadArgs(request), undefined, ctx.cwd, signal), request);
		},
	}) as never);

	pi.registerTool(({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		label: "Apply File Changes",
		description: "对一个文本文件原子应用一组互不冲突的 stale-safe 修改。",
		promptSnippet: "原子应用一个文件的锚点修改",
		promptGuidelines: [
			"对同一文件的一组完整、互不冲突的修改，只调用一次 hledit_apply_file_changes。lines 只能包含原始文件文本，不能带锚点或 diff 标记。",
			"hledit_apply_file_changes 的 replace 未提供 end_anchor 时只消费一个源文件行，即使 lines 含多行也是如此；替换现有代码块时，必须提供包含首尾的 end_anchor。",
			"hledit_apply_file_changes 因单锚点 replace 被拒绝后不得原样重试；替换代码块时在同一项 replace 中补充 end_anchor，保留锚点行时改用 insert after 且不要重复锚点行。",
			"hledit_apply_file_changes 中不得出现 #??/#XX 等占位锚点、operation:read 或未完成的修改；必须先单独调用 hledit_read_anchors。",
			"hledit_apply_file_changes 的 delete 使用 { operation: \"delete\", anchor, end_anchor? }，不带 lines；insert 使用 { operation: \"insert\", anchor, position: \"before\" | \"after\", lines }。",
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
			const message = `hledit 当前不可用，已保留 Pi 内置 edit 工具。可运行 /hledit-status 查看详情。\n\n${HLEDIT_INSTALL_HINT}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
			warnedHleditUnavailable = true;
		}
	});

	pi.registerCommand("hledit-status", {
		description: "检查随扩展附带的 hledit CLI 状态",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
			const bin = resolveHleditBin();
			const capabilities = parseHleditCapabilities(run);
			if (capabilities) {
				ctx.ui.notify(`hledit 已就绪：${bin}（版本 ${capabilities.version}；支持结构化范围读取、批量向后插入和修改后锚点回传）`, "info");
			} else if (run.exitCode === 0) {
				ctx.ui.notify(`hledit 版本不兼容：${bin} 未声明所需的结构化读取和原子批次能力。\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`hledit 启动失败：${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
