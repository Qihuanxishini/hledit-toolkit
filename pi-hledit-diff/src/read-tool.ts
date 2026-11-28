import {
	createReadToolDefinition, defineTool, detectSupportedImageMimeTypeFromFile, withFileMutationQueue,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { HLEDIT_READ_TOOL } from "./active-tools.ts";
import { runHledit } from "./cli.ts";
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, normalizeToolPath } from "./read-args.ts";
import { ReadEvidenceStore, resolveReadEvidencePath } from "./read-evidence.ts";
import { runResolvedReadTransaction } from "./read-transaction.ts";
import { renderReadAnchorsResult, renderReadCall, renderReadHeading } from "./render.ts";
import { isRecord, shouldMarkHleditResultAsError, type HleditDetails, type TextResult } from "./result.ts";

const EMPTY_FILE_NOTE = "empty file; use write to add content";
const READ_DESCRIPTION = "Read text or images. Text returns LN#HASH anchors and a file-bound proof_id for edit; no separate anchor read is needed. Defaults to line 1, at most 2000 lines and a 50 KiB CLI JSON budget. Use offset/limit to page. Images and unsupported text remain readable without edit proof.";

export function createAnchoredReadTool(cwd: string, evidence: ReadEvidenceStore, nestedCalls: ReadonlySet<string>, ready: () => boolean, autoResizeImages: () => boolean) {
	const native = createReadToolDefinition(cwd);
	let nativeNoResize: typeof native | undefined;
	const executeNative: typeof native.execute = (...args) =>
		(autoResizeImages() ? native : (nativeNoResize ??= createReadToolDefinition(cwd, { autoResizeImages: false }))).execute(...args);
	type ReadDetails = Awaited<ReturnType<typeof native.execute>>["details"] | HleditDetails;
	return defineTool({
		...native,
		description: READ_DESCRIPTION,
		parameters: { ...native.parameters, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false },
		promptGuidelines: [
			"Use read to examine files instead of cat or sed. Direct text reads provide edit proof for complete returned lines; nested reads do not. Read every line an edit consumes, not only its endpoints.",
		],
		renderShell: "default",
		renderCall: renderReadCall,
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Container();
			if (isRecord(result.details) && (result.details.read || result.details.windowsRead || (result.details.disposition && result.details.disposition !== "succeeded"))) {
				return renderReadAnchorsResult(result as TextResult, options, theme, context);
			}
			if (context.isError) {
				return renderReadAnchorsResult({ ...result, details: { disposition: "rejected" } }, options, theme, context);
			}
			const output = new Container();
			const first = result.content[0];
			const emptyFile = !context.isError && first?.type === "text" && first.text.trim() === `[Read-only: ${EMPTY_FILE_NOTE}; no edit proof.]`;
			// [喵喵喵]: 外层 lastComponent 是组合容器，不能传给原生 Text 渲染器复用。
			const nativeContext = { ...context, lastComponent: undefined };
			output.addChild(emptyFile
				? renderReadHeading(normalizeToolPath(context.args.path), undefined, ["空文件"], [], theme, context)
				: native.renderCall!(context.args, theme, nativeContext));
			output.addChild(native.renderResult!(result as Awaited<ReturnType<typeof native.execute>>, options, theme, nativeContext));
			return output;
		},
		async execute(id, input, signal, onUpdate, ctx): Promise<AgentToolResult<ReadDetails>> {
			// [喵喵喵]: 嵌套结果不会进入 transcript；保持原生 structuredContent，且绝不据此登记 proof。
			if (nestedCalls.has(id)) return executeNative(id, input, signal, onUpdate, ctx);
			if (!ready()) throw new Error("Hash editing is unavailable. Run /hledit-status; read cannot create proof until it recovers.");
			const path = normalizeToolPath(input.path);
			const evidencePath = await resolveReadEvidencePath(ctx.cwd, path);
			const delegate = async (note?: string): Promise<AgentToolResult<ReadDetails>> => withFileMutationQueue(evidencePath, async () => {
				const result = await executeNative(id, input, signal, onUpdate, ctx);
				const details = { ...result.details, disposition: "succeeded" as const, path, evidencePath, evidenceDropped: true as const };
				evidence.updateFromToolResult(HLEDIT_READ_TOOL, details, ctx.cwd);
				if (!note) return { ...result, details };
				const content = result.content.map((block) => block.type === "text" ? { ...block, text: `${block.text}\n[Read-only: ${note}; no edit proof.]` } : block);
				return { ...result, content, details, structuredContent: content.find((block) => block.type === "text")?.text ?? "" };
			});
			signal?.throwIfAborted();
			const image = await detectSupportedImageMimeTypeFromFile(evidencePath).catch(() => null);
			if (image) return delegate();
			const offset = input.offset ?? 1;
			const limit = input.limit ?? DEFAULT_READ_LIMIT;
			if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset + Math.min(limit, MAX_READ_LIMIT))) {
				return delegate("this range uses native read semantics");
			}
			const result = await runResolvedReadTransaction({ path, evidencePath, windows: [{ offset, limit: Math.min(limit, MAX_READ_LIMIT) }] }, ctx.cwd, signal, evidence, runHledit, HLEDIT_READ_TOOL);
			const error = result.details.error;
			if (error?.code === "range" && error.totalLines === 0 && offset === 1) return delegate(EMPTY_FILE_NOTE);
			if (error?.code === "binary" || error?.code === "encoding") return delegate("not anchorable UTF-8 text; original bytes are unchanged");
			if (error?.code === "io") return delegate("native path resolution; no anchored snapshot");
			return { ...result, isError: shouldMarkHleditResultAsError(result.details), structuredContent: result.content[0]?.text ?? "" };
		},
	});
}
