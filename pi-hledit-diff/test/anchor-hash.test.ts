import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { computeAnchorTag, computeLineHash } from "../src/anchor-hash.ts";
import { resolveHleditBin } from "../src/cli.ts";

const execFileAsync = promisify(execFile);

test("computeLineHash returns three URL-safe base64 characters", () => {
	for (const [lineNum, text] of [[1, "hello"], [500, "}"], [7, ""], [3, "中文行"], [42, "a-b_c"]] as Array<[number, string]>) {
		assert.match(computeLineHash(lineNum, text), /^[A-Za-z0-9_-]{3}$/);
	}
});

test("structural lines mix in the line number while significant lines do not", () => {
	// 有字母/数字的行 hash 只依赖内容，行号平移后 hash 不变。
	assert.equal(computeLineHash(10, "const value = 1;"), computeLineHash(999, "const value = 1;"));
	// 结构行（空行、纯符号）混入行号，不同的行号产生不同 hash 的概率极高。
	assert.notEqual(computeLineHash(10, "}"), computeLineHash(11, "}"));
	assert.notEqual(computeLineHash(300, ""), computeLineHash(301, ""));
	// 尾部空白不参与锚点身份。
	assert.equal(computeLineHash(5, "text"), computeLineHash(5, "text   \t"));
});

// golden 对拍：TS 复刻必须与 bundled CLI 对每一行输出完全一致的锚点。
// hash 语义属于锚点协议；两侧任何不一致都必须视为协议破坏并在此失败。
test("computeAnchorTag matches every anchor emitted by the bundled CLI", async () => {
	const lines = [
		"hello world",
		"}",
		"",
		"    return nil",
		");",
		"中文注释行",
		"\tconst x = 42;",
		"   ",
		"a-b_c",
		"!!!",
		"trailing spaces   ",
		"mixed　全角space",
	];
	// 行数超过 255 覆盖结构行行号的多字节混入路径。
	while (lines.length < 300) lines.push(`filler line ${lines.length}`);
	lines.push("", "}", "]", "*/");

	const dir = await mkdtemp(join(tmpdir(), "hledit-hash-golden-"));
	const target = join(dir, "golden.txt");
	try {
		await writeFile(target, lines.join("\n") + "\n", "utf8");
		const { stdout } = await execFileAsync(resolveHleditBin(), [
			"read-range",
			target,
			"--offset",
			"1",
			"--limit",
			"2000",
		]);
		const parsed = JSON.parse(stdout) as { ok: boolean; lines: Array<{ line: number; anchor: string; text: string }> };
		assert.equal(parsed.ok, true);
		assert.equal(parsed.lines.length, lines.length);
		for (const line of parsed.lines) {
			assert.equal(computeAnchorTag(line.line, line.text), line.anchor, `line ${line.line}: ${JSON.stringify(line.text)}`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
