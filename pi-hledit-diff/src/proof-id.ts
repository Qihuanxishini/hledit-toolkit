import { randomBytes } from "node:crypto";

// proof id 的唯一用途是让 selectProof 判断"提交的 id 是否就是该文件当前 read
// generation"，做的是相等比较：既不需要全局唯一，也不需要不可猜测。因此这里用
// 短 id 取代 UUID —— 它每次 read 都要写进模型正文并被回抄进 apply 请求，UUID 的
// 十六进制碎片在 tokenizer 下要花 25 个 token，短 id 只要 5-6 个。
//
// 单调计数器保证同进程内 id 绝不复用，这正是"分页或后续显式 read 轮换 proof id"
// 所依赖的性质。前缀是每进程一次的随机量：restoreFromBranch 会把转录里的历史
// proof id 重新载回 store，纯计数器在进程重启后会从 1 重新发号，可能与同一文件
// 的历史 id 相撞，让已轮换的 id 通过 generation 检查。
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const PREFIX_LENGTH = 3;

function randomPrefix(): string {
	let prefix = "";
	for (const byte of randomBytes(PREFIX_LENGTH)) {
		prefix += PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length];
	}
	return prefix;
}

const prefix = randomPrefix();
let counter = 0;

export function nextProofId(): string {
	counter += 1;
	return `${prefix}${counter}`;
}
