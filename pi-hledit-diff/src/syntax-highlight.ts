import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// [喵喵喵]: 受控简化 — 按规范化显示行的 UTF-16 长度限制同步高亮；边界：8,192 code units；
// 升级：预算内仍出现主线程卡顿 → 可中断高亮。超限仅降级着色，不截断正文。
const MAX_HIGHLIGHT_CODE_UNITS = 8_192;

export type HighlightedText = {
	text: string;
	width: number;
};

function resolveLanguage(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return getLanguageFromPath(path.replace(/^@/, ""));
	} catch {
		return undefined;
	}
}

// [喵喵喵]: 先可视化不可信文本的 C0/C1/DEL，再添加主题 ANSI；
// 只改变显示副本，原始内容仍用于 hash、proof 与写入。(2026-09-05)
export function escapeTerminalControls(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

// width 按规范化后的纯文本测量：ANSI 序列本就不占显示宽度，用纯文本测量可以让换行
// 计算不依赖高亮器的输出形状。高亮失败或超出长度预算时降级为纯文本，不影响布局。
function highlightText(text: string, language: string | undefined): HighlightedText {
	const normalized = escapeTerminalControls(text.replace(/\t/g, "    "));
	const width = visibleWidth(normalized);
	if (!language || !normalized || normalized.length > MAX_HIGHLIGHT_CODE_UNITS) return { text: normalized, width };
	try {
		return { text: highlightCode(normalized, language)[0] ?? normalized, width };
	} catch {
		return { text: normalized, width };
	}
}

// 按行对象身份缓存高亮结果：同一批行会在多次重绘（不同宽度、展开切换）中反复渲染，
// 而高亮与宽度只取决于行文本。WeakMap 让被替换的行自动释放，组件 invalidate() 时整体丢弃。
// 缓存键与被高亮的文本必须来自同一个对象，因此这里直接要求 { content }，不接受分开传入。
export type HighlightedTextCache = {
	highlight(line: { content: string }): HighlightedText;
	clear(): void;
};

export function createHighlightedTextCache(path: string | undefined): HighlightedTextCache {
	const language = resolveLanguage(path);
	let cache = new WeakMap<object, HighlightedText>();
	return {
		highlight(line: { content: string }): HighlightedText {
			const cached = cache.get(line);
			if (cached) return cached;
			const highlighted = highlightText(line.content, language);
			cache.set(line, highlighted);
			return highlighted;
		},
		clear(): void {
			cache = new WeakMap<object, HighlightedText>();
		},
	};
}
