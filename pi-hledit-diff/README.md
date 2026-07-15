# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

## 工具

插件注册两个职责明确的工具：

- `hledit_read_anchors`：读取文本文件并返回 `LN#HASH` 锚点。
- `hledit_apply_file_changes`：对一个文件原子提交一组非冲突修改，并直接返回修改后的新锚点。

插件会替换 Pi 的普通 `edit` 工具；如果 bundled CLI 缺失或 capability 不符合要求，则恢复内置 `edit`。

## 独立 TUI 渲染

插件自行渲染两个工具，不依赖 `pi-tool-display` 或其他渲染扩展：

- 锚点读取使用独立的 `LN#HASH` gutter、源码语法高亮和紧凑预览；展开工具结果后显示全部已读取锚点。
- 文件修改按每次 `render(width)` 的可用内容宽度实时重排：120 列及以上显示 old/new 双栏，更窄时显示统一 diff。
- 新增行使用主题衍生的淡绿色背景，删除行使用淡红色背景，并保留增删前景色、行号和语法高亮。
- diff 提供宽度保护和折叠提示；展开后还会显示 CLI 返回的新锚点。
- 所有颜色取自当前 Pi theme，不固定绑定深色或浅色主题。
- diff 与锚点读取组件都缓存最终宽度输出及宽度无关的语法高亮；同宽重绘直接复用结果，窗口拖动只重算必要的换行和双栏结构。

## CLI 要求

插件固定调用自身目录下的：

```text
bin/hledit.exe
```

当前 bundled CLI 面向 Windows x64，并且必须返回：

```json
{
  "ok": true,
  "batchInsertAfter": true,
  "batchUpdatedAnchors": true
}
```

成功的 batch 响应必须包含合法的 `updatedAnchors`。插件不会为旧 CLI 再执行一次修改后 `read-range`。

## 开发

```bash
npm ci
npm run check
```

`npm run check` 会执行 TypeScript 类型检查和全部 Node 测试，其中包括 bundled CLI 与插件协议的端到端验证。

## 更新 bundled CLI

在仓库根目录执行：

```bash
cd cli
go test ./...
go build -trimpath -ldflags="-s -w" -o ../pi-hledit-diff/bin/hledit.exe .
```

修改 TypeScript 源码后，需要在 Pi 中执行 `/reload` 或开启新会话。仅替换 `bin/hledit.exe` 时，后续工具调用会直接使用新二进制。

## 安装说明

本目录是开发源码。将其复制或链接到 Pi 的扩展目录后安装依赖，再重新加载 Pi。具体扩展加载方式以当前 Pi 文档为准。

详细协议和维护约束参见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
