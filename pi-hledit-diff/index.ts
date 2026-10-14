import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	HLEDIT_SEARCH_ANCHORS_TOOL,
	preferBuiltInEditFallback,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import { recordAnchoredFileOperations } from "./src/compaction-files.ts";
import { decodeFileChangeInput, prepareFileChangeArguments } from "./src/prepare-arguments.ts";
import { ReadEvidenceStore } from "./src/read-evidence.ts";
import { runApplyTransaction } from "./src/apply-transaction.ts";
import { runReadAnchorsTransaction, runSearchAnchorsTransaction } from "./src/read-transaction.ts";
import {
	rejectedToolResult,
	shouldMarkHleditResultAsError,
	type TextResult,
} from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
	HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
	HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
} from "./src/schema.ts";
import {
	renderFileChangesResult,
	renderHleditCall,
	renderReadAnchorsResult,
} from "./src/render.ts";

export { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
export type { FileChangeParams, ReadAnchorsParams, SearchAnchorsParams } from "./src/schema.ts";

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
		description: "Read precise text windows from one snapshot with LN#HASH anchors and a file-bound proof_id for editing.",
		promptGuidelines: [
			"For planned edits, use hledit_read_anchors directly, not ordinary read/grep. Reuse complete hledit_search_anchors output or verified updated anchors covering the target.",
			"In hledit_read_anchors, cover every consumed source line; sparse endpoints and truncated text are not proof. Supply windows for one or more smallest semantically complete ranges. Follow continuation guidance.",
		],
		parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
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
			"Use hledit_search_anchors for matching lines, not broad source inspection; use hledit_read_anchors for gaps. Search one file; enumerate files first for project-wide search. Only complete returned lines provide proof.",
			"In hledit_search_anchors, literal:true means verbatim substring search: do not add regex anchors or regex-only escaping. If no match, check mode, pattern and offset.",
		],
		parameters: HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
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
		description: "Apply one atomic batch of source ranges and anchored inserts in one file; requires complete read proof. Supply all four arrays (use [] when unused), totaling 1-200 items in pre-edit coordinates. No overlapping ranges, inserts inside consumed ranges or duplicate insertion boundaries.",
		promptGuidelines: [
			"Use hledit_apply_file_changes with proof_id and anchors from the same evidence generation. Reuse verified output anchors with the new proof; read intermediate lines when needed. Old pairs work only for verified surviving targets. Failed reads create no proof.",
			"In hledit_apply_file_changes, batch independent same-file edits. Keep consumed ranges semantically complete without unrelated lines. Insert preserves its anchor; moving text also requires deletion.",
			"In hledit_apply_file_changes item lines, one trailing \\n terminates the last line; \"\" writes a blank line, not a deletion. Use write only for new/empty files or intentional full rewrites permitted by recovery guidance; never bypass proof.",
			"After hledit_apply_file_changes, never replay success. Rejected batches made no write; fix the cause and review recovered reads before retrying. Recovery reads do not apply edits. On outcome_unknown, inspect the file and follow recovery guidance before writing.",
		],
		parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
		prepareArguments: prepareFileChangeArguments,
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
			const result = await runApplyTransaction(decoded.params, ctx.cwd, signal, readEvidence);
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
