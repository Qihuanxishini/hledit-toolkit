import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type CanonicalTarget = {
	requestedPath: string;
	absolutePath: string;
	canonicalFileKey: string;
	canonicalTargetPath: string;
	exists: boolean;
};

export class CanonicalPathError extends Error {
	readonly code: "invalid_path" | "path_unavailable";

	constructor(code: CanonicalPathError["code"], message: string) {
		super(message);
		this.name = "CanonicalPathError";
		this.code = code;
	}
}

export function normalizeToolPath(path: string): string {
	const cleaned = path.replace(/^@/, "");
	const msysDrive = cleaned.match(/^\/([A-Za-z])\/(.*)$/);
	if (process.platform === "win32" && msysDrive) {
		return `${msysDrive[1]}:/${msysDrive[2]}`;
	}
	return cleaned;
}

export function canonicalKeyFromPath(path: string): string {
	const normalizedSeparators = path.replace(/\\/g, "/");
	return process.platform === "win32" ? normalizedSeparators.toLowerCase() : normalizedSeparators;
}

async function nearestRealAncestor(absolutePath: string): Promise<{ source: string; target: string }> {
	let candidate = absolutePath;
	for (;;) {
		try {
			await lstat(candidate);
			return { source: candidate, target: await realpath(candidate) };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new CanonicalPathError("path_unavailable", `Could not inspect ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const parent = dirname(candidate);
			if (parent === candidate) {
				throw new CanonicalPathError("path_unavailable", `No existing ancestor could be resolved for ${absolutePath}.`);
			}
			candidate = parent;
		}
	}
}

export async function resolveCanonicalTarget(cwd: string, suppliedPath: string): Promise<CanonicalTarget> {
	const requestedPath = normalizeToolPath(suppliedPath);
	if (requestedPath.length === 0 || requestedPath.includes("\0")) {
		throw new CanonicalPathError("invalid_path", "Path must be non-empty and cannot contain NUL bytes.");
	}
	const absolutePath = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
	try {
		await lstat(absolutePath);
		const canonicalTargetPath = await realpath(absolutePath);
		return {
			requestedPath,
			absolutePath,
			canonicalFileKey: canonicalKeyFromPath(canonicalTargetPath),
			canonicalTargetPath,
			exists: true,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			throw new CanonicalPathError("path_unavailable", `Could not resolve ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const ancestor = await nearestRealAncestor(dirname(absolutePath));
	const suffix = relative(ancestor.source, absolutePath);
	if (suffix.startsWith("..") || isAbsolute(suffix)) {
		throw new CanonicalPathError("path_unavailable", `Target escaped its resolved ancestor: ${absolutePath}.`);
	}
	const canonicalTargetPath = join(ancestor.target, suffix);
	return {
		requestedPath,
		absolutePath,
		canonicalFileKey: canonicalKeyFromPath(canonicalTargetPath),
		canonicalTargetPath,
		exists: false,
	};
}

export function sameCanonicalTarget(left: CanonicalTarget, right: CanonicalTarget): boolean {
	return left.canonicalFileKey === right.canonicalFileKey;
}
