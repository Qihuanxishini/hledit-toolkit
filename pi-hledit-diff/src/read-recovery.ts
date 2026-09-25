import { buildReadArgs, MAX_READ_LIMIT, normalizeReadRequest, suggestedReadWindow } from "./read-args.ts";
import {
	formatReadProofDiagnosis,
	lineRangeDescription,
	readProofFailureContext,
	type ReadEvidenceStore,
	type ReadProofFailure,
} from "./read-evidence.ts";
import type { HleditReadRunner } from "./read-transaction.ts";
import { formatReadMetadata, readAnchorsResult } from "./read-result.ts";
import { attachEvidencePath, rejectedToolResult, type HleditReadMetadata, type TextResult } from "./result.ts";

// 编辑证明缺口的定向补读：在调用方已持有的 file mutation queue 事务内，用 read-range 把
// selectProof 指出的缺失行读回来、记进 evidence，再把源码原样返回给调用方复核后显式重提
// batch。这一趟往返正是"模型必须看过被消费的行"这条不变量的执行点，因此这里不自动重放修改。
//
// 读到的每一行都会回灌进调用方上下文，所以补读必须有预算。三个上限各管一件事，任一触发
// 都停止自动补读并返回终止性指导：
// - LINES：缺口跨度。超限时一个子进程都不启动——先读 200 KB 再说"太大了"是最差的结果；
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
	evidence: ReadEvidenceStore;
	run: HleditReadRunner;
};

// failure 没给出目标区间时无处可读（例如锚点行号本身不可用），交回调用方走普通拒绝。
export async function recoverMissingReadProof(request: ReadProofRecoveryRequest): Promise<TextResult | undefined> {
	const { failure, path, evidencePath, cwd, signal, evidence, run } = request;
	const range = failure.suggestedReadRange;
	if (!range) return undefined;

	const diagnosis = formatReadProofDiagnosis(failure);
	const failureContext = readProofFailureContext(failure);
	const reads: HleditReadMetadata[] = [];
	const renderedPages: string[] = [];
	let renderedBytes = 0;
	let proofId: string | undefined;

	// 所有返回路径共用：诊断段 + 本路径指令 + 已渲染页面，并始终带上已完成补读的结构化
	// 结果。details 里的 recoveredReads 是 branch replay 的唯一依据（read-result.ts 的
	// READ_PROOF_RECOVERY_CODES），漏带就会让实时 evidence 与重放结果分歧。
	const recoveryResult = (
		code: string,
		message: string,
		instructions: string[],
		extraDetails: Record<string, unknown> = {},
	): TextResult => {
		const proofIdInstruction = proofId && !instructions.some((instruction) => instruction.includes(`proof_id: ${proofId}`))
			? [`proof_id: ${proofId}`]
			: [];
		const rejected = rejectedToolResult(
			[diagnosis, ...proofIdInstruction, ...instructions, ...renderedPages].filter(Boolean).join("\n"),
			{ code, message, ...failureContext },
		);
		return attachEvidencePath({
			...rejected,
			details: {
				...rejected.details,
				...(proofId ? { proofId } : {}),
				...(reads.length > 0 ? { recoveredReads: [...reads] } : {}),
				...extraDetails,
			},
		}, path, evidencePath);
	};

	const explicitReadInstruction = (start: number): string => {
		const window = suggestedReadWindow(start, range.end);
		const call = `hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${window.offset}, limit: ${window.limit} })`;
		const readInstruction = window.lastLine < range.end
			? `Call ${call}, continue with nextOffset until line ${range.end} is covered.`
			: `Call ${call} to cover ${lineRangeDescription({ start, end: range.end })}.`;
		return `${readInstruction} Use proof_id from the latest successful read page and current anchors, then resubmit the batch.`;
	};
	const narrowRangeInstruction =
		"If the change does not need to consume that many source lines, narrow start_anchor/end_anchor instead; a range operation must cover exactly the block it replaces or deletes.";

	const spanLines = range.end - range.start + 1;
	if (spanLines > MAX_RECOVERY_LINES) {
		const message = `The missing source range spans ${spanLines} lines, above the ${MAX_RECOVERY_LINES}-line automatic recovery budget.`;
		return recoveryResult("proof_recovery_budget_exceeded", message, [
			`${message} No recovery read was started, so no source is included below.`,
			explicitReadInstruction(range.start),
			narrowRangeInstruction,
		]);
	}

	const firstWindow = suggestedReadWindow(range.start, range.end);
	let readRequest = normalizeReadRequest({ path, offset: firstWindow.offset, limit: firstWindow.limit });
	for (;;) {
		const readResult = attachEvidencePath(
			readAnchorsResult(await run(buildReadArgs(readRequest), undefined, cwd, signal), readRequest),
			path,
			evidencePath,
		);
		if (readResult.details.disposition !== "succeeded" || !readResult.details.read) {
			const message = "The targeted recovery read failed before edit proof could be established.";
			return recoveryResult(
				"proof_recovery_read_failed",
				message,
				[`${message} Resolve the read error below before resubmitting.`, readResult.content[0]?.text ?? ""],
				{ recoveryReadError: readResult.details },
			);
		}

		const recoveredRead = readResult.details.read;
		const renderedPage = formatReadMetadata(recoveredRead);
		const renderedPageBytes = Buffer.byteLength(renderedPage, "utf8")
			+ (renderedPages.length > 0 ? Buffer.byteLength("\n", "utf8") : 0);
		const fitsBudget = renderedBytes + renderedPageBytes <= MAX_RECOVERY_TEXT_BYTES;
		if (recoveredRead.textTruncated) {
			// 截断行不能进入 evidence/recoveredReads，实时状态与 branch replay 必须一致。
			// [喵喵喵]: 截断页也受正文预算约束；整页容纳不下时仅报告行号，
			// 仍保留终止性诊断，避免调用方反复补读同一超长行。(2026-09-05)
			if (fitsBudget) renderedPages.push(renderedPage);
			const truncatedLine = recoveredRead.lines.find((line) => line.textTruncated)!.line;
			const message = `Source-line text at line ${truncatedLine} was truncated and cannot establish edit proof.`;
			return recoveryResult("source_line_truncated", message, [
				`${message} Do not resubmit this hledit_apply_file_changes call. Use write only if an intentional complete-file rewrite is safe.`,
				...(!fitsBudget ? ["The truncated source page was omitted to stay within the recovery text budget."] : []),
			]);
		}

		if (!fitsBudget) {
			// [喵喵喵]: 先判断候选页再写入 evidence，避免正文预算超限而模型仍拿到
			// 不完整的补读上下文；被丢弃的页面必须由模型显式重读。
			const recoveryStart = Math.max(range.start, readRequest.offset);
			const message = `Automatic recovery stopped at its budget (${MAX_RECOVERY_PAGES} pages / ${Math.floor(MAX_RECOVERY_TEXT_BYTES / 1024)} KiB) before covering ${lineRangeDescription({ start: recoveryStart, end: range.end })}.`;
			return recoveryResult("proof_recovery_budget_exceeded", message, [
				`${message} ${reads.length > 0 ? `The ${reads.length} page(s) already read are recorded below and remain valid proof.` : "No recovery page was retained, so no source is included below."}`,
				explicitReadInstruction(recoveryStart),
				narrowRangeInstruction,
			]);
		}
		reads.push(recoveredRead);
		renderedPages.push(renderedPage);
		renderedBytes += renderedPageBytes;
		proofId = readResult.details.proofId;
		evidence.recordRead(evidencePath, recoveredRead, proofId);

		const nextOffset = recoveredRead.nextOffset;
		// 先判定是否已覆盖缺口，再判定预算：最后一页正好把缺口读完时不该报超预算。
		if (nextOffset === undefined || nextOffset > range.end) break;
		// 此处 nextOffset 即仍缺证据的起点，用于给出准确的"还差哪里"。
		if (reads.length >= MAX_RECOVERY_PAGES || renderedBytes >= MAX_RECOVERY_TEXT_BYTES) {
			const message = `Automatic recovery stopped at its budget (${MAX_RECOVERY_PAGES} pages / ${Math.floor(MAX_RECOVERY_TEXT_BYTES / 1024)} KiB) before covering ${lineRangeDescription({ start: nextOffset, end: range.end })}.`;
			return recoveryResult("proof_recovery_budget_exceeded", message, [
				`${message} The ${reads.length} page(s) already read are recorded below and remain valid proof.`,
				explicitReadInstruction(nextOffset),
				narrowRangeInstruction,
			]);
		}
		readRequest = normalizeReadRequest({
			path,
			offset: nextOffset,
			limit: Math.min(MAX_READ_LIMIT, range.end - nextOffset + 1),
		});
	}

	const renameInstruction = failure.renamedAnchors?.length ? "apply every listed anchor rename, " : "";
	return recoveryResult(failure.code, failure.message, [
		`The targeted missing range was read and recorded in ${reads.length} page(s). Review the current source, ${renameInstruction}replace any mismatched endpoint anchors with the returned current anchors, then resubmit the batch once using the proof_id above.`,
	]);
}
