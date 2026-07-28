import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
	HLEDIT_REPLACE_ONCE_TOOL,
} from "./active-tools.ts";
import { computeAnchorTag } from "./anchor-hash.ts";
import { lineFromAnchor, type HleditBatchReadProof } from "./file-changes.ts";
import { parseAnchorContext, type BatchAnchorContext } from "./post-edit-context.ts";
import { parseEditDeltas, type HleditDetails, type HleditEditDelta, type HleditReadMetadata } from "./result.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

type EvidenceLine = {
	anchor: string;
	text: string;
};

type FileReadEvidence = {
	revision: string;
	lines: Map<number, EvidenceLine>;
	// 上次成功编辑造成的锚点更名（旧锚点 -> 内容未变的新锚点），仅用于失败恢复提示。
	renames: Map<string, string>;
};

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
	code: "insufficient_read_proof";
	message: string;
	reportedMissingLines: number[];
	suggestedReadRange?: ReadProofLineRange;
	proofGap?: ReadProofGap;
	renamedAnchors?: RenamedAnchor[];
	// true 表示把列出的更名全部替换进请求即可恢复完整 proof；缺席时更名之外仍有
	// 缺口，恢复正文必须同时给出定向重读指引。
	renamesRestoreProof?: true;
};

// 本次修改实际消费或依附的、同 revision 完整读取行；只用于插件内部的护栏与
// change preview，不进入公开工具 schema。
export type ConsumedEvidenceLine = {
	line: number;
	anchor: string;
	text: string;
};

export type ReadProofSelection =
	| { proof: HleditBatchReadProof; consumedLines: Map<number, ConsumedEvidenceLine> }
	| { failure: ReadProofFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRevision(value: unknown): value is string {
	return typeof value === "string" && RAW_REVISION_PATTERN.test(value);
}

function parsePersistedRead(value: unknown): HleditReadMetadata | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || !validRevision(value.revision) || !Array.isArray(value.lines) || !isRecord(value.requested)) {
		return undefined;
	}
	if (value.requested.grep !== undefined && typeof value.requested.grep !== "string") {
		return undefined;
	}
	const lines = value.lines.flatMap((line) => {
		if (!isRecord(line) || !positiveInteger(line.line) || typeof line.anchor !== "string" || typeof line.text !== "string") {
			return [];
		}
		return [{
			line: line.line,
			anchor: line.anchor,
			text: line.text,
			textTruncated: line.textTruncated === true,
		}];
	});
	if (lines.length !== value.lines.length) {
		return undefined;
	}
	return { ...value, lines } as HleditReadMetadata;
}

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

function lineRangeDescription(range: ReadProofLineRange): string {
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
	const availableLines = [...evidenceLines.keys()].sort((left, right) => left - right);
	const coveredLines: number[] = [];
	let availableIndex = 0;

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
		while (availableLines[availableIndex] !== undefined && availableLines[availableIndex]! < range.start) availableIndex += 1;
		let expectedLine = range.start;
		while (availableLines[availableIndex] !== undefined && availableLines[availableIndex]! <= range.end) {
			const availableLine = availableLines[availableIndex]!;
			if (availableLine > expectedLine) return missingCoverage(expectedLine, availableLine - 1);
			coveredLines.push(availableLine);
			expectedLine = availableLine + 1;
			availableIndex += 1;
		}
		if (expectedLine <= range.end) return missingCoverage(expectedLine, range.end);
	}
	return { coveredLines, reportedMissingLines: [], firstMissingRange: undefined };
}

// [喵喵喵]: 一次补读覆盖同一 change 从首个缺口到最后一个缺口的完整跨度；
// 已知的连续尾部不重复读取，避免离散 evidence 触发多轮 apply → 补读。(2026-07-28)
function unresolvedReadSpanForChange(gap: ReadProofGap, evidenceLines: Map<number, EvidenceLine>): ReadProofLineRange {
	let lastMissingLine = gap.requiredEnd;
	while (lastMissingLine > gap.end && evidenceLines.has(lastMissingLine)) lastMissingLine -= 1;
	return { start: gap.start, end: Math.max(gap.end, lastMissingLine) };
}

export async function resolveReadEvidencePath(cwd: string, path: string): Promise<string> {
	const absolutePath = resolve(cwd, path);
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

// 原始行 L 落在任一消费区间内则该行已被编辑（返回 undefined）；否则叠加所有
// 位于其前方的编辑行数差得到新行号。空区间（oldEnd === oldStart-1）表示纯插入，
// 统一规则 "L > oldEnd 时累加 delta" 对两类编辑同时成立。
function remapLineNumber(line: number, deltas: HleditEditDelta[]): number | undefined {
	let shift = 0;
	for (const delta of deltas) {
		if (line >= delta.oldStart && line <= delta.oldEnd) return undefined;
		if (line > delta.oldEnd) shift += delta.delta;
	}
	const remapped = line + shift;
	return remapped >= 1 ? remapped : undefined;
}

function renamedEndpointAnchors(renames: Map<string, string>, endpointAnchors: RequestedEndpointAnchor[]): RenamedAnchor[] {
	const renamed: RenamedAnchor[] = [];
	for (const requestedAnchor of new Set(endpointAnchors.map((endpoint) => endpoint.anchor))) {
		const current = renames.get(requestedAnchor);
		if (current) renamed.push({ requested: requestedAnchor, current });
	}
	return renamed;
}

function substituteRenamedAnchors(changes: FileChangeParams["changes"], renames: Map<string, string>): FileChangeParams["changes"] {
	return changes.map((change) => {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			return { ...change, anchor: renames.get(change.anchor) ?? change.anchor };
		}
		return {
			...change,
			start_anchor: renames.get(change.start_anchor) ?? change.start_anchor,
			end_anchor: renames.get(change.end_anchor) ?? change.end_anchor,
		};
	});
}

type EvidenceProofEvaluation =
	| { anchors: string[]; coveredLines: number[] }
	| { failure: { message: string; reportedMissingLines: number[]; suggestedReadRange?: ReadProofLineRange; proofGap?: ReadProofGap } };

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
				},
			};
		}
	}
	return { anchors: coverage.coveredLines.map((line) => evidenceLines.get(line)!.anchor), coveredLines: coverage.coveredLines };
}

export function formatReadProofFailure(path: string, failure: ReadProofFailure): string {
	const lines = [
		"Valid read proof does not cover every source line required by this change. Batch was not started and no content was written.",
		`Reason: ${failure.message}`,
	];
	const renames = failure.renamedAnchors ?? [];
	if (renames.length > 0) {
		lines.push(
			"Verified anchor renames from this file's last edit (content unchanged, line numbers shifted):",
			...renames.map((rename) => `- ${rename.requested} -> ${rename.current}`),
		);
		// 更名足以恢复 proof 时不给重读指引：并列的读取建议会诱导模型放弃廉价重提交。
		if (failure.renamesRestoreProof) {
			lines.push("Resubmit after replacing every renamed anchor with its current form, or reread the range if the intended target is unclear.");
			return lines.join("\n");
		}
		lines.push("Replacing the renamed anchors is required but not sufficient; the remaining lines below also need the targeted read before resubmitting.");
	}
	const targetLines = failure.reportedMissingLines;
	const firstLine = failure.suggestedReadRange?.start ?? targetLines[0] ?? 1;
	const lastLine = failure.suggestedReadRange?.end ?? targetLines[targetLines.length - 1] ?? firstLine;
	const offset = Math.max(1, firstLine - 2);
	const preferredLimit = Math.max(12, lastLine - offset + 3);
	const limit = Math.min(MAX_READ_LIMIT, preferredLimit);
	const lastSuggestedLine = offset + limit - 1;
	const completionTarget = failure.proofGap
		? `all required source lines for change ${failure.proofGap.changeNumber} through line ${lastLine}`
		: firstLine === lastLine ? "the target line" : "the complete target range";
	const readInstruction = lastSuggestedLine < lastLine
		? `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first, then continue with nextOffset until line ${lastLine} is covered.`
		: `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first and confirm ${completionTarget}.`;
	const resubmitInstruction = renames.length > 0
		? "After the read succeeds, resubmit the original hledit_apply_file_changes call with every listed anchor rename applied."
		: "After the read succeeds, resubmit the original hledit_apply_file_changes call.";
	lines.push(readInstruction, resubmitInstruction);
	return lines.join("\n");
}

export class ReadEvidenceStore {
	private readonly files = new Map<string, FileReadEvidence>();

	clear(): void {
		this.files.clear();
	}

	invalidate(path: string): void {
		this.files.delete(path);
	}

	recordRead(path: string, read: HleditReadMetadata): void {
		const evidence = this.files.get(path);
		if (evidence && evidence.revision !== read.revision) this.files.delete(path);
		// 过滤读取可以贡献离散行；范围是否完整由 selectProof 统一判断。
		const next = evidence?.revision === read.revision
			? evidence
			: { revision: read.revision, lines: new Map<number, EvidenceLine>(), renames: new Map<string, string>() };
		for (const line of read.lines) {
			if (!line.textTruncated) next.lines.set(line.line, { anchor: line.anchor, text: line.text });
		}
		if (next.lines.size > 0) this.files.set(path, next);
		else this.files.delete(path);
	}

	recordUpdatedAnchors(path: string, revision: string, context: BatchAnchorContext): void {
		if (!validRevision(revision) || context.lines.length === 0) {
			this.files.delete(path);
			return;
		}
		const existing = this.files.get(path);
		// revision 未变时（no-op 提交、重映射后的同版合并、连续 stale 的同快照窗口）
		// 旧证据字节级精确有效，合并窗口而不是把整份证据收缩成 ≤20 行窗口。
		const sameRevision = existing?.revision === revision;
		const lines = sameRevision ? existing.lines : new Map<number, EvidenceLine>();
		const renames = sameRevision ? existing.renames : new Map<string, string>();
		for (const line of context.lines) {
			if (!line.textTruncated) lines.set(line.line, { anchor: line.anchor, text: line.text });
		}
		if (lines.size > 0) this.files.set(path, { revision, lines, renames });
		else this.files.delete(path);
	}

	// 成功编辑后把变更区间之外的证据行平移到新行号：内容未变，行号由 editDeltas
	// 唯一确定；锚点用本地 hash 复刻重算，且必须先重现旧锚点（自校验）才可信。
	// 同时维护旧锚点 -> 新锚点的更名表，供 selectProof 的失败恢复提示使用。
	private remapEvidenceForApply(path: string, newRevision: string, deltas: HleditEditDelta[] | undefined): void {
		const evidence = this.files.get(path);
		if (!evidence || evidence.revision === newRevision) return;
		if (!deltas) {
			this.files.delete(path);
			return;
		}
		const lines = new Map<number, EvidenceLine>();
		const renames = new Map<string, string>();
		for (const [line, info] of evidence.lines) {
			const newLine = remapLineNumber(line, deltas);
			if (newLine === undefined) continue;
			if (newLine === line) {
				lines.set(newLine, info);
				continue;
			}
			if (computeAnchorTag(line, info.text) !== info.anchor) continue;
			const anchor = computeAnchorTag(newLine, info.text);
			lines.set(newLine, { anchor, text: info.text });
			if (anchor !== info.anchor) renames.set(info.anchor, anchor);
		}
		// 别名链：更早的名字指向最新名字；目标行消失则丢弃对应别名。
		const survivingAnchors = new Set([...lines.values()].map((line) => line.anchor));
		for (const [older, previous] of evidence.renames) {
			const latest = renames.get(previous) ?? (survivingAnchors.has(previous) ? previous : undefined);
			if (latest && latest !== older) renames.set(older, latest);
		}
		if (lines.size === 0) {
			this.files.delete(path);
			return;
		}
		this.files.set(path, { revision: newRevision, lines, renames });
	}

	private recordApplyResult(path: string, details: HleditDetails): void {
		if (details.disposition === "succeeded" && validRevision(details.revision)) {
			const updatedAnchors = parseAnchorContext(details.updatedAnchors);
			if (!updatedAnchors) {
				this.invalidate(path);
				return;
			}
			this.remapEvidenceForApply(path, details.revision, parseEditDeltas(details.editDeltas));
			this.recordUpdatedAnchors(path, details.revision, updatedAnchors);
			return;
		}

		// unavailable = CLI 未启动、前置读取失败或 ok:false 的不兼容拒绝，目标从未被本次调用写入；
		// 即使证据碰巧过期，提交时的 revision 校验也会兜底，保留证据可省一轮重读。
		if (details.disposition === "unavailable") {
			return;
		}
		const code = details.error?.code;
		if (details.disposition === "rejected" && code !== "stale" && code !== "source_changed_before_commit") {
			return;
		}
		this.invalidate(path);
		if (code !== "stale" || !validRevision(details.error?.currentRevision)) return;
		const currentAnchors = parseAnchorContext(details.error.currentAnchors);
		if (!currentAnchors || currentAnchors.truncated || currentAnchors.lines.some((line) => line.textTruncated)) return;
		this.recordUpdatedAnchors(path, details.error.currentRevision, currentAnchors);
	}

	selectProof(path: string, changes: FileChangeParams["changes"]): ReadProofSelection {
		const requested = requestedChangeEvidence(changes);
		if (!requested || requested.ranges.length === 0) {
			return {
				failure: {
					code: "insufficient_read_proof",
					message: "The source lines required by this change could not be determined.",
					reportedMissingLines: [],
				},
			};
		}

		const evidence = this.files.get(path);
		if (!evidence) {
			const emptyEvidence = new Map<number, EvidenceLine>();
			const coverage = collectProofCoverage(requested.ranges, emptyEvidence);
			const proofGap = proofGapFromMissingRange(coverage.firstMissingRange, requested.sourceRanges);
			const suggestedReadRange = proofGap
				? unresolvedReadSpanForChange(proofGap, emptyEvidence)
				: coverage.firstMissingRange;
			return {
				failure: {
					code: "insufficient_read_proof",
					message: proofGap
						? formatProofGapMessage(proofGap)
						: "No current anchors have been read for the source lines required by this change.",
					reportedMissingLines: coverage.reportedMissingLines,
					...(suggestedReadRange ? { suggestedReadRange } : {}),
					...(proofGap ? { proofGap } : {}),
				},
			};
		}

		const direct = evaluateProofAgainstEvidence(requested, evidence.lines, evidence.renames);
		if ("anchors" in direct) {
			const consumedLines = new Map<number, ConsumedEvidenceLine>();
			for (const line of direct.coveredLines) {
				const info = evidence.lines.get(line)!;
				consumedLines.set(line, { line, anchor: info.anchor, text: info.text });
			}
			return { proof: { revision: evidence.revision, anchors: direct.anchors }, consumedLines };
		}

		const renamedAnchors = renamedEndpointAnchors(evidence.renames, requested.endpointAnchors);
		const failure: ReadProofFailure = {
			code: "insufficient_read_proof",
			message: direct.failure.message,
			reportedMissingLines: direct.failure.reportedMissingLines,
			...(direct.failure.suggestedReadRange ? { suggestedReadRange: direct.failure.suggestedReadRange } : {}),
			...(direct.failure.proofGap ? { proofGap: direct.failure.proofGap } : {}),
		};
		if (renamedAnchors.length === 0) {
			return { failure };
		}

		// what-if：把已验证更名替换进请求后重评。全部恢复 → 纯更名指引（一次重提交
		// 即可）；仍有缺口 → 复合指引，且定向重读指向替换后的剩余缺口，而不是已被
		// 更名解释的旧区间。
		const substituted = requestedChangeEvidence(substituteRenamedAnchors(changes, evidence.renames));
		const substitutedEvaluation = substituted && substituted.ranges.length > 0
			? evaluateProofAgainstEvidence(substituted, evidence.lines, evidence.renames)
			: undefined;
		if (substitutedEvaluation && "anchors" in substitutedEvaluation) {
			return { failure: { ...failure, renamedAnchors, renamesRestoreProof: true } };
		}
		if (substitutedEvaluation) {
			return {
				failure: {
					code: "insufficient_read_proof",
					message: substitutedEvaluation.failure.message,
					reportedMissingLines: substitutedEvaluation.failure.reportedMissingLines,
					...(substitutedEvaluation.failure.suggestedReadRange
						? { suggestedReadRange: substitutedEvaluation.failure.suggestedReadRange }
						: {}),
					...(substitutedEvaluation.failure.proofGap ? { proofGap: substitutedEvaluation.failure.proofGap } : {}),
					renamedAnchors,
				},
			};
		}
		return { failure: { ...failure, renamedAnchors } };
	}

	restoreFromBranch(ctx: ExtensionContext): void {
		this.files.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = isRecord(entry.message.details) ? entry.message.details : undefined;
			if (!details) continue;
			const path = evidencePathFromDetails(details, ctx.cwd);
			if (!path) continue;

			if (entry.message.toolName === HLEDIT_READ_ANCHORS_TOOL) {
				// [喵喵喵]: 读取失败没有写入副作用；保留旧 evidence，由最终 revision proof
				// 安全兜底，避免一次越界或临时 I/O 失败迫使目标整段重读。(2026-07-28)
				if (details.disposition !== "succeeded") continue;
				const read = parsePersistedRead(details.read);
				if (read) this.recordRead(path, read);
				continue;
			}

			if (entry.message.toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL && entry.message.toolName !== HLEDIT_REPLACE_ONCE_TOOL) continue;
			this.recordApplyResult(path, details as HleditDetails);
		}
	}

	updateFromToolResult(toolName: string, detailsValue: unknown, cwd: string): void {
		if (!isRecord(detailsValue)) return;
		const details = detailsValue as HleditDetails;
		const path = evidencePathFromDetails(details, cwd);
		if (!path) return;

		if (toolName === HLEDIT_READ_ANCHORS_TOOL) {
			// 与 branch replay 使用同一无写入副作用规则。
			if (details.disposition === "succeeded" && details.read) this.recordRead(path, details.read);
			return;
		}
		if (toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL && toolName !== HLEDIT_REPLACE_ONCE_TOOL) return;

		this.recordApplyResult(path, details);
	}
}
