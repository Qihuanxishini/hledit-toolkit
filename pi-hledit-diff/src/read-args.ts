export const DEFAULT_READ_LIMIT = 160;
export const MAX_READ_LIMIT = 2000;

export type ReadArgsParams = {
	path: string;
	offset?: number;
	limit?: number;
	grep?: string;
	context?: number;
	ignore_case?: boolean;
	literal?: boolean;
};

export type NormalizedReadRequest = {
	path: string;
	offset: number;
	limit: number;
	grep?: string;
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

function toReadLimit(v: number | undefined): number | undefined {
	const limit = toPositiveInteger(v);
	return limit === undefined ? undefined : Math.min(limit, MAX_READ_LIMIT);
}

export function normalizeReadRequest(params: ReadArgsParams): NormalizedReadRequest {
	const grep = params.grep || undefined;
	const context = toNonNegativeInteger(params.context);
	// literal 只在 grep 生效时有意义；默认正则与 Pi 内置 grep 对齐。
	const literal = grep !== undefined && params.literal === true;
	const ignoreCase = grep !== undefined && params.ignore_case === true;
	return {
		path: normalizeToolPath(params.path),
		offset: toPositiveInteger(params.offset) ?? 1,
		limit: toReadLimit(params.limit) ?? DEFAULT_READ_LIMIT,
		...(grep ? { grep } : {}),
		...(literal ? { literal: true } : {}),
		...(context !== undefined ? { context } : {}),
		...(ignoreCase ? { ignoreCase: true } : {}),
	};
}

// 只接受 normalizeReadRequest 的输出：入参已在边界完成归一化，这里不得再次归一化。
// [喵喵喵]: 曾因入参误标为原始 shape 并二次归一化，丢失 ignore_case → ignoreCase
// 的改名字段，导致生产路径的大小写开关从未到达 CLI。(2026-07-25)
export function buildReadArgs(request: NormalizedReadRequest): string[] {
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
		if (request.literal) {
			args.push("--literal");
		}
	}
	if (request.context !== undefined) {
		args.push("--context", String(request.context));
	}
	if (request.ignoreCase) {
		args.push("--ignore-case");
	}

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
