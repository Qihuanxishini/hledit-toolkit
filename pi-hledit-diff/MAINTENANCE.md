# pi-hledit-diff 维护与升级说明

本文记录 `pi-hledit-diff` 与 patched `hledit` CLI 之间的硬性契约、验证方式和升级约束。

## 仓库布局

```text
hledit-toolkit/
├─ cli/                 # CLI 唯一维护源码
└─ pi-hledit-diff/      # Pi 插件开发源码与 bundled CLI
```

开发仓库与 Pi 的实际插件加载目录是两个概念。修改本仓库不会自动更新运行中的 Pi 插件；部署 TypeScript 源码后必须 `/reload` 或开启新会话。

### 正式部署白名单

Pi 实际加载目录不是开发工作区的镜像，只允许包含以下运行时产物：

```text
pi-hledit-diff/
├─ index.ts
├─ package.json
├─ bin/
└─ src/
```

不得部署 `test/`、`node_modules/`、`README.md`、`MAINTENANCE.md`、`package-lock.json` 或 `tsconfig.json`。运行时包由 Pi 宿主提供，正式目录不得执行 `npm install`。每次同步应以该白名单为边界，并清理目标目录中的非运行时文件；不得用整个开发目录覆盖正式目录。

## CLI capability 硬性要求

插件启动时执行：

```bash
bin/hledit.exe capabilities
```

CLI 必须返回非空版本，并同时声明：

```json
{
  "ok": true,
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true
}
```

缺少任一字段、输出非 JSON 或命令失败都视为不兼容。插件不支持旧 CLI、旧 batch wire 或旧 `delete.lines:[]` 形状，也不保留纯文本读取解析、修改后额外 `read-range` 或 stale 后自动重试的回退链路。

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
未显式提供 `limit` 时插件默认读取 160 行；公开上限保持 2000，已知位置应使用更小的定向窗口。

插件固定调用 `read-range --json`。成功响应必须包含：

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "totalLines": 120,
  "lines": [{"line":51,"anchor":"51#aB3","text":"source","textTruncated":false}],
  "truncated": true,
  "nextOffset": 52
}
```

插件在 CLI 边界验证总行数、锚点格式与行号、递增顺序、未过滤读取的连续性、`limit`、`textTruncated`、`truncated` 和 `nextOffset`。正文由已验证结构生成；TUI 从 `details.read` 获取实际范围、总行数、EOF 和续读 offset，不重新解析正文。
`revision` 是目标文件原始字节的 SHA-256，包含 BOM、CRLF/LF 和末尾换行差异。插件仅把成功、未过滤、连续且未发生行内截断的读取记录为写入证据；`grep` 结果和截断行必须重新读取明确范围。

越界错误必须携带 `requestedOffset` 与 `totalLines`。模型可见正文第一行直接使用 CLI `message`，折叠 TUI 不以内部错误码替代具体原因；插件仍严格拒绝越界，不自动 clamp。
读取证据按 canonical real path、revision 和行号集合合并。`session_start` / `session_tree` 只从当前 branch 的有效 tool result 恢复，不从聊天正文解析 anchors。

### `hledit_apply_file_changes`

```ts
{
  path: string,
  changes: [
    {
      operation: "replace_range",
      start_anchor: "12#aB3",
      end_anchor: "18#xY7",
      lines: ["new line", "another line"],
    },
    {
      operation: "delete_range",
      start_anchor: "24#nK2",
      end_anchor: "29#Qw_",
    },
    {
      operation: "insert_before",
      anchor: "30#xY7",
      lines: ["logger.info(\"starting\");"],
    },
    {
      operation: "insert_after",
      anchor: "31#Qw_",
      lines: ["logger.info(\"ready\");"],
    },
  ],
}
```

`revision` 和 proof 不出现在公开工具 schema。插件根据当前 branch 的读取证据，把内部 batch 请求扩展为：
```json
{
	"edits": [{"op":"replace","pos":"12#aB3","end_pos":"13#Qw_","lines":["new block"]}],
	"proof": {"revision":"sha256:<digest>","anchors":["12#aB3","13#Qw_"]}
}
```
proof 必须覆盖 replace/delete 消费的每个原始行以及 insert 依附行；CLI 仍独立验证 revision、proof anchors、编辑 anchors 和物理冲突。

规则：

- 每次调用只修改一个文件，但应合并该文件中的所有非冲突变更；
- 公开 operation 仅有 `replace_range`、`delete_range`、`insert_before` 和 `insert_after`；旧 `replace` / `delete` / `insert` 形状及 `replace-range` 别名不迁移，必须由严格 schema 拒绝；
- `replace_range` / `delete_range` 必须同时提供 `start_anchor` 与 `end_anchor`，范围包含首尾；单行范围使用同一个锚点作为首尾；
- `replace_range`、`insert_before` 和 `insert_after` 的 `lines` 必须非空，每一项只能包含一行原始文件文本；`delete_range` 不接受 `lines`；
- anchor 格式必须与 CLI 一致：`LN#[A-Za-z0-9_-]{3}`，只接受三位 URL-safe Base64 hash；旧两位锚点必须拒绝；
- `prepareArguments` 只修复不改变编辑语义的结构偏差：最多两层 JSON 序列化、单个 change 包装、字符串 `lines` 分行，以及把原样复制的 `LN#HASH:text` 归一化为 `LN#HASH`；不得迁移旧 operation 或旧字段；
- 单行 `replace_range` 若输出多行且首行与原锚点行完全相同，插件先调用 `batch --check` 验证整个批次。stale、冲突或非法请求优先返回 CLI 错误；仅在 check 成功后返回高风险范围扩展指导；
- 错误正文必须列出实际 operation、`start_anchor`、`end_anchor` 和 lines 行数，并禁止原样重试。不存在安全结束锚点时要求重新读取且不得输出占位 anchor；`insert_after` 模板使用原 lines 去除重复首行后的真实内容；
- 同批次若有 `delete_range` 紧接 replace 行的下一行开始，说明后续旧代码已被显式覆盖，护栏允许该批次；若只有一个 `delete_range` 从后两行开始，check 成功后可作为疑似同块提示并生成使用真实 `end_anchor` 的合并模板。调用方仍须确认语义并移除原 delete，插件不得自动改写或执行 change；
- object 使用 `additionalProperties:false`，未知字段必须被拒绝；
- `lines` 不包含 diff 标记或 `LN#HASH` 前缀。

枚举字段使用 `StringEnum`；变更集合使用严格的判别联合。

CLI capability 健康但当前 branch 没有有效证据时，active tools 只启用 `hledit_read_anchors`；首次有效读取后增量启用 apply。工具切换必须保留无关 active tools，`session_tree` 后按当前 branch 重建；CLI 不可用时恢复 Pi 内置 `edit`。

## 执行路径与一致性边界

```text
withFileMutationQueue(real path)
  → 按 canonical path 选择覆盖全部 change 的 revision/read-set proof
      → 证据不足：返回定向读取建议，不启动 batch
  → read before（仅用于意图护栏与 diff）
  → 检测高风险单行范围扩展
      → 带同一 proof 调用 hledit batch --check
      → stale / conflict / invalid：返回 CLI 错误
      → check 成功：返回恢复指导，不执行写入
  → 普通请求：带隐藏 proof 调用 hledit batch
  → CLI plan + pre-commit revision recheck + atomic replace
  → 验证 ok / revision / editsApplied / updatedAnchors
  → read after
  → diff / patch details
  → 用新 revision / updatedAnchors 更新证据
```

约束：

- 插件不直接写目标文件；
- 普通写入路径只发送一次非 check CLI batch 请求；高风险单行范围路径只发送一次 `batch --check`，同一次工具调用中绝不在 check 后继续真正 batch；
- CLI 负责 hash 校验、stale、冲突检测、CRLF 保留和原子写入；
- 插件只识别语义明确的单行范围重复护栏；恢复指导仅使用已经通过 check 的 anchor，但仍不会猜测、补全、改写或静默丢弃 change；
- `batch --check` 仅用于高风险护栏的错误优先级与恢复数据验证，不作为正常写入前置步骤；
- diff/patch 只放入 `details`，不注入 LLM 可见正文；工具错误的 `details` 供 TUI、session 和扩展 hook 使用，模型纠错必须依赖 `content` 中的正文；
- `updatedAnchors` 在 CLI 输出边界只验证一次，内部链路信任该不变量。
- 取消、超时、输出超限或 stdin 失败时，`runHledit` 必须等到子进程确认退出后再返回，mutation queue 不得在 CLI 仍可能写文件时提前放行。
- apply 执行前若没有充分证据，插件不启动 batch，而是返回定向 `hledit_read_anchors` 建议；成功 apply 使用新 revision 与 `updatedAnchors` 建立下一轮证据。
- stale、`source_changed_before_commit`、outcome unknown 或不兼容响应会使旧证据失效；只有携带完整、未截断 `currentRevision` / `currentAnchors` 的 stale 结果才可作为当前 revision 证据。

即使修改后文件读取失败，CLI 已返回的新锚点仍然可用；此时只把 diff 标记为不可用。

TUI 渲染由插件自身完成，不通过全局 adapter API 委托给其他扩展。读取结果以 `details.read` 为真源，工具标题仍显示请求范围，结果摘要显示实际范围、总行数、EOF 或下一 offset；多项修改标题按 change 顺序分别显示范围，失败折叠摘要必须包含直接修复动作；路径在终端支持时使用 `file://` 超链接。diff 组件必须在每次 `render(width)` 时按 120 列断点重新选择双栏或统一布局；新增/删除背景色由当前 `toolSuccessBg` 与 `toolDiffAdded` / `toolDiffRemoved` 混合生成，以适配深浅主题。

响应式渲染的性能不变量：最终 tool-result 组件必须按最近宽度复用完整 `string[]`；语法高亮与源码可见宽度按 `DiffLine` 或锚点源码行缓存；未溢出的源码行不得调用 ANSI 换行器；`invalidate()` 必须清除最终布局、高亮和主题色缓存，并向被组合的子组件传播。组合 diff、新锚点和 warning 时必须复制子组件输出，不得修改其缓存数组。不得在拖动热路径重新解析 diff、重建 split rows，或对已知适宽行执行二次截断。

## CLI batch 契约

插件发送：

```json
{
  "edits": [
    {"op":"replace","pos":"12#aB3","end_pos":"13#Qw_","lines":["new block"]}
  ],
  "proof": {
    "revision": "sha256:<64 lowercase hex digits>",
    "anchors": ["12#aB3", "13#Qw_"]
  }
}
```

batch wire v3 的字段形状是唯一 canonical 形状：`replace` 必须提供 `lines`（可为空），`delete` 必须省略 `lines`，`insert` 必须提供非空 `lines`，`after` 只能在 insert 中以 `true` 出现。旧字段形状直接拒绝，不做自动迁移或双格式解析。
CLI batch 可选 `proof`；声明 `batchReadProof:true` 的 bundled CLI 必须严格验证 proof。`--check` 与 apply 共享同一 planner；apply 在临时文件同步后、rename 前复检原始字节 revision，检测到变化时返回 `source_changed_before_commit`，但 recheck 与 rename 之间仍保留极短外部竞态，不宣称线性化 CAS。

CLI 必须先在同一原始文件状态上验证全部 anchor 和冲突，再按原始边界排序，通过 cursor 单次重建文件，最后执行一次原子写。

CLI 必须拒绝且不得写入：

- 空 batch；
- `insert` 携带 `end_pos` 或空内容；
- 多个 insert 映射到同一物理 boundary（例如 `insert_after(N)` 与 `insert_before(N+1)`）；
- insert 的物理 boundary 落入 replace/delete 消费的边界范围；
- replace/delete 范围重叠；
- 任一 stale、越界或非法 anchor。

## 成功响应与新锚点

非 check batch 成功响应必须包含当前原始字节 `revision`：
```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "editsApplied": 1,
  "contentChanged": true,
  "updatedAnchors": {
    "lines": [{"line":12,"anchor":"12#aB3","text":"updated"}],
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
- `contentChanged` 若存在则必须为 boolean；bundled CLI 始终返回该字段；
- `warnings` 若存在则必须是 string array，并同时进入模型正文与 TUI。

CLI 默认使用修改区域前后 2 行、最多 20 行和约 4096 bytes 的窗口。发生截断时，插件要求模型用 `hledit_read_anchors` 定向重读。

未截断的 `updatedAnchors` 直接来自成功写入后的新文件状态，可用于后续提交；不得复用该次写入前的旧锚点。

当 `contentChanged:false` 时，CLI 已验证全部操作但没有触碰目标文件；插件将其显示为 no-op，仍消费返回的新锚点并完成队列内的 post-read。

## 失败语义

插件使用 `details.disposition` 区分：

```ts
"succeeded" | "rejected" | "unavailable" | "outcome_unknown"
```

在 `tool_result` handler 中，只要 disposition 不是 `succeeded`，就返回：

```ts
{ isError: true }
```

因此 schema 拒绝、stale、logical error、CLI 不可用以及不兼容成功响应都会成为真正的 Pi 工具错误。
所有 batch 拒绝结果必须明确说明原子失败、零写入，避免调用方误判前序 change 已部分应用。
插件前置护栏拒绝必须在 `details.error` 中返回结构化恢复信息：`code`、`message`、`changeNumber`、`operation`、`anchor` 与 `outputLineCount`。检测到疑似同块 `delete_range` 时，额外返回 `relatedChangeNumber` 和 `candidateEndAnchor`；这些 anchor 已通过本次 `batch --check`，但是否属于同一个业务代码块仍须调用方确认，插件不会自动执行该范围。
单行范围扩展的模型可见正文必须明确禁止原样重试。没有安全结束锚点时要求重新读取且不得生成违反 anchor schema 的占位值；保留锚点行时提供使用真实剩余 lines 的 `insert_after`；存在唯一后两行起始的相邻 `delete_range` 时才提供完整范围 `replace_range`。TUI 折叠摘要必须直接包含修复动作。
不兼容成功响应与 batch 拒绝不同：CLI 可能已经写入。错误正文必须要求重新读取当前文件，不得声称零写入或直接建议重试。
已启动但退出、超时、取消、输出超限或响应不完整的 apply 使用 `outcome_unknown`；工具必须先重新读取当前文件，禁止直接重试原请求。没有启动 CLI 的情况使用 `unavailable`。

stale 的 remap 只用于定位，不能自动替换后重试。CLI 能构建同快照窗口时返回 `currentRevision` / `currentAnchors`；插件把它们放入 details，并根据失败 change 列出提交锚点和当前同号行。proof revision mismatch 等无法提供完整窗口的 stale 结果必须重新读取。只有未截断窗口覆盖原定目标全部行时，证据层才可按新 revision 使用其中 anchors；任何路径都不得自动修正、重试或覆盖并发修改。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工具注册、mutation 主流程、错误升级和 session 工具激活。 |
| `src/schema.ts` | 严格工具 schema 与参数类型。 |
| `src/file-changes.ts` | 将四种公开 change 映射为 CLI batch JSON，并识别高风险单行范围扩展。 |
| `src/read-evidence.ts` | 按 canonical path/revision 合并读取证据，生成隐藏 proof，恢复 branch 状态并处理 apply 失效。 |
| `src/active-tools.ts` | 激活锚点工具或恢复 Pi 内置 `edit`。 |
| `src/read-args.ts` | 归一化读取请求并构造强制 `--json` 的 CLI `read-range` 参数。 |
| `src/cli.ts` | 固定 bundled CLI 路径、capability 验证、超时与输出上限。 |
| `src/result.ts` | 验证结构化读取/编辑响应与 `batch --check` 成功标记，生成模型正文、disposition、actionable error、stale 字段核对信息和 diff details。 |
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

测试必须覆盖 capability（含 `batchWireV3` 与 `batchReadProof`）、四种严格 operation、旧参数拒绝、结构化参数解包、revision 与 BOM/CRLF/LF/末尾换行边界、完整 read proof、proof 缺失/内部变化/stale、物理冲突、提交前 revision 竞态、结构化读取元数据、batch/check parity、未知 JSON 字段拒绝、单行范围重复护栏、stale 同快照字段核对及零写入、结果未知、branch 恢复、动态工具激活、中文折叠错误摘要、tool error 升级，以及 bundled CLI 与插件的端到端调用。

## 构建 bundled CLI

从仓库根目录执行：

```bash
cd cli
go test ./...
go build -trimpath -ldflags="-s -w" -o ../pi-hledit-diff/bin/hledit.exe .
../pi-hledit-diff/bin/hledit.exe capabilities
```

capabilities 必须同时返回 `anchorProtocolV2:true`、`readRangeMetadata:true`、`batchInsertAfter:true`、`batchCheck:true`、`batchUpdatedAnchors:true`、`batchStaleContext:true`、`batchWireV3:true` 和 `batchReadProof:true`。

## 升级原则

1. 不恢复旧单工具协议或隐式 CLI 兼容层。
2. 不恢复修改后的额外 `read-range` 子进程。
3. 不把完整 diff 发送给 LLM。
4. 不绕过 `withFileMutationQueue()` 或 CLI 原子 batch。
5. 仅在 schema、CLI 和真实 provider payload 验证后扩展协议。
6. 修改协议后必须同时更新 CLI、插件、端到端测试和本文档。
