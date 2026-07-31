import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { buildSnaplineChangePreview } from "./change-preview.ts";
import { canonicalKeyFromPath, normalizeToolPath, resolveCanonicalTarget, sameCanonicalTarget, type CanonicalTarget } from "./canonical-path.ts";
import {
	prepareModelBatch,
	SnaplineRequestError,
	translateModelBatch,
	type PreparedModelBatch,
} from "./coordinate-translation.ts";
import { commitAppliedSnapshot } from "./apply-format.ts";
import {
	ApplyValidationError,
	buildApplyWireRequest,
	collectApplyProof,
	projectApplyProducedRanges,
	validateApplySuccess,
} from "./apply-validation.ts";
import { recoverCurrentSnapshot, type RecoverySourceRange } from "./recovery.ts";
import type { SnaplineRunner } from "./read-transaction.ts";
import { SnapshotLedger, type ResolvedSnapshot } from "./snapshot-ledger.ts";
import type { SnaplineApplyParams } from "./schema.ts";
import { textToolResult, type SnaplineApplyDetails, type TextToolResult } from "./tool-details.ts";
import { parseSnaplineApplyRun, type SnaplineLogicalFailure } from "./wire.ts";

export type SnaplineApplyTransactionOutcome = {
	result: TextToolResult<SnaplineApplyDetails>;
	healthFailure: boolean;
};

function baseDetails(path: string, target?: CanonicalTarget): Pick<SnaplineApplyDetails, "protocolVersion" | "operation" | "path" | "canonicalFileKey" | "canonicalTargetPath"> {
	return {
		protocolVersion: 1,
		operation: "apply",
		path,
		...(target ? { canonicalFileKey: target.canonicalFileKey, canonicalTargetPath: target.canonicalTargetPath } : {}),
	};
}

function rejectedApply(
	path: string,
	code: string,
	message: string,
	target?: CanonicalTarget,
	sourceSnapshot?: string,
): SnaplineApplyTransactionOutcome {
	return {
		healthFailure: false,
		result: textToolResult(`Snapline apply rejected without writing: ${message}`, {
			...baseDetails(path, target),
			disposition: "rejected",
			...(sourceSnapshot ? { sourceSnapshot } : {}),
			contentChanged: false,
			error: { code, message },
		}),
	};
}

function unavailableApply(path: string, message: string, target?: CanonicalTarget): SnaplineApplyTransactionOutcome {
	return {
		healthFailure: true,
		result: textToolResult(message, {
			...baseDetails(path, target),
			disposition: "unavailable",
			contentChanged: false,
			error: { code: "snapline_unavailable", message },
		}),
	};
}

function rangesFromParams(params: SnaplineApplyParams): RecoverySourceRange[] {
	return [
		...(params.replacements ?? []).map((change) => ({ start: change.start, end: change.end })),
		...(params.deletions ?? []).map((change) => ({ start: change.start, end: change.end })),
		...(params.insertions_before ?? []).map((change) => ({ start: change.line, end: change.line })),
		...(params.insertions_after ?? []).map((change) => ({ start: change.line, end: change.line })),
	];
}

function rangesFromPrepared(prepared: PreparedModelBatch): RecoverySourceRange[] {
	return prepared.changes.map((change) =>
		change.group === "replacement" || change.group === "deletion"
			? { start: change.start, end: change.end }
			: { start: change.line, end: change.line },
	);
}

async function needsReview(
	path: string,
	target: CanonicalTarget,
	sourceSnapshot: string,
	code: string,
	message: string,
	ranges: readonly RecoverySourceRange[],
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<SnaplineApplyTransactionOutcome> {
	const recovery = await recoverCurrentSnapshot(target, ranges, message, cwd, signal, ledger, run);
	const body = recovery.body ?? `Needs review: ${message}\nThe previous write request was not applied. Recovery failed; perform a fresh snapline_read_file.`;
	return {
		healthFailure: recovery.healthFailure,
		result: textToolResult(body, {
			...baseDetails(path, target),
			disposition: "needs_review",
			sourceSnapshot,
			contentChanged: false,
			recovery: recovery.details,
			error: { code, message },
		}),
	};
}

async function outcomeUnknown(
	path: string,
	target: CanonicalTarget,
	sourceSnapshot: string,
	message: string,
	ranges: readonly RecoverySourceRange[],
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<SnaplineApplyTransactionOutcome> {
	ledger.clearFile(target.canonicalFileKey);
	const recovery = await recoverCurrentSnapshot(target, ranges, message, cwd, signal, ledger, run);
	const recoveryBody = recovery.body ? `\n\n${recovery.body}` : "\n\nCurrent context could not be recovered; perform a fresh snapline_read_file.";
	return {
		healthFailure: true,
		result: textToolResult(
			`Snapline apply outcome is unknown. Do not retry the same request: ${message}${recoveryBody}`,
			{
				...baseDetails(path, target),
				disposition: "outcome_unknown",
				sourceSnapshot,
				recovery: recovery.details,
				error: { code: "outcome_unknown", message },
			},
		),
	};
}

function logicalFailurePathMatches(failure: SnaplineLogicalFailure, target: CanonicalTarget): boolean {
	return failure.path === undefined || canonicalKeyFromPath(failure.path) === target.canonicalFileKey;
}

const RECOVERABLE_FAILURE_CODES = new Set([
	"snapshot_stale",
	"source_changed_before_commit",
	"proof_mismatch",
	"insufficient_read_proof",
]);

async function resolvePreparedBatch(
	params: SnaplineApplyParams,
	path: string,
	target: CanonicalTarget,
	lookup: ResolvedSnapshot,
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<{ prepared: PreparedModelBatch } | SnaplineApplyTransactionOutcome> {
	let prepared: PreparedModelBatch;
	try {
		prepared = prepareModelBatch(params, lookup.source.totalLines, lookup.source.exposedCoverage, lookup.source.exposedEmptyBoundary);
	} catch (error) {
		if (error instanceof SnaplineRequestError && error.code === "exposure_missing") {
			return needsReview(path, target, params.snapshot, error.code, error.message, rangesFromParams(params), cwd, signal, ledger, run);
		}
		return rejectedApply(path, error instanceof SnaplineRequestError ? error.code : "invalid_request", error instanceof Error ? error.message : String(error), target, params.snapshot);
	}
	try {
		return { prepared: translateModelBatch(prepared, lookup.lineage) };
	} catch (error) {
		if (error instanceof SnaplineRequestError && error.code === "lineage_conflict") {
			return needsReview(path, target, params.snapshot, error.code, error.message, rangesFromParams(params), cwd, signal, ledger, run);
		}
		return rejectedApply(path, error instanceof SnaplineRequestError ? error.code : "invalid_request", error instanceof Error ? error.message : String(error), target, params.snapshot);
	}
}

export async function runSnaplineApplyTransaction(
	params: SnaplineApplyParams,
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
	run: SnaplineRunner,
): Promise<SnaplineApplyTransactionOutcome> {
	const path = normalizeToolPath(params.path);
	let initialTarget: CanonicalTarget;
	try {
		initialTarget = await resolveCanonicalTarget(cwd, params.path);
	} catch (error) {
		return rejectedApply(path, "path_unavailable", error instanceof Error ? error.message : String(error), undefined, params.snapshot);
	}

	return withFileMutationQueue(initialTarget.canonicalFileKey, async () => {
		let target: CanonicalTarget;
		try {
			target = await resolveCanonicalTarget(cwd, params.path);
		} catch (error) {
			return rejectedApply(path, "path_unavailable", error instanceof Error ? error.message : String(error), initialTarget, params.snapshot);
		}
		if (!sameCanonicalTarget(initialTarget, target)) {
			return rejectedApply(path, "target_identity_changed", "The supplied path resolved to a different canonical target while waiting for the file queue.", initialTarget, params.snapshot);
		}

		const lookup = ledger.lookup(target.canonicalFileKey, params.snapshot);
		if (!lookup.ok) {
			ledger.clearFile(target.canonicalFileKey);
			return needsReview(path, target, params.snapshot, lookup.reason, "The submitted snapshot is unknown, ambiguous, or outside the current branch ancestry.", rangesFromParams(params), cwd, signal, ledger, run);
		}
		const resolved = await resolvePreparedBatch(params, path, target, lookup.value, cwd, signal, ledger, run);
		if (!("prepared" in resolved)) return resolved;
		const prepared = resolved.prepared;
		let proof;
		try {
			proof = collectApplyProof(prepared, lookup.value.head);
		} catch (error) {
			if (error instanceof ApplyValidationError && error.message.includes("missing line")) {
				return needsReview(path, target, params.snapshot, "proof_missing", error.message, rangesFromPrepared(prepared), cwd, signal, ledger, run);
			}
			return rejectedApply(path, "proof_limit", error instanceof Error ? error.message : String(error), target, params.snapshot);
		}
		const uncertainRecoveryRanges = [
			...rangesFromPrepared(prepared),
			...projectApplyProducedRanges(prepared, proof.lines),
		];

		const wireRequest = buildApplyWireRequest(target.canonicalTargetPath, lookup.value.head.revision, proof.ranges, prepared);
		const parsed = parseSnaplineApplyRun(await run(["apply"], JSON.stringify(wireRequest), cwd, signal));
		if (parsed.disposition === "unavailable") return unavailableApply(path, parsed.message, target);
		if (parsed.disposition === "outcome_unknown") {
			return outcomeUnknown(path, target, params.snapshot, parsed.message, uncertainRecoveryRanges, cwd, signal, ledger, run);
		}
		if (parsed.disposition === "rejected") {
			if (!logicalFailurePathMatches(parsed.failure, target)) {
				return outcomeUnknown(path, target, params.snapshot, "Snapline returned a logical outcome for a different canonical target.", uncertainRecoveryRanges, cwd, signal, ledger, run);
			}
			if (RECOVERABLE_FAILURE_CODES.has(parsed.failure.code)) {
				if (parsed.failure.code === "snapshot_stale" || parsed.failure.code === "source_changed_before_commit") ledger.clearFile(target.canonicalFileKey);
				return needsReview(path, target, params.snapshot, parsed.failure.code, parsed.failure.message, rangesFromPrepared(prepared), cwd, signal, ledger, run);
			}
			return rejectedApply(path, parsed.failure.code, parsed.failure.message, target, params.snapshot);
		}
		if (canonicalKeyFromPath(parsed.result.path) !== target.canonicalFileKey) {
			return outcomeUnknown(path, target, params.snapshot, "Snapline success referenced a different canonical target.", uncertainRecoveryRanges, cwd, signal, ledger, run);
		}

		let validated;
		try {
			validated = validateApplySuccess(parsed.result, prepared, lookup.value.head, proof.lines);
		} catch (error) {
			return outcomeUnknown(path, target, params.snapshot, error instanceof Error ? error.message : String(error), uncertainRecoveryRanges, cwd, signal, ledger, run);
		}
		let preview: ReturnType<typeof buildSnaplineChangePreview>;
		try {
			preview = buildSnaplineChangePreview(prepared, validated.effects, proof.lines);
		} catch {
			preview = undefined;
		}
		if (parsed.result.outcome === "no_op") {
			return {
				healthFailure: false,
				result: textToolResult(`No byte changes were needed. snapshot:${params.snapshot}`, {
					...baseDetails(path, target),
					disposition: "succeeded",
					sourceSnapshot: params.snapshot,
					snapshot: params.snapshot,
					contentChanged: false,
					stats: parsed.result.stats,
					effects: validated.effects,
					warnings: parsed.result.warnings,
					preview,
				}),
			};
		}

		try {
			const stage = ledger.stageChangedApply(
				target.canonicalFileKey,
				parsed.result.newRevision,
				parsed.result.stats.newLineCount,
				validated.effects.filter((effect) => effect.changed),
				validated.generatedLines,
				validated.generatedLines,
			);
			const committed = commitAppliedSnapshot({
				ledger,
				stage,
				prepared,
				effects: validated.effects,
				generatedLines: validated.generatedLines,
				stats: parsed.result.stats,
				warnings: parsed.result.warnings,
			});
			return {
				healthFailure: false,
				result: textToolResult(committed.body, {
					...baseDetails(path, target),
					disposition: "succeeded",
					sourceSnapshot: params.snapshot,
					snapshot: committed.snapshot,
					contentChanged: true,
					stats: parsed.result.stats,
					effects: validated.effects,
					warnings: parsed.result.warnings,
					producedRanges: committed.producedRanges,
					...(committed.producedTruncated ? { producedTruncated: true as const } : {}),
					...(committed.capacityRebased ? { capacityRebased: true as const } : {}),
					snapshotDelta: committed.delta,
					preview,
				}),
			};
		} catch (error) {
			ledger.clearFile(target.canonicalFileKey);
			const message = `The file was applied atomically, but the child snapshot could not be persisted: ${error instanceof Error ? error.message : String(error)}. Perform a fresh snapline_read_file.`;
			return {
				healthFailure: true,
				result: textToolResult(message, {
					...baseDetails(path, target),
					disposition: "succeeded",
					sourceSnapshot: params.snapshot,
					contentChanged: true,
					stats: parsed.result.stats,
					effects: validated.effects,
					warnings: parsed.result.warnings,
					preview,
					error: { code: "snapshot_persistence_failed", message },
				}),
			};
		}
	});
}
