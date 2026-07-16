import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseHleditCapabilities, resolveHleditBin, runHledit } from "../src/cli.ts";
import { parseBatchUpdatedAnchorContext } from "../src/post-edit-context.ts";

test("resolveHleditBin uses the fixed bundled CLI path", () => {
	const resolved = resolveHleditBin().replace(/\\/g, "/");

	assert.match(resolved, /\/pi-hledit-diff\/bin\/hledit\.exe$/);
	assert.equal(existsSync(resolveHleditBin()), true);
});

test("runHledit executes the fixed bundled CLI", async () => {
	const run = await runHledit(["capabilities"], undefined, process.cwd(), undefined);

	assert.deepEqual(parseHleditCapabilities(run), { version: "1.2.5", batchInsertAfter: true, batchUpdatedAnchors: true });
});

test("parseHleditCapabilities requires the patched batch capability", () => {
	assert.deepEqual(
		parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.5","batchInsertAfter":true,"batchUpdatedAnchors":true}', stderr: "", exitCode: 0 }),
		{ version: "1.2.5", batchInsertAfter: true, batchUpdatedAnchors: true },
	);
	assert.equal(
		parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.4","batchInsertAfter":true}', stderr: "", exitCode: 0 }),
		undefined,
	);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.4"}', stderr: "", exitCode: 0 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: '{"ok":true,"version":"1.2.4","batchInsertAfter":true}', stderr: "", exitCode: 1 }), undefined);
	assert.equal(parseHleditCapabilities({ stdout: "not json", stderr: "", exitCode: 0 }), undefined);
});

test("bundled batch emits plugin-compatible updated anchors", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-hledit-diff-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, "target.txt");
	await writeFile(target, "one\ntwo\nthree\n", "utf8");

	const read = await runHledit(["read-range", target, "--offset", "2", "--limit", "1"], undefined, directory, undefined);
	const renderedAnchor = read.stdout.trim().split(/\r?\n/, 1)[0]!;
	assert.match(renderedAnchor, /^2#[A-Za-z0-9]+:two$/);
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
			{ op: "delete", pos: staleAnchor, lines: [] },
		],
	});

	const rejected = await runHledit(["batch", target], request, directory, undefined);
	const parsed = JSON.parse(rejected.stdout) as Record<string, unknown>;
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error, "stale");
	assert.equal(await readFile(target, "utf8"), original);
});
