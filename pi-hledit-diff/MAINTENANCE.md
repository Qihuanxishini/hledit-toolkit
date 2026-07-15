# pi-hledit-diff 维护与升级说明

本文记录 `pi-hledit-diff` 与 patched `hledit` CLI 之间的硬性契约、验证方式和升级约束。

## 仓库布局

```text
hledit-toolkit/
├─ cli/                 # CLI 唯一维护源码
└─ pi-hledit-diff/      # Pi 插件开发源码与 bundled CLI
```

开发仓库与 Pi 的实际插件加载目录是两个概念。修改本仓库不会自动更新运行中的 Pi 插件；部署 TypeScript 源码后必须 `/reload` 或开启新会话。

## CLI capability 硬性要求

插件启动时执行：

```bash
bin/hledit.exe capabilities
```

CLI 必须返回非空版本，并同时声明：

```json
{
  "ok": true,
  "batchInsertAfter": true,
  "batchUpdatedAnchors": true
}
```

缺少任一字段、输出非 JSON 或命令失败都视为不兼容。插件不支持旧 CLI，也不保留修改后的额外 `read-range` 回退链路。

## 工具协议

插件只注册两个 LLM 工具：

| 工具 | 职责 |
| --- | --- |
| `hledit_read_anchors` | 读取文本文件并返回 `LN#HASH` 锚点。 |
| `hledit_apply_file_changes` | 对一个文件提交一组非冲突变更，以一次 batch 原子应用并返回新锚点。 |

旧的单一 `hledit` 工具及 `op:'read'|'edit'|'batch'` 方言不再支持。

### `hledit_read_anchors`

```ts
{
  path: string,
  offset?: number,
  limit?: number,
  grep?: string,
}
```

准备修改文本文件时应立即读取锚点。所有 anchor 必须从输出逐字复制，不得手写或猜测 hash。

### `hledit_apply_file_changes`

```ts
{
  path: string,
  changes: [
    {
      operation: "replace",
      anchor: "12#NK",
      end_anchor?: "18#VR",
      lines: ["new line", "another line"],
    },
    {
      operation: "delete",
      anchor: "24#TX",
      end_anchor?: "29#AB",
    },
    {
      operation: "insert",
      anchor: "30#VR",
      position: "before" | "after",
      lines: ["logger.info(\"ready\");"],
    },
  ],
}
```

规则：

- 每次调用只修改一个文件，但应合并该文件中的所有非冲突变更；
- `replace` / `insert` 的 `lines` 必须非空，每一项只能包含一行原始文件文本；
- `delete` 不接受 `lines`；
- `insert` 必须提供 `position`，且不接受 `end_anchor`；
- `replace` / `delete` 的 `end_anchor` 是包含端点的范围；
- object 使用 `additionalProperties:false`，未知字段必须被拒绝；
- `lines` 不包含 diff 标记或 `LN#HASH` 前缀。

枚举字段使用 `StringEnum`；变更集合使用严格的判别联合。

## 执行路径与一致性边界

```text
withFileMutationQueue(real path)
  read before
  → hledit batch
  → 验证 ok / editsApplied / updatedAnchors
  → read after
  → diff / patch details
  → 输出 CLI 已返回的新锚点
```

约束：

- 插件不直接写目标文件；
- 所有 `changes[]` 只翻译成一次 CLI batch 请求；
- CLI 负责 hash 校验、stale、冲突检测、CRLF 保留和原子写入；
- 不先执行 `batch --check` 再执行真正 batch；
- diff/patch 只放入 `details`，不注入 LLM 可见正文；
- `updatedAnchors` 在 CLI 输出边界只验证一次，内部链路信任该不变量。

即使修改后文件读取失败，CLI 已返回的新锚点仍然可用；此时只把 diff 标记为不可用。

TUI 渲染由插件自身完成，不通过全局 adapter API 委托给其他扩展。diff 组件必须在每次 `render(width)` 时按 120 列断点重新选择双栏或统一布局；新增/删除背景色由当前 `toolSuccessBg` 与 `toolDiffAdded` / `toolDiffRemoved` 混合生成，以适配深浅主题。渲染器只读取 `details.diff` 和工具正文，不改变发送给模型的内容或 CLI 契约。

响应式渲染的性能不变量：最终 tool-result 组件必须按最近宽度复用完整 `string[]`；语法高亮与源码可见宽度按 `DiffLine` 或锚点源码行缓存；未溢出的源码行不得调用 ANSI 换行器；`invalidate()` 必须清除最终布局、高亮和主题色缓存，并向被组合的子组件传播。组合 diff、新锚点和 warning 时必须复制子组件输出，不得修改其缓存数组。不得在拖动热路径重新解析 diff、重建 split rows，或对已知适宽行执行二次截断。

## CLI batch 契约

插件发送：

```json
{
  "edits": [
    {"op":"replace","pos":"12#NK","end_pos":"18#VR","lines":["new block"]},
    {"op":"delete","pos":"24#TX","lines":[]},
    {"op":"insert","pos":"30#VR","after":true,"lines":["logger.info(\"ready\");"]}
  ]
}
```

CLI 必须先在同一原始文件状态上验证全部 anchor 和冲突，再按原始边界排序，通过 cursor 单次重建文件，最后执行一次原子写。

CLI 必须拒绝且不得写入：

- 空 batch；
- `insert` 携带 `end_pos` 或空内容；
- 同一 anchor 上的多个 insert；
- insert 落入 replace/delete 范围；
- replace/delete 范围重叠；
- 任一 stale、越界或非法 anchor。

## 成功响应与新锚点

非 check batch 成功响应必须包含：

```json
{
  "ok": true,
  "editsApplied": 1,
  "updatedAnchors": {
    "lines": [{"line":12,"anchor":"12#AB","text":"updated"}],
    "offset": 10,
    "limit": 5,
    "desiredLimit": 5,
    "truncated": false
  }
}
```

插件会验证：

- `offset` 为正整数；
- `limit`、`desiredLimit` 为非负整数；
- `limit === lines.length`；
- `desiredLimit >= limit`；
- 行号从 `offset` 开始连续；
- anchor 行号与 `line` 一致；
- `text` 与 `textTruncated` 类型正确。

CLI 默认使用修改区域前后 2 行、最多 20 行和约 4096 bytes 的窗口。发生截断时，插件要求模型用 `hledit_read_anchors` 定向重读。

## 失败语义

插件使用 `details.disposition` 区分：

```ts
"succeeded" | "rejected" | "unavailable"
```

在 `tool_result` handler 中，只要 disposition 不是 `succeeded`，就返回：

```ts
{ isError: true }
```

因此 schema 拒绝、stale、logical error、CLI 不可用以及不兼容成功响应都会成为真正的 Pi 工具错误。

stale 的 remap 只用于定位，不允许自动替换 anchor 后重试。必须重新调用 `hledit_read_anchors`、检查当前内容，再提交新请求。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工具注册、mutation 主流程、错误升级和 session 工具激活。 |
| `src/schema.ts` | 严格工具 schema 与参数类型。 |
| `src/file-changes.ts` | 将 `changes[]` 映射为 CLI batch JSON。 |
| `src/active-tools.ts` | 激活锚点工具或恢复 Pi 内置 `edit`。 |
| `src/read-args.ts` | 构造 CLI `read-range` 参数并标准化路径。 |
| `src/cli.ts` | 固定 bundled CLI 路径、capability 验证、超时与输出上限。 |
| `src/result.ts` | CLI 输出验证、disposition、stale 指引和 diff details。 |
| `src/post-edit-context.ts` | 验证并格式化 CLI 返回的 `updatedAnchors`。 |
| `src/render.ts` | 工具调用、锚点读取、成功/失败状态与新锚点 TUI 渲染。 |
| `src/diff-renderer.ts` | 独立自适应 diff 渲染，包括统一/双栏布局、语法高亮、折叠和宽度保护。 |

## 验证

插件：

```bash
cd pi-hledit-diff
npm ci
npm run check
```

CLI：

```bash
cd cli
gofmt -w *.go
go vet ./...
go test ./...
```

测试必须覆盖 capability、严格 schema、参数归一化、batch 协议、新锚点结构、tool error 升级，以及 bundled CLI 与插件的端到端调用。

## 构建 bundled CLI

从仓库根目录执行：

```bash
cd cli
go test ./...
go build -trimpath -ldflags="-s -w" -o ../pi-hledit-diff/bin/hledit.exe .
../pi-hledit-diff/bin/hledit.exe capabilities
```

capabilities 必须同时返回 `batchInsertAfter:true` 和 `batchUpdatedAnchors:true`。

## 升级原则

1. 不恢复旧单工具协议或隐式 CLI 兼容层。
2. 不恢复修改后的额外 `read-range` 子进程。
3. 不把完整 diff 发送给 LLM。
4. 不绕过 `withFileMutationQueue()` 或 CLI 原子 batch。
5. 仅在 schema、CLI 和真实 provider payload 验证后扩展协议。
6. 修改协议后必须同时更新 CLI、插件、端到端测试和本文档。
