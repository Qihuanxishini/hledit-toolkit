import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { guardedCreateFile } from "../src/guarded-write.ts";
import { SnapshotLedger } from "../src/snapshot-ledger.ts";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "snapline-write-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

async function doesNotExist(target: string): Promise<boolean> {
	try {
		await access(target);
		return false;
	} catch {
		return true;
	}
}

test("healthy write exclusively creates a missing file", async (t) => {
	const cwd = await temporaryDirectory(t);
	const ledger = new SnapshotLedger();
	const result = await guardedCreateFile({ path: "@new.txt", content: "hello 世界" }, cwd, undefined, ledger);
	assert.equal(await readFile(path.join(cwd, "new.txt"), "utf8"), "hello 世界");
	assert.match(result.content[0]!.text, /Successfully wrote/);
});

test("healthy write rejects every existing target including empty files", async (t) => {
	const cwd = await temporaryDirectory(t);
	for (const [name, content] of [["empty.txt", ""], ["bom.txt", "\ufeff"], ["content.txt", "old"]] as const) {
		const target = path.join(cwd, name);
		await writeFile(target, content, "utf8");
		await assert.rejects(() => guardedCreateFile({ path: name, content: "new" }, cwd, undefined, new SnapshotLedger()), /only creates missing files/);
		assert.equal(await readFile(target, "utf8"), content);
	}
});

test("nested creation revalidates the canonical parent", async (t) => {
	const cwd = await temporaryDirectory(t);
	await guardedCreateFile({ path: "nested/deeper/new.txt", content: "created" }, cwd, undefined, new SnapshotLedger());
	assert.equal(await readFile(path.join(cwd, "nested", "deeper", "new.txt"), "utf8"), "created");
});

test("aborted creation writes nothing", async (t) => {
	const cwd = await temporaryDirectory(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => guardedCreateFile({ path: "aborted.txt", content: "no" }, cwd, controller.signal, new SnapshotLedger()), /aborted/);
	assert.equal(await doesNotExist(path.join(cwd, "aborted.txt")), true);
});

test("concurrent creates serialize and exactly one wins", async (t) => {
	const cwd = await temporaryDirectory(t);
	const writes = await Promise.allSettled([
		guardedCreateFile({ path: "race.txt", content: "first" }, cwd, undefined, new SnapshotLedger()),
		guardedCreateFile({ path: "race.txt", content: "second" }, cwd, undefined, new SnapshotLedger()),
	]);
	assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
	assert.ok(["first", "second"].includes(await readFile(path.join(cwd, "race.txt"), "utf8")));
});

test("dangling symlink entries are not treated as creatable paths", { skip: process.platform === "win32" }, async (t) => {
	const cwd = await temporaryDirectory(t);
	await symlink(path.join(cwd, "missing-target"), path.join(cwd, "dangling.txt"));
	await assert.rejects(() => guardedCreateFile({ path: "dangling.txt", content: "no" }, cwd, undefined, new SnapshotLedger()), /only creates missing files/);
});
