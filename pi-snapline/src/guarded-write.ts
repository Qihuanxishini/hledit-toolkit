import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue, type WriteToolInput } from "@earendil-works/pi-coding-agent";

import { resolveCanonicalTarget, sameCanonicalTarget } from "./canonical-path.ts";
import { SnapshotLedger } from "./snapshot-ledger.ts";

async function pathEntryExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export async function guardedCreateFile(
	params: WriteToolInput,
	cwd: string,
	signal: AbortSignal | undefined,
	ledger: SnapshotLedger,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const initial = await resolveCanonicalTarget(cwd, params.path);
	return withFileMutationQueue(initial.canonicalFileKey, async () => {
		throwIfAborted(signal);
		const queued = await resolveCanonicalTarget(cwd, params.path);
		if (!sameCanonicalTarget(initial, queued)) {
			throw new Error("Write target identity changed while waiting for the file queue.");
		}
		if (queued.exists || await pathEntryExists(queued.absolutePath)) {
			throw new Error("Snapline healthy mode only creates missing files. Read and edit every existing file through snapshot tools.");
		}
		await mkdir(dirname(queued.canonicalTargetPath), { recursive: true });
		throwIfAborted(signal);

		const afterMkdir = await resolveCanonicalTarget(cwd, params.path);
		if (!sameCanonicalTarget(queued, afterMkdir) || afterMkdir.exists || await pathEntryExists(afterMkdir.absolutePath)) {
			throw new Error("Write target or parent identity changed before exclusive creation.");
		}
		throwIfAborted(signal);

		let file;
		try {
			file = await open(afterMkdir.canonicalTargetPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error("Write target was created externally before exclusive creation completed.");
			}
			throw error;
		}
		ledger.clearFile(afterMkdir.canonicalFileKey);
		try {
			await file.writeFile(params.content, "utf8");
			throwIfAborted(signal);
			await file.sync();
			throwIfAborted(signal);
		} finally {
			await file.close();
		}
		return {
			content: [{ type: "text", text: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}` }],
			details: undefined,
		};
	});
}
