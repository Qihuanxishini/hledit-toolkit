import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	HLEDIT_SEARCH_ANCHORS_TOOL,
} from "./active-tools.ts";
import { computeAnchorTag } from "./anchor-hash.ts";
import { lineFromAnchor } from "./anchor.ts";
import type { HleditBatchReadProof } from "./file-changes.ts";
import { parseAnchorContext, parseUpdatedAnchorSpans } from "./post-edit-context.ts";
import { nextProofId } from "./proof-id.ts";
import { parseHleditReadMetadata, parseRecoveredReads } from "./read-result.ts";
import {
	isRawRevision,
	isRecord,
	parseEditDeltas,
	type HleditDetails,
	type HleditErrorMetadata,
	type HleditReadMetadata,
} from "./result.ts";
import { suggestedReadWindow } from "./read-args.ts";
import { MAX_FILE_CHANGE_COUNT, type FileChangeParams } from "./schema.ts";

import { ProofState, MAX_EVIDENCE_RECORDS_PER_FILE, type EvidenceLine } from "./proof-state.ts";
export { MAX_EVIDENCE_RECORDS_PER_FILE, MAX_EVIDENCE_BYTES_PER_FILE, MAX_EVIDENCE_RECORDS_PER_SESSION, MAX_EVIDENCE_BYTES_PER_SESSION } from "./proof-state.ts";

type ReadProofLineRange = { start: number; end: number };
type FileChangeOperation = FileChangeParams["changes"][number]["operation"];

type RequestedSourceRange = ReadProofLineRange & {
	changeNumber: number;
	operation: FileChangeOperation;
};

// [喵喵喵]: 同一物理行可能被多个 change 引用；逐项保留端点，避免按行号建 Map
// 时后一个锚点覆盖前一个待验证锚点。(2026-07-28)
type RequestedEndpointAnchor = {
	line: number;
	anchor: string;
	changeNumber: number;
	operation: FileChangeOperation;
};

export type ReadProofGap = ReadProofLineRange & {
	changeNumber: number;
	operation: FileChangeOperation;
	requiredStart: number;
	requiredEnd: number;
};

export type RenamedAnchor = {
	requested: string;
	current: string;
};

export type ReadProofFailure = {
	code: "insufficient_read_proof" | "invalid_proof_id" | "evidence_capacity_exceeded" | "read_evidence_evicted"
		| "invalid_anchor_range" | "target_consumed" | "target_changed" | "proof_source_unavailable";
	message: string;
	reportedMissingLines: number[];
	suggestedReadRange?: ReadProofLineRange;
	proofGap?: ReadProofGap;
	recoveryRanges?: ReadProofLineRange[];
	recoveryRevision?: string;
};

// 本次修改实际消费或依附的、同 revision 完整读取行；只用于插件内部的护栏与
// change preview，不进入公开工具 schema。
export type ConsumedEvidenceLine = {
	line: number;
	anchor: string;
	text: string;
};

export type ReadProofSelection =
	| {
		proof: HleditBatchReadProof;
		consumedLines: Map<number, ConsumedEvidenceLine>;
		normalizedChanges?: FileChangeParams["changes"];
		renamedAnchors?: RenamedAnchor[];
	}
	| { failure: ReadProofFailure };

function evidencePathFromDetails(details: Record<string, unknown>, cwd: string): string | undefined {
	if (typeof details.evidencePath === "string" && details.evidencePath.length > 0) {
		return details.evidencePath;
	}
	const read = isRecord(details.read) ? details.read : undefined;
	const path = typeof details.path === "string" ? details.path : typeof read?.path === "string" ? read.path : undefined;
	return path ? resolve(cwd, path) : undefined;
}


type RequestedChangeEvidence = {
	ranges: ReadProofLineRange[];
	sourceRanges: RequestedSourceRange[];
	endpointAnchors: RequestedEndpointAnchor[];
};

const MAX_REPORTED_MISSING_LINES = 20;

function requestedChangeEvidence(changes: FileChangeParams["changes"]): RequestedChangeEvidence | undefined {
	const sourceRanges: RequestedSourceRange[] = [];
	const endpointAnchors: RequestedEndpointAnchor[] = [];
	for (const [changeIndex, change] of changes.entries()) {
		const changeNumber = changeIndex + 1;
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			const line = lineFromAnchor(change.anchor);
			if (line === undefined) return undefined;
			sourceRanges.push({ start: line, end: line, changeNumber, operation: change.operation });
			endpointAnchors.push({ line, anchor: change.anchor, changeNumber, operation: change.operation });
			continue;
		}

		const start = lineFromAnchor(change.start_anchor);
		const end = lineFromAnchor(change.end_anchor);
		if (start === undefined || end === undefined || start > end) return undefined;
		sourceRanges.push({ start, end, changeNumber, operation: change.operation });
		endpointAnchors.push(
			{ line: start, anchor: change.start_anchor, changeNumber, operation: change.operation },
			{ line: end, anchor: change.end_anchor, changeNumber, operation: change.operation },
		);
	}

	// [喵喵喵]: 仅合并真正重叠的范围；相邻 change 保持独立，避免首个缺口的
	// reportedMissingLines 越过受影响 operation 的边界。(2026-07-28)
	const rangesInFileOrder = [...sourceRanges].sort((left, right) => left.start - right.start || left.end - right.end);
	const mergedRanges: ReadProofLineRange[] = [];
	for (const range of rangesInFileOrder) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			mergedRanges.push({ start: range.start, end: range.end });
		}
	}
	return { ranges: mergedRanges, sourceRanges, endpointAnchors };
}

export function lineRangeDescription(range: ReadProofLineRange): string {
	return range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
}

function proofGapFromMissingRange(
	missingRange: ReadProofLineRange | undefined,
	sourceRanges: RequestedSourceRange[],
): ReadProofGap | undefined {
	if (!missingRange) return undefined;
	// [喵喵喵]: 边界 insert 与 range 可合法共享端点；多个 change 同时覆盖首个缺行时，
	// 选择结束最远者可一次补齐完整范围，避免先补单行再补 range。(2026-07-28)
	const sourceRange = sourceRanges
		.filter((range) => range.start <= missingRange.start && range.end >= missingRange.start)
		.reduce<RequestedSourceRange | undefined>((selected, range) =>
			!selected || range.end > selected.end ? range : selected, undefined);
	if (!sourceRange) return undefined;
	return {
		start: Math.max(missingRange.start, sourceRange.start),
		end: Math.min(missingRange.end, sourceRange.end),
		changeNumber: sourceRange.changeNumber,
		operation: sourceRange.operation,
		requiredStart: sourceRange.start,
		requiredEnd: sourceRange.end,
	};
}

function formatProofGapMessage(gap: ReadProofGap): string {
	const missingRange = lineRangeDescription(gap);
	if (gap.operation === "replace_range" || gap.operation === "delete_range") {
		return `Change ${gap.changeNumber} (${gap.operation} ${gap.requiredStart}-${gap.requiredEnd}) requires complete read proof for every source line in the inclusive range; missing ${missingRange}. Endpoint anchors alone are insufficient.`;
	}
	return `Change ${gap.changeNumber} (${gap.operation} at line ${gap.requiredStart}) requires complete read proof for its anchor line; missing ${missingRange}.`;
}

function collectProofCoverage(
	ranges: ReadProofLineRange[],
	evidenceLines: Map<number, EvidenceLine>,
): { coveredLines: number[]; reportedMissingLines: number[]; firstMissingRange: ReadProofLineRange | undefined } {
	const coveredLines: number[] = [];

	// [喵喵喵]: 诊断只属于首个连续缺口；后续 change 的缺行不应混入同一次
	// failure，完整补读跨度由 affected change 的 evidence 另行计算。(2026-07-28)
	const missingCoverage = (start: number, end: number) => {
		const reportCount = Math.min(end - start + 1, MAX_REPORTED_MISSING_LINES);
		return {
			coveredLines,
			reportedMissingLines: Array.from({ length: reportCount }, (_, offset) => start + offset),
			firstMissingRange: { start, end },
		};
	};

	for (const range of ranges) {
		for (let line = range.start; line <= range.end; line += 1) {
			if (evidenceLines.has(line)) {
				coveredLines.push(line);
				continue;
			}
			// [喵喵喵]: 正常路径只查询消费行；缺口时无排序寻找下个已知行，避免枚举异常大空区间。
			let missingEnd = range.end;
			for (const availableLine of evidenceLines.keys()) {
				if (availableLine > line && availableLine <= missingEnd) missingEnd = availableLine - 1;
			}
			return missingCoverage(line, missingEnd);
		}
	}
	return { coveredLines, reportedMissingLines: [], firstMissingRange: undefined };
}

// [喵喵喵]: 保留首个受影响 change 的建议跨度供主诊断使用；实际自动补读采用整批 recoveryRanges。
function unresolvedReadSpanForChange(gap: ReadProofGap, evidenceLines: Map<number, EvidenceLine>): ReadProofLineRange {
	let lastMissingLine = gap.requiredEnd;
	while (lastMissingLine > gap.end && evidenceLines.has(lastMissingLine)) lastMissingLine -= 1;
	return { start: gap.start, end: Math.max(gap.end, lastMissingLine) };
}

// [喵喵喵]: 只在失败路径规划整批实际缺口；消费行总数已由 selectProof 的容量预检约束。
// 已知但不匹配或有歧义的端点保留确认上下文，普通缺行仅合并近邻窗口。
function recoveryRangesFor(
	requested: RequestedChangeEvidence,
	evidenceLines: Map<number, EvidenceLine>,
	ambiguousTokens: ReadonlySet<string> = new Set(),
): ReadProofLineRange[] {
	const windows: ReadProofLineRange[] = [];
	for (const range of requested.ranges) {
		let start: number | undefined;
		for (let line = range.start; line <= range.end; line += 1) {
			if (!evidenceLines.has(line)) start ??= line;
			else if (start !== undefined) {
				windows.push({ start, end: line - 1 });
				start = undefined;
			}
		}
		if (start !== undefined) windows.push({ start, end: range.end });
	}
	for (const endpoint of requested.endpointAnchors) {
		const known = evidenceLines.get(endpoint.line);
		if (ambiguousTokens.has(endpoint.anchor) || (known && known.anchor !== endpoint.anchor)) {
			const window = suggestedReadWindow(endpoint.line, endpoint.line);
			windows.push({ start: window.offset, end: window.lastLine });
		}
	}
	windows.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: ReadProofLineRange[] = [];
	for (const window of windows) {
		const previous = merged.at(-1);
		// [喵喵喵]: 至多跨接两行已知源码，沿用确认上下文的尺度，避免零碎缺口耗尽页数预算。
		if (previous && window.start - previous.end - 1 <= 2) previous.end = Math.max(previous.end, window.end);
		else merged.push({ ...window });
	}
	return merged;
}

export async function resolveReadEvidencePath(cwd: string, path: string): Promise<string> {
	const absolutePath = resolve(cwd, path);
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

function replaceRenamedAnchors(
	changes: FileChangeParams["changes"],
	renames: Map<string, string>,
): { changes: FileChangeParams["changes"]; renamedAnchors: RenamedAnchor[] } {
	const renamedAnchors: RenamedAnchor[] = [];
	const seen = new Set<string>();
	const substitute = (anchor: string): string => {
		const current = renames.get(anchor);
		if (current && !seen.has(anchor)) {
			seen.add(anchor);
			renamedAnchors.push({ requested: anchor, current });
		}
		return current ?? anchor;
	};
	return {
		changes: changes.map((change) => {
			if (change.operation === "insert_before" || change.operation === "insert_after") {
				return { ...change, anchor: substitute(change.anchor) };
			}
			return {
				...change,
				start_anchor: substitute(change.start_anchor),
				end_anchor: substitute(change.end_anchor),
			};
		}),
		renamedAnchors,
	};
}

type EvidenceProofFailure = {
	message: string;
	reportedMissingLines: number[];
	suggestedReadRange?: ReadProofLineRange;
	proofGap?: ReadProofGap;
	recoveryRanges?: ReadProofLineRange[];
};

type EvidenceProofEvaluation =
	| { anchors: string[]; coveredLines: number[] }
	| { failure: EvidenceProofFailure };

function insufficientReadProof(failure: EvidenceProofFailure): ReadProofFailure {
	return { code: "insufficient_read_proof", ...failure };
}

function consumedEvidenceLines(coveredLines: number[], evidenceLines: Map<number, EvidenceLine>): Map<number, ConsumedEvidenceLine> {
	const consumed = new Map<number, ConsumedEvidenceLine>();
	for (const line of coveredLines) {
		const info = evidenceLines.get(line)!;
		consumed.set(line, { line, anchor: info.anchor, text: info.text });
	}
	return consumed;
}

// 对同一份证据评估一次请求的逐行 coverage 与每个提交端点；selectProof 用它分别
// 评估原始请求与"更名替换后"的 what-if 请求。
function evaluateProofAgainstEvidence(
	requested: RequestedChangeEvidence,
	evidenceLines: Map<number, EvidenceLine>,
	renames: Map<string, string>,
): EvidenceProofEvaluation {
	const coverage = collectProofCoverage(requested.ranges, evidenceLines);
	if (coverage.reportedMissingLines.length > 0) {
		const proofGap = proofGapFromMissingRange(coverage.firstMissingRange, requested.sourceRanges);
		const suggestedReadRange = proofGap
			? unresolvedReadSpanForChange(proofGap, evidenceLines)
			: coverage.firstMissingRange;
		return {
			failure: {
				message: proofGap
					? formatProofGapMessage(proofGap)
					: `Read proof is missing ${lineRangeDescription(coverage.firstMissingRange ?? { start: coverage.reportedMissingLines[0]!, end: coverage.reportedMissingLines.at(-1)! })}.`,
				reportedMissingLines: coverage.reportedMissingLines,
				recoveryRanges: recoveryRangesFor(requested, evidenceLines),
				...(suggestedReadRange ? { suggestedReadRange } : {}),
				...(proofGap ? { proofGap } : {}),
			},
		};
	}
	for (const endpoint of requested.endpointAnchors) {
		if (evidenceLines.get(endpoint.line)?.anchor !== endpoint.anchor) {
			return {
				failure: {
					message: renames.has(endpoint.anchor)
						? `Change ${endpoint.changeNumber} (${endpoint.operation}) submitted anchor ${endpoint.anchor} from before this file's last edit; the same unchanged content now has a shifted line number.`
						: `Change ${endpoint.changeNumber} (${endpoint.operation}) submitted anchor for line ${endpoint.line} does not match the most recently read anchor on this branch.`,
					reportedMissingLines: [endpoint.line],
					suggestedReadRange: { start: endpoint.line, end: endpoint.line },
					recoveryRanges: recoveryRangesFor(requested, evidenceLines),
				},
			};
		}
	}
	return { anchors: coverage.coveredLines.map((line) => evidenceLines.get(line)!.anchor), coveredLines: coverage.coveredLines };
}

// 诊断段：失败原因与已验证的锚点更名。补读成功与未补读两条路径共用同一段诊断，
// 各自追加自己的后续指令；调用方不得再从完整正文里切割这一段。
export function formatReadProofDiagnosis(failure: ReadProofFailure): string {
	if (failure.code === "evidence_capacity_exceeded" || failure.code === "read_evidence_evicted") {
		return `Read evidence capacity prevents this batch from proceeding. Batch was not started and no content was written.\nReason: ${failure.message}`;
	}
	if (failure.code === "invalid_proof_id") {
		return [
			"The submitted proof_id is not valid for the current editable evidence. Batch was not started and no content was written.",
			`Reason: ${failure.message}`,
		].join("\n");
	}
	if (["target_consumed", "target_changed", "proof_source_unavailable", "invalid_anchor_range"].includes(failure.code)) {
		return `The target cannot be authorized by this proof. Batch was not started and no content was written.\nReason: ${failure.message}`;
	}
	const lines = [
		"Valid read proof does not cover every source line required by this change. Batch was not started and no content was written.",
		`Reason: ${failure.message}`,
	];
	return lines.join("\n");
}

// 失败结果 error 元数据中与 proof 缺口相关的结构化字段；直接拒绝与补读后拒绝共用。
export function readProofFailureContext(failure: ReadProofFailure): Pick<HleditErrorMetadata, "changeNumber" | "operation" | "nextAction"> {
	return {
		nextAction: failure.code === "evidence_capacity_exceeded" ? "reduce_batch"
			: ["target_consumed", "target_changed", "proof_source_unavailable", "invalid_anchor_range"].includes(failure.code) ? "relocate_target" : "read_target",
		...(failure.proofGap ? { changeNumber: failure.proofGap.changeNumber, operation: failure.proofGap.operation } : {}),
	};
}

export function formatReadProofFailure(path: string, failure: ReadProofFailure): string {
	const lines = [formatReadProofDiagnosis(failure)];
	if (failure.code === "evidence_capacity_exceeded") {
		lines.push("Do not keep paging or resubmit this unchanged batch. Narrow the consumed ranges to the intended changes. If separate batches are semantically safe, read and apply each separately; splitting forfeits whole-batch atomicity. Otherwise stop and ask the user to choose a larger-edit workflow.");
		return lines.join("\n");
	}
	if (readProofFailureContext(failure).nextAction === "relocate_target") {
		lines.push("Stop this batch. Locate the intended target in the current file and obtain its proof and anchors; no old-coordinate recovery will be attempted.");
		return lines.join("\n");
	}
	if (!failure.suggestedReadRange && failure.reportedMissingLines.length === 0) {
		lines.push(failure.code === "invalid_proof_id"
			? `Call hledit_read_anchors for ${JSON.stringify(path)} to obtain a proof for this target, then review its anchors before submitting a new batch.`
			: "Correct the request anchors and range before retrying; a targeted read cannot be determined from this request.");
		return lines.join("\n");
	}
	const targetLines = failure.reportedMissingLines;
	const firstLine = failure.suggestedReadRange?.start ?? targetLines[0] ?? 1;
	const lastLine = failure.suggestedReadRange?.end ?? targetLines[targetLines.length - 1] ?? firstLine;
	const { offset, limit, lastLine: lastSuggestedLine } = suggestedReadWindow(firstLine, lastLine);
	const completionTarget = failure.proofGap
		? `all required source lines for change ${failure.proofGap.changeNumber} through line ${lastLine}`
		: firstLine === lastLine ? "the target line" : "the complete target range";
	const readInstruction = lastSuggestedLine < lastLine
		? `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first, then continue with nextOffset until line ${lastLine} is covered.`
		: `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first and confirm ${completionTarget}.`;
	const resubmitInstruction = "After the read succeeds, use proof_id from the latest successful read page and current anchors, then resubmit the hledit_apply_file_changes batch.";
	if (failure.code === "read_evidence_evicted") {
		lines.push("Earlier evidence exceeded the per-file cache limit. Use the targeted read below rather than paging the whole file again. If it evicts another required range, stop: narrow the batch or ask whether separate, non-atomic batches are acceptable.");
	}
	lines.push(readInstruction, resubmitInstruction);
	return lines.join("\n");
}

function priorityLines(value: unknown): Set<number> | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILE_CHANGE_COUNT) return undefined;
	const lines = new Set<number>();
	let count = 0;
	for (const range of value) {
		if (!isRecord(range) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
			|| typeof range.start !== "number" || typeof range.end !== "number" || range.start < 1 || range.end < range.start) return undefined;
		count += range.end - range.start + 1;
		if (count >= MAX_EVIDENCE_RECORDS_PER_FILE) return undefined;
		for (let line = range.start; line <= range.end; line++) lines.add(line);
	}
	return lines;
}
export class ReadEvidenceStore {
	private readonly state = new ProofState();
	private timeline = nextProofId();
	private sequence = 0;
	clear(): void { this.state.clear(); }
	invalidate(path: string): void { this.state.invalidate(path); }
	getProofId(path: string): string | undefined { return this.state.get(path)?.current.proofId; }

	recoveryRequirements(changes: FileChangeParams["changes"]): Array<{ start: number; end: number }> {
		return requestedChangeEvidence(changes)?.ranges ?? [];
	}
	canRetainRecovery(path: string, reads: readonly HleditReadMetadata[], proofId: string, ranges: unknown): boolean {
		const priority = priorityLines(ranges);
		if (!priority) return false;
		// [喵喵喵]: 只复制目标文件的有界索引；源行共享且不修改原状态，判据与正式登记一致。
		const prospective = this.state.forkFile(path);
		for (const read of reads) prospective.read(path, read.revision, read.lines, proofId, read.actual.totalLines, priority);
		const retained = prospective.get(path)?.current.lines;
		return [...priority].every((line) => retained?.has(line));
	}
	recordRead(path: string, read: HleditReadMetadata, proofId?: string): void {
		if (read.requested.pattern !== undefined && read.lines.length === 0) {
			if (this.state.get(path)?.current.revision === read.revision) this.state.touch(path);
			else this.invalidate(path);
			return;
		}
		this.state.read(path, read.revision, read.lines, proofId, read.actual.totalLines);
	}

	anchorsRequiringRead(path: string, anchors: readonly string[]): string[] {
		const lines = this.state.get(path)?.current.lines;
		return anchors.filter((anchor) => lines?.get(lineFromAnchor(anchor) ?? 0)?.anchor !== anchor);
	}
	anchorTokens(path: string): ReadonlySet<string> {
		return new Set([...(this.state.get(path)?.current.lines.values() ?? [])].map((line) => line.anchor));
	}

	selectProof(path: string, changes: FileChangeParams["changes"], proofId?: string): ReadProofSelection {
		const file = this.state.get(path);
		const fail = (code: ReadProofFailure["code"], message: string): ReadProofSelection => ({ failure: { code, message, reportedMissingLines: [] } });
		if (proofId !== undefined && this.state.owner(proofId) !== path) {
			const owner = this.state.owner(proofId);
			return fail("invalid_proof_id", owner
				? `proof_id ${proofId} was issued for ${JSON.stringify(owner)}, not ${JSON.stringify(path)}. Obtain a proof for the target file.`
				: `proof_id ${proofId} is unknown or expired on this branch. Obtain fresh target evidence; do not pair old anchors with a different proof.`);
		}
		const requested = requestedChangeEvidence(changes);
		if (!requested?.ranges.length) return fail("invalid_anchor_range", "Verify anchor line numbers and range order; this request cannot be repaired by reading the same offsets.");
		const historical = proofId === undefined || file?.current.proofIds.has(proofId) ? undefined
			: file?.history.find((item) => item.epoch.proofIds.has(proofId));
		const epoch = historical?.epoch ?? file?.current;
		if (epoch?.totalLines !== undefined && requested.ranges.some((range) => range.end > epoch.totalLines!)) {
			return fail("invalid_anchor_range", epoch.totalLines === 0
				? "The proof describes an empty file. No line anchors exist. Adding content requires an intentional write, not an anchored edit."
				: `The requested target is outside this proof's ${epoch.totalLines}-line snapshot. Stop this recovery plan; relocate the target and obtain fresh anchors rather than repeating invalid offsets.`);
		}
		const requiredLines = requested.ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
		if (requiredLines >= MAX_EVIDENCE_RECORDS_PER_FILE) return fail("evidence_capacity_exceeded", `This batch requires ${requiredLines} distinct source lines plus a proof id, exceeding the ${MAX_EVIDENCE_RECORDS_PER_FILE}-record limit. Reading more cannot make it fit.`);
		const evidenceLines = epoch?.lines ?? new Map<number, EvidenceLine>();
		const evaluation = evaluateProofAgainstEvidence(requested, evidenceLines, new Map());
		if ("failure" in evaluation) {
			if (historical) return fail("proof_source_unavailable", "The historical proof does not completely identify this target. Relocate and read the target in the current file; old coordinates will not be used for automatic recovery.");
			return { failure: {
				...insufficientReadProof(evaluation.failure),
				...(epoch ? { recoveryRevision: epoch.revision } : {}),
				...(file?.capacityEvicted && evaluation.failure.proofGap ? {
					code: "read_evidence_evicted" as const,
					message: `Earlier evidence was evicted at the per-file limit. ${evaluation.failure.message}`,
				} : {}),
			} };
		}
		if (!file || !epoch) return fail("invalid_proof_id", "No retained proof exists for this file.");
		if (!historical) return {
			proof: { revision: epoch.revision, anchors: evaluation.anchors },
			consumedLines: consumedEvidenceLines(evaluation.coveredLines, epoch.lines),
		};

		// [喵喵喵]: 旧范围的每一行都必须存续且仍连续；只迁移端点会悄悄消费后来插入的新行。
		for (const range of requested.sourceRanges) {
			let previous: number | undefined;
			for (let source = range.start; source <= range.end; source++) {
				const current = historical.positions.get(source);
				if (current === undefined) return fail("target_consumed", "This proof's target was consumed by a verified edit. A same-looking current token is a different target. Relocate and read the intended current target.");
				if (previous !== undefined && current !== previous + 1) return fail("target_changed", "New source lines now separate the historical range. Its endpoints cannot authorize consuming those lines. Read and confirm the current range.");
				previous = current;
			}
		}
		const currentLines = new Map<number, EvidenceLine>();
		for (const source of evaluation.coveredLines) {
			const current = historical.positions.get(source)!;
			const info = epoch.lines.get(source)!;
			currentLines.set(current, { text: info.text, anchor: computeAnchorTag(current, info.text) });
		}
		const renames = new Map(requested.endpointAnchors.map((endpoint) => [endpoint.anchor, currentLines.get(historical.positions.get(endpoint.line)!)!.anchor]));
		const resolved = replaceRenamedAnchors(changes, renames);
		return {
			proof: { revision: file.current.revision, anchors: [...currentLines.values()].map((line) => line.anchor) },
			consumedLines: consumedEvidenceLines([...currentLines.keys()], currentLines),
			normalizedChanges: resolved.changes,
			...(resolved.renamedAnchors.length ? { renamedAnchors: resolved.renamedAnchors } : {}),
		};
	}

	// [喵喵喵]: 实时与 branch replay 消费同一条已发布事件；事件内的 id 和 base id 不在重放时重建。
	private reduce(toolName: string, details: HleditDetails, cwd: string): void {
		const path = evidencePathFromDetails(details, cwd);
		if (!path) return;
		if (details.evidenceDropped) { this.invalidate(path); return; }
		if (toolName === HLEDIT_READ_ANCHORS_TOOL || toolName === HLEDIT_SEARCH_ANCHORS_TOOL) {
			const read = details.disposition === "succeeded" ? parseHleditReadMetadata(details.read) : undefined;
			if (read) this.recordRead(path, read, details.proofId);
			else this.state.touch(path);
			return;
		}
		if (toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) return;
		const priority = priorityLines(details.recoveryRequiredRanges);
		for (const read of parseRecoveredReads(details)) this.state.read(path, read.revision, read.lines, details.proofId, read.actual.totalLines, priority);
		if (details.disposition === "succeeded") {
			if (details.contentChanged === false) { this.state.touch(path); return; }
			const contexts = parseUpdatedAnchorSpans(details.updatedAnchorSpans);
			// [喵喵喵]: 旧 apply 的 proof 跨 revision 复用，无法恢复独立身份；迁移时失效而不猜测。
			if (details.evidenceVersion !== 2 || !isRawRevision(details.revision) || !contexts || typeof details.proofId !== "string") {
				this.invalidate(path); return;
			}
			this.state.commit(path, details.revision, contexts.flatMap((context) => context.lines), parseEditDeltas(details.editDeltas), details.proofId,
				typeof details.baseProofId === "string" ? details.baseProofId : undefined);
			return;
		}
		if (details.disposition === "outcome_unknown" || details.error?.code === "source_changed_before_commit") { this.invalidate(path); return; }
		const revision = details.error?.currentRevision;
		if (isRawRevision(revision) && this.state.get(path)?.current.revision !== revision) this.invalidate(path);
		if (details.error?.code === "stale") {
			if (!isRawRevision(revision)) { this.invalidate(path); return; }
			const context = parseAnchorContext(details.error.currentAnchors);
			if (context && !context.truncated && context.lines.every((line) => !line.textTruncated) && typeof details.proofId === "string") {
				this.state.read(path, revision, context.lines, details.proofId);
			}
		}
		this.state.touch(path);
	}

	restoreFromBranch(ctx: ExtensionContext): void {
		this.clear();
		let timeline: string | undefined;
		let pending: Array<{ toolName: string; details: HleditDetails; sequence: number }> = [];
		const flush = () => {
			pending.sort((left, right) => left.sequence - right.sequence);
			for (const event of pending) this.reduce(event.toolName, event.details, ctx.cwd);
			pending = [];
			timeline = undefined;
		};
		// [喵喵喵]: Pi 并行执行按请求顺序持久化结果，不一定是完成顺序；仅在同一工具批次、
		// 同一运行实例内按发布序重放，不能跨用户/助手消息或重启边界重排历史。
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "toolResult") { flush(); continue; }
			if (!isRecord(entry.message.details)) continue;
			const toolName = entry.message.toolName;
			if (toolName !== HLEDIT_READ_ANCHORS_TOOL && toolName !== HLEDIT_SEARCH_ANCHORS_TOOL && toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) continue;
			const details = entry.message.details as HleditDetails;
			const order = details.evidenceOrder;
			if (!isRecord(order) || typeof order.timeline !== "string" || typeof order.sequence !== "number"
				|| !Number.isSafeInteger(order.sequence) || order.sequence < 1) {
				flush();
				this.reduce(entry.message.toolName, details, ctx.cwd);
				continue;
			}
			if (timeline !== undefined && timeline !== order.timeline) flush();
			timeline = order.timeline;
			pending.push({ toolName: entry.message.toolName, details, sequence: order.sequence });
		}
		flush();
	}

	updateFromToolResult(toolName: string, value: unknown, cwd: string): void {
		if (!isRecord(value)) return;
		const details = value as HleditDetails;
		const path = evidencePathFromDetails(details, cwd);
		if (!path) return;
		details.evidenceVersion = 2;
		if (!Number.isSafeInteger(++this.sequence)) { this.timeline = nextProofId(); this.sequence = 1; }
		details.evidenceOrder = { timeline: this.timeline, sequence: this.sequence };
		if (toolName === HLEDIT_APPLY_FILE_CHANGES_TOOL) {
			if (details.disposition === "succeeded") {
				details.baseProofId = this.getProofId(path);
				details.proofId = details.contentChanged === false ? this.getProofId(path) : nextProofId();
			} else if (details.error?.code === "stale") {
				const context = parseAnchorContext(details.error.currentAnchors);
				if (isRawRevision(details.error.currentRevision) && context && !context.truncated && context.lines.every((line) => !line.textTruncated)) {
					details.proofId ??= nextProofId();
				} else delete details.proofId;
			}
		}
		this.reduce(toolName, details, cwd);
		if (details.proofId && this.state.owner(details.proofId) !== path) {
			this.invalidate(path);
			delete details.proofId;
			details.evidenceDropped = true;
		}
	}
}
