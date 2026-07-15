import assert from "node:assert/strict";
import test from "node:test";

import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderStandaloneDiff } from "../src/diff-renderer.ts";
import { renderFileChangesResult, renderHleditCall, renderReadAnchorsResult, type RenderTheme } from "../src/render.ts";
import type { TextResult } from "../src/result.ts";

const theme: RenderTheme = {
	fg: (_name, text) => text,
	bold: (text) => text,
};

const coloredTheme: RenderTheme = {
	fg: (_name, text) => text,
	bold: (text) => text,
	getBgAnsi: () => "\x1b[48;2;40;50;40m",
	getFgAnsi: (name) => name === "toolDiffAdded" ? "\x1b[38;2;100;200;120m" : "\x1b[38;2;220;90;100m",
};

function options(expanded = false): ToolRenderResultOptions {
	return { expanded, isPartial: false } as ToolRenderResultOptions;
}

function render(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width);
}

test("renderHleditCall includes read range and grep", () => {
	assert.deepEqual(render(renderHleditCall("read_anchors", { path: "src/a.ts", offset: 3, limit: 5, grep: "token" }, theme)), [
		'read anchors src/a.ts:3-7 contains "token"',
	]);
});

test("renderHleditCall includes changed range and operation count", () => {
	assert.deepEqual(
		render(renderHleditCall("apply_file_changes", { path: "src/a.ts", changes: [{ anchor: "4#AA", end_anchor: "6#BB" }] }, theme)),
		["apply changes src/a.ts:4-6 (1 operation)"],
	);
});

test("renderReadAnchorsResult shows a structured collapsed preview", () => {
	const text = Array.from({ length: 14 }, (_, index) => `${index + 1}#AA:line ${index + 1}`).join("\n");
	const result: TextResult = { content: [{ type: "text", text }], details: { disposition: "succeeded" } };
	const output = render(renderReadAnchorsResult(result, options(), theme, { args: { path: "notes.txt" } }), 80);

	assert.equal(output[0], "↳ 14 anchored lines • 1-14");
	assert.equal(output[2], " 1#AA │ line 1");
	assert.ok(output.some((line) => line.includes("2 more anchored lines")));
	assert.ok(output.every((line) => visibleWidth(line) <= 80));
});

test("renderReadAnchorsResult expands all anchors and reports backend truncation", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "8#AA:first\n9#BB:second\n-- truncated: use read-range --offset 10 --" }],
		details: { disposition: "succeeded" },
	};
	const output = render(renderReadAnchorsResult(result, options(true), theme, { args: { path: "notes.txt" } }), 80);

	assert.equal(output[0], "↳ 2 anchored lines • 8-9 • truncated");
	assert.ok(output.includes("8#AA │ first"));
	assert.ok(output.some((line) => line.includes("use read-range")));
});

test("renderReadAnchorsResult caches its final width and invalidates highlighted output", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "1#AA:const alpha = 1;\n2#BB:const beta = alpha + 1;" }],
		details: { disposition: "succeeded" },
	};
	const component = renderReadAnchorsResult(result, options(), theme, { args: { path: "sample.ts" } });
	const first = component.render(80);

	assert.strictEqual(component.render(80), first);
	component.invalidate();
	const refreshed = component.render(80);
	assert.notStrictEqual(refreshed, first);
	assert.deepEqual(refreshed, first);
	assert.ok(refreshed.every((line) => visibleWidth(line) <= 80));
});

test("renderFileChangesResult renders an adaptive unified diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			diff: " 1 alpha\n-2 beta\n+2 BETA\n+3 gamma",
			editsApplied: 1,
		},
	};
	const output = render(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }), 72);

	assert.equal(output[0], "↳ diff +2 -1 • 1 hunk • unified");
	assert.ok(output.some((line) => line.includes("▌") && line.includes("beta")));
	assert.ok(output.some((line) => line.includes("▌") && line.includes("BETA")));
	assert.ok(output.every((line) => visibleWidth(line) <= 72));
});

test("renderFileChangesResult switches to split layout on wide terminals", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const output = render(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }), 120);

	assert.equal(output[0], "↳ diff +1 -1 • 1 hunk • split");
	assert.ok(output.some((line) => line.includes("old") && line.includes("new")));
	assert.ok(output.some((line) => line.includes("beta") && line.includes("BETA")));
	assert.ok(output.every((line) => visibleWidth(line) <= 120));
});

test("renderFileChangesResult reflows the same component when width crosses the breakpoint", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } });

	assert.equal(render(component, 120)[0], "↳ diff +1 -1 • 1 hunk • split");
	assert.equal(render(component, 119)[0], "↳ diff +1 -1 • 1 hunk • unified");
});

test("standalone diff caches an unchanged width and invalidates theme-dependent output", () => {
	const component = renderStandaloneDiff("-2 beta\n+2 BETA", "notes.txt", false, theme);
	assert.ok(component);
	const first = component.render(72);

	assert.strictEqual(component.render(72), first);
	component.invalidate();
	const refreshed = component.render(72);
	assert.notStrictEqual(refreshed, first);
	assert.deepEqual(refreshed, first);
});

test("default Pi tool box preserves responsive reflow", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const box = new Box(1, 1);
	box.addChild(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }));

	assert.ok(box.render(122).some((line) => line.includes("• split")));
	assert.ok(box.render(121).some((line) => line.includes("• unified")));
});

test("renderFileChangesResult gives added and removed code rows distinct tinted backgrounds", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const output = render(renderFileChangesResult(result, options(), coloredTheme, { args: { path: "notes.txt" } }), 72);
	const removedLine = output.find((line) => line.includes("beta"));
	const addedLine = output.find((line) => line.includes("BETA"));
	const backgroundPattern = /^\x1b\[48;2;\d+;\d+;\d+m/;

	assert.match(removedLine ?? "", backgroundPattern);
	assert.match(addedLine ?? "", backgroundPattern);
	assert.notEqual(backgroundPattern.exec(removedLine ?? "")?.[0], backgroundPattern.exec(addedLine ?? "")?.[0]);
	assert.ok(output.every((line) => visibleWidth(line) <= 72));
});

test("renderFileChangesResult caches expanded anchors without mutating the diff result", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied.\n\nUpdated anchors:\n2#ZZ:BETA" }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const component = renderFileChangesResult(result, options(true), theme, { args: { path: "notes.txt" } });
	const first = component.render(72);

	assert.strictEqual(component.render(72), first);
	assert.equal(first.filter((line) => line.includes("updated anchors")).length, 1);
	assert.ok(first.includes("2#ZZ │ BETA"));
	assert.ok(first.every((line) => visibleWidth(line) <= 72));

	component.invalidate();
	const refreshed = component.render(72);
	assert.notStrictEqual(refreshed, first);
	assert.deepEqual(refreshed, first);
});

test("renderFileChangesResult folds failures unless expanded", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes were not applied.\nError: stale\nCurrent anchor hints:\n- 2#AA -> 2#BB" }],
		details: { disposition: "rejected" },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), ["× Changes were not applied. stale"]);
	assert.ok(render(renderFileChangesResult(result, options(true), theme, {})).some((line) => line.includes("2#AA -> 2#BB")));
});

test("renderFileChangesResult summarizes success without a diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", editsApplied: 2, firstChangedLine: 4, lastChangedLine: 5, linesAdded: 3, linesDeleted: 1 },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), ["✓ 2 changes applied • lines 4-5 +3 -1"]);
});
