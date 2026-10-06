# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

运行需要 Pi 0.99.0 或以上版本；当前开发验证基线为 0.99.0。

## 工具

插件注册三个职责明确的工具：

- `hledit_read_anchors`（TUI 显示为 `Read for Edit`）：只读取连续物理行并返回 `LN#HASH` 锚点；需要正则、字面量或上下文定位时使用 `hledit_search_anchors`。
- `hledit_search_anchors`（TUI 显示为 `Search Anchors`）：按 RE2 正则或字面量模式搜索，并返回带锚点的匹配/上下文行。
- `hledit_apply_file_changes`：对一个文件原子提交一组非冲突修改，并直接返回修改后的新锚点。

三个工具均使用 `model-only` 暴露方式：由模型直接调用，完整读取结果进入会话后再提交编辑，结构化结果用于分支恢复与压缩文件记录。read/search 声明只读，apply 声明可能覆盖或删除内容；这些属性不替代权限检查。

编辑语义：

- 三个工具统一展开 `~`、`~/` 主目录路径（Windows 同时支持 `~\`），并处理 `@` 前缀和 Windows MSYS 盘符路径。
- 编辑现有非空文本文件前，使用 `hledit_read_anchors` 读取会被消费的连续原始行，或使用 `hledit_search_anchors` 定位并读取匹配/上下文行；普通 `read` 只用于参考文件或尚未确定修改目标的探索。`write` 只用于新文件、空文件或读取工具报告 source-line truncation 的例外场景。
- 规范锚点是 `LN#[A-Za-z0-9_-]{3}` token。公开 change 只复制范围首尾或 insert 依附行；区间内部 proof 由插件从 evidence 注入。apply 使用严格输入，不剥离带源码后缀的 anchor，也不迁移旧字段或包装形状。
- 公开修改协议只有 `replace_range`、`delete_range`、`insert_before` 和 `insert_after`。范围操作同时提供 `start_anchor` 与 `end_anchor`；单行范围使用同一锚点。旧 operation 与内容匹配替换不迁移。
- `replace_range`、`insert_before` 和 `insert_after` 的 `lines` 只接受换行分隔字符串；一个末尾换行仅终止末行，空字符串表示一行空文本。`delete_range` 不接受 `lines`。
- 单次 batch 限 1–200 个 changes、1 MiB replacement UTF-8 bytes 和 20,000 个输出行。batch 是原子的：任一 change 非法、冲突、proof 不完整或 stale 时均不写入。
- 无效 `proof_id` 按目标证据给出单一恢复动作：证据完整时换用当前 id；有缺口或身份不明时定向读取。revision 过期返回目标附近的当前快照，完整快照附带可续编的 `proof_id`；审阅后显式提交，插件不会自动重试。
- `insufficient_read_proof` 会在同一 canonical file queue 内自动分页执行定向只读，直到目标缺口完整覆盖或触及恢复预算。结果返回全部 `recoveredReads`、最新 evidence 和一个权威 `proof_id`，但不会自动重放修改；审阅当前源码与端点锚点后再显式重提 apply。
- 定向补读有硬预算：缺口跨度 1,200 行、4 页、96 KiB 正文。补读会把读到的每一行回灌进上下文，因此跨度超限时一个子进程都不启动，直接返回 `proof_recovery_budget_exceeded` 与显式分块读取指令；页数或字节超限时保留已读页并返回同一 code。source-line truncation 返回终止性指导，读取失败通过 `recoveryReadError` 暴露。
- 读取错误一律给出可操作正文：`pattern` 转发 RE2 编译原文并说明 RE2 不支持 lookahead/lookbehind/backreference（可改用 `literal:true`），`broad_pattern` 指向 `hledit_read_anchors`。
- 超过单页预算的源行会标记 `textTruncated`，不能作为编辑 proof；若后面还有待读行或匹配，结果仍提供 `nextOffset` 和续读提示。
- 单行 `replace_range` 输出多行且首行重复原行时，插件先用 `batch --check` 验证整个请求，再返回字段级范围修复指引，不自动扩大或执行范围。
- CLI 在临时文件同步后、原子替换前复检原始字节 revision。`source_changed_before_commit` 是确认零写入；已启动进程的取消、超时、输出超限或异常响应属于 `outcome_unknown`，必须重新读取。
- 成功 apply 使用 `editDeltas` 重映射未消费 evidence，再合并新 revision 的 `updatedAnchorSpans`（每个产出了行的编辑各一个精确覆盖产出区间的 span）。唯一、非歧义、同 revision 且替换后完整 proof 仍成立的 verified rename 会被内部规范化并报告在 `details.resolvedAnchors`；旧 token 被当前行重新占用，或其源行/alias 最终目标被消费失联时，身份会保持 ambiguous 直到覆盖当前行的显式读取。
- 读取、proof 选择、CLI mutation 与 evidence 更新按 canonical real path 使用同一 file mutation queue。同文件状态事务串行，不同文件仍可并行。
- evidence 有界：单文件最多 10,000 records / 4 MiB logical UTF-8 payload，session 最多 50,000 records / 16 MiB。单批最少所需 records 已超上限时提前返回 `evidence_capacity_exceeded`；当前 revision 曾发生单文件容量淘汰且 proof 仍不完整时返回 `read_evidence_evicted`，避免反复分页。缩小目标范围优先；拆分 batch 须接受失去整批原子性的代价。branch replay 使用相同顺序与容量规则。
- 仅接受有效 UTF-8 且不含 NUL 的文本；revision 基于原始字节。非空结果保留既有 BOM，拒绝会把首字符 U+FEFF 重新解释为 BOM 的修改。孤立 CR 作为正文保留；空末行必要地补行尾，其余按局部规则保留行尾与末尾换行状态。
- Windows 写入保留目标 DACL、继承状态和 NTFS 附加流。替换中途失败时先以不覆盖方式移回原文件，成功即为零写入失败；无法移回时返回 `outcome_unknown` 并保留、报告恢复文件，须先检查文件状态；已成功写入但恢复副本清理失败则返回成功及含路径的 warning。

CLI 3.x capability 健康时，插件始终启用这三个专用工具并替换 Pi 内置 `edit`。`session_tree` 重建当前 branch evidence，但不隐藏工具。若 bundled CLI 缺失、版本不在 3.x、缺少正 capability、残留已删除的 `contentReplaceOnce` 字段或响应 malformed，则恢复内置 `edit`。

## 独立 TUI 渲染

插件自行渲染三个工具，不依赖其他显示扩展：

- 连续锚点读取和搜索都使用 `LN#HASH` gutter、语法高亮和紧凑预览；摘要显示实际范围、总行数、EOF、匹配统计或下一 offset。
- 文件修改在 120 列及以上显示 old/new 双栏，更窄时显示统一 diff；多项修改在标题中分别显示范围。
- `details.changePreview` 是提交绑定的结构化局部 diff；上限为 2,000 行 / 256 KiB UTF-8，超长单行保留首尾并标记截断。截断统计使用 CLI 验证的 `linesAdded` / `linesDeleted`，不把局部 hunk 数冒充完整统计。
- 读取、差异预览和 expanded 更新锚点分别消费 `details.read`、`details.changePreview`、`details.updatedAnchorSpans`；展示与证据恢复共用结构化结果。
- 组件缓存同宽布局与语法高亮，并从当前 Pi theme 派生颜色。
- 错误摘要区分待复核（未写入）、未写入、未执行与结果未知；展开后按终端宽度换行，完整显示恢复路径和操作指令。

## CLI 要求

插件固定调用自身目录下的 Windows x64 binary：

```text
bin/hledit.exe
```

兼容响应必须包含 3.x 版本及全部正 capability，并且不得包含 `contentReplaceOnce`：

```json
{
  "ok": true,
  "version": "3.4.0",
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchorSpans": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true,
  "batchEditDeltas": true,
  "searchIgnoreCase": true,
  "searchRegex": true,
  "searchLiteral": true,
  "search": true
}
```

成功 JSON 读取包含合法 `revision`、`totalLines`、锚点行和截断状态。内部 batch 携带 `{revision, anchors}` proof；CLI 重新验证逐行覆盖、锚点和当前原始字节 revision。成功 batch 包含新 `revision`、`updatedAnchorSpans`、`editDeltas`、`linesAdded` 与 `linesDeleted`，插件逐项核对请求区间、产出 span 和统计；不兼容成功响应按结果未知处理。batch wire v3 中 `delete` 必须省略 `lines`。

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
cargo test --locked
pwsh -NoProfile -File build-bundle.ps1
pwsh -NoProfile -File build-bundle.ps1 -VerifyOnly
cd ../pi-hledit-diff
npm run test:bundled
npm run check
```

Rust 版本固定在 `cli/rust-toolchain.toml`，依赖固定在 `cli/Cargo.lock`。构建脚本生成静态 CRT 的 Windows x64 CLI、依赖许可及 `hledit.build.json`；`-VerifyOnly` 核对源码指纹、binary SHA-256 和许可摘要。该检查用于检测过期或错配制品，不证明跨机器逐字节可复现，也不是真实性签名。CI 分别验证 tracked 与源码重建产物的同一插件协议。

修改 TypeScript 源码后，需要在 Pi 中执行 `/reload` 或开启新会话。仅替换 `bin/hledit.exe` 时，后续工具调用会直接使用新 binary。

## 安装说明

本目录是开发源码。正式部署到 Pi 扩展目录时只同步运行时白名单：`index.ts`、`src/`、`bin/` 和 `package.json`；不得携带 `test/`、`node_modules/`、开发文档、锁文件或 `tsconfig.json`。运行时依赖由 Pi 宿主提供，部署目录不执行 `npm install`。同步后执行 `/reload` 或开启新会话。

详细协议和维护约束参见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
