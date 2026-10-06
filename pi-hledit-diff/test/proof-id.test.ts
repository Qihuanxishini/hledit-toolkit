import assert from "node:assert/strict";
import test from "node:test";
import { nextProofId } from "../src/proof-id.ts";

// proof id 的形态被两处依赖：模型正文里的 `proof_id: <id>` 行，以及
// read-evidence 的 generation 相等比较。
test("proof ids never repeat within one process", () => {
	const ids = Array.from({ length: 64 }, () => nextProofId());
	assert.equal(new Set(ids).size, ids.length);
});

// 单调计数是"分页或后续显式 read/search 轮换 proof id"的执行点：计数一旦回退或
// 复用，已轮换的旧 id 就能通过 selectProof 的 generation 检查。
test("proof ids share one process prefix and advance monotonically", () => {
	const parsed = Array.from({ length: 8 }, () => {
		const id = nextProofId();
		const match = /^([A-Za-z0-9_-]{16})\.(\d+)$/.exec(id);
		assert.ok(match, `unexpected proof id shape: ${id}`);
		return { prefix: match[1]!, counter: Number(match[2]!) };
	});
	assert.equal(new Set(parsed.map((entry) => entry.prefix)).size, 1);
	for (const [index, entry] of parsed.entries()) {
		if (index === 0) continue;
		assert.equal(entry.counter, parsed[index - 1]!.counter + 1);
	}
});
