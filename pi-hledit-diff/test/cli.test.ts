import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseHleditCapabilities, resolveHleditBin, runHledit } from "../src/cli.ts";
import { parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";

const EXPECTED_CAPABILITIES = {
	version: "2.0.0",
	anchorProtocolV2: true,
	readRangeMetadata: true,
	batchInsertAfter: true,
	batchCheck: true,
	batchUpdatedAnchors: true,
	batchStaleContext: true,
	batchWireV3: true,
	batchReadProof: true,
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

	assert.equal(run.stdout, "hledit 执行已取消。");
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
