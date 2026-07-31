import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
	CanonicalPathError,
	canonicalKeyFromPath,
	normalizeToolPath,
	resolveCanonicalTarget,
	sameCanonicalTarget,
} from "../src/canonical-path.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "snapline-path-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("existing targets bind to real paths and normalize leading @", async (t) => {
	const cwd = await temporaryDirectory(t);
	await writeFile(path.join(cwd, "file.txt"), "text", "utf8");
	const target = await resolveCanonicalTarget(cwd, "@file.txt");
	assert.equal(target.exists, true);
	assert.equal(target.canonicalTargetPath, await realpath(path.join(cwd, "file.txt")));
	assert.equal(target.canonicalFileKey, canonicalKeyFromPath(target.canonicalTargetPath));
	assert.equal(normalizeToolPath("@file.txt"), "file.txt");
});

test("missing targets derive identity through the nearest real ancestor", async (t) => {
	const cwd = await temporaryDirectory(t);
	await mkdir(path.join(cwd, "existing"));
	const first = await resolveCanonicalTarget(cwd, "existing/new/deep.txt");
	const second = await resolveCanonicalTarget(cwd, path.join(cwd, "existing", "new", "deep.txt"));
	assert.equal(first.exists, false);
	assert.equal(sameCanonicalTarget(first, second), true);
});

test("symlink aliases resolve to one canonical identity", { skip: process.platform === "win32" }, async (t) => {
	const cwd = await temporaryDirectory(t);
	await mkdir(path.join(cwd, "real"));
	await writeFile(path.join(cwd, "real", "file.txt"), "text", "utf8");
	await symlink(path.join(cwd, "real"), path.join(cwd, "alias"), "dir");
	const realTarget = await resolveCanonicalTarget(cwd, "real/file.txt");
	const aliasTarget = await resolveCanonicalTarget(cwd, "alias/file.txt");
	assert.equal(sameCanonicalTarget(realTarget, aliasTarget), true);
});

test("empty and NUL paths fail before filesystem access", async () => {
	for (const suppliedPath of ["", "\0bad"]) {
		await assert.rejects(
			() => resolveCanonicalTarget(process.cwd(), suppliedPath),
			(error: unknown) => error instanceof CanonicalPathError && error.code === "invalid_path",
		);
	}
});

test("Windows canonical keys normalize case and separators", { skip: process.platform !== "win32" }, () => {
	assert.equal(canonicalKeyFromPath("C:\\Temp\\File.txt"), "c:/temp/file.txt");
	assert.equal(normalizeToolPath("/c/Temp/File.txt"), "c:/Temp/File.txt");
});
