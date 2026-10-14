import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { HLEDIT_APPLY_FILE_CHANGES_TOOL } from "./active-tools.ts";
import { lineFromAnchor } from "./anchor.ts";
import { applyFileChangesResult } from "./apply-result.ts";
import { buildAnchoredChangePreview, emptyChangePreview, type VerifiedChangePreview } from "./change-preview.ts";
import { runHledit } from "./cli.ts";
import { buildFileChangeRequest, changeShapeIssueResult, findChangeShapeIssue } from "./file-changes.ts";
import { formatReadProofFailure, ReadEvidenceStore, readProofFailureContext, resolveReadEvidencePath } from "./read-evidence.ts";
import { normalizeToolPath } from "./read-args.ts";
import { recoverMissingReadProof } from "./read-recovery.ts";
import { attachEvidencePath, rejectedToolResult, type TextResult } from "./result.ts";
import type { FileChangeParams } from "./schema.ts";

function appendResultText(result: TextResult, text: string): TextResult["content"] {
	const [first, ...rest] = result.content;
	return first ? [{ ...first, text: `${first.text}\n\n${text}` }, ...rest] : [{ type: "text", text }];
}

function appendCurrentProofId(result: TextResult, proofId: string | undefined): TextResult {
	const hasCurrentSnapshot = result.details.disposition === "rejected" && result.details.error?.code === "stale"
		&& result.details.error.currentAnchors && !result.details.error.currentAnchors.truncated
		&& result.details.error.currentAnchors.lines.every((line) => !line.textTruncated);
	if (!proofId || (result.details.disposition !== "succeeded" && !hasCurrentSnapshot)) return result;
	return { ...result, content: appendResultText(result, `proof_id: ${proofId}`), details: { ...result.details, proofId } };
}

// [喵喵喵]: preview 仅使用已验证输入，构建失败只降级显示，不推翻已确认的写入结果。
function tryBuildChangePreview(result: TextResult, build: () => VerifiedChangePreview | undefined): VerifiedChangePreview | undefined {
	try {
		return result.details.contentChanged === false ? emptyChangePreview() : build();
	} catch {
		return undefined;
	}
}

export async function runApplyTransaction(
	params: FileChangeParams,
	cwd: string,
	signal: AbortSignal | undefined,
	evidence: ReadEvidenceStore,
): Promise<TextResult> {
	const path = normalizeToolPath(params.path);
	const evidencePath = await resolveReadEvidencePath(cwd, path);
	const normalizedParams = { ...params, path };
	if (!normalizedParams.proof_id) {
		return attachEvidencePath(
			rejectedToolResult("The apply request is missing proof_id. Call hledit_read_anchors first and use its returned proof_id.", {
				code: "invalid_proof_id", message: "proof_id is required for anchored edits.",
			}), path, evidencePath,
		);
	}
	const applyWithinQueue = async (): Promise<TextResult> => {
		// [喵喵喵]: 请求自身的矛盾必须先拒绝，重读无法修复参数，不能落入 proof 恢复循环。
		const shapeIssue = findChangeShapeIssue(normalizedParams, {
			has: (anchor) => evidence.anchorsRequiringRead(evidencePath, [anchor]).length === 0,
		});
		if (shapeIssue) return attachEvidencePath(changeShapeIssueResult(shapeIssue, params.changes), path, evidencePath);
		const selection = evidence.selectProof(evidencePath, normalizedParams.changes, normalizedParams.proof_id);
		if ("failure" in selection) {
			const { failure } = selection;
			if (failure.code === "insufficient_read_proof") {
				const requiredRanges = evidence.recoveryRequirements(normalizedParams.changes);
				const recovered = await recoverMissingReadProof({
					failure, path, evidencePath, cwd, signal, run: runHledit, requiredRanges,
					canRetain: (reads, proofId) => evidence.canRetainRecovery(evidencePath, reads, proofId, requiredRanges),
					requiredLastLine: Math.max(...normalizedParams.changes.map((change) =>
						lineFromAnchor("end_anchor" in change ? change.end_anchor : change.anchor) ?? 0)),
				});
				if (recovered) return recovered;
			}
			return attachEvidencePath(rejectedToolResult(formatReadProofFailure(path, failure), {
				code: failure.code, message: failure.message, ...readProofFailureContext(failure),
			}), path, evidencePath);
		}

		// [喵喵喵]: 只迁移逐行验证存续的目标；CLI 仍复验 revision、完整 proof 与整批冲突。
		const effectiveParams = selection.normalizedChanges
			? { ...normalizedParams, changes: selection.normalizedChanges }
			: normalizedParams;
		const request = buildFileChangeRequest(effectiveParams, selection.proof);
		const run = await runHledit(request.args, request.stdin, cwd, signal);
		const result = attachEvidencePath(applyFileChangesResult(run, { path, changes: effectiveParams.changes }), path, evidencePath);
		if (result.details.disposition !== "succeeded") return result;
		const preview = tryBuildChangePreview(result, () => buildAnchoredChangePreview(effectiveParams.changes, selection.consumedLines));
		result.details = {
			...result.details,
			...(preview ? { changePreview: preview }
				: { previewError: "A verified change preview could not be built for this edit; the write itself succeeded." }),
		};
		if (selection.renamedAnchors?.length) {
			const resolved = selection.renamedAnchors.map((rename) => `${rename.requested} -> ${rename.current}`).join(", ");
			result.content = appendResultText(result, `Resolved verified anchors: ${resolved}.`);
			result.details.resolvedAnchors = selection.renamedAnchors;
		}
		return result;
	};

	// [喵喵喵]: CLI、证据转换和发布属于同一 canonical queue 事务；放行后下一次调用即可续编。
	return withFileMutationQueue(evidencePath, async () => {
		let result = await applyWithinQueue();
		evidence.updateFromToolResult(HLEDIT_APPLY_FILE_CHANGES_TOOL, result.details, cwd);
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
