import type { VerifiedChangePreview } from "./change-preview.ts";
import type { SnapshotDelta } from "./snapshot-ledger.ts";
import type { SnaplineApplyStats, SnaplineEditEffect } from "./wire.ts";

export type SnaplineOmissionReason = "line_limit" | "byte_budget" | "line_too_long" | "replay_delta_budget";
export type SnaplineDisplayedRange = {
	start: number;
	end: number;
	reason?: SnaplineOmissionReason;
	approximate?: true;
};

export type SnaplineReadDetails = {
	protocolVersion: 1;
	operation: "read";
	disposition: "succeeded" | "rejected" | "unavailable";
	path: string;
	canonicalFileKey?: string;
	canonicalTargetPath?: string;
	snapshot?: string;
	totalLines?: number;
	revision?: string;
	displayedRanges?: SnaplineDisplayedRange[];
	omittedRanges?: SnaplineDisplayedRange[];
	nextOffset?: number;
	repairedOffset?: number;
	repairedLimit?: number;
	capacityRebased?: true;
	snapshotDelta?: SnapshotDelta;
	error?: { code: string; message: string };
	imageDelegated?: true;
};

export type SnaplineRecoveryDetails = {
	snapshot?: string;
	totalLines?: number;
	revision?: string;
	displayedRanges?: SnaplineDisplayedRange[];
	omittedRanges?: SnaplineDisplayedRange[];
	snapshotDelta?: SnapshotDelta;
	failed?: { code: string; message: string };
};

export type SnaplineApplyDetails = {
	protocolVersion: 1;
	operation: "apply";
	disposition: "succeeded" | "rejected" | "needs_review" | "unavailable" | "outcome_unknown";
	path: string;
	canonicalFileKey?: string;
	canonicalTargetPath?: string;
	sourceSnapshot?: string;
	snapshot?: string;
	contentChanged?: boolean;
	stats?: SnaplineApplyStats;
	effects?: SnaplineEditEffect[];
	warnings?: Array<{ code: "post_commit_durability"; message: string }>;
	producedRanges?: Array<{ group: "replacement" | "insertion_before" | "insertion_after"; groupIndex: number; start: number; end: number }>;
	producedTruncated?: true;
	capacityRebased?: true;
	snapshotDelta?: SnapshotDelta;
	preview?: VerifiedChangePreview;
	recovery?: SnaplineRecoveryDetails;
	error?: { code: string; message: string };
};

export type SnaplineToolDetails = SnaplineReadDetails | SnaplineApplyDetails;

export type TextToolResult<TDetails = SnaplineToolDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails;
};

export function textToolResult<TDetails>(text: string, details: TDetails): TextToolResult<TDetails> {
	return { content: [{ type: "text", text }], details };
}
