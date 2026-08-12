import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
} from "./active-tools.ts";
import { computeAnchorTag } from "./anchor-hash.ts";
import { lineFromAnchor, type HleditBatchReadProof } from "./file-changes.ts";
import { parseAnchorContext, type BatchAnchorContext } from "./post-edit-context.ts";
import {
	parseEditDeltas,
	parseHleditReadMetadata,
	parseRecoveredRead,
	type HleditDetails,
	type HleditEditDelta,
	type HleditReadMetadata,
} from "./result.ts";
import { suggestedReadWindow } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const MAX_EVIDENCE_RECORDS_PER_FILE = 10_000;
export const MAX_EVIDENCE_BYTES_PER_FILE = 4 * 1024 * 1024;
export const MAX_EVIDENCE_RECORDS_PER_SESSION = 50_000;
export const MAX_EVIDENCE_BYTES_PER_SESSION = 16 * 1024 * 1024;

type EvidenceLine = {
	anchor: string;
	text: string;
};

type FileReadEvidence = {
	revision: string;
	lines: Map<number, EvidenceLine>;
	// 成功编辑造成的锚点更名（旧锚点 -> 内容未变的新锚点），仅用于失败恢复提示。
	renames: Map<string, string>;
	// 旧 rename token 被当前行重新占用后身份不可判定；只有明确的新 read 可以解除。
	ambiguousTokens: Set<string>;
};

type EvidenceUsage = {
	records: number;
	bytes: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRevision(value: unknown): value is string {
	return typeof value === "string" && RAW_REVISION_PATTERN.test(value);
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

// 诊断段：失败原因与已验证的锚点更名。补读成功与未补读两条路径共用同一段诊断，
// 各自追加自己的后续指令；调用方不得再从完整正文里切割这一段。
export function formatReadProofDiagnosis(failure: ReadProofFailure): string {
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
	}
	return lines.join("\n");
}

export function formatReadProofFailure(path: string, failure: ReadProofFailure): string {
	const lines = [formatReadProofDiagnosis(failure)];
	const renames = failure.renamedAnchors ?? [];
	if (renames.length > 0) {
		lines.push("Replacing the renamed anchors is required but not sufficient; the remaining lines below also need the targeted read before resubmitting.");
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
	const resubmitInstruction = renames.length > 0
		? "After the read succeeds, resubmit the original hledit_apply_file_changes call with every listed anchor rename applied."
		: "After the read succeeds, resubmit the original hledit_apply_file_changes call.";
	lines.push(readInstruction, resubmitInstruction);
	return lines.join("\n");
}

export class ReadEvidenceStore {
	// Map 顺序即 session entry 可重放的 file-level LRU；每次 read/apply result 都 touch。
	private readonly files = new Map<string, FileReadEvidence>();

	clear(): void {
		this.files.clear();
	}

	invalidate(path: string): void {
		this.files.delete(path);
	}

	private evidenceUsage(path: string, evidence: FileReadEvidence): EvidenceUsage {
		let bytes = Buffer.byteLength(path, "utf8");
		for (const line of evidence.lines.values()) {
			bytes += Buffer.byteLength(line.anchor, "utf8") + Buffer.byteLength(line.text, "utf8");
		}
		for (const [older, current] of evidence.renames) {
			bytes += Buffer.byteLength(older, "utf8") + Buffer.byteLength(current, "utf8");
		}
		for (const token of evidence.ambiguousTokens) bytes += Buffer.byteLength(token, "utf8");
		return {
			records: evidence.lines.size + evidence.renames.size + evidence.ambiguousTokens.size,
			bytes,
		};
	}

	private fitsFileLimit(path: string, evidence: FileReadEvidence): boolean {
		const usage = this.evidenceUsage(path, evidence);
		return usage.records <= MAX_EVIDENCE_RECORDS_PER_FILE && usage.bytes <= MAX_EVIDENCE_BYTES_PER_FILE;
	}

	private enforceSessionLimit(): void {
		let records = 0;
		let bytes = 0;
		for (const [path, evidence] of this.files) {
			const usage = this.evidenceUsage(path, evidence);
			records += usage.records;
			bytes += usage.bytes;
		}
		while (records > MAX_EVIDENCE_RECORDS_PER_SESSION || bytes > MAX_EVIDENCE_BYTES_PER_SESSION) {
			const oldest = this.files.entries().next().value as [string, FileReadEvidence] | undefined;
			if (!oldest) return;
			const [path, evidence] = oldest;
			const usage = this.evidenceUsage(path, evidence);
			this.files.delete(path);
			records -= usage.records;
			bytes -= usage.bytes;
		}
	}

	private storeEvidence(path: string, evidence: FileReadEvidence): boolean {
		if (evidence.lines.size === 0) {
			this.files.delete(path);
			return true;
		}
		if (!this.fitsFileLimit(path, evidence)) {
			this.files.delete(path);
			return false;
		}
		this.files.delete(path);
		this.files.set(path, evidence);
		this.enforceSessionLimit();
		return this.files.has(path);
	}

	private touch(path: string): void {
		const evidence = this.files.get(path);
		if (!evidence) return;
		this.files.delete(path);
		this.files.set(path, evidence);
	}

	private addTokenReuseAmbiguities(
		lines: Map<number, EvidenceLine>,
		renames: Map<string, string>,
		preserved: Set<string>,
	): Set<string> {
		const ambiguousTokens = new Set(preserved);
		const currentTokens = new Set([...lines.values()].map((line) => line.anchor));
		for (const older of renames.keys()) {
			if (currentTokens.has(older)) ambiguousTokens.add(older);
		}
		return ambiguousTokens;
	}

	recordRead(path: string, read: HleditReadMetadata): void {
		const existing = this.files.get(path);
		const sameRevision = existing?.revision === read.revision;
		const lines = sameRevision ? new Map(existing.lines) : new Map<number, EvidenceLine>();
		const renames = sameRevision ? new Map(existing.renames) : new Map<string, string>();
		const ambiguousTokens = sameRevision ? new Set(existing.ambiguousTokens) : new Set<string>();
		const freshLines = new Map<number, EvidenceLine>();

		// 明确 read 覆盖当前 token 时，以当前语义为准：删除同 token 的旧 alias 和歧义。
		for (const line of read.lines) {
			if (line.textTruncated) continue;
			const info = { anchor: line.anchor, text: line.text };
			lines.set(line.line, info);
			freshLines.set(line.line, info);
			renames.delete(line.anchor);
			ambiguousTokens.delete(line.anchor);
		}
		const next: FileReadEvidence = {
			revision: read.revision,
			lines,
			renames,
			ambiguousTokens: this.addTokenReuseAmbiguities(lines, renames, ambiguousTokens),
		};
		if (this.storeEvidence(path, next)) return;

		// 合并后超限时不保留历史 alias/ambiguity 链，只尝试缓存触发更新的 fresh window。
		this.storeEvidence(path, {
			revision: read.revision,
			lines: freshLines,
			renames: new Map(),
			ambiguousTokens: new Set(),
		});
	}

	recordUpdatedAnchors(
		path: string,
		revision: string,
		context: BatchAnchorContext,
		tokensNeedingDisambiguation?: ReadonlySet<string>,
	): void {
		if (!validRevision(revision) || context.lines.length === 0) {
			this.files.delete(path);
			return;
		}
		const existing = this.files.get(path);
		const sameRevision = existing?.revision === revision;
		const lines = sameRevision ? new Map(existing.lines) : new Map<number, EvidenceLine>();
		const renames = sameRevision ? new Map(existing.renames) : new Map<string, string>();
		const ambiguousTokens = sameRevision ? new Set(existing.ambiguousTokens) : new Set<string>();
		for (const line of context.lines) {
			if (line.textTruncated) continue;
			const info = { anchor: line.anchor, text: line.text };
			lines.set(line.line, info);
		}
		const nextAmbiguousTokens = this.addTokenReuseAmbiguities(lines, renames, ambiguousTokens);
		if (tokensNeedingDisambiguation) {
			// 目标行可能在更晚的编辑中才重新产生旧 token；不能只检查本次 anchor window。
			for (const token of tokensNeedingDisambiguation) nextAmbiguousTokens.add(token);
		}
		const next: FileReadEvidence = {
			revision,
			lines,
			renames,
			// updatedAnchors 不能消歧；模型仍可能持有编辑前或已消费行的同 token。
			ambiguousTokens: nextAmbiguousTokens,
		};
		// updatedAnchors 不是显式重读；容量超限时 storeEvidence 已清空该文件，
		// 不能丢弃 ambiguity 后把局部窗口重新解释成 fresh evidence。
		this.storeEvidence(path, next);
	}

	// 成功编辑后把变更区间之外的证据行平移到新行号：内容未变，行号由 editDeltas
	// 唯一确定；锚点用本地 hash 复刻重算，且必须先重现旧锚点（自校验）才可信。
	private remapEvidenceForApply(
		path: string,
		newRevision: string,
		deltas: HleditEditDelta[] | undefined,
	): { tokensNeedingDisambiguation: Set<string>; capacityExceeded: boolean } {
		const evidence = this.files.get(path);
		if (!evidence) return { tokensNeedingDisambiguation: new Set(), capacityExceeded: false };
		if (evidence.revision === newRevision) {
			this.touch(path);
			return { tokensNeedingDisambiguation: new Set(), capacityExceeded: false };
		}
		const tokensNeedingDisambiguation = new Set(evidence.ambiguousTokens);
		if (!deltas) {
			for (const line of evidence.lines.values()) tokensNeedingDisambiguation.add(line.anchor);
			for (const older of evidence.renames.keys()) tokensNeedingDisambiguation.add(older);
			this.files.delete(path);
			return { tokensNeedingDisambiguation, capacityExceeded: false };
		}
		const lines = new Map<number, EvidenceLine>();
		const renames = new Map<string, string>();
		for (const [line, info] of evidence.lines) {
			const newLine = remapLineNumber(line, deltas);
			if (newLine === undefined) {
				tokensNeedingDisambiguation.add(info.anchor);
				continue;
			}
			if (newLine === line) {
				lines.set(newLine, info);
				continue;
			}
			if (computeAnchorTag(line, info.text) !== info.anchor) continue;
			const anchor = computeAnchorTag(newLine, info.text);
			lines.set(newLine, { anchor, text: info.text });
			if (anchor !== info.anchor) renames.set(info.anchor, anchor);
		}
		// [喵喵喵]: 别名最终目标被消费后保留旧身份歧义，防止后续编辑延迟复用旧 token。(2026-07-30)
		const survivingAnchors = new Set([...lines.values()].map((line) => line.anchor));
		for (const [older, previous] of evidence.renames) {
			const latest = renames.get(previous) ?? (survivingAnchors.has(previous) ? previous : undefined);
			if (latest && latest !== older) renames.set(older, latest);
			else if (!latest) tokensNeedingDisambiguation.add(older);
		}
		const remappedAmbiguousTokens = this.addTokenReuseAmbiguities(lines, renames, evidence.ambiguousTokens);
		// 被消费或失联的 token 失去原身份；持续保留到显式 read，捕获延迟重新占用。
		for (const token of tokensNeedingDisambiguation) remappedAmbiguousTokens.add(token);
		const retained = this.storeEvidence(path, {
			revision: newRevision,
			lines,
			renames,
			ambiguousTokens: remappedAmbiguousTokens,
		});
		return { tokensNeedingDisambiguation, capacityExceeded: !retained };
	}

	private recordApplyResult(path: string, details: HleditDetails): void {
		if (details.disposition === "succeeded" && validRevision(details.revision)) {
			const updatedAnchors = parseAnchorContext(details.updatedAnchors);
			if (!updatedAnchors) {
				this.invalidate(path);
				return;
			}
			const remap = this.remapEvidenceForApply(path, details.revision, parseEditDeltas(details.editDeltas));
			// remap 容量超限时必须保持无 evidence；updatedAnchors 不能越过淘汰重建身份。
			if (remap.capacityExceeded) return;
			this.recordUpdatedAnchors(path, details.revision, updatedAnchors, remap.tokensNeedingDisambiguation);
			return;
		}

		const code = details.error?.code;
		if (details.disposition === "outcome_unknown" || code === "source_changed_before_commit") {
			this.invalidate(path);
			return;
		}

		const currentRevision = validRevision(details.error?.currentRevision)
			? details.error.currentRevision
			: undefined;
		const existing = this.files.get(path);
		if (currentRevision && existing && existing.revision !== currentRevision) this.invalidate(path);

		if (details.disposition === "unavailable") {
			this.touch(path);
			return;
		}
		if (details.disposition !== "rejected") {
			this.invalidate(path);
			return;
		}
		if (code !== "stale") {
			this.touch(path);
			return;
		}
		if (!currentRevision) {
			this.invalidate(path);
			return;
		}
		const currentAnchors = parseAnchorContext(details.error?.currentAnchors);
		if (!currentAnchors || currentAnchors.truncated || currentAnchors.lines.some((line) => line.textTruncated)) {
			this.touch(path);
			return;
		}
		this.recordUpdatedAnchors(path, currentRevision, currentAnchors);
	}

	selectProof(path: string, changes: FileChangeParams["changes"]): ReadProofSelection {
		const requested = requestedChangeEvidence(changes);
		if (!requested || requested.ranges.length === 0) {
			return {
				failure: {
					code: "insufficient_read_proof",
					// findChangeShapeIssue 已在 apply 入口拦下锚点顺序问题，这里只可能是行号
					// 溢出等不可用锚点；仍点名两项待查，避免退化成无从下手的泛化诊断。
					message: "The source lines required by this change could not be determined; verify that each anchor is a current LN#HASH token and that start_anchor is not below end_anchor.",
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

		const ambiguousEndpoint = requested.endpointAnchors.find((endpoint) => evidence.ambiguousTokens.has(endpoint.anchor));
		if (ambiguousEndpoint) {
			return {
				failure: {
					code: "insufficient_read_proof",
					message: `Change ${ambiguousEndpoint.changeNumber} (${ambiguousEndpoint.operation}) submitted anchor token ${ambiguousEndpoint.anchor}, but that token lost its unique identity after a verified edit. It may refer to a consumed or moved pre-edit target, or to a different current line. Explicitly reread the target before resubmitting; the plugin will not guess.`,
					reportedMissingLines: [ambiguousEndpoint.line],
					suggestedReadRange: { start: ambiguousEndpoint.line, end: ambiguousEndpoint.line },
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
		if (renamedAnchors.length === 0) return { failure };

		const renamed = replaceRenamedAnchors(changes, evidence.renames);
		const substituted = requestedChangeEvidence(renamed.changes);
		const substitutedEvaluation = substituted && substituted.ranges.length > 0
			? evaluateProofAgainstEvidence(substituted, evidence.lines, evidence.renames)
			: undefined;
		if (substitutedEvaluation && "anchors" in substitutedEvaluation) {
			const consumedLines = new Map<number, ConsumedEvidenceLine>();
			for (const line of substitutedEvaluation.coveredLines) {
				const info = evidence.lines.get(line)!;
				consumedLines.set(line, { line, anchor: info.anchor, text: info.text });
			}
			return {
				proof: { revision: evidence.revision, anchors: substitutedEvaluation.anchors },
				consumedLines,
				normalizedChanges: renamed.changes,
				renamedAnchors: renamed.renamedAnchors,
			};
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
				if (details.disposition === "succeeded") {
					const read = parseHleditReadMetadata(details.read);
					if (read) this.recordRead(path, read);
					else this.touch(path);
				} else {
					this.touch(path);
				}
				continue;
			}

			if (entry.message.toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) continue;
			const applyDetails = details as HleditDetails;
			const recoveredRead = parseRecoveredRead(applyDetails);
			if (recoveredRead) this.recordRead(path, recoveredRead);
			this.recordApplyResult(path, applyDetails);
		}
	}

	updateFromToolResult(toolName: string, detailsValue: unknown, cwd: string): void {
		if (!isRecord(detailsValue)) return;
		const details = detailsValue as HleditDetails;
		const path = evidencePathFromDetails(details, cwd);
		if (!path) return;

		if (toolName === HLEDIT_READ_ANCHORS_TOOL) {
			if (details.disposition === "succeeded" && details.read) this.recordRead(path, details.read);
			else this.touch(path);
			return;
		}
		if (toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) return;
		const recoveredRead = parseRecoveredRead(details);
		if (recoveredRead) this.recordRead(path, recoveredRead);
		this.recordApplyResult(path, details);
	}
}
