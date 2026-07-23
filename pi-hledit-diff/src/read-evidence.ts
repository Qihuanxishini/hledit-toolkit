import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	HLEDIT_APPLY_FILE_CHANGES_TOOL,
	HLEDIT_READ_ANCHORS_TOOL,
} from "./active-tools.ts";
import { lineFromAnchor, type HleditBatchReadProof } from "./file-changes.ts";
import { parseAnchorContext, type BatchAnchorContext } from "./post-edit-context.ts";
import type { HleditDetails, HleditReadMetadata } from "./result.ts";
import { MAX_READ_LIMIT } from "./read-args.ts";
import type { FileChangeParams } from "./schema.ts";

const RAW_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

type EvidenceLine = {
	anchor: string;
};

type FileReadEvidence = {
	revision: string;
	lines: Map<number, EvidenceLine>;
};

export type ReadProofFailure = {
	code: "insufficient_read_proof";
	message: string;
	requiredLines: number[];
	missingLines: number[];
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

type RequestedLineRange = { start: number; end: number };

type RequestedChangeEvidence = {
	ranges: RequestedLineRange[];
	endpointAnchors: Map<number, string>;
};

const MAX_REPORTED_MISSING_LINES = 20;

function requestedChangeEvidence(changes: FileChangeParams["changes"]): RequestedChangeEvidence | undefined {
	const ranges: RequestedLineRange[] = [];
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
	const mergedRanges: RequestedLineRange[] = [];
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

function summarizedRequiredLines(ranges: RequestedLineRange[]): number[] {
	return ranges.flatMap((range) => range.start === range.end ? [range.start] : [range.start, range.end]);
}

function collectProofCoverage(
	ranges: RequestedLineRange[],
	evidenceLines: Map<number, EvidenceLine>,
): { coveredLines: number[]; missingLines: number[] } {
	const availableLines = [...evidenceLines.keys()].sort((left, right) => left - right);
	const coveredLines: number[] = [];
	const missingLines: number[] = [];
	let availableIndex = 0;

	const appendMissingRange = (start: number, end: number): boolean => {
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
				return { coveredLines, missingLines };
			}
			coveredLines.push(availableLine);
			expectedLine = availableLine + 1;
			availableIndex += 1;
		}
		if (expectedLine <= range.end && appendMissingRange(expectedLine, range.end)) {
			return { coveredLines, missingLines };
		}
	}
	return { coveredLines, missingLines };
}

export async function resolveReadEvidencePath(cwd: string, path: string): Promise<string> {
	const absolutePath = resolve(cwd, path);
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

export function formatReadProofFailure(path: string, failure: ReadProofFailure): string {
	const targetLines = failure.missingLines.length > 0 ? failure.missingLines : failure.requiredLines;
	const firstLine = targetLines[0] ?? 1;
	const lastLine = targetLines[targetLines.length - 1] ?? firstLine;
	const offset = Math.max(1, firstLine - 2);
	const limit = Math.min(MAX_READ_LIMIT, Math.max(12, lastLine - offset + 3));
	return [
		"缺少覆盖本次修改范围的有效读取证据，因此未启动 batch，也未写入任何内容。",
		`原因：${failure.message}`,
		`请先调用 hledit_read_anchors({ path: ${JSON.stringify(path)}, offset: ${offset}, limit: ${limit} })，确认完整目标范围后再提交修改。`,
	].join("\n");
}

export class ReadEvidenceStore {
	private readonly files = new Map<string, FileReadEvidence>();

	clear(): void {
		this.files.clear();
	}

	invalidate(path: string): void {
		this.files.delete(path);
	}

	hasEvidence(): boolean {
		return [...this.files.values()].some((evidence) => evidence.lines.size > 0);
	}

	recordRead(path: string, read: HleditReadMetadata): void {
		const evidence = this.files.get(path);
		if (evidence && evidence.revision !== read.revision) this.files.delete(path);
		// grep 返回的是搜索结果而不是连续读取窗口；修改前必须再读取明确范围。
		if (read.requested.grep) return;
		const next = evidence?.revision === read.revision
			? evidence
			: { revision: read.revision, lines: new Map<number, EvidenceLine>() };
		for (const line of read.lines) {
			if (!line.textTruncated) next.lines.set(line.line, { anchor: line.anchor });
		}
		if (next.lines.size > 0) this.files.set(path, next);
		else this.files.delete(path);
	}

	recordUpdatedAnchors(path: string, revision: string, context: BatchAnchorContext): void {
		this.files.delete(path);
		if (!validRevision(revision) || context.lines.length === 0) return;
		const lines = new Map<number, EvidenceLine>();
		for (const line of context.lines) {
			if (!line.textTruncated) lines.set(line.line, { anchor: line.anchor });
		}
		if (lines.size > 0) this.files.set(path, { revision, lines });
	}

	private recordApplyResult(path: string, details: HleditDetails): void {
		if (details.disposition === "succeeded" && validRevision(details.revision)) {
			const updatedAnchors = parseAnchorContext(details.updatedAnchors);
			if (updatedAnchors) this.recordUpdatedAnchors(path, details.revision, updatedAnchors);
			else this.invalidate(path);
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
					message: "无法确定本次修改所依赖的原始行。",
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
					message: `尚未读取第 ${firstRequired}-${lastRequired} 行的当前锚点。`,
					requiredLines,
					missingLines: coverage.missingLines,
				},
			};
		}

		const coverage = collectProofCoverage(requested.ranges, evidence.lines);
		if (coverage.missingLines.length > 0) {
			return {
				failure: {
					code: "insufficient_read_proof",
					message: `读取证据缺少第 ${coverage.missingLines.join(", ")} 行${coverage.missingLines.length === MAX_REPORTED_MISSING_LINES ? "（仅列出前 20 行）" : ""}。`,
					requiredLines,
					missingLines: coverage.missingLines,
				},
			};
		}

		for (const [line, requestedAnchor] of requested.endpointAnchors) {
			if (evidence.lines.get(line)?.anchor !== requestedAnchor) {
				return {
					failure: {
						code: "insufficient_read_proof",
						message: `第 ${line} 行提交的锚点与当前分支最近读取到的锚点不一致。`,
						requiredLines,
						missingLines: [line],
					},
				};
			}
		}

		return {
			proof: {
				revision: evidence.revision,
				anchors: coverage.coveredLines.map((line) => evidence.lines.get(line)!.anchor),
			},
		};
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

			if (entry.message.toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) continue;
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
		if (toolName !== HLEDIT_APPLY_FILE_CHANGES_TOOL) return;

		this.recordApplyResult(path, details);
	}
}
