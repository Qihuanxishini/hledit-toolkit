import { buildReadArgs, MAX_READ_LIMIT, normalizeReadRequest, suggestedReadWindow } from "./read-args.ts";
import {
	formatReadProofDiagnosis,
	lineRangeDescription,
	readProofFailureContext,
	type ReadProofFailure,
} from "./read-evidence.ts";
import type { HleditReadRunner } from "./read-transaction.ts";
import { formatReadMetadata, readAnchorsResult } from "./read-result.ts";
import { attachEvidencePath, rejectedToolResult, type HleditErrorMetadata, type HleditReadMetadata, type TextResult } from "./result.ts";

// 编辑证明缺口的定向补读：在调用方持有的 file mutation queue 事务内收集缺失行，
// 把源码原样返回给调用方复核后显式重提 batch；证据由调用方在队列放行前统一登记。
// 这一趟往返执行“模型必须看过被消费的行”的不变量，因此这里不自动重放修改。
//
// 读到的每一行都会回灌进调用方上下文，所以补读必须有预算。三个上限各管一件事，任一触发
// 都停止自动补读并返回终止性指导：
// - LINES：整批窗口累计行数（含确认上下文），不按首尾间的距离计数；超限时不启动读取；
// - PAGES：子进程轮数上限。CLI 每页另有 50 KiB 截断，长行文件会提前分页；
// - TEXT_BYTES：回灌正文的硬上限，与行数无关，长行文件由它兜底。
// 这些不是性能调优值：它们决定单次工具结果最多能占多少上下文窗口。
export const MAX_RECOVERY_LINES = 1_200;
export const MAX_RECOVERY_PAGES = 4;
export const MAX_RECOVERY_TEXT_BYTES = 96 * 1024;

export type ReadProofRecoveryRequest = {
	failure: ReadProofFailure;
	path: string;
	evidencePath: string;
	cwd: string;
	signal: AbortSignal | undefined;
	run: HleditReadRunner;
	requiredLastLine?: number;
	requiredRanges?: Array<{ start: number; end: number }>;
	canRetain?: (reads: readonly HleditReadMetadata[], proofId: string) => boolean;
};

// failure 没给出目标区间时无处可读（例如锚点行号本身不可用），交回调用方走普通拒绝。
export async function recoverMissingReadProof(request: ReadProofRecoveryRequest): Promise<TextResult | undefined> {
	const { failure, path, evidencePath, cwd, signal, run } = request;
	const fallback = failure.suggestedReadRange;
	if (!failure.recoveryRanges?.length && !fallback) return undefined;
	const fallbackWindow = fallback && suggestedReadWindow(fallback.start, fallback.end);
	const pending = (failure.recoveryRanges ?? (fallbackWindow ? [{ start: fallbackWindow.offset, end: fallbackWindow.lastLine }] : []))
		.map((range) => ({ ...range }));

	const diagnosis = formatReadProofDiagnosis(failure);
	const failureContext = readProofFailureContext(failure);
	const reads: HleditReadMetadata[] = [];
	const renderedPages: string[] = [];
	let renderedBytes = 0;
	let proofId: string | undefined;
	let expectedRevision = failure.recoveryRevision;
	let changedRevision: string | undefined;

	// 所有返回路径共用：诊断段 + 本路径指令 + 已渲染页面，并始终带上已完成补读的结构化
	// 结果。details 里的 recoveredReads 是 branch replay 的唯一依据（read-result.ts 的
	// READ_PROOF_RECOVERY_CODES），漏带就会让实时 evidence 与重放结果分歧。
	// [喵喵喵]: 实时登记也只消费返回结果，统一使用最终 proof id；逐页提前登记会让容量淘汰与重放分歧。
	const recoveryResult = (
		code: string,
		message: string,
		instructions: string[],
		nextAction: NonNullable<HleditErrorMetadata["nextAction"]>,
		extraDetails: Record<string, unknown> = {},
	): TextResult => {
		const proofIdInstruction = proofId && !instructions.some((instruction) => instruction.includes(`proof_id: ${proofId}`))
			? [`proof_id: ${proofId}`]
			: [];
		const rejected = rejectedToolResult(
			[diagnosis, ...proofIdInstruction, ...instructions, ...renderedPages].filter(Boolean).join("\n"),
			{ code, message, ...failureContext, nextAction, ...(changedRevision ? { currentRevision: changedRevision } : {}) },
		);
		return attachEvidencePath({
			...rejected,
			details: {
				...rejected.details,
				...(proofId ? { proofId } : {}),
				...(request.requiredRanges ? { recoveryRequiredRanges: request.requiredRanges } : {}),
				...(reads.length > 0 ? { recoveredReads: [...reads] } : {}),
				...extraDetails,
			},
		}, path, evidencePath);
	};

	const remainingInstruction = (): string => {
		const first = pending[0]!;
		const limit = Math.min(MAX_READ_LIMIT, first.end - first.start + 1);
		const ranges = pending.slice(0, 8).map(lineRangeDescription).join(", ");
		return `Remaining read windows: ${ranges}${pending.length > 8 ? `; ${pending.length - 8} more windows` : ""}. Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${first.start}, limit: ${limit} }), continue with nextOffset as needed, and cover all remaining required ranges before resubmitting the batch with current anchors and the latest proof_id.`;
	};
	const budgetResult = (message: string): TextResult => recoveryResult("proof_recovery_budget_exceeded", message, [
		`${message} ${reads.length > 0 ? `The ${reads.length} retained page(s) are recorded below; recovery is incomplete.` : "No recovery read was retained, so no source is included below."}`,
		remainingInstruction(),
		"If the change does not need to consume that many source lines, narrow start_anchor/end_anchor instead.",
	], "read_target");

	const plannedLines = pending.reduce((count, range) => count + range.end - range.start + 1, 0);
	if (plannedLines > MAX_RECOVERY_LINES) {
		return budgetResult(`The batch recovery plan spans ${plannedLines} lines, above the ${MAX_RECOVERY_LINES}-line automatic recovery budget. No recovery read was started.`);
	}

	while (pending.length > 0) {
		if (reads.length >= MAX_RECOVERY_PAGES || renderedBytes >= MAX_RECOVERY_TEXT_BYTES) {
			return budgetResult(`Automatic recovery stopped at its budget (${MAX_RECOVERY_PAGES} pages / ${Math.floor(MAX_RECOVERY_TEXT_BYTES / 1024)} KiB).`);
		}
		const range = pending[0]!;
		const readRequest = normalizeReadRequest({ path, offset: range.start, limit: Math.min(MAX_READ_LIMIT, range.end - range.start + 1) });
		const readResult = attachEvidencePath(
			readAnchorsResult(await run(buildReadArgs(readRequest), undefined, cwd, signal), readRequest),
			path,
			evidencePath,
		);
		if (readResult.details.disposition !== "succeeded" || !readResult.details.read) {
			if (readResult.details.error?.code === "range") {
				return recoveryResult("proof_recovery_read_failed", "The requested source range is outside the current file.", [
					readResult.content[0]?.text ?? "",
					"Stop this recovery plan. Do not retry the same offsets or batch: relocate the intended target within the current file and obtain fresh anchors. If the file is empty, no anchors exist; adding content requires write.",
				], "relocate_target", { recoveryReadError: readResult.details });
			}
			const message = "The targeted recovery read failed before edit proof could be established.";
			return recoveryResult("proof_recovery_read_failed", message,
				[`${message} Resolve the read error below before resubmitting.`, readResult.content[0]?.text ?? "", remainingInstruction()],
				"resolve_read_error", { recoveryReadError: readResult.details });
		}

		const recoveredRead = readResult.details.read;
		if (expectedRevision !== undefined && recoveredRead.revision !== expectedRevision) {
			// [喵喵喵]: 旧窗口计划基于旧坐标；跨 revision 时既不发布旧页面，也不登记新页或自动重试。
			// currentRevision 让实时状态和 branch replay 都失效旧 evidence，无需创建新 proof。
			reads.length = 0;
			renderedPages.length = 0;
			proofId = undefined;
			changedRevision = recoveredRead.revision;
			const message = "The file revision changed during proof recovery; the previous read plan is no longer valid.";
			return recoveryResult("proof_recovery_source_changed", message, [
				`${message} No content was written. Recovery pages were discarded. Reread the intended targets with hledit_read_anchors, reconfirm their locations, and use fresh anchors and proof_id; do not blindly resubmit the old batch.`,
			], "relocate_target");
		}
		expectedRevision = recoveredRead.revision;
		const requiredLastLine = request.requiredLastLine ?? failure.proofGap?.requiredEnd;
		// [喵喵喵]: 上下文窗口可越过 EOF，只有实际消费或依附的目标越界才终止恢复。
		if (requiredLastLine !== undefined && requiredLastLine > recoveredRead.actual.totalLines) {
			return recoveryResult("proof_recovery_read_failed", "The requested source range extends beyond the current file.", [
				`The requested target ends at line ${requiredLastLine}, but the file has ${recoveredRead.actual.totalLines} lines. Stop this recovery plan; do not resubmit the same batch. Relocate the intended target and obtain fresh anchors within the current file.`,
			], "relocate_target");
		}
		const renderedPage = formatReadMetadata(recoveredRead, undefined, "recovery");
		const renderedPageBytes = Buffer.byteLength(renderedPage, "utf8") + (renderedPages.length > 0 ? 1 : 0);
		const fitsBudget = renderedBytes + renderedPageBytes <= MAX_RECOVERY_TEXT_BYTES;
		if (recoveredRead.textTruncated) {
			// [喵喵喵]: 截断页不进入 recoveredReads；正文也受预算约束，避免展示与登记分歧。
			if (fitsBudget) renderedPages.push(renderedPage);
			const truncatedLine = recoveredRead.lines.find((line) => line.textTruncated)!.line;
			const message = `Source-line text at line ${truncatedLine} was truncated and cannot establish edit proof.`;
			return recoveryResult("source_line_truncated", message, [
				`${message} Do not resubmit this hledit_apply_file_changes call. Use write only if an intentional complete-file rewrite is safe.`,
				...(!fitsBudget ? ["The truncated source page was omitted to stay within the recovery text budget."] : []),
			], "inspect_source");
		}
		if (!fitsBudget) return budgetResult(`Automatic recovery stopped at its text budget (${Math.floor(MAX_RECOVERY_TEXT_BYTES / 1024)} KiB).`);
		reads.push(recoveredRead);
		renderedPages.push(renderedPage);
		renderedBytes += renderedPageBytes;
		proofId = readResult.details.proofId;

		// [喵喵喵]: 页数预算对整个计划共享；先完成当前窗口，再判断是否需要下一页。
		const nextOffset = recoveredRead.nextOffset;
		if (nextOffset !== undefined && nextOffset <= range.end) range.start = nextOffset;
		else pending.shift();
	}

	if (proofId && request.canRetain && !request.canRetain(reads, proofId)) {
		return recoveryResult("evidence_capacity_exceeded", "The full target evidence cannot remain retained after recovery.", [
			"The source pages below are shown for review, but the entire batch is NOT authorized: its required evidence cannot remain retained together. Do not resubmit this unchanged batch or keep paging the same ranges. Narrow the consumed ranges, or ask whether separate batches are acceptable; splitting forfeits whole-batch atomicity. No content was written.",
		], "reduce_batch");
	}
	return recoveryResult(failure.code, failure.message, [
		`The batch recovery plan was read and recorded in ${reads.length} page(s). Review the displayed source, replace any mismatched endpoint anchors with the returned current anchors, then explicitly resubmit the batch using the proof_id above. The batch has not been executed.`,
	], "review_and_retry");
}
