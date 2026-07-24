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
	assert.deepEqual(render(renderHleditCall("read_anchors", { path: "src/a.ts", offset: 3, limit: 5, grep: "token", context: 2 }, theme)), [
		'read for edit src/a.ts 包含 "token"（上下文 ±2 行；从第 3 行开始；最多 5 行）',
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
		render(renderHleditCall("apply_file_changes", { path: "src/a.ts", changes: [{ anchor: "4#AAB", end_anchor: "6#BBK" }] }, theme)),
		["apply changes src/a.ts:4-6（1 项操作）"],
	);
});

test("renderHleditCall preserves separate ranges for multiple operations", () => {
	assert.deepEqual(
		render(
			renderHleditCall(
				"apply_file_changes",
				{ path: "src/a.ts", changes: [{ anchor: "482#AAB" }, { anchor: "484#BBK", end_anchor: "489#CCL" }] },
				theme,
			),
		),
		["apply changes src/a.ts:482,484-489（2 项操作）"],
	);
});

test("renderReadAnchorsResult shows actual range, total lines, and EOF", () => {
    const lines = Array.from({ length: 14 }, (_, index) => ({
        line: index + 1,
        anchor: `${index + 1}#AAB`,
        text: `line ${index + 1}`,
        textTruncated: false,
    }));
    const result: TextResult = {
        content: [{ type: "text", text: lines.map((line) => `${line.anchor}:${line.text}`).join("\n") }],
        details: {
            disposition: "succeeded",
            read: {
                path: "notes.txt",
				revision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
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

    assert.equal(output[0], "↳ 14 行锚点 • 第 1-14 行 / 共 14 行 • 已到文件末尾");
    assert.equal(output[2], " 1#AAB │ line 1");
    assert.ok(output.some((line) => line.includes("还有 2 行锚点")));
    assert.ok(output.every((line) => visibleWidth(line) <= 80));
});

test("renderReadAnchorsResult expands structured continuation details", () => {
    const lines = [
        { line: 8, anchor: "8#AAB", text: "first", textTruncated: false },
        { line: 9, anchor: "9#BBK", text: "second", textTruncated: false },
    ];
    const result: TextResult = {
        content: [{ type: "text", text: "8#AAB:first\n9#BBK:second\n-- showing lines 8-9 of 20; use offset 10 to continue --" }],
        details: {
            disposition: "succeeded",
            read: {
                path: "notes.txt",
				revision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
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

    assert.equal(output[0], "↳ 2 行锚点 • 第 8-9 行 / 共 20 行 • 下一页从第 10 行开始");
    assert.ok(output.includes("8#AAB │ first"));
    assert.ok(output.some((line) => line.includes("继续读取请使用 offset 10")));
});

test("renderReadAnchorsResult folds structured errors to the actionable message", () => {
    const result: TextResult = {
        content: [{ type: "text", text: "起始行 600 超出文件范围（文件共 599 行）。\n建议：请将 offset 设为 1 到 599 之间的整数。\n错误代码：range" }],
        details: {
            disposition: "rejected",
            error: {
                code: "range",
                message: "起始行 600 超出文件范围（文件共 599 行）。",
				rawMessage: "offset 600 exceeds file length 599",
                hint: "请将 offset 设为 1 到 599 之间的整数。",
                requestedOffset: 600,
                totalLines: 599,
            },
        },
    };

    assert.deepEqual(render(renderReadAnchorsResult(result, options(), theme, { isError: true })), ["× 起始行 600 超出文件范围（文件共 599 行）。"]);
    assert.ok(render(renderReadAnchorsResult(result, options(true), theme, { isError: true })).some((line) => line.includes("请将 offset 设为 1 到 599")));
});

test("renderReadAnchorsResult caches its final width and invalidates highlighted output", () => {
    const lines = [
        { line: 1, anchor: "1#AAB", text: "const alpha = 1;", textTruncated: false },
        { line: 2, anchor: "2#BBK", text: "const beta = alpha + 1;", textTruncated: false },
    ];
    const result: TextResult = {
        content: [{ type: "text", text: lines.map((line) => `${line.anchor}:${line.text}`).join("\n") }],
        details: {
            disposition: "succeeded",
            read: {
                path: "sample.ts",
				revision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
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

	assert.equal(output[0], "↳ 差异 +2 -1 • 1 个变更块 • 统一");
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

	assert.equal(output[0], "↳ 差异 +1 -1 • 1 个变更块 • 双栏");
	assert.ok(output.some((line) => line.includes("修改前") && line.includes("修改后")));
	assert.ok(output.some((line) => line.includes("beta") && line.includes("BETA")));
	assert.ok(output.every((line) => visibleWidth(line) <= 120));
});

test("renderFileChangesResult reflows the same component when width crosses the breakpoint", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } });

	assert.equal(render(component, 120)[0], "↳ 差异 +1 -1 • 1 个变更块 • 双栏");
	assert.equal(render(component, 119)[0], "↳ 差异 +1 -1 • 1 个变更块 • 统一");
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

	assert.ok(box.render(122).some((line) => line.includes("• 双栏")));
	assert.ok(box.render(121).some((line) => line.includes("• 统一")));
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
		content: [{ type: "text", text: "修改已应用。\n\n更新后的锚点：\n2#ZZZ:BETA" }],
		details: { disposition: "succeeded", diff: "-2 beta\n+2 BETA", editsApplied: 1 },
	};
	const component = renderFileChangesResult(result, options(true), theme, { args: { path: "notes.txt" } });
	const first = component.render(72);

	assert.strictEqual(component.render(72), first);
	assert.equal(first.filter((line) => line.includes("更新后的锚点")).length, 1);
	assert.ok(first.includes("2#ZZZ │ BETA"));
	assert.ok(first.every((line) => visibleWidth(line) <= 72));

	component.invalidate();
	const refreshed = component.render(72);
	assert.notStrictEqual(refreshed, first);
	assert.deepEqual(refreshed, first);
});

test("renderFileChangesResult folds failures unless expanded", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "原子批次已拒绝，未写入任何内容。\n原因：目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。\n错误代码：io" }],
		details: {
			disposition: "rejected",
			error: { code: "io", message: "目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。" },
		},
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), ["× 目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。"]);
	assert.ok(render(renderFileChangesResult(result, options(true), theme, {})).some((line) => line.includes("错误代码：io")));
});

test("renderFileChangesResult folds single-line range failures to the corrective action", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "原子批次已拒绝，未写入任何内容。\n第 1 项修改被拒绝。\n禁止使用相同参数重试。" }],
		details: {
			disposition: "rejected",
			error: {
				code: "single_line_range_expansion",
				message: "第 1 项 replace_range 仅覆盖一行且重复原行；请扩大 end_anchor 或改用 insert_after，禁止原样重试。",
				hint: "replace_range 必须完整覆盖待替换旧代码。",
			},
		},
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), [
		"× 第 1 项 replace_range 仅覆盖一行且重复原行；请扩大 end_anchor 或改用 insert_after，禁止原样重试。",
	]);
	assert.ok(render(renderFileChangesResult(result, options(true), theme, {})).some((line) => line.includes("禁止使用相同参数重试")));
});

test("renderFileChangesResult summarizes success without a diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", editsApplied: 2, firstChangedLine: 4, lastChangedLine: 5, linesAdded: 3, linesDeleted: 1 },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), ["✓ 已应用 2 项修改 • 第 4-5 行 +3 -1"]);
});

test("renderFileChangesResult identifies a no-op", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "No changes were needed." }],
		details: { disposition: "succeeded", editsApplied: 1, contentChanged: false, firstChangedLine: 4, lastChangedLine: 4, linesAdded: 1, linesDeleted: 1 },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), ["✓ 无需修改 • 已检查 1 项操作"]);
});

test("renderFileChangesResult shows a diff warning without a diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "修改已应用，但无法生成差异。" }],
		details: { disposition: "succeeded", editsApplied: 1, diffError: "修改已应用，但无法重新读取 target.txt 以生成差异。" },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), [
		"✓ 已应用 1 项修改",
		"差异警告：修改已应用，但无法重新读取 target.txt 以生成差异。",
	]);
});

test("renderFileChangesResult shows a durability warning", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", editsApplied: 1, warnings: ["文件内容已成功替换，但目录元数据未能同步；断电等极端场景下，持久性保证可能降低。"] },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), [
		"✓ 已应用 1 项修改",
		"写入警告：文件内容已成功替换，但目录元数据未能同步；断电等极端场景下，持久性保证可能降低。",
	]);
});
