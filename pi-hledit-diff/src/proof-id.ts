import { randomBytes } from "node:crypto";

// [喵喵喵]: proof 是坐标代引用，不是可复用的当前状态标签。96 位进程 nonce 降低重启后
// 与历史 id 碰撞的风险；BigInt 序号保证同进程不重复，也不需要无限保存已淘汰 id。
const prefix = randomBytes(12).toString("base64url");
let counter = 0n;

export function nextProofId(): string {
	counter += 1n;
	return `${prefix}.${counter}`;
}
