import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL } from "./active-tools.ts";
import type { HleditRun } from "./cli.ts";
import { ReadEvidenceStore, resolveReadEvidencePath } from "./read-evidence.ts";
import { buildReadArgs, buildSearchArgs, normalizeReadRequest, normalizeSearchRequest } from "./read-args.ts";
import { readAnchorsResult } from "./read-result.ts";
import type { TextResult } from "./result.ts";
import type { ReadAnchorsParams, SearchAnchorsParams } from "./schema.ts";

export type HleditReadRunner = (
	args: string[],
	stdin: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
) => Promise<HleditRun>;

// CLI 读取、响应校验和 evidence 更新是同一文件队列中的一个完整状态事务。
export async function runReadAnchorsTransaction(
	params: ReadAnchorsParams,
	cwd: string,
	signal: AbortSignal | undefined,
	evidence: ReadEvidenceStore,
	run: HleditReadRunner,
): Promise<TextResult> {
	const request = normalizeReadRequest(params);
	const evidencePath = await resolveReadEvidencePath(cwd, request.path);
	return withFileMutationQueue(evidencePath, async () => {
		const result = readAnchorsResult(await run(buildReadArgs(request), undefined, cwd, signal), request);
		const queuedResult = { ...result, details: { ...result.details, path: request.path, evidencePath } };
		evidence.updateFromToolResult(HLEDIT_READ_ANCHORS_TOOL, queuedResult.details, cwd);
		return queuedResult;
	});
}

export async function runSearchAnchorsTransaction(
	params: SearchAnchorsParams,
	cwd: string,
	signal: AbortSignal | undefined,
	evidence: ReadEvidenceStore,
	run: HleditReadRunner,
): Promise<TextResult> {
	const request = normalizeSearchRequest(params);
	const evidencePath = await resolveReadEvidencePath(cwd, request.path);
	return withFileMutationQueue(evidencePath, async () => {
		const result = readAnchorsResult(await run(buildSearchArgs(request), undefined, cwd, signal), request);
		const queuedResult = { ...result, details: { ...result.details, path: request.path, evidencePath } };
		evidence.updateFromToolResult(HLEDIT_SEARCH_ANCHORS_TOOL, queuedResult.details, cwd);
		// [喵喵喵]: 0 命中不发新 id，但同 revision 的旧证据仍有效；把现有 id 回显给模型，
		// 避免它为了拿 id 再做一次无意义的重读。(2026-09-22)
		const retainedProofId = queuedResult.details.disposition === "succeeded" && !queuedResult.details.proofId
			? evidence.getProofId(evidencePath)
			: undefined;
		if (!retainedProofId) return queuedResult;
		const [first, ...rest] = queuedResult.content;
		return {
			content: first ? [{ ...first, text: `proof_id: ${retainedProofId}\n${first.text}` }, ...rest] : queuedResult.content,
			details: { ...queuedResult.details, proofId: retainedProofId },
		};
	});
}
