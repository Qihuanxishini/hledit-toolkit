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

export type RenamedAnchor = {
	requested: string;
	current: string;
};

export type ReadProofFailure = {
	code: "insufficient_read_proof";
	message: string;
	requiredLines: number[];
	missingLines: number[];
	suggestedReadRange?: ReadProofLineRange;
	renamedAnchors?: RenamedAnchor[];
	// true 表示把列出的更名全部替换进请求即可恢复完整 proof；缺席时更名之外仍有
	// 缺口，恢复正文必须同时给出定向重读指引。
	renamesRestoreProof?: true;
};

export type ReadProofSelection =
	| { proof: HleditBatchReadProof }
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
	endpointAnchors: Map<number, string>;
};

const MAX_REPORTED_MISSING_LINES = 20;

function requestedChangeEvidence(changes: FileChangeParams["changes"]): RequestedChangeEvidence | undefined {
	const ranges: ReadProofLineRange[] = [];
	const endpointAnchors = new Map<number, string>();
	for (const change of changes) {
		if (change.operation === "insert_before" || change.operation === "insert_after") {
			const line = lineFromAnchor(change.anchor);
			if (line === undefined) return undefined;
			ranges.push({ start: line, end: line });
			endpointAnchors.set(line, change.anchor);
			continue;
		}

		const start = lineFromAnchor(change.start_anchor);
		const end = lineFromAnchor(change.end_anchor);
		if (start === undefined || end === undefined || start > end) return undefined;
		ranges.push({ start, end });
		endpointAnchors.set(start, change.start_anchor);
		endpointAnchors.set(end, change.end_anchor);
	}

	ranges.sort((left, right) => left.start - right.start || left.end - right.end);
	const mergedRanges: ReadProofLineRange[] = [];
	for (const range of ranges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			mergedRanges.push({ ...range });
		}
	}
	return { ranges: mergedRanges, endpointAnchors };
}

function summarizedRequiredLines(ranges: ReadProofLineRange[]): number[] {
	return ranges.flatMap((range) => range.start === range.end ? [range.start] : [range.start, range.end]);
}

function collectProofCoverage(
	ranges: ReadProofLineRange[],
	evidenceLines: Map<number, EvidenceLine>,
): { coveredLines: number[]; missingLines: number[]; firstMissingRange: ReadProofLineRange | undefined } {
	const availableLines = [...evidenceLines.keys()].sort((left, right) => left - right);
	const coveredLines: number[] = [];
	const missingLines: number[] = [];
	let firstMissingRange: ReadProofLineRange | undefined;
	let availableIndex = 0;

	const appendMissingRange = (start: number, end: number): boolean => {
		firstMissingRange ??= { start, end };
		const reportCount = Math.min(end - start + 1, MAX_REPORTED_MISSING_LINES - missingLines.length);
		for (let offset = 0; offset < reportCount; offset += 1) missingLines.push(start + offset);
		return missingLines.length >= MAX_REPORTED_MISSING_LINES;
	};

	for (const range of ranges) {
		while (availableLines[availableIndex] !== undefined && availableLines[availableIndex]! < range.start) availableIndex += 1;
		let expectedLine = range.start;
		while (availableLines[availableIndex] !== undefined && availableLines[availableIndex]! <= range.end) {
			const availableLine = availableLines[availableIndex]!;
			if (availableLine > expectedLine && appendMissingRange(expectedLine, availableLine - 1)) {
				return { coveredLines, missingLines, firstMissingRange };
			}
			coveredLines.push(availableLine);
			expectedLine = availableLine + 1;
			availableIndex += 1;
		}
		if (expectedLine <= range.end && appendMissingRange(expectedLine, range.end)) {
			return { coveredLines, missingLines, firstMissingRange };
		}
	}
	return { coveredLines, missingLines, firstMissingRange };
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

function renamedEndpointAnchors(renames: Map<string, string>, endpointAnchors: Map<number, string>): RenamedAnchor[] {
	const renamed: RenamedAnchor[] = [];
	for (const requestedAnchor of new Set(endpointAnchors.values())) {
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
	| { anchors: string[] }
	| { failure: { message: string; missingLines: number[]; suggestedReadRange?: ReadProofLineRange } };

// 对同一份证据评估一次请求的逐行 coverage 与端点锚点匹配；selectProof 用它分别
// 评估原始请求与"更名替换后"的 what-if 请求。
function evaluateProofAgainstEvidence(
	requested: RequestedChangeEvidence,
	evidenceLines: Map<number, EvidenceLine>,
	renames: Map<string, string>,
): EvidenceProofEvaluation {
	const coverage = collectProofCoverage(requested.ranges, evidenceLines);
	if (coverage.missingLines.length > 0) {
		return {
			failure: {
				message: `Read proof is missing lines ${coverage.missingLines.join(", ")}${coverage.missingLines.length === MAX_REPORTED_MISSING_LINES ? " (only the first 20 are listed)" : ""}.`,
				missingLines: coverage.missingLines,
				...(coverage.firstMissingRange ? { suggestedReadRange: coverage.firstMissingRange } : {}),
			},
		};
	}
	for (const [line, requestedAnchor] of requested.endpointAnchors) {
		if (evidenceLines.get(line)?.anchor !== requestedAnchor) {
			return {
				failure: {
					message: renames.has(requestedAnchor)
						? `The submitted anchor ${requestedAnchor} predates this file's last edit; the same unchanged content now has a shifted line number.`
						: `The submitted anchor for line ${line} does not match the most recently read anchor on this branch.`,
					missingLines: [line],
					suggestedReadRange: { start: line, end: line },
				},
			};
		}
	}
	return { anchors: coverage.coveredLines.map((line) => evidenceLines.get(line)!.anchor) };
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
	const targetLines = failure.missingLines.length > 0 ? failure.missingLines : failure.requiredLines;
	const firstLine = failure.suggestedReadRange?.start ?? targetLines[0] ?? 1;
	const lastLine = failure.suggestedReadRange?.end ?? targetLines[targetLines.length - 1] ?? firstLine;
	const offset = Math.max(1, firstLine - 2);
	const preferredLimit = Math.max(12, lastLine - offset + 3);
	const limit = Math.min(MAX_READ_LIMIT, preferredLimit);
	const lastSuggestedLine = offset + limit - 1;
	const readInstruction = lastSuggestedLine < lastLine
		? `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first, then continue with nextOffset until line ${lastLine} is covered before submitting the change.`
		: `Call hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} }) first, confirm the complete target range, then submit the change.`;
	lines.push(readInstruction);
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
					requiredLines: [],
					missingLines: [],
				},
			};
		}

		const requiredLines = summarizedRequiredLines(requested.ranges);
		const evidence = this.files.get(path);
		if (!evidence) {
			const firstRequired = requested.ranges[0]!.start;
			const lastRequired = requested.ranges.at(-1)!.end;
			const coverage = collectProofCoverage(requested.ranges, new Map<number, EvidenceLine>());
			return {
				failure: {
					code: "insufficient_read_proof",
					message: `No current anchors have been read for lines ${firstRequired}-${lastRequired}.`,
					requiredLines,
					missingLines: coverage.missingLines,
					...(coverage.firstMissingRange ? { suggestedReadRange: coverage.firstMissingRange } : {}),
				},
			};
		}

		const direct = evaluateProofAgainstEvidence(requested, evidence.lines, evidence.renames);
		if ("anchors" in direct) {
			return { proof: { revision: evidence.revision, anchors: direct.anchors } };
		}

		const renamedAnchors = renamedEndpointAnchors(evidence.renames, requested.endpointAnchors);
		const failure: ReadProofFailure = {
			code: "insufficient_read_proof",
			message: direct.failure.message,
			requiredLines,
			missingLines: direct.failure.missingLines,
			...(direct.failure.suggestedReadRange ? { suggestedReadRange: direct.failure.suggestedReadRange } : {}),
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
					message: direct.failure.message,
					requiredLines,
					missingLines: substitutedEvaluation.failure.missingLines,
					...(substitutedEvaluation.failure.suggestedReadRange
						? { suggestedReadRange: substitutedEvaluation.failure.suggestedReadRange }
						: {}),
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
				if (details.disposition !== "succeeded") {
					this.invalidate(path);
					continue;
				}
				const read = parsePersistedRead(details.read);
				if (read) this.recordRead(path, read);
				else this.invalidate(path);
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
			if (details.disposition === "succeeded" && details.read) this.recordRead(path, details.read);
			else this.invalidate(path);
			return;
		}
		if (toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL && toolName !== HLEDIT_REPLACE_ONCE_TOOL) return;

		this.recordApplyResult(path, details);
	}
}
