import { canonicalKeyFromPath, type CanonicalTarget } from "./canonical-path.ts";
import type { SnaplineRunner } from "./read-transaction.ts";
import { SnapshotLedger } from "./snapshot-ledger.ts";
import { collectVerifiedContextLines, commitFormattedSnapshot } from "./snapshot-format.ts";
import type { SnaplineRecoveryDetails } from "./tool-details.ts";
import { parseSnaplineReadRun, type SnaplineReadContext, type SnaplineReadRequest, type SnaplineReadWindow } from "./wire.ts";

export type RecoverySourceRange = { start: number; end: number };

export type SnapshotRecoveryOutcome = {
	body?: string;
	details: SnaplineRecoveryDetails;
	healthFailure: boolean;
};

function normalizedRecoveryWindows(ranges: readonly RecoverySourceRange[]): SnaplineReadWindow[] {
	const normalized = ranges
		.map((range) => ({ start: Math.max(1, range.start), end: Math.max(Math.max(1, range.start), range.end) }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of normalized) {
		const prior = merged.at(-1);
		if (prior && range.start <= prior.end + 1) prior.end = Math.max(prior.end, range.end);
		else merged.push({ ...range });
	}
	if (merged.length === 0) merged.push({ start: 1, end: 1 });
	while (merged.length > 64) {
		let closestIndex = 0;
		let closestGap = Number.POSITIVE_INFINITY;
		for (let index = 0; index < merged.length - 1; index++) {
			const gap = merged[index + 1]!.start - merged[index]!.end;
			if (gap < closestGap) {
				closestGap = gap;
				closestIndex = index;
			}
		}
		merged.splice(closestIndex, 2, { start: merged[closestIndex]!.start, end: merged[closestIndex + 1]!.end });
	}
	return merged.map((range) => ({ offset: range.start, limit: range.end - range.start + 1 }));
}

function approximateContexts(contexts: readonly SnaplineReadContext[]): SnaplineReadContext[] {
	return contexts.map((context) => ({
		...context,
		lines: [...context.lines],
		...(context.truncatedLine ? { truncatedLine: { ...context.truncatedLine } } : {}),
		approximate: true,
	}));
}

export async function recoverCurrentSnapshot(
	target: CanonicalTarget,
	ranges: readonly RecoverySourceRange[],
	reason: string,
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<SnapshotRecoveryOutcome> {
	const request: SnaplineReadRequest = {
		protocolVersion: 1,
		path: target.canonicalTargetPath,
		windows: normalizedRecoveryWindows(ranges),
	};
	const parsed = parseSnaplineReadRun(await run(["read"], JSON.stringify(request), cwd, signal), request);
	if (parsed.disposition === "unavailable" || parsed.disposition === "invalid_response") {
		return {
			details: { failed: { code: "recovery_unavailable", message: parsed.message } },
			healthFailure: true,
		};
	}
	if (parsed.disposition === "rejected") {
		return {
			details: { failed: { code: parsed.failure.code, message: parsed.failure.message } },
			healthFailure: false,
		};
	}
	if (canonicalKeyFromPath(parsed.result.path) !== target.canonicalFileKey) {
		return {
			details: { failed: { code: "invalid_cli_response", message: "Recovery read returned a different canonical target." } },
			healthFailure: true,
		};
	}
	const contexts = approximateContexts(parsed.result.contexts);
	const omittedRanges = parsed.result.omittedRanges.map((range) => ({ ...range, approximate: true as const }));
	const verifiedLines = collectVerifiedContextLines(contexts);
	try {
		const stage = ledger.stageRecovery(target.canonicalFileKey, parsed.result.revision, parsed.result.totalLines, verifiedLines, verifiedLines);
		const formatted = commitFormattedSnapshot({
			ledger,
			stage,
			contexts,
			omittedRanges,
			totalLines: parsed.result.totalLines,
		});
		return {
			body: `Needs review: ${reason}\nThe previous write request was not replayed.\n\n${formatted.body}`,
			details: {
				snapshot: formatted.snapshot,
				totalLines: parsed.result.totalLines,
				revision: parsed.result.revision,
				displayedRanges: formatted.displayedRanges,
				omittedRanges: formatted.omittedRanges,
				snapshotDelta: formatted.delta,
			},
			healthFailure: false,
		};
	} catch (error) {
		return {
			details: { failed: { code: "recovery_persistence_failed", message: error instanceof Error ? error.message : String(error) } },
			healthFailure: true,
		};
	}
}
