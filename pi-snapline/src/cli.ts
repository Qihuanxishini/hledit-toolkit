import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const SNAPLINE_INSTALL_HINT = `This extension requires the bundled Windows x64 Snapline CLI 1.x with wire protocol 1.
Resync or reinstall pi-snapline, then confirm that bin/snapline.exe exists.`;

export const SNAPLINE_RUN_TIMEOUT_MS = 30_000;
export const SNAPLINE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const SNAPLINE_TERMINATION_GRACE_MS = 250;

export type SnaplineRun = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	started?: boolean;
};

export type SnaplineCapabilities = {
	product: "snapline";
	version: string;
	wireProtocol: 1;
	rawRevision: "sha256";
	multiWindowRead: true;
	boundedBinaryPreflight: true;
	groupedAtomicApply: true;
	completeReadProof: true;
	preCommitRevisionCheck: true;
	structuredEditEffects: true;
	structuredRecoveryContexts: true;
};

const SUPPORTED_CLI_VERSION_PATTERN = /^1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_KEYS = new Set([
	"ok",
	"product",
	"version",
	"wireProtocol",
	"rawRevision",
	"multiWindowRead",
	"boundedBinaryPreflight",
	"groupedAtomicApply",
	"completeReadProof",
	"preCommitRevisionCheck",
	"structuredEditEffects",
	"structuredRecoveryContexts",
]);

export function parseSnaplineCapabilities(run: SnaplineRun): SnaplineCapabilities | undefined {
	if (run.exitCode !== 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(run.stdout);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (
			Object.keys(record).some((key) => !CAPABILITY_KEYS.has(key)) ||
			Object.keys(record).length !== CAPABILITY_KEYS.size ||
			record.ok !== true ||
			record.product !== "snapline" ||
			typeof record.version !== "string" ||
			!SUPPORTED_CLI_VERSION_PATTERN.test(record.version) ||
			record.wireProtocol !== 1 ||
			record.rawRevision !== "sha256" ||
			record.multiWindowRead !== true ||
			record.boundedBinaryPreflight !== true ||
			record.groupedAtomicApply !== true ||
			record.completeReadProof !== true ||
			record.preCommitRevisionCheck !== true ||
			record.structuredEditEffects !== true ||
			record.structuredRecoveryContexts !== true
		) return undefined;
		return {
			product: "snapline",
			version: record.version,
			wireProtocol: 1,
			rawRevision: "sha256",
			multiWindowRead: true,
			boundedBinaryPreflight: true,
			groupedAtomicApply: true,
			completeReadProof: true,
			preCommitRevisionCheck: true,
			structuredEditEffects: true,
			structuredRecoveryContexts: true,
		};
	} catch {
		return undefined;
	}
}

export function resolveSnaplineBin(): string {
	return resolve(EXTENSION_ROOT, "bin", "snapline.exe");
}

type ForceTerminateProcess = (
	child: ChildProcessWithoutNullStreams,
	reportDiagnostic: (message: string) => void,
) => void;

export type SnaplineProcessWaitOptions = {
	executablePath: string;
	signal: AbortSignal | undefined;
	maxOutputBytes: number;
	timeoutMs: number;
	terminationGraceMs: number;
	forceTerminate?: ForceTerminateProcess;
};

function forceTerminateSnaplineProcess(
	child: ChildProcessWithoutNullStreams,
	reportDiagnostic: (message: string) => void,
): void {
	const killDirectly = () => {
		try {
			if (!child.kill("SIGKILL")) reportDiagnostic("Forced termination request returned false.");
		} catch (error) {
			reportDiagnostic(`Forced termination request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	if (process.platform !== "win32" || child.pid === undefined) {
		killDirectly();
		return;
	}

	const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
		stdio: "ignore",
		windowsHide: true,
	});
	taskkill.once("error", (error) => {
		reportDiagnostic(`taskkill could not start: ${error.message}`);
		killDirectly();
	});
	taskkill.once("close", (exitCode) => {
		if (exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
			reportDiagnostic(`taskkill exited with code ${exitCode ?? "unknown"}.`);
			killDirectly();
		}
	});
}

export function waitForSnaplineProcess(
	child: ChildProcessWithoutNullStreams,
	stdin: string | undefined,
	options: SnaplineProcessWaitOptions,
): Promise<SnaplineRun> {
	const forceTerminate = options.forceTerminate ?? forceTerminateSnaplineProcess;
	return new Promise((resolveRun) => {
		let commandStarted = false;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		let terminationRequested = false;
		let terminationResult: SnaplineRun | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const diagnostics: string[] = [];

		const reportDiagnostic = (message: string) => diagnostics.push(message);
		const runWithDiagnostics = (run: SnaplineRun): SnaplineRun => ({
			...run,
			stderr: [run.stderr, ...diagnostics].filter(Boolean).join("\n"),
			started: run.started ?? commandStarted,
		});
		const clearTimersAndAbort = () => {
			if (timeout) clearTimeout(timeout);
			if (forceTimer) clearTimeout(forceTimer);
			options.signal?.removeEventListener("abort", abort);
		};
		const removeProcessListeners = () => {
			child.removeListener("spawn", onSpawn);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdin.removeListener("error", onStdinError);
			child.stdout.removeListener("data", onStdout);
			child.stderr.removeListener("data", onStderr);
		};
		const prepareCompletion = (): boolean => {
			if (settled) return false;
			settled = true;
			clearTimersAndAbort();
			removeProcessListeners();
			return true;
		};
		const complete = (run: SnaplineRun) => {
			if (!prepareCompletion()) return;
			resolveRun(runWithDiagnostics(run));
		};
		const destroyLocalHandles = () => {
			for (const stream of [child.stdin, child.stdout, child.stderr]) {
				if (stream.closed) continue;
				const ignoreLateError = () => {};
				stream.once("error", ignoreLateError);
				stream.once("close", () => stream.removeListener("error", ignoreLateError));
				stream.destroy();
			}
		};
		const completeTerminated = () => {
			if (!terminationResult || !prepareCompletion()) return;
			destroyLocalHandles();
			resolveRun(runWithDiagnostics(terminationResult));
		};
		const processExitConfirmed = () => child.exitCode !== null || child.signalCode !== null;
		const requestTermination = (run: SnaplineRun) => {
			if (settled || terminationRequested) return;
			terminationRequested = true;
			terminationResult = run;
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			if (processExitConfirmed()) {
				completeTerminated();
				return;
			}
			try {
				if (!child.kill()) reportDiagnostic("Graceful termination request returned false.");
			} catch (error) {
				reportDiagnostic(`Graceful termination failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			forceTimer = setTimeout(() => {
				if (settled || processExitConfirmed()) {
					if (processExitConfirmed()) completeTerminated();
					return;
				}
				try {
					forceTerminate(child, reportDiagnostic);
				} catch (error) {
					reportDiagnostic(`Forced termination failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}, options.terminationGraceMs);
		};
		const abort = () => requestTermination({ stdout: "Snapline execution was cancelled.", stderr: "", exitCode: 1 });
		const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
			if (settled || terminationRequested) return;
			outputBytes += Buffer.byteLength(chunk, "utf8");
			if (outputBytes > options.maxOutputBytes) {
				requestTermination({ stdout: `Snapline output exceeded ${options.maxOutputBytes} bytes.`, stderr: "", exitCode: 1 });
				return;
			}
			if (target === "stdout") stdout += chunk;
			else stderr += chunk;
		};
		const onSpawn = () => {
			commandStarted = true;
		};
		const onError = (error: Error) => {
			if (!commandStarted) {
				complete({
					stdout: terminationResult?.stdout ?? `Could not start Snapline: ${options.executablePath}\n\n${SNAPLINE_INSTALL_HINT}`,
					stderr: error.message || stderr,
					exitCode: 1,
					started: false,
				});
				return;
			}
			reportDiagnostic(`Snapline process error after start: ${error.message}`);
		};
		const onExit = () => {
			if (terminationRequested) completeTerminated();
		};
		const onClose = (exitCode: number | null) => {
			if (terminationRequested) completeTerminated();
			else complete({ stdout, stderr, exitCode });
		};
		const onStdinError = (error: Error) => requestTermination({
			stdout: "Could not send input to Snapline.",
			stderr: error.message || stderr,
			exitCode: 1,
		});
		const onStdout = (chunk: string) => appendOutput("stdout", chunk);
		const onStderr = (chunk: string) => appendOutput("stderr", chunk);

		child.once("spawn", onSpawn);
		child.on("error", onError);
		child.on("exit", onExit);
		child.on("close", onClose);
		child.stdin.on("error", onStdinError);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);

		if (options.signal?.aborted) {
			abort();
			return;
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		timeout = setTimeout(() => {
			requestTermination({ stdout: `Snapline did not finish within ${options.timeoutMs / 1000} seconds.`, stderr: "", exitCode: 1 });
		}, options.timeoutMs);
		if (!terminationRequested) {
			try {
				child.stdin.end(stdin ?? "");
			} catch (error) {
				onStdinError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	});
}

export async function runSnapline(
	args: string[],
	stdin: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	maxOutputBytes: number = SNAPLINE_MAX_OUTPUT_BYTES,
): Promise<SnaplineRun> {
	const executablePath = resolveSnaplineBin();
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(executablePath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	} catch (error) {
		return {
			stdout: `Could not start Snapline: ${executablePath}\n\n${SNAPLINE_INSTALL_HINT}`,
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 1,
			started: false,
		};
	}
	return waitForSnaplineProcess(child, stdin, {
		executablePath,
		signal,
		maxOutputBytes,
		timeoutMs: SNAPLINE_RUN_TIMEOUT_MS,
		terminationGraceMs: SNAPLINE_TERMINATION_GRACE_MS,
	});
}
