// CLI tag（cli/src/text.rs）的复刻，仅用于编辑成功后平移证据行号时重算锚点。
// 契约：调用方必须先用旧行号重算并与 CLI 返回的旧锚点比对（自校验），一致才信任新行号
// 的重算结果；任何不一致都丢弃该行证据，由 CLI 的 proof/revision 校验兜底。
// hash 语义变更属于锚点协议版本升级，必须与 CLI 同步修改并通过 golden 对拍测试。

const ANCHOR_HASH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// v2 协议的 Unicode White_Space 精确集合，用转义序列避免不可见字符。
// 与 JS 的 \s 或 trimEnd() 不同：包含 U+0085 (NEL)，不包含 U+FEFF (BOM)。
const WHITESPACE_CHARACTER = new RegExp(
	"^[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]$",
	"u",
);

// 显著字符对应 Unicode L* 与 Nd 类别（Nd 不含 Nl/No）；Unicode 版本差异由调用方自校验兜底。
const SIGNIFICANT_RUNE = /[\p{L}\p{Nd}]/u;

const utf8Encoder = new TextEncoder();

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function computeLineHash(lineNum: number, line: string): string {
	// [喵喵喵]: 从末尾逐字符检查，避免长内部空白使未锚定的尾空白正则平方级回溯。
	// White_Space 全部位于 BMP；按 UTF-16 code unit 扫描不会截断正文中的代理对。
	let end = line.length;
	while (end > 0 && WHITESPACE_CHARACTER.test(line[end - 1]!)) end -= 1;
	const trimmed = line.slice(0, end);

	let hash = FNV_OFFSET_BASIS;
	const mix = (byte: number) => {
		hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
	};

	// 结构行（无字母/数字）把行号按小端逐字节混入，与 CLI 保持一致。
	if (!SIGNIFICANT_RUNE.test(trimmed)) {
		let n = lineNum;
		while (n > 0) {
			mix(n & 0xff);
			n >>>= 8;
		}
	}

	for (const byte of utf8Encoder.encode(trimmed)) {
		mix(byte);
	}

	return ANCHOR_HASH_ALPHABET[(hash >>> 12) & 0x3f]! + ANCHOR_HASH_ALPHABET[(hash >>> 6) & 0x3f]! + ANCHOR_HASH_ALPHABET[hash & 0x3f]!;
}

export function computeAnchorTag(lineNum: number, line: string): string {
	return `${lineNum}#${computeLineHash(lineNum, line)}`;
}
