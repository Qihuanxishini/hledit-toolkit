import { getLatestCompactionEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL, HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL,
	preferAnchoredEditingTools,
} from "./src/active-tools.ts";
import { HLEDIT_INSTALL_HINT, parseHleditCapabilities, resolveHleditBin, runHledit } from "./src/cli.ts";
import { recordAnchoredFileOperations } from "./src/compaction-files.ts";
import { decodeFileChangeInput, prepareFileChangeArguments } from "./src/prepare-arguments.ts";
import { ReadEvidenceStore } from "./src/read-evidence.ts";
import { createAnchoredReadTool } from "./src/read-tool.ts";
import { runApplyTransaction } from "./src/apply-transaction.ts";
import { runReadAnchorsTransaction, runSearchAnchorsTransaction } from "./src/read-transaction.ts";
import { rejectedToolResult, shouldMarkHleditResultAsError, type TextResult } from "./src/result.ts";
import {
	HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
} from "./src/schema.ts";
import { renderFileChangesResult, renderHleditCall, renderReadAnchorsResult } from "./src/render.ts";

export { buildReadArgs, normalizeToolPath } from "./src/read-args.ts";
export type { FileChangeParams, ReadAnchorsParams, SearchAnchorsParams } from "./src/schema.ts";

const EDIT_DESCRIPTION = "Edit one file with proof_id and LN#HASH anchors from read, read_windows or hledit_search_anchors. Applies 1-200 non-overlapping changes atomically; every consumed line must have complete read proof.";

export default function piHleditDiffExtension(pi: ExtensionAPI): void {
	let installed = false;
	let ownerPath: string | undefined;
	let available = false;
	const readEvidence = new ReadEvidenceStore();
	const nestedReads = new Set<string>();
	const synchronizeEditingTools = () => {
		if (!available) return;
		const active = pi.getActiveTools();
		const preferred = preferAnchoredEditingTools(active, pi.getAllTools().map((tool) => tool.name));
		if (preferred.join("\0") !== active.join("\0")) pi.setActiveTools(preferred);
	};
	const publishResult = (result: TextResult): TextResult => ({
		...result,
		details: { ...result.details, evidenceVersion: 2 },
		isError: shouldMarkHleditResultAsError(result.details),
	});
	const unavailable = (): TextResult => publishResult(
		rejectedToolResult("Hash editing is unavailable. Run /hledit-status; no changes were made.", { code: "backend_unavailable", message: "The hash backend is unavailable." }),
	);

	const registerTools = (cwd: string) => {
		pi.registerTool(createAnchoredReadTool(cwd, readEvidence, nestedReads, () => available, () => pi.getSettings().images?.autoResize ?? true));
		pi.registerTool<typeof HLEDIT_READ_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
			name: HLEDIT_READ_ANCHORS_TOOL,
			exposure: "model-only",
			annotations: { readOnlyHint: true, openWorldHint: false },
			label: "read_windows",
			description: "Read 1-8 text ranges from one file snapshot with anchors and a shared proof_id. Single range: 50 KiB JSON; multiple ranges: 2000 lines/96 KiB combined.",
			promptGuidelines: [
				"Use read_windows for disjoint ranges of one file, not to fetch anchors after read. Only a complete multi-window result provides proof; read incomplete windows in smaller calls.",
			],
			parameters: HLEDIT_READ_ANCHORS_PARAMS_SCHEMA,
			renderShell: "self",
			renderCall: (args, theme, context) => renderHleditCall("read_anchors", args, theme, context),
			renderResult: renderReadAnchorsResult,
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!available) return unavailable();
				const result = await runReadAnchorsTransaction(params, ctx.cwd, signal, readEvidence, runHledit);
				return publishResult(result);
			},
		});
		pi.registerTool<typeof HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA, TextResult["details"]>({
			name: HLEDIT_SEARCH_ANCHORS_TOOL,
			exposure: "model-only",
			annotations: { readOnlyHint: true, openWorldHint: false },
			label: "Search Anchors",
			description: "Search one text file for literal text or RE2 matches; returns anchors and proof for complete matching/context lines.",
			promptGuidelines: [
				"Use hledit_search_anchors for matching lines in one file; enumerate files first for project-wide search. Complete returned lines can be edited directly; use read only for unseen gaps.",
				"In hledit_search_anchors, literal:true is verbatim substring search, without regex escaping. If no match, check mode, pattern and offset.",
			],
			parameters: HLEDIT_SEARCH_ANCHORS_PARAMS_SCHEMA,
			renderCall: (args, theme, context) => renderHleditCall("search_anchors", args, theme, context),
			renderResult: renderReadAnchorsResult,
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!available) return unavailable();
				const result = await runSearchAnchorsTransaction(params, ctx.cwd, signal, readEvidence, runHledit);
				return publishResult(result);
			},
		});
		pi.registerTool<typeof HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA, TextResult["details"]>({
			name: HLEDIT_APPLY_FILE_CHANGES_TOOL,
			exposure: "model-only",
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
			label: "edit",
			description: EDIT_DESCRIPTION,
			promptSnippet: "Edit files using read proof and line anchors",
			promptGuidelines: [
				"Use edit with proof_id and anchors from the same file and evidence generation. Reuse verified output anchors with the new proof; read intermediate lines only when needed. Never pair old anchors with an unrelated proof.",
				"In edit, batch independent same-file changes. No overlapping consumed ranges, inserts inside consumed ranges or duplicate insertion boundaries. Insert preserves its anchor; moving text also requires deletion.",
				"In edit, replace with lines: \"\" deletes the range. One trailing \\n terminates the last line. Use write only for new/empty files or intentional full rewrites allowed by recovery guidance, never to bypass proof.",
				"After edit, never replay success. Rejected batches made no write: review recovered source before resubmitting. Recovery reads do not apply edits. On outcome_unknown, inspect the file before any further write.",
			],
			parameters: HLEDIT_APPLY_FILE_CHANGES_PARAMS_SCHEMA,
			prepareArguments: prepareFileChangeArguments,
			renderCall: (args, theme, context) => renderHleditCall("apply_file_changes", args, theme, context),
			renderResult: renderFileChangesResult,
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!available) return unavailable();
				const decoded = decodeFileChangeInput(params);
				if ("error" in decoded) return publishResult(rejectedToolResult(decoded.error, { code: "invalid", message: decoded.error }));
				const result = await runApplyTransaction(decoded.params, ctx.cwd, signal, readEvidence);
				return publishResult(result);
			},
		});
		ownerPath = pi.getAllTools().find((tool) => ["read", "read_windows", "hledit_search_anchors", "edit"].includes(tool.name))?.sourceInfo.path;
		installed = true;
	};

	const conflict = (): string | undefined => {
		const tools = pi.getAllTools();
		for (const name of ["read", "edit"]) {
			const tool = tools.find((item) => item.name === name);
			if (tool && (installed ? tool.sourceInfo.path !== ownerPath : tool.sourceInfo.source !== "builtin")) {
				return `pi-hledit-diff cannot take over ${name}: another override is loaded. Enable only one read/edit backend (including pi-snow-edit), then /reload.`;
			}
		}
		return undefined;
	};
	const checkBackend = async (ctx: ExtensionContext): Promise<{ ok: boolean; message: string }> => {
		const collision = conflict();
		if (collision) { available = false; readEvidence.clear(); return { ok: false, message: collision }; }
		const run = await runHledit(["capabilities"], undefined, ctx.cwd, undefined);
		const capabilities = parseHleditCapabilities(run);
		if (!capabilities) {
			available = false;
			readEvidence.clear();
			return { ok: false, message: `hledit unavailable: ${resolveHleditBin()}. ${installed ? "Hash edit remains fail-closed; it will not fall back to unproven edits." : "Existing read/edit tools were not replaced."}\n${HLEDIT_INSTALL_HINT}` };
		}
		if (!available) readEvidence.restoreFromBranch(ctx);
		available = true;
		// [喵喵喵]: 所有扩展完成加载后才检查并注册，避免与 Snow 等覆盖工具按加载顺序争抢 edit。
		if (!installed) registerTools(ctx.cwd);
		return { ok: true, message: `hledit ready: ${resolveHleditBin()} (${capabilities.version}); read, read_windows, hledit_search_anchors and edit.` };
	};

	pi.on("tool_call", (event) => {
		if (event.toolName === "read" && event.parentToolCallId) nestedReads.add(event.toolCallId);
		if (installed && event.toolName === "edit") {
			const reason = conflict();
			if (reason) return { block: true, reason };
		}
	});
	pi.on("tool_execution_end", (event) => { nestedReads.delete(event.toolCallId); });
	pi.on("session_before_compact", (event, ctx) => {
		const previous = getLatestCompactionEntry(ctx.sessionManager.getBranch());
		recordAnchoredFileOperations(
			[...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
			event.preparation.fileOps,
			previous?.fromHook ? undefined : previous?.details,
		);
	});
	pi.on("session_start", async (_event, ctx) => {
		available = false;
		nestedReads.clear();
		const status = await checkBackend(ctx);
		if (!status.ok) {
			if (ctx.hasUI) ctx.ui.notify(status.message, "warning");
			else console.warn(status.message);
		}
	});
	const restoreEvidence = (_event: unknown, ctx: ExtensionContext) => {
		nestedReads.clear();
		if (available) readEvidence.restoreFromBranch(ctx);
	};
	pi.on("session_tree", restoreEvidence);
	pi.on("before_agent_start", () => {
		if (installed && conflict()) { available = false; readEvidence.clear(); }
	});
	pi.registerCommand("hledit-status", {
		description: "检查 CLI 与工具冲突；就绪后启用 read/read_windows/edit",
		handler: async (_args, ctx) => {
			const status = await checkBackend(ctx);
			if (status.ok) synchronizeEditingTools();
			ctx.ui.notify(status.message, status.ok ? "info" : "error");
		},
	});
}
