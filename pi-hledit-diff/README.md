# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

## 工具

插件注册两个职责明确的工具：

- `hledit_read_anchors`：读取文本文件并返回 `LN#HASH` 锚点；grep 读取可用 `context` 同时返回匹配行前后的锚点。
- `hledit_apply_file_changes`：对一个文件原子提交一组非冲突修改，并直接返回修改后的新锚点。

编辑语义：
- 锚点格式严格跟随 CLI：`LN#[BHJKMNPQRSTVWXYZ]{2}`；格式不合规会在 schema 边界被拒绝，格式合规但内容伪造仍会被 CLI 判为 stale。
- `replace` 未提供 `end_anchor` 时只消费一个源文件行；替换现有代码块必须在同一项 change 中提供包含端点的 `end_anchor`。兼容别名 `replace-range` 只在同时提供 `end_anchor` 时归一化，否则保留给 schema 拒绝。
- 若单锚点多行 `replace` 的首行与原锚点行完全相同，插件会判定为高风险块扩展；返回恢复指导前先以 `batch --check` 验证本批次全部锚点，stale、冲突或非法请求优先返回 CLI 原始错误。
- 高风险块扩展错误会列出实际参数并禁止原样重试：存在唯一紧邻范围 `delete` 时给出已验证的完整合并模板；没有安全结束锚点时要求重新读取，而不输出非法占位 anchor；`insert after` 模板直接复用原 lines 去除重复首行后的内容。`details.error` 同时返回错误代码、change 序号、anchor、缺失字段和输出行数。
- batch 是原子的：任一 change 非法、冲突或 stale 时均为零写入。
- stale 拒绝会返回校验时同一文件快照中的 `currentAnchors`；调用方须先核对当前文本，禁止自动重试或覆盖并发修改。
- 已验证但内容相同的 batch 返回 no-op，不触碰目标文件；模型正文和 TUI 不再误报为已修改。
- 写入会保留 symlink、使用唯一临时文件，并明确拒绝有多个 hardlink 的目标。
- 仅接受有效 UTF-8 文本，并在修改时保留已有 UTF-8 BOM。
- 工具名称和协议字段保持稳定；Pi 中的调用摘要、结果、错误、警告和重试指引统一使用简体中文。

插件会替换 Pi 的普通 `edit` 工具；如果 bundled CLI 缺失或 capability 不符合要求，则恢复内置 `edit`。

## 独立 TUI 渲染

插件自行渲染两个工具，不依赖 `pi-tool-display` 或其他渲染扩展：

- 锚点读取使用独立的 `LN#HASH` gutter、源码语法高亮和紧凑预览；摘要显示实际范围、文件总行数、EOF 或下一 offset，展开后显示全部已读取锚点。
- 文件修改按每次 `render(width)` 的可用内容宽度实时重排：120 列及以上显示 old/new 双栏，更窄时显示统一 diff。
- 多项文件修改在调用标题中分别显示锚点范围，例如 `482,484-489`，避免把独立操作误解为一个连续范围。
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
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
  "batchStaleContext": true
}
```

成功的 JSON 读取必须包含合法的 `totalLines`、锚点行和截断状态；成功的 batch 响应必须包含合法的 `updatedAnchors`。stale batch 响应必须包含来自同一校验快照的 `currentAnchors`，供核对后显式重试。插件不会为旧 CLI 保留文本读取解析或修改后 `read-range` 回退。

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
