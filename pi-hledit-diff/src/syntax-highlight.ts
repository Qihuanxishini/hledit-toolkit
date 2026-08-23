import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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

// width 按规范化后的纯文本测量：ANSI 序列本就不占显示宽度，用纯文本测量可以让换行
// 计算不依赖高亮器的输出形状。高亮失败时降级为纯文本，不影响布局。
function highlightText(text: string, language: string | undefined): HighlightedText {
	const normalized = text.replace(/\t/g, "    ");
	const width = visibleWidth(normalized);
	if (!language || !normalized) return { text: normalized, width };
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
