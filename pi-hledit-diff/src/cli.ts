import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const HLEDIT_INSTALL_HINT = `This extension requires the bundled Windows x64 hledit CLI 3.x with v2 anchors, structured range reads, strict batch wire v3, read proof, batch validation, insert-after support, updated-anchor contexts, edit deltas, and case-insensitive grep.
Resync or reinstall pi-hledit-diff, then confirm that bin/hledit.exe exists.`;

export const HLEDIT_RUN_TIMEOUT_MS = 30_000;
export const HLEDIT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const HLEDIT_TERMINATION_GRACE_MS = 250;

export type HleditRun = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	started?: boolean;
};

export type HleditCapabilities = {
	version: string;
	anchorProtocolV2: true;
	readRangeMetadata: true;
	batchInsertAfter: true;
	batchCheck: true;
	batchUpdatedAnchors: true;
	batchStaleContext: true;
	batchWireV3: true;
	batchReadProof: true;
	batchEditDeltas: true;
	readIgnoreCase: true;
};

const SUPPORTED_CLI_VERSION_PATTERN = /^3\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
			!SUPPORTED_CLI_VERSION_PATTERN.test(record.version) ||
			Object.prototype.hasOwnProperty.call(record, "contentReplaceOnce") ||
			record.readRangeMetadata !== true ||
			record.batchInsertAfter !== true ||
			record.batchCheck !== true ||
			record.batchUpdatedAnchors !== true ||
			record.batchStaleContext !== true ||
			record.batchReadProof !== true ||
			record.batchWireV3 !== true ||
			record.batchEditDeltas !== true ||
			record.readIgnoreCase !== true ||
			record.anchorProtocolV2 !== true
		) {
			return undefined;
		}
		return {
			version: record.version,
			anchorProtocolV2: true,
			readRangeMetadata: true,
			batchInsertAfter: true,
			batchCheck: true,
			batchUpdatedAnchors: true,
			batchStaleContext: true,
			batchWireV3: true,
			batchReadProof: true,
			batchEditDeltas: true,
			readIgnoreCase: true,
		};
	} catch {
		return undefined;
	}
}

export function resolveHleditBin(): string {
	return resolve(EXTENSION_ROOT, "bin", "hledit.exe");
}

// maxOutputBytes 是 wrapper 协议余量：必须容纳 CLI 自身 50 KiB/2000 行截断后的
// 最坏 JSON 转义膨胀（控制字符 6 倍 + 逐行框架）。正式调用方使用默认值；
// 更小的显式值仅供回归测试覆盖 overflow 终止路径。
type ForceTerminateProcess = (
	child: ChildProcessWithoutNullStreams,
	reportDiagnostic: (message: string) => void,
) => void;

export type HleditProcessWaitOptions = {
	executablePath: string;
	signal: AbortSignal | undefined;
	maxOutputBytes: number;
	timeoutMs: number;
	terminationGraceMs: number;
	forceTerminate?: ForceTerminateProcess;
};

function forceTerminateHleditProcess(
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

	// Windows 的 ChildProcess.kill 不终止后代；taskkill /T /F 负责整个 CLI 进程树。
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

// [喵喵喵]: 终止请求与 exit/close 分离；只有确认未启动或已退出后才允许释放同文件队列 (2026-07-30)
export function waitForHleditProcess(
	child: ChildProcessWithoutNullStreams,
	stdin: string | undefined,
	options: HleditProcessWaitOptions,
): Promise<HleditRun> {
	const forceTerminate = options.forceTerminate ?? forceTerminateHleditProcess;
	return new Promise((resolveRun) => {
		let commandStarted = false;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		let terminationRequested = false;
		let terminationResult: HleditRun | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const diagnostics: string[] = [];

		const reportDiagnostic = (message: string) => diagnostics.push(message);
		const runWithDiagnostics = (run: HleditRun): HleditRun => ({
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
		const complete = (run: HleditRun) => {
			if (!prepareCompletion()) return;
			resolveRun(runWithDiagnostics(run));
		};
		const destroyLocalHandles = () => {
			for (const stream of [child.stdin, child.stdout, child.stderr]) {
				if (stream.closed) continue;
				// listener 清理后仍可能有已排队的 pipe error；只在本地 handle close 前吸收一次，避免未处理 error。
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
		const requestTermination = (run: HleditRun) => {
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
				reportDiagnostic(`Graceful termination request failed: ${error instanceof Error ? error.message : String(error)}`);
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
		const abort = () => requestTermination({ stdout: "hledit execution was cancelled.", stderr: "", exitCode: 1 });
		const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
			if (settled || terminationRequested) return;
			outputBytes += Buffer.byteLength(chunk, "utf8");
			if (outputBytes > options.maxOutputBytes) {
				requestTermination({ stdout: `hledit output exceeded ${options.maxOutputBytes} bytes, so the process was terminated.`, stderr: "", exitCode: 1 });
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
				const neverStarted = terminationResult ?? {
					stdout: `Could not start hledit: ${options.executablePath}\n\n${HLEDIT_INSTALL_HINT}`,
					stderr: error.message || stderr,
					exitCode: 1,
				};
				complete({ ...neverStarted, started: false });
				return;
			}
			reportDiagnostic(`hledit process error after start: ${error.message}`);
		};
		const onExit = () => {
			if (terminationRequested) completeTerminated();
		};
		const onClose = (exitCode: number | null) => {
			if (terminationRequested) completeTerminated();
			else complete({ stdout, stderr, exitCode });
		};
		const onStdinError = (error: Error) => requestTermination({
			stdout: "Could not send input to hledit; the process was terminated.",
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
			requestTermination({ stdout: `hledit did not finish within ${options.timeoutMs / 1000} seconds, so the process was terminated.`, stderr: "", exitCode: 1 });
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

export async function runHledit(
	args: string[],
	stdin: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	maxOutputBytes: number = HLEDIT_MAX_OUTPUT_BYTES,
): Promise<HleditRun> {
	const bin = resolveHleditBin();
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { stdout: `Could not start hledit: ${bin}\n\n${HLEDIT_INSTALL_HINT}`, stderr: message, exitCode: 1, started: false };
	}
	return waitForHleditProcess(child, stdin, {
		executablePath: bin,
		signal,
		maxOutputBytes,
		timeoutMs: HLEDIT_RUN_TIMEOUT_MS,
		terminationGraceMs: HLEDIT_TERMINATION_GRACE_MS,
	});
}
