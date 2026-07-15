import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const HLEDIT_INSTALL_HINT = `This extension requires its bundled Windows x64 hledit CLI with batch insert-after and inline updated-anchor support.
Reinstall pi-hledit-diff and verify that bin/hledit.exe is present.`;

export const HLEDIT_RUN_TIMEOUT_MS = 30_000;
export const HLEDIT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type HleditRun = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export type HleditCapabilities = {
	version: string;
	batchInsertAfter: true;
	batchUpdatedAnchors: true;
};

export function parseHleditCapabilities(run: HleditRun): HleditCapabilities | undefined {
	if (run.exitCode !== 0) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(run.stdout);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;
		if (
			record.ok !== true ||
			typeof record.version !== "string" ||
			record.version.length === 0 ||
			record.batchInsertAfter !== true ||
			record.batchUpdatedAnchors !== true
		) {
			return undefined;
		}
		return { version: record.version, batchInsertAfter: true, batchUpdatedAnchors: true };
	} catch {
		return undefined;
	}
}

export function resolveHleditBin(): string {
	return resolve(EXTENSION_ROOT, "bin", "hledit.exe");
}

export async function runHledit(
	args: string[],
	stdin: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<HleditRun> {
	const bin = resolveHleditBin();
	return new Promise((resolveRun) => {
		let child;
		try {
			child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolveRun({ stdout: `failed to run ${bin}: ${message}\n\n${HLEDIT_INSTALL_HINT}`, stderr: "", exitCode: 1 });
			return;
		}

		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		};
		const finish = (run: HleditRun, terminate = false) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (terminate && !child.killed) child.kill();
			resolveRun(run);
		};
		const abort = () => finish({ stdout: "hledit execution was aborted.", stderr: "", exitCode: 1 }, true);
		const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
			outputBytes += Buffer.byteLength(chunk, "utf8");
			if (outputBytes > HLEDIT_MAX_OUTPUT_BYTES) {
				finish({ stdout: `hledit output exceeded ${HLEDIT_MAX_OUTPUT_BYTES} bytes and was terminated.`, stderr: "", exitCode: 1 }, true);
				return;
			}
			if (target === "stdout") stdout += chunk;
			else stderr += chunk;
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
		child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
		child.on("error", (error) =>
			finish({ stdout: `failed to run ${bin}: ${error.message}\n\n${HLEDIT_INSTALL_HINT}`, stderr, exitCode: 1 }),
		);
		child.on("close", (exitCode) => finish({ stdout, stderr, exitCode }));
		child.stdin.on("error", (error) => finish({ stdout: `failed to write hledit input: ${error.message}`, stderr, exitCode: 1 }, true));

		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		timeout = setTimeout(() => {
			finish({ stdout: `hledit timed out after ${HLEDIT_RUN_TIMEOUT_MS} ms.`, stderr: "", exitCode: 1 }, true);
		}, HLEDIT_RUN_TIMEOUT_MS);
		child.stdin.end(stdin ?? "");
	});
}
