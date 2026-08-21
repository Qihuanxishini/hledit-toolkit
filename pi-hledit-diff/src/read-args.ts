export const DEFAULT_READ_LIMIT = 160;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_READ_LIMIT = 2000;
export const MAX_SEARCH_LIMIT = MAX_READ_LIMIT;
export type ReadArgsParams = {
	path: string;
	offset?: number;
	limit?: number;
};

export type SearchArgsParams = {
	path: string;
	pattern: string;
	offset?: number;
	limit?: number;
	context?: number;
	ignore_case?: boolean;
	literal?: boolean;
};

export type NormalizedReadRequest = {
	path: string;
	offset: number;
	limit: number;
};

// Search requests carry their dedicated CLI contract; they are never represented as reads.
export type NormalizedSearchRequest = {
	path: string;
	offset: number;
	limit: number;
	pattern: string;
	context?: number;
	ignoreCase?: boolean;
	literal?: boolean;
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

function toBoundedLimit(v: number | undefined, fallback: number, maximum: number): number {
	const limit = toPositiveInteger(v);
	return limit === undefined ? fallback : Math.min(limit, maximum);
}

export function normalizeReadRequest(params: ReadArgsParams): NormalizedReadRequest {
	return {
		path: normalizeToolPath(params.path),
		offset: toPositiveInteger(params.offset) ?? 1,
		limit: toBoundedLimit(params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT),
	};
}

export function normalizeSearchRequest(params: SearchArgsParams): NormalizedSearchRequest {
	const context = toNonNegativeInteger(params.context);
	return {
		path: normalizeToolPath(params.path),
		pattern: params.pattern,
		offset: toPositiveInteger(params.offset) ?? 1,
		limit: toBoundedLimit(params.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
		...(params.literal === true ? { literal: true } : {}),
		...(context !== undefined ? { context } : {}),
		...(params.ignore_case === true ? { ignoreCase: true } : {}),
	};
}

export function buildReadArgs(request: NormalizedReadRequest): string[] {
	return [
		"read-range",
		"--offset",
		String(request.offset),
		"--limit",
		String(request.limit),
		"--",
		request.path,
	];
}

export function buildSearchArgs(request: NormalizedSearchRequest): string[] {
	const args = [
		"search",
		"--offset",
		String(request.offset),
		"--limit",
		String(request.limit),
	];
	if (request.literal) args.push("--literal");
	if (request.context !== undefined) args.push("--context", String(request.context));
	if (request.ignoreCase) args.push("--ignore-case");
	args.push("--", request.path, request.pattern);
	return args;
}

export type SuggestedReadWindow = {
	offset: number;
	limit: number;
	lastLine: number;
};

// 补读窗口：目标区间前后各留 2 行上下文，最少 12 行，并受 MAX_READ_LIMIT 约束。
// 插件实际执行的补读与给模型的补读建议必须共用这一份计算；两者不一致时，模型
// 按建议读完仍可能 proof 不足，多出一轮 apply 往返。
export function suggestedReadWindow(start: number, end: number): SuggestedReadWindow {
	const offset = Math.max(1, start - 2);
	const limit = Math.min(MAX_READ_LIMIT, Math.max(12, end - offset + 3));
	return { offset, limit, lastLine: offset + limit - 1 };
}
