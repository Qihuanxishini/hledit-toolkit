# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

## 工具

插件注册两个职责明确的工具：

- `hledit_read_anchors`：读取文本文件并返回 `LN#HASH` 锚点；grep 读取可用 `context` 同时返回匹配行前后的锚点。
- `hledit_apply_file_changes`：对一个文件原子提交一组非冲突修改，并直接返回修改后的新锚点。

编辑语义：
- 修改现有文本文件时先定向读取受影响区，再用 `hledit_apply_file_changes` 做局部修改；`write` 只用于创建新文件，不用于覆盖现有文件。
- 锚点格式严格跟随 CLI：`LN#[A-Za-z0-9_-]{3}`；也可将读取结果中的 `LN#HASH:text` 整段原样填入锚点字段，`prepareArguments` 会在 schema 校验前移除冒号后的源码文本。旧两位锚点会在 schema 边界被拒绝，格式合规但内容伪造仍会被 CLI 判为 stale。
- 公开修改协议只有四种完整操作：`replace_range`、`delete_range`、`insert_before` 和 `insert_after`。范围操作必须同时提供 `start_anchor` 与 `end_anchor`；单行范围使用同一个锚点作为首尾。旧 `replace` / `delete` / `insert` 形状不迁移，由严格 schema 直接拒绝。
- 成功的未过滤读取会在插件内部记录原始字节 SHA-256 revision 与返回 anchors；范围修改必须覆盖每个原始行，insert 必须覆盖依附行。revision 与 proof 不进入公开工具 schema。
- `grep` 结果和行内截断结果不建立写入证明；缺少完整证据时 apply 在启动 CLI batch 前直接拒绝，并返回定向读取建议。
- 若单行 `replace_range` 输出多行且首行与原锚点行完全相同，插件会判定为高风险范围扩展；返回恢复指导前先以 `batch --check` 验证本批次全部锚点，stale、冲突或非法请求优先返回 CLI 原始错误。
- 高风险范围扩展错误会列出实际参数并禁止原样重试：存在唯一、从下一行之后开始的相邻 `delete_range` 时给出已验证的完整合并模板；没有安全结束锚点时要求重新读取，而不输出非法占位 anchor；`insert_after` 模板直接复用原 lines 去除重复首行后的内容。紧接下一行开始的 `delete_range` 已显式覆盖后续旧代码，不触发该护栏。
- batch 是原子的：任一 change 非法、冲突或 stale 时均为零写入。
- CLI 能构建完整同快照窗口的 stale 拒绝会返回 `currentRevision` / `currentAnchors`，并在 `details.error.staleAnchors` 与正文中列出失败项和当前同号行。窗口缺失、截断或未覆盖完整目标范围时必须重新读取；插件不会自动修正锚点、重试或覆盖并发修改。
- 已验证但内容相同的 batch 返回 no-op，不触碰目标文件；模型正文和 TUI 不再误报为已修改。
- 写入会保留 symlink、使用唯一临时文件，并明确拒绝有多个 hardlink 的目标。
- CLI 在临时文件完成同步后、原子替换前复检源文件 revision；变化时返回 `source_changed_before_commit` 并保留外部内容。该复检显著缩小竞争窗口，但不宣称 recheck 与 rename 之间不存在极短竞态。
- 成功 apply 只用新 revision 与 `updatedAnchors` 重建证据；stale、结果未知或不兼容响应会使旧证据失效。
- 仅接受有效 UTF-8 文本，并在修改时保留已有 UTF-8 BOM。
- 工具名称和协议字段保持稳定；Pi 中的调用摘要、结果、错误、警告和重试指引统一使用简体中文。

CLI capability 健康时，插件始终用 `hledit_read_anchors` 与 `hledit_apply_file_changes` 替换 Pi 的普通 `edit`。apply 仍会独立校验当前 session branch 的读取证据；分支切换只重建证据，不隐藏修改工具。若 bundled CLI 缺失或不兼容，则恢复内置 `edit`。

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

成功的 JSON 读取必须包含合法的 `revision`、`totalLines`、锚点行和截断状态。插件内部 batch 请求携带 `{revision, anchors}` proof；CLI 重新验证 proof 覆盖、锚点和当前原始字节 revision。成功 batch 必须包含新 `revision` 与合法 `updatedAnchors`，失败可携带 `currentRevision` 与同快照 `currentAnchors`。batch wire v3 中 `delete` 必须省略 `lines`，旧 `delete.lines:[]` 直接拒绝；插件不保留旧 CLI、旧 wire 或无 proof 写入回退。

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

本目录是开发源码。正式部署到 Pi 扩展目录时只同步运行时白名单：`index.ts`、`src/`、`bin/` 和 `package.json`；不得携带 `test/`、`node_modules/`、开发文档、锁文件或 `tsconfig.json`。运行时依赖由 Pi 宿主提供，部署目录不执行 `npm install`。同步后执行 `/reload` 或开启新会话。

详细协议和维护约束参见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
