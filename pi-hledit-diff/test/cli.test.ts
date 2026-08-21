import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HLEDIT_MAX_OUTPUT_BYTES, parseHleditCapabilities, resolveHleditBin, runHledit } from "../src/cli.ts";
import { parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";
import { applyFileChangesResult } from "../src/result.ts";

// CLI 声明的完整能力集；解析结果只保留 version，其余字段仅用于构造被校验的输入。
const DECLARED_CAPABILITIES = {
	version: "3.2.0",
	anchorProtocolV2: true,
	readRangeMetadata: true,
	batchInsertAfter: true,
	batchCheck: true,
	batchUpdatedAnchors: true,
	batchStaleContext: true,
	batchWireV3: true,
	batchReadProof: true,
	batchEditDeltas: true,
	searchIgnoreCase: true,
	searchRegex: true,
	searchLiteral: true,
	search: true,
} as const;

test("resolveHleditBin uses the fixed bundled CLI path", () => {
	const resolved = resolveHleditBin().replace(/\\/g, "/");

	assert.match(resolved, /\/pi-hledit-diff\/bin\/hledit\.exe$/);
	assert.equal(existsSync(resolveHleditBin()), true);
});

test("runHledit executes the fixed bundled CLI", async () => {
	const run = await runHledit(["capabilities"], undefined, process.cwd(), undefined);

	assert.deepEqual(parseHleditCapabilities(run), { version: DECLARED_CAPABILITIES.version });
});

test("runHledit reports an already-aborted invocation", async () => {
	const controller = new AbortController();
	controller.abort();

	const run = await runHledit(["capabilities"], undefined, process.cwd(), controller.signal);

	assert.equal(run.stdout, "hledit execution was cancelled.");
	assert.equal(run.stderr, "");
	assert.equal(run.exitCode, 1);
	assert.equal(typeof run.started, "boolean");
});

test("parseHleditCapabilities requires the reviewed CLI 3.x read/search/apply contract", () => {
	assert.deepEqual(
		parseHleditCapabilities({ stdout: JSON.stringify({ ok: true, ...DECLARED_CAPABILITIES }), stderr: "", exitCode: 0 }),
		{ version: DECLARED_CAPABILITIES.version },
	);
	assert.equal(parseHleditCapabilities({ stdout: JSON.stringify({ ok: true, ...DECLARED_CAPABILITIES, version: "2.3.1" }), stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: JSON.stringify({ ok: true, ...DECLARED_CAPABILITIES, version: "4.0.0" }), stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: "not json", stderr: "", exitCode: 0 }), undefined);
});

// 单一 REQUIRED_CAPABILITIES 列表必须真的逐项生效：任何一项缺失都要拒绝整个 CLI。
test("parseHleditCapabilities rejects a CLI missing any single required capability", () => {
	const capabilities = Object.keys(DECLARED_CAPABILITIES).filter((name) => name !== "version");
	assert.equal(capabilities.length, 13);
	for (const capability of capabilities) {
		const declaration = { ok: true, ...DECLARED_CAPABILITIES, [capability]: false };
		assert.equal(
			parseHleditCapabilities({ stdout: JSON.stringify(declaration), stderr: "", exitCode: 0 }),
			undefined,
			`${capability} must be enforced`,
		);
	}
});

test("bundled read-range emits structured range metadata", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	const run = await runHledit(["read-range", target, "--offset", "2", "--limit", "1"], undefined, directory, undefined);
	const parsed = JSON.parse(run.stdout) as Record<string, unknown>;

	assert.equal(parsed.ok, true);
	assert.equal(parsed.totalLines, 3);
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.nextOffset, 3);
});

test("bundled batch emits plugin-compatible updated anchors", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	const read = await runHledit(["read-range", target, "--offset", "2", "--limit", "1"], undefined, directory, undefined);
	const readResult = JSON.parse(read.stdout) as { lines: Array<{ anchor: string }> };
	const anchor = readResult.lines[0]?.anchor;
	assert.match(anchor ?? "", /^2#[A-Za-z0-9_-]{3}$/);
	assert.ok(anchor);
	const request = JSON.stringify({ edits: [{ op: "replace", pos: anchor, lines: ["TWO"] }] });

	const applied = await runHledit(["batch", target], request, directory, undefined);
	assert.equal(applied.exitCode, 0);
	const parsed = JSON.parse(applied.stdout) as Record<string, unknown>;
	const updatedAnchors = parseBatchUpdatedAnchorContext(parsed);
	assert.ok(updatedAnchors);
	assert.equal(updatedAnchors.lines.some((line) => line.text === "TWO"), true);
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nthree\n");
});

test("bundled CLI rejects the removed replace-once verb without writing", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-removed-verb-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "one\ntwo\nthree\n";
	await writeFile(target, original, "utf8");

	const run = await runHledit(["replace-once", target], JSON.stringify({ old_lines: ["two"], new_lines: ["TWO"] }), directory, undefined);
	assert.equal(run.exitCode, 2);
	assert.equal(run.stdout, "");
	assert.match(run.stderr, /unknown verb "replace-once"/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("bundled batch is atomic when a later anchor is stale", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "one\ntwo\nthree\n";
	await writeFile(target, original, "utf8");

	const read = await runHledit(["read-range", target, "--offset", "2", "--limit", "2"], undefined, directory, undefined);
	const anchors = (JSON.parse(read.stdout) as { lines: Array<{ anchor: string }> }).lines.map((line) => line.anchor);
	const staleAnchor = `${anchors[1]!.slice(0, -1)}${anchors[1]!.endsWith("Z") ? "Y" : "Z"}`;
	const request = JSON.stringify({
		edits: [
			{ op: "replace", pos: anchors[0], lines: ["TWO"] },
			{ op: "delete", pos: staleAnchor },
		],
	});

	const rejected = await runHledit(["batch", target], request, directory, undefined);
	const parsed = JSON.parse(rejected.stdout) as Record<string, unknown>;
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error, "stale");
	assert.equal(await readFile(target, "utf8"), original);
});

// [喵喵喵]: CLI 按最终 JSON UTF-8 字节执行 50 KiB 预算；控制字符覆盖最坏转义，
// wrapper 必须完整透传接近上限的合法输出而不触发 1 MiB 保护。
test("wrapper accepts CLI-capped worst-case JSON escaping", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-escape-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	// [喵喵喵]: 0x01 是合法 UTF-8 文本（二进制检测只拦 NUL），也是单字节输入中 JSON 转义开销最大的内容。
	const line = "\u0001".repeat(128);
	const lineCount = 600;
	await writeFile(target, `${Array.from({ length: lineCount }, () => line).join("\n")}\n`, "utf8");

	const run = await runHledit(["read-range", target], undefined, directory, undefined);

	assert.equal(run.exitCode, 0);
	assert.notEqual(run.started, false);
	const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
	assert.equal(parsed.ok, true);
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.totalLines, lineCount);
	const outputBytes = Buffer.byteLength(run.stdout, "utf8");
	assert.ok(outputBytes > 48 * 1024, `escaped output ${outputBytes} bytes should use most of the CLI budget`);
	assert.ok(outputBytes <= 50 * 1024, `escaped output ${outputBytes} bytes must stay within the CLI cap`);
	assert.ok(outputBytes < HLEDIT_MAX_OUTPUT_BYTES, `escaped output ${outputBytes} bytes must stay under the wrapper limit`);
});

// [喵喵喵]: Phase 1.4 回归——输出超限终止发生在 CLI 已写入之后时，必须保持
// outcome_unknown，不得把已落盘的写入误报为零写入 (2026-07-25)
test("output overflow after a started write keeps outcome unknown", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-overflow-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	const read = await runHledit(["read-range", target, "--offset", "2", "--limit", "1"], undefined, directory, undefined);
	const anchor = (JSON.parse(read.stdout) as { lines: Array<{ anchor: string }> }).lines[0]?.anchor;
	assert.ok(anchor);
	const request = JSON.stringify({ edits: [{ op: "replace", pos: anchor, lines: ["TWO"] }] });

	// 64 字节上限保证成功 JSON 响应必然触发 overflow 终止，但 CLI 在输出前已完成原子写入。
	const applied = await runHledit(["batch", target], request, directory, undefined, 64);

	assert.equal(applied.exitCode, 1);
	assert.equal(applied.started, true);
	assert.match(applied.stdout, /output exceeded 64 bytes/);
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nthree\n");

	const result = applyFileChangesResult(applied, { path: target });
	assert.equal(result.details.disposition, "outcome_unknown");
	const text = result.content[0]?.text ?? "";
	assert.match(text, /write outcome is unknown/);
	assert.match(text, /Do not retry/);
	assert.match(text, /hledit_read_anchors/);
	assert.doesNotMatch(text, /No content was written|no write was attempted|was not started/i);
});
