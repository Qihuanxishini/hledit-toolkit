import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	HLEDIT_SEARCH_ANCHORS_TOOL,
	isAnchoredEditingTool,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit, type HleditRun } from "./src/cli.ts";
import {
	buildAnchoredChangePreview,
	emptyChangePreview,
	type VerifiedChangePreview,
} from "./src/change-preview.ts";
import { recordAnchoredFileOperations } from "./src/compaction-files.ts";
import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	findChangeShapeIssue,
	findSingleLineRangeExpansionIssue,
	formatChangeShapeIssue,
	formatSingleLineRangeExpansionIssue,
} from "./src/file-changes.ts";
import { formatUpdatedAnchorSpans, parseUpdatedAnchorSpans } from "./src/post-edit-context.ts";
import { decodeFileChangeInput, prepareReadAnchorsArguments, prepareSearchAnchorsArguments } from "./src/prepare-arguments.ts";
import {
	formatReadProofFailure,
	ReadEvidenceStore,
	resolveReadEvidencePath,
} from "./src/read-evidence.ts";
import { recoverMissingReadProof } from "./src/read-recovery.ts";
import { normalizeToolPath } from "./src/read-args.ts";
import { runReadAnchorsTransaction, runSearchAnchorsTransaction } from "./src/read-transaction.ts";
import {
	applyFileChangesResult,
	attachEvidencePath,
	fileChangeCheckFailure,
	shouldMarkHleditResultAsError,
	parseRunObject,
	rejectedToolResult,
	type TextResult,
} from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
	HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
	HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
	type FileChangeParams,
} from "./src/schema.ts";
import {
	renderFileChangesResult,
	renderHleditCall,
	renderReadAnchorsResult,
} from "./src/render.ts";

export { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
export type { FileChangeParams, ReadAnchorsParams, SearchAnchorsParams } from "./src/schema.ts";

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

function appendCurrentProofId(result: TextResult, proofId: string | undefined): TextResult {
	if (result.details.disposition !== "succeeded" || !proofId) return result;
	return {
		...result,
		content: appendResultText(result, `proof_id: ${proofId}`),
		details: { ...result.details, proofId },
	};
}

// 成功响应已由 result.ts 验证；这里统一追加局部锚点上下文与提交绑定的 change preview。
// 不再前后读取完整文件：preview 只由已验证输入构成，外部并发修改不可能混入
//（详见 change-preview.ts 与 D4）。preview 构建失败只降级为 previewError，
// 不得改变已确认成功的 disposition。
function finalizeSuccessfulEditResult(
	result: TextResult,
	run: HleditRun,
	normalizedPath: string,
	evidencePath: string,
	changePreview: VerifiedChangePreview | undefined,
): TextResult {
	const parsed = parseRunObject(run)!;
	// result.ts 已校验span 与 editDeltas 一一对应。
	const updatedAnchorSpans = parseUpdatedAnchorSpans(parsed.updatedAnchorSpans)!;
	const postEditContext = formatUpdatedAnchorSpans(updatedAnchorSpans);
	const modelPostEditContext = result.details.contentChanged === false ? undefined : postEditContext.text;

	return {
		...result,
		content: modelPostEditContext ? appendResultText(result, modelPostEditContext) : result.content,
		details: {
			...result.details,
			path: normalizedPath,
			evidencePath,
			revision: result.details.revision as string,
			updatedAnchorSpans,
			postEditContext: { truncated: postEditContext.truncated },
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
	const evidencePath = await resolveReadEvidencePath(ctx.cwd, normalizedPath);
	const normalizedParams = { ...params, path: normalizedPath };
	if (!normalizedParams.proof_id) {
		return attachEvidencePath(
			rejectedToolResult("The apply request is missing proof_id. Call hledit_read_anchors first and use its returned proof_id.", {
				code: "invalid_proof_id",
				message: "proof_id is required for anchored edits.",
			}),
			normalizedPath,
			evidencePath,
		);
	}
	const applyWithinQueue = async (): Promise<TextResult> => {
		// 请求层自洽性先于 evidence 校验：它不依赖文件状态，且重读无法修复，
		// 不能让它落到 insufficient_read_proof 的"去重读"指令上。锚点前缀检查
		// 对照当前证据里的全部 token，因此放在队列内读取。
		const shapeIssue = findChangeShapeIssue(normalizedParams, evidence.anchorTokens(evidencePath));
		if (shapeIssue) {
			return attachEvidencePath(
				rejectedToolResult(
					`The atomic batch was rejected; no content was written.\n${formatChangeShapeIssue(shapeIssue)}`,
					{
						code: shapeIssue.code,
						message: shapeIssue.code === "reversed_anchor_range"
							? `Change ${shapeIssue.changeNumber} submitted start_anchor ${shapeIssue.startAnchor} below end_anchor ${shapeIssue.endAnchor}; swap them instead of rereading.`
							: `Change ${shapeIssue.changeNumber} pasted the anchor token ${shapeIssue.anchorToken} into lines; strip the prefix instead of rereading.`,
						changeNumber: shapeIssue.changeNumber,
					},
				),
				normalizedPath,
				evidencePath,
			);
		}
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes, normalizedParams.proof_id);
		if ("failure" in proofSelection) {
			if (proofSelection.failure.code !== "invalid_proof_id") {
				const recovered = await recoverMissingReadProof({
					failure: proofSelection.failure,
					path: normalizedPath,
					evidencePath,
					cwd: ctx.cwd,
					signal,
					evidence,
					run: runHledit,
				});
				if (recovered) return recovered;
			}
			return attachEvidencePath(
				rejectedToolResult(formatReadProofFailure(normalizedPath, proofSelection.failure), {
					code: proofSelection.failure.code,
					message: proofSelection.failure.message,
					...(proofSelection.failure.renamedAnchors ? { renamedAnchors: proofSelection.failure.renamedAnchors } : {}),
					...(proofSelection.failure.proofGap
						? {
							changeNumber: proofSelection.failure.proofGap.changeNumber,
							operation: proofSelection.failure.proofGap.operation,
						}
						: {}),
				}),
				normalizedPath,
				evidencePath,
			);
		}

		// selectProof 只在唯一、非歧义且替换后完整 proof 再次成立时返回规范化参数。
		// CLI 仍会验证当前 raw revision、proof 与全部 anchors。
		const effectiveParams = proofSelection.normalizedChanges
			? { ...normalizedParams, changes: proofSelection.normalizedChanges }
			: normalizedParams;
		const applyContext = { path: normalizedPath, changes: effectiveParams.changes };
		const request = buildFileChangeRequest(effectiveParams, proofSelection.proof);
		const singleLineRangeExpansionIssue = findSingleLineRangeExpansionIssue(effectiveParams, proofSelection.consumedLines);

		if (singleLineRangeExpansionIssue) {
			const checkRequest = buildFileChangeCheckRequest(effectiveParams, proofSelection.proof);
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
			buildAnchoredChangePreview(effectiveParams.changes, proofSelection.consumedLines));
		const finalized = finalizeSuccessfulEditResult(result, run, normalizedPath, evidencePath, changePreview);
		if (!proofSelection.renamedAnchors) return finalized;
		const resolved = proofSelection.renamedAnchors
			.map((rename) => `${rename.requested} -> ${rename.current}`)
			.join(", ");
		return {
			...finalized,
			content: appendResultText(finalized, `Resolved verified anchors: ${resolved}.`),
			details: { ...finalized.details, resolvedAnchors: proofSelection.renamedAnchors },
		};
	};

	// D6：evidence 重映射/失效/记录属于同文件 mutation 的完整操作，必须在队列放行前
	// 完成，保证同文件下一项排队调用的 selectProof 立即看到本次结果。
	return withFileMutationQueue(evidencePath, async () => {
		const result = await applyWithinQueue();
		evidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, result.details, ctx.cwd);
		return appendCurrentProofId(result, evidence.getProofId(evidencePath));
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

	pi.registerTool<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_READ_ANCHORS_TOOL,
		label: "Read for Edit",
		description: "Read contiguous text lines with LN#HASH anchors for stale-safe edits.",
		promptGuidelines: [
			"Use hledit_read_anchors to obtain contiguous current proof for edits not already covered by successful hledit_search_anchors output or verified updated anchors.",
			"For replace_range or delete_range, cover every source line with hledit_read_anchors when current proof is incomplete; sparse endpoints are not proof.",
		],
		parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
		// provider 侧按 schema 约束采样，从源头消除畸形参数；不支持的模型自动回落普通调用。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: prepareReadAnchorsArguments,
		renderCall(args, theme, context) {
			return renderHleditCall("read_anchors", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadAnchorsResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<TextResult> {

			const result = await runReadAnchorsTransaction(params, ctx.cwd, signal, readEvidence, runHledit);
			synchronizeAnchoredTools();
			return result;
		},
	});

	pi.registerTool<typeof HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_SEARCH_ANCHORS_TOOL,
		label: "Search Anchors",
		description: "Search one text file (not a directory) for literal text or RE2 matches.",
		promptGuidelines: [
			"Use hledit_search_anchors on one file, never a directory; enumerate files first for project-wide search. Use it to locate matching lines, not to inspect broad contiguous text; use hledit_read_anchors for that. Only returned complete, non-truncated lines provide proof; read any range gaps.",
		],
		parameters: HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: prepareSearchAnchorsArguments,
		renderCall(args, theme, context) {
			return renderHleditCall("search_anchors", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadAnchorsResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<TextResult> {
			const result = await runSearchAnchorsTransaction(params, ctx.cwd, signal, readEvidence, runHledit);
			synchronizeAnchoredTools();
			return result;
		},
	});

	pi.registerTool<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		label: "Apply File Changes",
		description: "Atomically edit one text file with non-overlapping inclusive ranges or before/after anchor inserts; requires complete read proof.",
		promptGuidelines: [
			"Use hledit_apply_file_changes with the latest proof_id returned for that path and current LN#HASH tokens; any proof_id issued for the file's current revision is accepted. A failed read creates no proof. A successful apply may return proof_id for further edits with verified updated anchors.",
			"In hledit_apply_file_changes.lines, use raw text without LN#HASH prefixes: \\n separates lines; one trailing \\n terminates the last line, and an empty string writes one blank line. For targeted edits, do not use write to bypass read proof; use write only for a new/empty file or an intentional complete-file rewrite when the recovery guidance allows it.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args, theme, context) {
			return renderHleditCall("apply_file_changes", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderFileChangesResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<TextResult> {
			const decoded = decodeFileChangeInput(params);
			if ("error" in decoded) {
				return rejectedToolResult(decoded.error, { code: "invalid", message: decoded.error });
			}
			const result = await runFileChangesWithDiff(decoded.params, ctx, signal, readEvidence);
			synchronizeAnchoredTools();
			return result;
		},
	});

	pi.on("tool_result", (event) => {
		// D6/2.2：实时结果的 evidence 只由 execute 路径在 mutation queue 内应用一次；
		// branch/session 重放由 restoreFromBranch 负责。insufficient_read_proof 是可恢复的
		// 补读结果，其余失败继续升级为 Pi 工具错误。
		if (isAnchoredEditingTool(event.toolName) && shouldMarkHleditResultAsError(event.details)) {
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
				ctx.ui.notify(`hledit 版本不兼容：${bin} 未声明所需的结构化读取与原子 batch 能力。\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`无法启动 hledit：${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
