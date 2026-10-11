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

// [喵喵喵]: 受控简化 — 按行内容缓存高亮，键为“语言 NUL 行文本”；上限 4096 条 LRU。
// 边界：宿主每轮 updateDisplay 重建组件，行对象身份缓存必然 miss，跨重建复用只能靠内容键。
// 升级：多语言大文件会话中仍现卡顿 → 按语言分组分代。
// 主题或语言可用性变化无法经参数感知（theme 是全局 Proxy，onThemeChange 单槽已被宿主占用），
// 以哨兵输出的前后比较作失效信号；漏检的极端情形只是颜色不刷新，下次失效自愈。
const MAX_CACHE_ENTRIES = 4096;
const SENTINEL_TEXT = 'const s = 42; if (s) { f("x"); } // c';
const sentinelOutputs = new Map<string, string>();
const highlightedTextEntries = new Map<string, HighlightedText>();

function refreshHighlightCache(languageKey: string, language: string | undefined): void {
	const sentinel = highlightText(SENTINEL_TEXT, language).text;
	if (sentinelOutputs.get(languageKey) === sentinel) return;
	const prefix = `${languageKey}\0`;
	for (const key of highlightedTextEntries.keys()) {
		if (key.startsWith(prefix)) highlightedTextEntries.delete(key);
	}
	sentinelOutputs.set(languageKey, sentinel);
}

export type HighlightedTextCache = {
	highlight(line: { content: string }): HighlightedText;
	clear(): void;
};

export function createHighlightedTextCache(path: string | undefined): HighlightedTextCache {
	const language = resolveLanguage(path);
	const languageKey = language ?? "";
	refreshHighlightCache(languageKey, language);
	return {
		highlight(line: { content: string }): HighlightedText {
			const key = `${languageKey}\0${line.content}`;
			const cached = highlightedTextEntries.get(key);
			if (cached) {
				// LRU：命中后重插到末尾，超限时从最旧的键淘汰。
				highlightedTextEntries.delete(key);
				highlightedTextEntries.set(key, cached);
				return cached;
			}
			const highlighted = highlightText(line.content, language);
			if (highlightedTextEntries.size >= MAX_CACHE_ENTRIES) {
				const oldest = highlightedTextEntries.keys().next().value;
				if (oldest !== undefined) highlightedTextEntries.delete(oldest);
			}
			highlightedTextEntries.set(key, highlighted);
			return highlighted;
		},
		clear(): void {
			// invalidate() 不区分宽度、主题与语言加载，统一重验一次哨兵；输出未变时内容缓存保留，
			// 布局重置由 component() 自身的行缓存负责。
			refreshHighlightCache(languageKey, language);
		},
	};
}
