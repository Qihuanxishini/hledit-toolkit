export const MAX_READ_LIMIT = 2000;

export type ReadArgsParams = {
	path: string;
	offset?: number;
	limit?: number;
	grep?: string;
	context?: number;
};

export type NormalizedReadRequest = {
	path: string;
	offset: number;
	limit: number;
	grep?: string;
	context?: number;
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

function toNonNegativeInteger(v: number | undefined): number | undefined {
	return v !== undefined && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function toReadLimit(v: number | undefined): number | undefined {
	const limit = toPositiveInteger(v);
	return limit === undefined ? undefined : Math.min(limit, MAX_READ_LIMIT);
}

export function normalizeReadRequest(params: ReadArgsParams): NormalizedReadRequest {
	const grep = params.grep || undefined;
	const context = toNonNegativeInteger(params.context);
	return {
		path: normalizeToolPath(params.path),
		offset: toPositiveInteger(params.offset) ?? 1,
		limit: toReadLimit(params.limit) ?? MAX_READ_LIMIT,
		...(grep ? { grep } : {}),
		...(context !== undefined ? { context } : {}),
	};
}

export function buildReadArgs(params: ReadArgsParams): string[] {
	const request = normalizeReadRequest(params);
	const args = [
		"read-range",
		request.path,
		"--offset",
		String(request.offset),
		"--limit",
		String(request.limit),
		"--json",
	];

	if (request.grep) {
		args.push("--grep", request.grep);
	}
	if (request.context !== undefined) {
		args.push("--context", String(request.context));
	}

	return args;
}
