import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { canonicalKeyFromPath, normalizeToolPath, resolveCanonicalTarget, sameCanonicalTarget } from "./canonical-path.ts";
import type { SnaplineRun } from "./cli.ts";
import { SnapshotLedger } from "./snapshot-ledger.ts";
import { collectVerifiedContextLines, commitFormattedSnapshot } from "./snapshot-format.ts";
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, type SnaplineReadParams } from "./schema.ts";
import { textToolResult, type SnaplineReadDetails, type TextToolResult } from "./tool-details.ts";
import { parseSnaplineReadRun, type SnaplineReadRequest } from "./wire.ts";

export type SnaplineRunner = (
	args: string[],
	stdin: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
) => Promise<SnaplineRun>;

export type SnaplineReadTransactionOutcome =
	| { kind: "result"; result: TextToolResult<SnaplineReadDetails>; healthFailure: boolean }
	| { kind: "image_candidate"; path: string; canonicalFileKey: string; canonicalTargetPath: string };

type NormalizedRead = {
	suppliedPath: string;
	path: string;
	offset: number;
	limit: number;
	repairedOffset?: number;
	repairedLimit?: number;
};

function normalizeRead(params: SnaplineReadParams): NormalizedRead {
	const offset = Number.isSafeInteger(params.offset) && (params.offset ?? 0) > 0 ? params.offset! : 1;
	const requestedLimit = Number.isSafeInteger(params.limit) && (params.limit ?? 0) > 0 ? params.limit! : DEFAULT_READ_LIMIT;
	const limit = Math.min(requestedLimit, MAX_READ_LIMIT);
	return {
		suppliedPath: params.path,
		path: normalizeToolPath(params.path),
		offset,
		limit,
		...(params.offset !== undefined && params.offset !== offset ? { repairedOffset: offset } : {}),
		...(params.limit !== undefined && params.limit !== limit ? { repairedLimit: limit } : {}),
	};
}

function rejectedRead(
	request: NormalizedRead,
	code: string,
	message: string,
	canonicalFileKey?: string,
	canonicalTargetPath?: string,
): SnaplineReadTransactionOutcome {
	return {
		kind: "result",
		healthFailure: false,
		result: textToolResult(`Snapline read rejected: ${message}`, {
			protocolVersion: 1,
			operation: "read",
			disposition: "rejected",
			path: request.path,
			...(canonicalFileKey ? { canonicalFileKey } : {}),
			...(canonicalTargetPath ? { canonicalTargetPath } : {}),
			...(request.repairedOffset !== undefined ? { repairedOffset: request.repairedOffset } : {}),
			...(request.repairedLimit !== undefined ? { repairedLimit: request.repairedLimit } : {}),
			error: { code, message },
		}),
	};
}

function unavailableRead(
	request: NormalizedRead,
	message: string,
	canonicalFileKey?: string,
	canonicalTargetPath?: string,
): SnaplineReadTransactionOutcome {
	return {
		kind: "result",
		healthFailure: true,
		result: textToolResult(message, {
			protocolVersion: 1,
			operation: "read",
			disposition: "unavailable",
			path: request.path,
			...(canonicalFileKey ? { canonicalFileKey } : {}),
			...(canonicalTargetPath ? { canonicalTargetPath } : {}),
			error: { code: "snapline_unavailable", message },
		}),
	};
}

export async function runSnaplineReadTransaction(
	params: SnaplineReadParams,
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<SnaplineReadTransactionOutcome> {
	const request = normalizeRead(params);
	let initialTarget;
	try {
		initialTarget = await resolveCanonicalTarget(cwd, request.suppliedPath);
	} catch (error) {
		return rejectedRead(request, "path_unavailable", error instanceof Error ? error.message : String(error));
	}

	return withFileMutationQueue(initialTarget.canonicalFileKey, async () => {
		let target;
		try {
			target = await resolveCanonicalTarget(cwd, request.suppliedPath);
		} catch (error) {
			return rejectedRead(request, "path_unavailable", error instanceof Error ? error.message : String(error), initialTarget.canonicalFileKey, initialTarget.canonicalTargetPath);
		}
		if (!sameCanonicalTarget(initialTarget, target)) {
			return rejectedRead(request, "target_identity_changed", "The supplied path resolved to a different canonical target while waiting for the file queue.", initialTarget.canonicalFileKey, initialTarget.canonicalTargetPath);
		}

		const wireRequest: SnaplineReadRequest = {
			protocolVersion: 1,
			path: target.canonicalTargetPath,
			windows: [{ offset: request.offset, limit: request.limit }],
		};
		const parsed = parseSnaplineReadRun(await run(["read"], JSON.stringify(wireRequest), cwd, signal), wireRequest);
		if (parsed.disposition === "unavailable" || parsed.disposition === "invalid_response") {
			return unavailableRead(request, parsed.message, target.canonicalFileKey, target.canonicalTargetPath);
		}
		if (parsed.disposition === "rejected") {
			const failure = parsed.failure;
			if (failure.path && canonicalKeyFromPath(failure.path) !== target.canonicalFileKey) {
				return unavailableRead(request, "Snapline read returned a failure for a different canonical target.", target.canonicalFileKey, target.canonicalTargetPath);
			}
			if (failure.code === "image_candidate") {
				return { kind: "image_candidate", path: request.path, canonicalFileKey: target.canonicalFileKey, canonicalTargetPath: target.canonicalTargetPath };
			}
			return rejectedRead(request, failure.code, failure.message, target.canonicalFileKey, target.canonicalTargetPath);
		}

		const result = parsed.result;
		if (canonicalKeyFromPath(result.path) !== target.canonicalFileKey) {
			return unavailableRead(request, "Snapline read returned content for a different canonical target.", target.canonicalFileKey, target.canonicalTargetPath);
		}
		if (result.totalLines > 0 && request.offset > result.totalLines) {
			return rejectedRead(
				request,
				"range_out_of_bounds",
				`Offset ${request.offset} is beyond the file's ${result.totalLines} logical lines. Read from line ${Math.max(1, result.totalLines - request.limit + 1)} instead.`,
				target.canonicalFileKey,
				target.canonicalTargetPath,
			);
		}

		const verifiedLines = collectVerifiedContextLines(result.contexts);
		let formatted;
		try {
			const stage = ledger.stageRead(target.canonicalFileKey, result.revision, result.totalLines, verifiedLines, verifiedLines);
			formatted = commitFormattedSnapshot({
				ledger,
				stage,
				contexts: result.contexts,
				omittedRanges: result.omittedRanges,
				totalLines: result.totalLines,
			});
		} catch (error) {
			return unavailableRead(request, `Snapline could not persist bounded snapshot proof: ${error instanceof Error ? error.message : String(error)}`, target.canonicalFileKey, target.canonicalTargetPath);
		}
		return {
			kind: "result",
			healthFailure: false,
			result: textToolResult(formatted.body, {
				protocolVersion: 1,
				operation: "read",
				disposition: "succeeded",
				path: request.path,
				canonicalFileKey: target.canonicalFileKey,
				canonicalTargetPath: target.canonicalTargetPath,
				snapshot: formatted.snapshot,
				totalLines: result.totalLines,
				revision: result.revision,
				displayedRanges: formatted.displayedRanges,
				omittedRanges: formatted.omittedRanges,
				nextOffset: formatted.nextOffset,
				...(request.repairedOffset !== undefined ? { repairedOffset: request.repairedOffset } : {}),
				...(request.repairedLimit !== undefined ? { repairedLimit: request.repairedLimit } : {}),
				...(formatted.capacityRebased ? { capacityRebased: true as const } : {}),
				snapshotDelta: formatted.delta,
			}),
		};
	});
}
