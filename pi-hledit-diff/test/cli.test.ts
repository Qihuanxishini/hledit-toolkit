import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HLEDIT_MAX_OUTPUT_BYTES, parseHleditCapabilities, resolveHleditBin, runHledit } from "../src/cli.ts";
import { parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";
import { applyFileChangesResult } from "../src/result.ts";

const EXPECTED_CAPABILITIES = {
	version: "2.3.1",
	anchorProtocolV2: true,
	readRangeMetadata: true,
	batchInsertAfter: true,
	batchCheck: true,
	batchUpdatedAnchors: true,
	batchStaleContext: true,
	batchWireV3: true,
	batchReadProof: true,
	contentReplaceOnce: true,
	batchEditDeltas: true,
	readIgnoreCase: true,
} as const;

test("resolveHleditBin uses the fixed bundled CLI path", () => {
	const resolved = resolveHleditBin().replace(/\\/g, "/");

	assert.match(resolved, /\/pi-hledit-diff\/bin\/hledit\.exe$/);
	assert.equal(existsSync(resolveHleditBin()), true);
});

test("runHledit executes the fixed bundled CLI", async () => {
	const run = await runHledit(["capabilities"], undefined, process.cwd(), undefined);

	assert.deepEqual(parseHleditCapabilities(run), EXPECTED_CAPABILITIES);
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

test("parseHleditCapabilities requires structured reads and patched batch capabilities", () => {
	assert.deepEqual(
		parseHleditCapabilities({ stdout: JSON.stringify({ ok: true, ...EXPECTED_CAPABILITIES }), stderr: "", exitCode: 0 }),
		EXPECTED_CAPABILITIES,
	);
	assert.equal(
		parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.6","batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchors":true,"batchStaleContext":true}', stderr: "", exitCode: 0 }),
		undefined,
	);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.6","readRangeMetadata":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.6","readRangeMetadata":true,"batchInsertAfter":true,"batchUpdatedAnchors":true,"batchStaleContext":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.6","readRangeMetadata":true,"batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchors":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"2.0.0","readRangeMetadata":true,"batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchors":true,"batchStaleContext":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"2.0.0","anchorProtocolV2":true,"readRangeMetadata":true,"batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchors":true,"batchStaleContext":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"2.0.0","anchorProtocolV2":true,"readRangeMetadata":true,"batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchors":true,"batchStaleContext":true,"batchWireV3":true}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: "not json", stderr: "", exitCode: 0 }), undefined);
});

test("bundled read-range emits structured range metadata", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	const run = await runHledit(["read-range", target, "--offset", "2", "--limit", "1", "--json"], undefined, directory, undefined);
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
	const renderedAnchor = read.stdout.trim().split(/\r?\n/, 1)[0]!;
	assert.match(renderedAnchor, /^2#[A-Za-z0-9_-]{3}:two$/);
	const anchor = renderedAnchor.split(":", 1)[0]!;
	const request = JSON.stringify({ edits: [{ op: "replace", pos: anchor, lines: ["TWO"] }] });

	const applied = await runHledit(["batch", target], request, directory, undefined);
	assert.equal(applied.exitCode, 0);
	const parsed = JSON.parse(applied.stdout) as Record<string, unknown>;
	const updatedAnchors = parseBatchUpdatedAnchorContext(parsed);
	assert.ok(updatedAnchors);
	assert.equal(updatedAnchors.lines.some((line) => line.text === "TWO"), true);
	assert.equal(await readFile(target, "utf8"), "one\nTWO\nthree\n");
});


test("bundled replace-once replaces one unique block and rejects ambiguity", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-replace-once-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\ntwo\n", "utf8");

	const ambiguous = await runHledit(
		["replace-once", target],
		JSON.stringify({ old_lines: ["two"], new_lines: ["TWO"] }),
		directory,
		undefined,
	);
	const ambiguousResult = JSON.parse(ambiguous.stdout) as Record<string, unknown>;
	assert.deepEqual(ambiguousResult.candidates, [{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 4 }]);
	assert.equal(ambiguousResult.error, "content_ambiguous");

	const applied = await runHledit(
		["replace-once", target],
		JSON.stringify({ old_lines: ["one", "two", "three"], new_lines: ["ONE", "TWO", "THREE"] }),
		directory,
		undefined,
	);
	const appliedResult = JSON.parse(applied.stdout) as Record<string, unknown>;
	assert.equal(appliedResult.ok, true);
	assert.equal(appliedResult.editsApplied, 1);
	assert.equal(await readFile(target, "utf8"), "ONE\nTWO\nTHREE\ntwo\n");
});

test("bundled batch is atomic when a later anchor is stale", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	const original = "one\ntwo\nthree\n";
	await writeFile(target, original, "utf8");

	const read = await runHledit(["read-range", target, "--offset", "2", "--limit", "2"], undefined, directory, undefined);
	const anchors = read.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.split(":", 1)[0]!);
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

// [喵喵喵]: Phase 1.4 协议余量回归——CLI 侧 50 KiB 上限按转义前原始字节计数，控制字符
// 经 JSON 转义可膨胀 6 倍（0x01 → \u0001 六字节），wrapper 上限收敛前必须证明合法最坏输出不被终止 (2026-07-25)
test("wrapper output limit passes through worst-case legal JSON escape expansion", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-escape-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	// 0x01 是合法 UTF-8 文本（二进制检测只拦 NUL），是每原始字节转义开销最大的内容。
	const line = "\u0001".repeat(128);
	const lineCount = 600;
	await writeFile(target, `${Array.from({ length: lineCount }, () => line).join("\n")}\n`, "utf8");

	const run = await runHledit(["read-range", target, "--json"], undefined, directory, undefined);

	assert.equal(run.exitCode, 0);
	assert.notEqual(run.started, false);
	const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
	assert.equal(parsed.ok, true);
	// CLI 自身的 50 KiB 原始字节截断必须先生效：本输出即合法读取的最坏体量。
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.totalLines, lineCount);
	const outputBytes = Buffer.byteLength(run.stdout, "utf8");
	assert.ok(outputBytes > 4 * 50 * 1024, `escaped output ${outputBytes} bytes should exceed 4x the raw CLI cap`);
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
	const anchor = read.stdout.trim().split(/\r?\n/, 1)[0]!.split(":", 1)[0]!;
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
