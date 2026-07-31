import { SNAPLINE_APPLY_TOOL, SNAPLINE_READ_TOOL } from "./schema.ts";

type SnaplineCompactionFileOps = {
	read: Set<string>;
	edited: Set<string>;
};

export function recordSnaplineFileOperations(messages: unknown[], fileOps: SnaplineCompactionFileOps): void {
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "toolResult" || typeof candidate.toolName !== "string") continue;
		if (typeof candidate.details !== "object" || candidate.details === null) continue;
		const details = candidate.details as Record<string, unknown>;
		if (typeof details.path !== "string" || details.path.length === 0 || details.protocolVersion !== 1) continue;
		if (candidate.toolName === SNAPLINE_READ_TOOL) {
			if (details.operation === "read" && details.disposition === "succeeded") fileOps.read.add(details.path);
			continue;
		}
		if (candidate.toolName !== SNAPLINE_APPLY_TOOL || details.operation !== "apply") continue;
		if (details.disposition === "succeeded") {
			if (details.contentChanged === true) fileOps.edited.add(details.path);
			else if (details.contentChanged === false) fileOps.read.add(details.path);
			continue;
		}
		if (details.disposition === "outcome_unknown") {
			fileOps.edited.add(details.path);
			continue;
		}
		if (details.disposition === "needs_review" && typeof details.recovery === "object" && details.recovery !== null) {
			const recovery = details.recovery as Record<string, unknown>;
			if (typeof recovery.snapshot === "string") fileOps.read.add(details.path);
		}
	}
}
