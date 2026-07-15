export const MAX_READ_LIMIT = 2000;

export type ReadArgsParams = {
	path: string;
	offset?: number;
	limit?: number;
	grep?: string;
};

export function normalizeToolPath(path: string): string {
	const cleaned = path.replace(/^@/, "");
	const msysDrive = cleaned.match(/^\/([A-Za-z])\/(.*)$/);
	if (process.platform === "win32" && msysDrive) {
		return `${msysDrive[1]}:/${msysDrive[2]}`;
	}
	return cleaned;
}

function toPositiveInteger(v: number | undefined): number | undefined {
	return v !== undefined && Number.isInteger(v) && v > 0 ? v : undefined;
}

function toReadLimit(v: number | undefined): number | undefined {
	const limit = toPositiveInteger(v);
	return limit === undefined ? undefined : Math.min(limit, MAX_READ_LIMIT);
}

export function buildReadArgs(params: ReadArgsParams): string[] {
	const offset = toPositiveInteger(params.offset);
	const limit = toReadLimit(params.limit);
	const grep = params.grep || undefined;
	const path = normalizeToolPath(params.path);

	const args = ["read-range", path, "--offset", String(offset ?? 1), "--limit", String(limit ?? MAX_READ_LIMIT)];

	if (grep) {
		args.push("--grep", grep);
	}

	return args;
}
