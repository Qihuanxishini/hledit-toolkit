import assert from "node:assert/strict";
import test from "node:test";

import { Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, Box, getCapabilities, parseColor, setCapabilities, visibleWidth, type TerminalColorMode } from "@earendil-works/pi-tui";
import { renderStandaloneDiff, type StructuredDiffLine } from "../src/diff-renderer.ts";
import { renderFileChangesResult, renderHleditCall, renderReadAnchorsResult, type RenderTheme } from "../src/render.ts";
import type { TextResult } from "../src/result.ts";

function createNativeTheme(mode: TerminalColorMode, background = "", appearance: "dark" | "light" = "dark"): Theme {
	return new Theme({
		text: "", toolOutput: "", muted: 8, dim: 8, warning: 3, thinkingXhigh: 5,
		accent: 4, error: 1, success: 2, toolTitle: "",
		toolDiffAdded: "#64c878", toolDiffRemoved: "#dc5a64",
	} as ConstructorParameters<typeof Theme>[0], {
		toolSuccessBg: background, selectedBg: "",
	} as ConstructorParameters<typeof Theme>[1], mode, { appearance });
}

const coloredTheme = createNativeTheme("truecolor", "#283228");
const theme: RenderTheme = {
	fg: (_name, text) => text,
	bold: (text) => text,
	appearance: "dark",
	getColorMode: () => "truecolor",
	style: (text) => text,
	getBgAnsi: () => "",
};

function options(expanded = false): ToolRenderResultOptions {
	return { expanded, isPartial: false } as ToolRenderResultOptions;
}

function render(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width);
}

test("diff hides operation separators but retains omitted content markers", () => {
	const output = renderStandaloneDiff("+2 inserted\n\n-2 old\n+3 new\n   ...\n-9 distant", "notes.txt", false, theme)!.render(72);
	const inserted = output.findIndex((line) => line.includes("inserted"));
	assert.match(output[inserted + 1]!, /old/);
	assert.equal(output.filter((line) => line.includes("⋮")).length, 1);
	assert.ok(output.some((line) => line.includes("distant")));
});

const replacementPreview: { truncated: boolean; lines: StructuredDiffLine[] } = {
	truncated: false,
	lines: [
		{ kind: "remove", oldLine: 2, text: "beta", changeIndex: 0 },
		{ kind: "add", newLine: 2, text: "BETA", changeIndex: 0 },
	],
};

for (const mode of ["truecolor", "256color"] as const) {
	for (const appearance of ["dark", "light"] as const) {
		test(`diff preserves tinted fills and normal-weight stripes (${appearance}, ${mode})`, () => {
			const light = appearance === "light";
			const addedBg = mode === "256color" ? `\x1b[48;5;${light ? 194 : 22}m` : light ? "\x1b[48;2;218;251;225m" : "\x1b[48;2;53;67;48m";
			const removedBg = mode === "256color" ? `\x1b[48;5;${light ? 224 : 52}m` : light ? "\x1b[48;2;255;235;233m" : "\x1b[48;2;62;56;49m";
			const baseBg = backgroundAnsi(parseColor("#283228"), mode);
			// [喵喵喵]: 绿色成功背景曾把删除行混成黄绿；同时覆盖终端默认色和有色容器。
			for (const background of ["", light ? "#fafafa" : "#283228", "#282828"]) {
				const nativeTheme = createNativeTheme(mode, background, appearance);
				const containerBg = nativeTheme.getBgAnsi("toolSuccessBg");
				const addedGutter = nativeTheme.style("▎ +  2", { fg: parseColor(light ? "#116329" : "#B5BD68") });
				const removedGutter = nativeTheme.style("▎ -  2", { fg: parseColor(light ? "#82071E" : "#CC6666") });
				const component = renderStandaloneDiff(" 1 context\n-2 beta\n+2 BETA\n   ...\n+9 tail", "notes.txt", false, nativeTheme, undefined, [
					{ kind: "context", oldLine: 1, newLine: 1, text: "context" },
					...replacementPreview.lines,
					{ kind: "add", newLine: 9, text: "tail", changeIndex: 1 },
				])!;
				for (const width of [72, 160]) {
					const output = component.render(width);
					assert.ok(output.some((line) => line.includes(addedBg) && line.includes(addedGutter) && line.includes("BETA")));
					assert.ok(output.some((line) => line.includes(removedBg) && line.includes(removedGutter) && line.includes("beta")));
					assert.ok(output.every((line) => visibleWidth(line) === width));
					if (mode === "256color") assert.doesNotMatch(output.join("\n"), /\x1b\[(?:38|48);2;/);
					const context = output.find((line) => line.includes("context"))!;
					// [喵喵喵]: 未改动区域固定为工具绿色，不受宿主主题底色变化影响。
					assert.ok(context.startsWith(baseBg));
					assert.ok(output.some((line) => line.includes("⋮") && line.startsWith(baseBg)));
					if (width === 160) assert.ok(output.some((line) => line.includes("tail") && line.startsWith(baseBg)));
					const changedRows = output.filter((line) => line.includes("beta") || line.includes("BETA"));
					assert.ok(changedRows.every((line) => line.endsWith(containerBg)));
					assert.ok(changedRows.every((line) => !line.includes("\x1b[1m")));
				}
			}
		});
	}
}

test("diff invalidation refreshes native theme colors", () => {
	let activeTheme = createNativeTheme("truecolor", "#101010");
	const switchingTheme: RenderTheme = {
		...theme,
		get appearance() { return activeTheme.appearance; },
		getColorMode: () => activeTheme.getColorMode(),
		style: (text, options) => activeTheme.style(text, options),
		getBgAnsi: (name) => activeTheme.getBgAnsi(name),
	};
	const component = renderStandaloneDiff("-2 beta\n+2 BETA", "notes.txt", false, switchingTheme)!;
	const first = component.render(72);
	activeTheme = createNativeTheme("256color", "#fafafa", "light");
	component.invalidate();
	const refreshed = component.render(72);
	assert.notDeepEqual(refreshed, first);
	const addedBg = backgroundAnsi(parseColor(194), "256color");
	assert.ok(refreshed.some((line) => line.startsWith(addedBg) && line.includes("BETA")));
});
test("renderHleditCall includes search range and pattern", () => {
	assert.deepEqual(render(renderHleditCall("search_anchors", { path: "src/a.ts", offset: 3, limit: 5, pattern: "token", context: 2 }, theme)), [
		'search anchors src/a.ts 匹配 "token"（正则匹配；上下文 ±2 行；从第 3 行开始；最多 5 行）',
	]);
});


test("renderHleditCall labels literal and case-insensitive search", () => {
	assert.deepEqual(render(renderHleditCall("search_anchors", { path: "src/a.ts", pattern: "Token", literal: true, ignore_case: true }, theme)), [
		'search anchors src/a.ts 包含 "Token"（字面匹配；忽略大小写）',
	]);
});

// [喵喵喵]: Phase 2.4 回归——limit 省略时实际 CLI 请求默认 160 行，标题不得显示 1-2000 (2026-07-25)
test("renderHleditCall shows the actual 160-line default range when limit is omitted", () => {
	assert.deepEqual(render(renderHleditCall("read_anchors", { path: "src/a.ts" }, theme)), [
		"read for edit src/a.ts:1-160",
	]);
	assert.deepEqual(render(renderHleditCall("read_anchors", { path: "src/a.ts", offset: 41 }, theme)), [
		"read for edit src/a.ts:41-200",
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

for (const text of ["x".repeat(30_000), "字🙂e\u0301".repeat(2_000)]) {
	test(`collapsed anchor preview bounds wrapped rows (${text.length} characters)`, () => {
		const result: TextResult = {
			content: [{ type: "text", text: `proof_id: test1\n1#AAB:${text}` }],
			details: {
				disposition: "succeeded", proofId: "test1",
				read: {
					path: "sample.txt", revision: `sha256:${"a".repeat(64)}`,
					requested: { offset: 1, limit: 1 },
					actual: { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 1 },
					lines: [{ line: 1, anchor: "1#AAB", text, textTruncated: false }],
					truncated: false, textTruncated: false, eof: true,
				},
			},
		};
		const snapshot = JSON.stringify(result);
		const collapsed = renderReadAnchorsResult(result, options(), theme, { args: { path: "sample.txt" } });
		for (const width of [18, 40, 100]) {
			const output = collapsed.render(width);
			assert.equal(output.length, 16);
			assert.ok(output.every((line) => visibleWidth(line) <= width));
			assert.ok(output.some((line) => line.includes("预览已折叠")));
			assert.strictEqual(collapsed.render(width), output);
		}
		const expanded = render(renderReadAnchorsResult(result, options(true), theme, { args: { path: "sample.txt" } }), 100);
		assert.ok(expanded.length > 16);
		assert.equal(expanded.slice(2).map((line) => line.slice(line.indexOf(" │ ") + 3)).join(""), text);
		assert.equal(JSON.stringify(result), snapshot);
	});
}

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

    assert.deepEqual(render(renderReadAnchorsResult(result, options(), theme, { isError: true })), ["× 未写入 · 起始行 600 超出文件范围（文件共 599 行）。"]);
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

test("renderFileChangesResult renders a unified diff", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			changePreview: {
				truncated: false,
				lines: [
					{ kind: "context", oldLine: 1, newLine: 1, text: "alpha" },
					...replacementPreview.lines,
					{ kind: "add", newLine: 3, text: "gamma", changeIndex: 0 },
				],
			},
			editsApplied: 1,
		},
	};
	const output = render(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }), 72);

	assert.equal(output[0]!.trimEnd(), "↳ 差异 +2 -1 • 1 个变更块");
	assert.ok(output.some((line) => /^▎ -\s+2\s+│/.test(line) && line.includes("beta")));
	assert.ok(output.some((line) => /^▎ \+\s+2\s+│/.test(line) && line.includes("BETA")));
	assert.ok(output.every((line) => visibleWidth(line) <= 72));
});

// [喵喵喵]: 相同文本的删除/新增仍是普通编辑；旧、新行号必须在不同宽度下清晰可见。
test("renderFileChangesResult keeps old and new line numbers visible when changed text is identical", () => {
	const text = "const value = 1;";
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			changePreview: {
				truncated: false,
				lines: [
					{ kind: "remove", oldLine: 30, text, changeIndex: 0 },
					{ kind: "add", newLine: 50, text, changeIndex: 1 },
				],
			},
			editsApplied: 2,
		},
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "sample.ts" } });

	const unifiedRows = render(component, 80).filter((line) => line.includes(text));
	assert.equal(unifiedRows.length, 2);
	assert.match(unifiedRows[0] ?? "", /^▎ -\s+30\s+│/);
	assert.match(unifiedRows[1] ?? "", /^▎ \+\s+50\s+│/);

	const wideRows = render(component, 160).filter((line) => line.includes(text));
	assert.equal(wideRows.length, 2);
	assert.match(wideRows[0]!, /^▎ -\s+30\s+│ const value = 1;\s+│\s*$/);
	assert.match(wideRows[1]!, /^\s+│ ▎ \+\s+50\s+│ const value = 1;/);

	const coloredRows = render(
		renderFileChangesResult(result, options(), coloredTheme, { args: { path: "sample.ts" } }),
		80,
	).filter((line) => line.includes(text));
	const backgroundPattern = /^\x1b\[48;2;\d+;\d+;\d+m/;
	assert.equal(coloredRows.length, 2);
	assert.notEqual(backgroundPattern.exec(coloredRows[0] ?? "")?.[0], backgroundPattern.exec(coloredRows[1] ?? "")?.[0]);
});

test("renderFileChangesResult keeps separate operations in source order even when their text matches", () => {
	const text = "same text";
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			changePreview: {
				truncated: false,
				lines: [
					{ kind: "remove", oldLine: 2, text, changeIndex: 0 },
					{ kind: "remove", oldLine: 3, text: "delete only", changeIndex: 0 },
					{ kind: "add", newLine: 3, text, changeIndex: 1 },
					{ kind: "add", newLine: 4, text: "add only", changeIndex: 1 },
				],
			},
			editsApplied: 2,
		},
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "sample.ts" } });

	const unifiedRows = render(component, 80).filter((line) => line.includes(text) || line.includes("delete only") || line.includes("add only"));
	assert.equal(unifiedRows.length, 4);
	assert.match(unifiedRows[0] ?? "", /^▎ -\s+2\s+│/);
	assert.match(unifiedRows[1] ?? "", /^▎ -\s+3\s+│/);
	assert.match(unifiedRows[2] ?? "", /^▎ \+\s+3\s+│/);
	assert.match(unifiedRows[3] ?? "", /^▎ \+\s+4\s+│/);

	const wideRows = render(component, 160).filter((line) => line.includes(text) || line.includes("delete only") || line.includes("add only"));
	assert.equal(wideRows.length, 4);
	assert.match(wideRows[0]!, /^▎ -\s+2\s+│ same text\s+│\s*$/);
	assert.match(wideRows[1]!, /^▎ -\s+3\s+│ delete only\s+│\s*$/);
	assert.match(wideRows[2]!, /^\s+│ ▎ \+\s+3\s+│ same text/);
	assert.match(wideRows[3]!, /^\s+│ ▎ \+\s+4\s+│ add only/);
});

test("unified pairs replacement lines while keeping adjacent operations in source order", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded", editsApplied: 3,
			changePreview: { truncated: false, lines: [
				{ kind: "add", newLine: 2, text: "inserted-line", changeIndex: 2 },
				{ kind: "remove", oldLine: 2, text: "bravo", changeIndex: 0 },
				{ kind: "remove", oldLine: 3, text: "charlie", changeIndex: 0 },
				{ kind: "add", newLine: 3, text: "BRAVO", changeIndex: 0 },
				{ kind: "add", newLine: 4, text: "CHARLIE", changeIndex: 0 },
				{ kind: "remove", oldLine: 4, text: "echo-line", changeIndex: 1 },
			] },
		},
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } });
	for (const width of [40, 120]) {
		const rows = component.render(width).slice(2, -1);
		assert.deepEqual(rows.map((line) => line.split(" │ ")[1]!.trimEnd()), [
			"inserted-line", "bravo", "BRAVO", "charlie", "CHARLIE", "echo-line",
		]);
	}
});
test("renderFileChangesResult switches between paired unified and split layouts", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", changePreview: replacementPreview, editsApplied: 1 },
	};
	const component = renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } });
	for (const width of [40, 80, 139, 140, 141, 200, 80]) {
		const output = render(component, width);
		assert.equal(output[0]!.trimEnd(), "↳ 差异 +1 -1 • 1 个变更块");
		if (width >= 141) {
			assert.match(output[2]!, /^修改前\s+│ 修改后/);
			assert.match(output[3]!, /^▎ -\s+2\s+│ beta\s+│ ▎ \+\s+2\s+│ BETA/);
		} else {
			assert.match(output[2]!, /^▎ -\s+2\s+│ beta/);
			assert.match(output[3]!, /^▎ \+\s+2\s+│ BETA/);
		}
		assert.ok(output.every((line) => visibleWidth(line) <= width));
	}
});

test("unified diff uses full width and preserves wrapped Unicode source", () => {
	const text = "const value = " + "字🙂e\u0301".repeat(12) + ";";
	const component = renderStandaloneDiff(`+100 ${text}`, "notes.txt", true, theme)!;
	for (const width of [40, 80, 119, 120, 200, 40]) {
		const output = component.render(width);
		const rows = output.slice(2, -1);
		assert.ok(output.every((line) => visibleWidth(line) <= width));
		assert.match(rows[0]!, /^▎ \+ 100 │ /);
		assert.ok(rows.slice(1).every((line) => line.startsWith("▎       │ ")));
		assert.equal(rows.map((line) => line.slice(10).trimEnd()).join(""), text);
		if (width >= 119) assert.equal(rows.length, 1);
		else assert.ok(rows.length > 1);
	}
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
		details: { disposition: "succeeded", changePreview: replacementPreview, editsApplied: 1 },
	};
	const box = new Box(1, 1);
	box.addChild(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }));

	for (const width of [82, 142, 143, 202]) {
		const output = box.render(width);
		assert.ok(output.some((line) => line.includes("↳ 差异 +1 -1 • 1 个变更块")));
		assert.ok(output.every((line) => visibleWidth(line) <= width));
		assert.equal(output.some((line) => line.includes("修改前") && line.includes("修改后")), width >= 143);
	}
});

test("renderFileChangesResult gives added and removed code rows distinct tinted backgrounds", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", changePreview: replacementPreview, editsApplied: 1 },
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
		content: [{ type: "text", text: "正文格式与锚点窗口无关。" }],
		details: {
			disposition: "succeeded",
			changePreview: replacementPreview,
			editsApplied: 1,
			updatedAnchorSpans: [{ lines: [{ line: 2, anchor: "2#ZZZ", text: "BETA", textTruncated: false }], offset: 2, limit: 1, desiredLimit: 1, truncated: false }],
		},
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

test("renderFileChangesResult keeps updated anchors whose hash contains URL-safe symbols", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			changePreview: { truncated: false, lines: [{ kind: "remove", oldLine: 7, text: "old" }, { kind: "add", newLine: 7, text: "gamma" }] },
			editsApplied: 1,
			updatedAnchorSpans: [{
				lines: [
					{ line: 7, anchor: "7#a-_", text: "gamma", textTruncated: false },
					{ line: 8, anchor: "8#_x-", text: "delta", textTruncated: false },
				],
				offset: 7,
				limit: 2,
				desiredLimit: 2,
				truncated: false,
			}],
		},
	};
	const output = render(renderFileChangesResult(result, options(true), theme, { args: { path: "notes.txt" } }), 72);

	assert.ok(output.includes("7#a-_ │ gamma"));
	assert.ok(output.includes("8#_x- │ delta"));
});


test("renderFileChangesResult shows structured updated anchors even when no diff is available", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied without a preview." }],
		details: {
			disposition: "succeeded",
			editsApplied: 1,
			linesAdded: 1,
			linesDeleted: 1,
			updatedAnchorSpans: [{
				lines: [{ line: 3, anchor: "3#ABC", text: "current", textTruncated: false }],
				offset: 3,
				limit: 1,
				desiredLimit: 1,
				truncated: false,
			}],
		},
	};
	const output = render(renderFileChangesResult(result, options(true), theme, { args: { path: "notes.txt" } }), 72);

	assert.ok(output.includes("3#ABC │ current"));
	assert.equal(output.filter((line) => line.includes("更新后的锚点")).length, 1);
});


test("renderFileChangesResult uses CLI counts for a truncated structured preview", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: {
			disposition: "succeeded",
			changePreview: { lines: [{ kind: "add", newLine: 1, text: "局部" }], truncated: true },
			linesAdded: 12,
			linesDeleted: 7,
			editsApplied: 2,
		},
	};
	const output = render(renderFileChangesResult(result, options(), theme, { args: { path: "notes.txt" } }), 72);

	assert.equal(output[0]!.trimEnd(), "↳ 差异 +12 -7 • 局部预览");
	assert.doesNotMatch(output[0] ?? "", /变更块/);
});

test("renderFileChangesResult folds failures unless expanded", () => {
	const result: TextResult = {
		content: [{ type: "text", text: "原子批次已拒绝，未写入任何内容。\n原因：目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。\n错误代码：io" }],
		details: {
			disposition: "rejected",
			error: { code: "io", message: "目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。" },
		},
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {}), 180), ["× 未写入 · 目标文件存在 2 个 hardlink。为同时保证原子性和链接身份，本次写入已拒绝。"]);
	assert.ok(render(renderFileChangesResult(result, options(true), theme, {})).some((line) => line.includes("错误代码：io")));
});

test("failure rendering distinguishes review-ready, zero-write and unknown outcomes", () => {
	const cases: Array<[TextResult["details"], string]> = [
		[{ disposition: "rejected", error: { code: "invalid", message: "bad request" } }, "× 未写入"],
		[{ disposition: "unavailable" }, "× 未执行"],
		[{ disposition: "outcome_unknown" }, "! 结果未知"],
		[{ disposition: "rejected", proofId: "current", recoveredReads: [{} as never], error: { code: "insufficient_read_proof", message: "review source" } }, "↳ 待复核（未写入）"],
		[{ disposition: "rejected", proofId: "current", recoveredReads: [{} as never], error: { code: "proof_recovery_budget_exceeded", message: "incomplete" } }, "× 未写入"],
		[{ disposition: "rejected", proofId: "current", error: { code: "stale", message: "review source", currentAnchors: { offset: 1, limit: 1, desiredLimit: 1, truncated: false, lines: [{ line: 1, anchor: "1#AAA", text: "current", textTruncated: false }] } } }, "↳ 待复核（未写入）"],
	];
	for (const [details, label] of cases) {
		const result: TextResult = { content: [{ type: "text", text: "Diagnostic" }], details };
		assert.ok(render(renderFileChangesResult(result, options(), theme, {}))[0]!.startsWith(label));
	}
});

test("expanded failure details wrap long recovery paths and retain every character", () => {
	const path = "C:/Users/example/" + "long-directory/".repeat(8) + "recovery-file.txt";
	const result: TextResult = {
		content: [{ type: "text", text: `Do not retry.\nRecovery file: ${path}` }],
		details: { disposition: "outcome_unknown" },
	};
	for (const width of [16, 40, 80]) {
		const output = render(renderFileChangesResult(result, options(true), coloredTheme, {}), width);
		assert.ok(output.every((line) => visibleWidth(line) <= width));
		const plain = output.join("").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s/g, "");
		assert.ok(plain.includes(path), plain);
	}
	assert.deepEqual(render(renderFileChangesResult(result, options(true), theme, {}), 0), []);
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

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {}), 180), [
		"× 未写入 · 第 1 项 replace_range 仅覆盖一行且重复原行；请扩大 end_anchor 或改用 insert_after，禁止原样重试。",
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
		details: { disposition: "succeeded", editsApplied: 1, previewError: "修改已应用，但无法生成提交绑定的预览。" },
	};

	assert.deepEqual(render(renderFileChangesResult(result, options(), theme, {})), [
		"✓ 已应用 1 项修改",
		"差异警告：修改已应用，但无法生成提交绑定的预览。",
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


test("collapsed diffs only color visible rows while keeping complete summary counts", () => {
	const diff = Array.from({ length: 2_000 }, (_, index) => `+${index + 1} value-${index}`).join("\n");
	let calls = 0;
	const countingTheme: RenderTheme = { ...theme, fg: (_name, text) => { calls++; return text; } };
	const component = renderStandaloneDiff(diff, "notes.txt", false, countingTheme)!;
	for (const width of [80, 120]) {
		calls = 0;
		const rows = component.render(width);
		assert.match(rows[0]!, /\+2000/);
		assert.ok(rows.some((line) => line.includes("展开")));
		assert.ok(rows.length <= 29);
		assert.ok(rows.every((line) => visibleWidth(line) <= width));
		assert.ok(calls < 200, `${calls} color calls for ${rows.length} visible rows`);
		assert.strictEqual(component.render(width), rows);
	}
});

test("a long first diff row only colors visible wrapped fragments", () => {
	let calls = 0;
	const countingTheme: RenderTheme = { ...theme, fg: (_name, text) => { calls++; return text; } };
	const component = renderStandaloneDiff(`+1 ${"x".repeat(8_000)}`, "notes.txt", false, countingTheme)!;
	for (const width of [80, 120]) {
		calls = 0;
		const rows = component.render(width);
		assert.ok(rows.some((line) => line.includes("展开")));
		assert.ok(rows.length <= 29);
		assert.ok(rows.every((line) => visibleWidth(line) <= width));
		assert.ok(calls < 200, `${calls} color calls for a wrapped row`);
	}
});


test("long highlighted diff rows keep wrapping bounded by the visible row budget", () => {
	const before = "const value = 0;";
	const after = `const value = ${"x".repeat(32_000)}`;
	const component = renderStandaloneDiff(`-1 ${before}\n+1 ${after}`, "sample.ts", false, theme, undefined, [
		{ kind: "remove", oldLine: 1, text: before, changeIndex: 0 },
		{ kind: "add", newLine: 1, text: after, changeIndex: 0 },
	])!;
	for (const width of [80, 160]) {
		const rows = component.render(width);
		assert.ok(rows.some((line) => line.includes("展开")));
		assert.ok(rows.length <= (width >= 141 ? 30 : 29));
		assert.ok(rows.every((line) => visibleWidth(line) <= width));
	}
});

test("source controls are visibly escaped in reads, diffs and updated anchors without changing details", () => {
	const payload = "// safe\x1b[2J\x1b]52;c;VEVTVA==\x07\x9b2J\rtail\x08\x7f";
	const result: TextResult = {
		content: [{ type: "text", text: `1#AAA:${payload}` }],
		details: {
			disposition: "succeeded",
			read: {
				path: "sample.ts",
				revision: `sha256:${"0".repeat(64)}`,
				requested: { offset: 1, limit: 1 },
				actual: { firstLine: 1, lastLine: 1, lineCount: 1, totalLines: 1 },
				lines: [{ line: 1, anchor: "1#AAA", text: payload, textTruncated: false }],
				truncated: false,
				textTruncated: false,
				eof: true,
			},
			changePreview: { truncated: false, lines: [{ kind: "add", newLine: 1, text: payload, changeIndex: 0 }] },
			updatedAnchorSpans: [{ lines: [{ line: 1, anchor: "1#AAA", text: payload, textTruncated: false }], offset: 1, limit: 1, desiredLimit: 1, truncated: false }],
		},
	};
	const original = JSON.stringify(result);
	for (const path of ["notes.txt", "sample.ts"]) {
		const components = [
			renderReadAnchorsResult(result, options(true), theme, { args: { path } }),
			renderFileChangesResult(result, options(true), coloredTheme, { args: { path } }),
			renderStandaloneDiff(`+1 ${payload}`, path, true, theme)!,
		];
		for (const component of components) {
			const output = component.render(240).join("\n");
			assert.doesNotMatch(output, /\x1b\[2J|\x1b\]52|[\x07\x08\x0d\x7f-\x9f]/);
			assert.ok(output.includes("\\x1b"));
			assert.ok(output.includes("\\x0d"));
		}
	}
	assert.equal(JSON.stringify(result), original);
});

test("terminal controls are escaped in paths, patterns, errors, warnings and diff metadata", () => {
	const payload = "\x1b[2J\x1b]52;c;VEVTVA==\x07\x9b2J";
	const failure: TextResult = {
		content: [{ type: "text", text: payload }],
		details: { disposition: "rejected", error: { code: "io", message: payload } },
	};
	const success: TextResult = {
		content: [{ type: "text", text: "Changes applied." }],
		details: { disposition: "succeeded", warnings: [payload], previewError: payload },
	};
	const components = [
		renderHleditCall("search_anchors", { path: `${payload}.txt`, pattern: payload }, theme),
		renderReadAnchorsResult(failure, options(), theme, {}),
		renderReadAnchorsResult(failure, options(true), theme, {}),
		renderFileChangesResult(success, options(true), theme, {}),
		renderStandaloneDiff(payload, "notes.txt", true, theme)!,
	];
	for (const component of components) {
		const output = component.render(240).join("\n");
		assert.doesNotMatch(output, /\x1b|[\x07\x7f-\x9f]/);
		assert.match(output, /\\x1b/);
	}
});


test("diff line limits only show continuation when a row is actually hidden", () => {
	for (const expanded of [false, true]) {
		const limit = expanded ? 2_000 : 24;
		for (const width of [80, 120]) {
			const sourceLines = limit;
			const exact = Array.from({ length: sourceLines }, (_, index) => `+${index + 1} value`).join("\n");
			const exactRows = renderStandaloneDiff(exact, "notes.txt", expanded, theme)!.render(width);
			assert.equal(exactRows.length, limit + 3);
			assert.ok(exactRows.every((line) => !/更多差异|预览已折叠/.test(line)));
			const overflowing = renderStandaloneDiff(`${exact}\n+${sourceLines + 1} extra`, "notes.txt", expanded, theme)!.render(width);
			assert.equal(overflowing.length, limit + 5);
			assert.ok(overflowing.some((line) => line.includes(expanded ? "更多差异" : "预览已折叠")));
		}
	}
});
