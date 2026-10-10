import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { lineFromAnchor } from "./src/anchor.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	HLEDIT_SEARCH_ANCHORS_TOOL,
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
	buildFileChangeRequest,
	changeShapeIssueResult,
	findChangeShapeIssue,
} from "./src/file-changes.ts";
import { decodeFileChangeInput, prepareReadAnchorsArguments, prepareSearchAnchorsArguments } from "./src/prepare-arguments.ts";
import {
	formatReadProofFailure,
	ReadEvidenceStore,
	readProofFailureContext,
	resolveReadEvidencePath,
} from "./src/read-evidence.ts";
import { recoverMissingReadProof } from "./src/read-recovery.ts";
import { normalizeToolPath } from "./src/read-args.ts";
import { runReadAnchorsTransaction, runSearchAnchorsTransaction } from "./src/read-transaction.ts";
import { applyFileChangesResult } from "./src/apply-result.ts";
import {
	attachEvidencePath,
	rejectedToolResult,
	shouldMarkHleditResultAsError,
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
	const hasCurrentSnapshot = result.details.disposition === "rejected" && result.details.error?.code === "stale"
		&& result.details.error.currentAnchors && !result.details.error.currentAnchors.truncated
		&& result.details.error.currentAnchors.lines.every((line) => !line.textTruncated);
	if (!proofId || (result.details.disposition !== "succeeded" && !hasCurrentSnapshot)) return result;
	return {
		...result,
		content: appendResultText(result, `proof_id: ${proofId}`),
		details: { ...result.details, proofId },
	};
}

// 成功响应和锚点正文已由 apply-result.ts 验证并生成；这里追加提交绑定的 change preview。
// 不再前后读取完整文件：preview 只由已验证输入构成，外部并发修改不可能混入
//（详见 change-preview.ts 与 D4）。preview 构建失败只降级为 previewError，
// 不得改变已确认成功的 disposition。
function finalizeSuccessfulEditResult(
	result: TextResult,
	normalizedPath: string,
	evidencePath: string,
	changePreview: VerifiedChangePreview | undefined,
): TextResult {
	return {
		...result,
		details: {
			...result.details,
			path: normalizedPath,
			evidencePath,
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
		// 只在疑似误贴的行首 token 出现时查询当前证据，因此仍放在队列内。
		const shapeIssue = findChangeShapeIssue(normalizedParams, {
			has: (anchor) => evidence.anchorsRequiringRead(evidencePath, [anchor]).length === 0,
		});
		if (shapeIssue) {
			return attachEvidencePath(changeShapeIssueResult(shapeIssue), normalizedPath, evidencePath);
		}
		const proofSelection = evidence.selectProof(evidencePath, normalizedParams.changes, normalizedParams.proof_id);
		if ("failure" in proofSelection) {
			const { failure } = proofSelection;
			if (failure.code === "insufficient_read_proof") {
				const requiredRanges = evidence.recoveryRequirements(normalizedParams.changes);
				const recovered = await recoverMissingReadProof({
					failure,
					path: normalizedPath,
					evidencePath,
					cwd: ctx.cwd,
					signal,
					run: runHledit,
					requiredRanges,
					canRetain: (reads, proofId) => evidence.canRetainRecovery(evidencePath, reads, proofId, requiredRanges),
					requiredLastLine: Math.max(...normalizedParams.changes.map((change) =>
						lineFromAnchor("end_anchor" in change ? change.end_anchor : change.anchor) ?? 0)),
				});
				if (recovered) return recovered;
			}
			return attachEvidencePath(
				rejectedToolResult(formatReadProofFailure(normalizedPath, failure), {
					code: failure.code,
					message: failure.message,
					...readProofFailureContext(failure),
				}),
				normalizedPath,
				evidencePath,
			);
		}

		// selectProof 只迁移可验证存续的目标，不改操作种类、消费范围或输出内容。
		// CLI 统一验证当前 raw revision、完整 proof、全部 anchors 与冲突，再原子提交。
		const effectiveParams = proofSelection.normalizedChanges
			? { ...normalizedParams, changes: proofSelection.normalizedChanges }
			: normalizedParams;
		const applyContext = { path: normalizedPath, changes: effectiveParams.changes };
		const request = buildFileChangeRequest(effectiveParams, proofSelection.proof);
		const run = await runHledit(request.args, request.stdin, ctx.cwd, signal);
		const result = applyFileChangesResult(run, applyContext);
		if (result.details.disposition !== "succeeded") {
			return attachEvidencePath(result, normalizedPath, evidencePath);
		}
		const changePreview = tryBuildChangePreview(result, () =>
			buildAnchoredChangePreview(effectiveParams.changes, proofSelection.consumedLines));
		const finalized = finalizeSuccessfulEditResult(result, normalizedPath, evidencePath, changePreview);
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
		let result = await applyWithinQueue();
		evidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, result.details, ctx.cwd);
		if (result.details.disposition === "succeeded") {
			const anchors = result.details.updatedAnchorSpans?.flatMap((span) => span.lines.map((line) => line.anchor)) ?? [];
			const blocked = evidence.anchorsRequiringRead(evidencePath, anchors);
			if (blocked.length > 0) {
				const warning = `Preview-only anchors (NOT directly usable): ${blocked.join(", ")}. Complete evidence for these lines was not retained. Read the intended target before editing it; do not repeat the successful edit.`;
				const blockedSet = new Set(blocked);
				const content = result.content.map((block) => ({ ...block, text: block.text.split("\n").map((line) => {
					const colon = line.indexOf(":");
					const anchor = line.slice(0, colon);
					return colon >= 0 && blockedSet.has(anchor) ? `[Preview only, line ${lineFromAnchor(anchor)}]${line.slice(colon)}` : line;
				}).join("\n") }));
				const warnings = Array.isArray(result.details.warnings) ? result.details.warnings : [];
				result = { ...result, content: appendResultText({ ...result, content }, warning), details: { ...result.details, unprovenAnchors: blocked, warnings: [...warnings, warning] } };
			}
		}
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

	// [喵喵喵]: 嵌套调用不持久化完整结果；三个工具只直达模型，保证源码审阅和 branch proof 重放。
	pi.registerTool<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_READ_ANCHORS_TOOL,
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },
		label: "Read for Edit",
		description: "Read contiguous text lines with LN#HASH anchors and file-bound proof_id for stale-safe edits.",
		promptGuidelines: [
			"Use hledit_read_anchors for edit proof unless successful hledit_search_anchors output or verified updated anchors already cover the target. Ordinary read/grep output is not proof.",
			"For replace_range or delete_range, use hledit_read_anchors to cover every source line missing from current proof; sparse endpoints are not proof. Truncated source lines are not proof; follow returned continuation offsets.",
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
			return { ...result, isError: shouldMarkHleditResultAsError(result.details) };
		},
	});

	pi.registerTool<typeof HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_SEARCH_ANCHORS_TOOL,
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },
		label: "Search Anchors",
		description: "Search one text file (not a directory) for literal text or RE2 matches.",
		promptGuidelines: [
			"Use hledit_search_anchors on one file, never a directory; enumerate files first for project-wide search. Use it to locate matching lines, not to inspect broad contiguous text; use hledit_read_anchors for that. Only returned complete, non-truncated lines provide proof; read any range gaps.",
			"In hledit_search_anchors, literal:true means verbatim substring search: do not add regex anchors or regex-only escaping. If no match, check mode, pattern and offset.",
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
			return { ...result, isError: shouldMarkHleditResultAsError(result.details) };
		},
	});

	pi.registerTool<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, TextResult["details"]>({
		name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
		exposure: "model-only",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		label: "Apply File Changes",
		description: "Atomic, non-overlapping inclusive ranges or anchor inserts on one file; requires complete read proof. Replacements may retain source lines and change the line count.",
		promptGuidelines: [
			"Use hledit_apply_file_changes with proof_id and LN#HASH tokens from the same evidence generation. Changed apply returns new proof; reuse complete Updated anchors. Old pairs work only for verified surviving targets. Failed reads create no proof.",
			"For hledit_apply_file_changes, insert_before/insert_after preserve the anchor; lines must contain only new content, not copied context. Moving text also requires deleting the original.",
			"In hledit_apply_file_changes.lines, use raw text without LN#HASH prefixes. \\n separates lines; one trailing \\n terminates the last line; \"\" writes one blank line, not a deletion. For targeted edits, use write only for a new/empty file or an intentional complete-file rewrite allowed by recovery guidance; never bypass proof.",
			"After hledit_apply_file_changes, never replay success. Rejected batches made no write; fix the cause and review recovered reads before retrying. Recovery reads do not apply edits. On outcome_unknown, inspect the file and follow recovery guidance before writing.",
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
				return { ...rejectedToolResult(decoded.error, { code: "invalid", message: decoded.error }), isError: true };
			}
			const result = await runFileChangesWithDiff(decoded.params, ctx, signal, readEvidence);
			synchronizeAnchoredTools();
			return { ...result, isError: shouldMarkHleditResultAsError(result.details) };
		},
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
