import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, type SnaplineReadParams } from "./schema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepareSnaplineReadArguments(args: unknown): SnaplineReadParams {
	if (!isRecord(args)) return args as SnaplineReadParams;
	const prepared = { ...args };
	if (Number.isSafeInteger(prepared.offset) && Number(prepared.offset) <= 0) prepared.offset = 1;
	if (Number.isSafeInteger(prepared.limit)) {
		if (Number(prepared.limit) <= 0) prepared.limit = DEFAULT_READ_LIMIT;
		else if (Number(prepared.limit) > MAX_READ_LIMIT) prepared.limit = MAX_READ_LIMIT;
	}
	return prepared as SnaplineReadParams;
}
