import assert from "node:assert/strict";
import test from "node:test";

import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
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

test("renderHleditCall hyperlinks paths when the terminal supports them", () => {
    const previous = getCapabilities();
    setCapabilities({ ...previous, hyperlinks: true });
    try {
        const output = render(renderHleditCall("read_anchors", { path: "src/a.ts", offset: 1, limit: 2 }, theme, { cwd: process.cwd() }));
        assert.match(output[0] ?? "", /\x1b\]8;;file:/);
        assert.match(output[0] ?? "", /src\/a\.ts/);
    } finally {
        setCapabilities(previous);
    }
});

test("renderHleditCall includes changed range and operation count", () => {
	assert.deepEqual(
		render(renderHleditCall("apply_file_changes", { path: "src/a.ts", changes: [{ anchor: "4#AA", end_anchor: "6#BB" }] }, theme)),
		["apply changes src/a.ts:4-6 (1 operation)"],
	);
});

test("renderReadAnchorsResult shows actual range, total lines, and EOF", () => {
    const lines = Array.from({ length: 14 }, (_, index) => ({
        line: index + 1,
        anchor: `${index + 1}#AA`,
        text: `line ${index + 1}`,
        textTruncated: false,
    }));
    const result: TextResult = {
        content: [{ type: "text", text: lines.map((line) => `${line.anchor}:${line.text}`).join("\n") }],
        details: {
            disposition: "succeeded",
            read: {
                path: "notes.txt",
                requested: { offset: 1, limit: 20 },
                actual: { firstLine: 1, lastLine: 14, lineCount: 14, totalLines: 14 },
                lines,
                truncated: false,
                textTruncated: false,
                eof: true,
            },
        },
    };
    const output = render(renderReadAnchorsResult(result, options(), theme, { args: { path: "notes.txt" } }), 80);

    assert.equal(output[0], "↳ 14 anchored lines • 1-14 of 14 • EOF");
    assert.equal(output[2], " 1#AA │ line 1");
    assert.ok(output.some((line) => line.includes("2 more anchored lines")));
    assert.ok(output.every((line) => visibleWidth(line) <= 80));
});

test("renderReadAnchorsResult expands structured continuation details", () => {
    const lines = [
        { line: 8, anchor: "8#AA", text: "first", textTruncated: false },
        { line: 9, anchor: "9#BB", text: "second", textTruncated: false },
    ];
    const result: TextResult = {
        content: [{ type: "text", text: "8#AA:first\n9#BB:second\n-- showing lines 8-9 of 20; use offset 10 to continue --" }],
        details: {
            disposition: "succeeded",
            read: {
                path: "notes.txt",
                requested: { offset: 8, limit: 2 },
                actual: { firstLine: 8, lastLine: 9, lineCount: 2, totalLines: 20 },
                lines,
                truncated: true,
                nextOffset: 10,
                textTruncated: false,
                eof: false,
            },
        },
    };
    const output = render(renderReadAnchorsResult(result, options(true), theme, { args: { path: "notes.txt" } }), 80);

    assert.equal(output[0], "↳ 2 anchored lines • 8-9 of 20 • next 10");
    assert.ok(output.includes("8#AA │ first"));
    assert.ok(output.some((line) => line.includes("continue with offset 10")));
});

test("renderReadAnchorsResult folds structured errors to the actionable message", () => {
    const result: TextResult = {
        content: [{ type: "text", text: "offset 600 exceeds file length 599\nHint: Use an offset between 1 and 599.\nError: range" }],
        details: {
            disposition: "rejected",
            error: {
                code: "range",
                message: "offset 600 exceeds file length 599",
                hint: "Use an offset between 1 and 599.",
                requestedOffset: 600,
                totalLines: 599,
            },
        },
    };

    assert.deepEqual(render(renderReadAnchorsResult(result, options(), theme, { isError: true })), ["× offset 600 exceeds file length 599"]);
    assert.ok(render(renderReadAnchorsResult(result, options(true), theme, { isError: true })).some((line) => line.includes("Use an offset between 1 and 599")));
});

test("renderReadAnchorsResult caches its final width and invalidates highlighted output", () => {
    const lines = [
        { line: 1, anchor: "1#AA", text: "const alpha = 1;", textTruncated: false },
        { line: 2, anchor: "2#BB", text: "const beta = alpha + 1;", textTruncated: false },
    ];
    const result: TextResult = {
        content: [{ type: "text", text: lines.map((line) => `${line.anchor}:${line.text}`).join("\n") }],
        details: {
            disposition: "succeeded",
            read: {
                path: "sample.ts",
                requested: { offset: 1, limit: 2 },
                actual: { firstLine: 1, lastLine: 2, lineCount: 2, totalLines: 2 },
                lines,
                truncated: false,
                textTruncated: false,
                eof: true,
            },
        },
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

test("renderFileChangesResult shows a diff warning without a diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied, but the diff is unavailable." }],
		details: { disposition: "succeeded", editsApplied: 1, diffError: "unable to reread target.txt" },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), [
		"✓ 1 change applied",
		"Diff warning: unable to reread target.txt",
	]);
});
