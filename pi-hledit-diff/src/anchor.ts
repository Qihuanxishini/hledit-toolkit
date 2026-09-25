// LN#HHH 锚点 token 的唯一语法定义，与 CLI anchorRE 一致：行号为不带前导零的正整数，
// hash 为三位 URL-safe Base64（CLI anchorHashAlphabet）。
export const ANCHOR_HASH_PATTERN = "[A-Za-z0-9_-]{3}";
const ANCHOR_LINE_PATTERN = "[1-9]\\d*";
export const ANCHOR_PATTERN = `^${ANCHOR_LINE_PATTERN}#${ANCHOR_HASH_PATTERN}$`;
const ANCHOR_TOKEN = new RegExp(`^(${ANCHOR_LINE_PATTERN})#${ANCHOR_HASH_PATTERN}$`);
// read 输出的一行是 `LN#HHH:text`；误贴进 lines 时由这里识别行首 token。
export const ANCHOR_LINE_PREFIX = new RegExp(`^(${ANCHOR_LINE_PATTERN}#${ANCHOR_HASH_PATTERN}):`);

function safeLineNumber(digits: string): number | undefined {
	const line = Number(digits);
	return Number.isSafeInteger(line) ? line : undefined;
}

// 规范锚点 token 的行号；形状不合法或行号超出安全整数时返回 undefined。
export function anchorTokenLine(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") return undefined;
	const match = ANCHOR_TOKEN.exec(anchor);
	return match ? safeLineNumber(match[1]!) : undefined;
}

// 已通过 schema 的请求锚点只需取行号前缀；hash 是否与当前文件一致由 proof 与 CLI 校验。
export function lineFromAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") return undefined;
	const match = /^([1-9]\d*)#/.exec(anchor);
	return match ? safeLineNumber(match[1]!) : undefined;
}
