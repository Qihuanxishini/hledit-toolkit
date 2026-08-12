import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	isAnchoredEditingTool,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import {
	buildAnchoredChangePreview,
	emptyChangePreview,
	type VerifiedChangePreview,
} from "./src/change-preview.ts";
import { recordAnchoredFileOperations } from "./src/compaction-files.ts";
import {
	buildFileChangeCheckRequest,
	buildFileChangeRequest,
	findSingleLineRangeExpansionIssue,
	formatSingleLineRangeExpansionIssue,
} from "./src/file-changes.ts";
import { formatBatchUpdatedAnchorContext, type BatchAnchorContext } from "./src/post-edit-context.ts";
import { decodeFileChangeInput, prepareReadAnchorsArguments } from "./src/prepare-arguments.ts";
import {
	formatReadProofDiagnosis,
	formatReadProofFailure,
	ReadEvidenceStore,
	resolveReadEvidencePath,
	type ReadProofFailure,
} from "./src/read-evidence.ts";
import { buildReadArgs, MAX_READ_LIMIT, normalizeReadRequest, normalizeToolPath, suggestedReadWindow } from "./src/read-args.ts";
import { runReadAnchorsTransaction } from "./src/read-transaction.ts";
import {
	applyFileChangesResult,
	producedLineRangesFromEditDeltas,
	fileChangeCheckFailure,
	shouldMarkHleditResultAsError,
	parseEditDeltas,
	readAnchorsResult,
	parseRunObject,
	rejectedToolResult,
	type TextResult,
} from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
	HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
	type FileChangeParams,
	type FileChangeInput,
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
	const postEditContext = formatBatchUpdatedAnchorContext(
		updatedAnchorContext,
		producedLineRangesFromEditDeltas(parseEditDeltas(parsed.editDeltas) ?? []),
	);
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

async function recoverMissingReadProof(
	failure: ReadProofFailure,
	normalizedPath: string,
	evidencePath: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<TextResult | undefined> {
	const range = failure.suggestedReadRange;
	if (!range) return undefined;

	const { offset, limit } = suggestedReadWindow(range.start, range.end);
	const request = normalizeReadRequest({ path: normalizedPath, offset, limit });
	const readResult = readAnchorsResult(await runHledit(buildReadArgs(request), undefined, ctx.cwd, signal), request);
	const queuedReadResult = attachEvidencePath(readResult, normalizedPath, evidencePath);
	const base = formatReadProofDiagnosis(failure);
	const failureContext = {
		...(failure.renamedAnchors ? { renamedAnchors: failure.renamedAnchors } : {}),
		...(failure.proofGap
			? { changeNumber: failure.proofGap.changeNumber, operation: failure.proofGap.operation }
			: {}),
	};

	if (queuedReadResult.details.disposition !== "succeeded" || !queuedReadResult.details.read) {
		const message = "The targeted recovery read failed before edit proof could be established.";
		const rejected = rejectedToolResult([
			base,
			`${message} Resolve the read error below before resubmitting.`,
			queuedReadResult.content[0]?.text ?? "",
		].filter(Boolean).join("\n"), {
			code: "proof_recovery_read_failed",
			message,
			...failureContext,
		});
		return attachEvidencePath({
			...rejected,
			details: { ...rejected.details, recoveryReadError: queuedReadResult.details },
		}, normalizedPath, evidencePath);
	}

	const recoveredRead = queuedReadResult.details.read;
	if (recoveredRead.textTruncated) {
		const message = "The target includes source-line text that was truncated and cannot establish edit proof.";
		return attachEvidencePath(rejectedToolResult([
			base,
			`${message} Do not resubmit this hledit_apply_file_changes call. Use write only if an intentional complete-file rewrite is safe.`,
			queuedReadResult.content[0]?.text ?? "",
		].filter(Boolean).join("\n"), {
			code: "source_line_truncated",
			message,
			...failureContext,
		}), normalizedPath, evidencePath);
	}

	const nextMissingOffset = recoveredRead.nextOffset !== undefined && recoveredRead.nextOffset <= range.end
		? recoveredRead.nextOffset
		: undefined;
	const instruction = nextMissingOffset === undefined
		// 只有 diagnosis 真的列出了 rename 时才要求应用；renamedAnchors 为空数组时 diagnosis 不输出列表。
		? `The targeted missing range was read and recorded below. Review the current source, ${failure.renamedAnchors?.length ? "apply every listed anchor rename, " : ""}replace any mismatched endpoint anchors with the returned current anchors, then resubmit the batch once.`
		: `Proof is still incomplete through line ${range.end}. Call hledit_read_anchors({ path: ${JSON.stringify(normalizedPath)}, offset: ${nextMissingOffset}, limit: ${Math.min(MAX_READ_LIMIT, range.end - nextMissingOffset + 1)} }) and continue with nextOffset until line ${range.end} is covered. Do not resubmit apply before then.`;
	const rejected = rejectedToolResult([
		base,
		instruction,
		queuedReadResult.content[0]?.text ?? "",
	].filter(Boolean).join("\n"), {
		code: failure.code,
		message: failure.message,
		...failureContext,
	});
	return attachEvidencePath(
		{ ...rejected, details: { ...rejected.details, recoveredRead } },
		normalizedPath,
		evidencePath,
	);
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
	const applyWithinQueue = async (): Promise<TextResult> => {
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes);
		if ("failure" in proofSelection) {
			const recovered = await recoverMissingReadProof(
				proofSelection.failure,
				normalizedPath,
				evidencePath,
				ctx,
				signal,
			);
			if (recovered) return recovered;
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
		description: "Read a text file and return LN#HASH anchors with source text for stale-safe edits.",
		promptGuidelines: [
			"For anchored edits of a nonempty existing text file, first read the target with hledit_read_anchors unless complete current proof is already available from verified updated anchors. Use ordinary read only for references or before the target is known. Use grep/context to locate code; once the target is known, read the smallest complete range needed for proof. Before replace_range or delete_range, ensure current evidence covers every source line from start_anchor through end_anchor; endpoint-only or sparse grep evidence is insufficient. In changes, copy only the current LN#HASH token for each endpoint or attachment line; interior anchors are carried automatically as hidden proof.",
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
			const result = await runReadAnchorsTransaction(params, ctx.cwd, signal, readEvidence, runHledit);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);

	pi.registerTool(({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		label: "Apply File Changes",
		description: "Atomically apply one complete non-overlapping batch using boundary anchors and hidden complete read proof.",
		promptGuidelines: [
			"Read the target with hledit_read_anchors before editing unless complete proof is already available. Submit only current LN#HASH tokens; range interiors are proven internally.",
			"In lines, \\n separates lines; one trailing \\n only terminates the last line, and an empty string is one blank line. Never overwrite a nonempty readable file with write; review targeted recovery results before resubmitting.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args: unknown, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderHleditCall("apply_file_changes", args, theme, context);
		},
		renderResult(result: TextResult, options: ToolRenderResultOptions, theme: RenderTheme, context: ToolRenderContextLike) {
			return renderFileChangesResult(result, options, theme, context);
		},
		async execute(
			_toolCallId: string,
			params: FileChangeInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<TextResult> {
			const decoded = decodeFileChangeInput(params);
			if ("error" in decoded) {
				return rejectedToolResult(decoded.error, { code: "invalid", message: decoded.error });
			}
			const result = await runFileChangesWithDiff(decoded.params, ctx, signal, readEvidence);
			synchronizeAnchoredTools();
			return result;
		},
	}) as never);

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
				ctx.ui.notify(`Incompatible hledit version: ${bin} does not declare the required structured read and atomic batch capabilities.\n\n${HLEDIT_INSTALL_HINT}`, "error");
			} else {
				ctx.ui.notify(`Could not start hledit: ${bin}\n\n${HLEDIT_INSTALL_HINT}`, "error");
			}
		},
	});
}
