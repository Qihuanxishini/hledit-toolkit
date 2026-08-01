# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

## 工具

插件注册两个职责明确的工具：

- `hledit_read_anchors`（TUI 显示为 `Read for Edit`）：读取文本文件并返回 `LN#HASH` 锚点；grep 读取可用 `context` 返回匹配行前后的锚点，`ignore_case` 控制大小写，完整返回行可直接贡献局部 proof。
- `hledit_apply_file_changes`：对一个文件原子提交一组非冲突修改，并直接返回修改后的新锚点。

编辑语义：

- 编辑现有非空文本文件前，使用 `hledit_read_anchors` 完整读取会被消费的原始行；普通 `read` 只用于参考文件或尚未确定修改目标的探索。`write` 只用于新文件、空文件或读取工具报告 source-line truncation 的例外场景。
- 规范锚点是 `LN#[A-Za-z0-9_-]{3}` token。公开 change 只复制范围首尾或 insert 依附行；区间内部 proof 由插件从 evidence 注入。apply 使用严格输入，不剥离带源码后缀的 anchor，也不迁移旧字段或包装形状。
- 公开修改协议只有 `replace_range`、`delete_range`、`insert_before` 和 `insert_after`。范围操作同时提供 `start_anchor` 与 `end_anchor`；单行范围使用同一锚点。旧 operation 与内容匹配替换不迁移。
- `replace_range`、`insert_before` 和 `insert_after` 的 `lines` 只接受换行分隔字符串；一个末尾换行仅终止末行，空字符串表示一行空文本。`delete_range` 不接受 `lines`。
- 单次 batch 限 1–200 个 changes、1 MiB replacement UTF-8 bytes 和 20,000 个输出行。batch 是原子的：任一 change 非法、冲突、proof 不完整或 stale 时均不写入。
- `insufficient_read_proof` 会在同一 canonical file queue 内执行一次定向只读。若返回 `nextOffset`，只提供下一页 `hledit_read_anchors` 指引并禁止提前重提 apply；完整覆盖后才通过顶层 `details.recoveredRead` 返回 evidence，供审阅后显式重提。source-line truncation 返回终止性指导，读取失败通过 `recoveryReadError` 暴露；不会启动 mutation batch 或自动重放修改。
- 单行 `replace_range` 输出多行且首行重复原行时，插件先用 `batch --check` 验证整个请求，再返回字段级范围修复指引，不自动扩大或执行范围。
- CLI 在临时文件同步后、原子替换前复检原始字节 revision。`source_changed_before_commit` 是确认零写入；已启动进程的取消、超时、输出超限或异常响应属于 `outcome_unknown`，必须重新读取。
- 成功 apply 使用 `editDeltas` 重映射未消费 evidence，再合并新 revision 的 `updatedAnchors`。唯一、非歧义、同 revision 且替换后完整 proof 仍成立的 verified rename 会被内部规范化并报告在 `details.resolvedAnchors`；旧 token 被当前行重新占用，或其源行/alias 最终目标被消费失联时，身份会保持 ambiguous 直到覆盖当前行的显式读取。
- 读取、proof 选择、CLI mutation 与 evidence 更新按 canonical real path 使用同一 file mutation queue。同文件状态事务串行，不同文件仍可并行。
- evidence 有界：单文件最多 10,000 records / 4 MiB logical UTF-8 payload，session 最多 50,000 records / 16 MiB；超限按完整文件淘汰并安全降级为补读。branch replay 使用相同顺序与容量规则，只恢复经过严格验证的 apply `recoveredRead`。
- 仅接受有效 UTF-8 文本；revision 基于原始字节，BOM、CRLF/LF 与末尾换行差异都会改变 revision。写入逐行保留未修改 terminator、UTF-8 BOM 与末尾换行状态。

CLI 3.x capability 健康时，插件始终启用这两个专用工具并替换 Pi 内置 `edit`。`session_tree` 重建当前 branch evidence，但不隐藏工具。若 bundled CLI 缺失、版本不在 3.x、缺少正 capability、残留已删除的 `contentReplaceOnce` 字段或响应 malformed，则恢复内置 `edit`。

## 独立 TUI 渲染

插件自行渲染两个工具，不依赖其他显示扩展：

- 锚点读取使用 `LN#HASH` gutter、语法高亮和紧凑预览；摘要显示实际范围、总行数、EOF 或下一 offset。
- 文件修改在 120 列及以上显示 old/new 双栏，更窄时显示统一 diff；多项修改在标题中分别显示范围。
- `details.changePreview` 是提交绑定的结构化局部 diff；上限为 2,000 行 / 256 KiB UTF-8，超长单行保留首尾并标记截断。截断统计使用 CLI 验证的 `linesAdded` / `linesDeleted`，不把局部 hunk 数冒充完整统计。
- expanded 结果直接消费 `details.updatedAnchors`，不从模型正文反向解析；历史结果只保留 `details.diff` 的渲染回退。
- 组件缓存同宽布局与语法高亮，并从当前 Pi theme 派生颜色。

## CLI 要求

插件固定调用自身目录下的 Windows x64 binary：

```text
bin/hledit.exe
```

兼容响应必须包含 3.x 版本及全部正 capability，并且不得包含 `contentReplaceOnce`：

```json
{
  "ok": true,
  "version": "3.0.0",
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true,
  "batchEditDeltas": true,
  "readIgnoreCase": true
}
```

成功 JSON 读取包含合法 `revision`、`totalLines`、锚点行和截断状态。内部 batch 携带 `{revision, anchors}` proof；CLI 重新验证逐行覆盖、锚点和当前原始字节 revision。成功 batch 包含新 `revision`、`updatedAnchors`、`editDeltas`、`linesAdded` 与 `linesDeleted`，插件逐项核对请求区间和统计；不兼容成功响应按结果未知处理。batch wire v3 中 `delete` 必须省略 `lines`。

## 开发

```bash
npm ci
npm run check
npm run test:bundled
```

`npm run test:bundled` 只验证仓库中已跟踪 binary 的 CLI、hash、激活和工具结果契约；CI 必须在覆盖 binary 前执行它。

## 更新 bundled CLI

在仓库根目录执行：

```bash
cd cli
go test ./...
go build -trimpath -ldflags="-s -w" -o ../pi-hledit-diff/bin/hledit.exe .
cd ../pi-hledit-diff
npm run test:bundled
npm run check
```

修改 TypeScript 源码后，需要在 Pi 中执行 `/reload` 或开启新会话。仅替换 `bin/hledit.exe` 时，后续工具调用会直接使用新 binary。

## 安装说明

本目录是开发源码。正式部署到 Pi 扩展目录时只同步运行时白名单：`index.ts`、`src/`、`bin/` 和 `package.json`；不得携带 `test/`、`node_modules/`、开发文档、锁文件或 `tsconfig.json`。运行时依赖由 Pi 宿主提供，部署目录不执行 `npm install`。同步后执行 `/reload` 或开启新会话。

详细协议和维护约束参见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
