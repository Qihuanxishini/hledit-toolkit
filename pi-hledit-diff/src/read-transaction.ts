import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { HLEDIT_READ_ANCHORS_TOOL, HLEDIT_SEARCH_ANCHORS_TOOL } from "./active-tools.ts";
import type { HleditRun } from "./cli.ts";
import { ReadEvidenceStore, resolveReadEvidencePath } from "./read-evidence.ts";
import { buildReadArgs, buildSearchArgs, normalizeReadRequest, normalizeSearchRequest } from "./read-args.ts";
import { readAnchorsResult, type TextResult } from "./result.ts";
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
		return queuedResult;
	});
}
