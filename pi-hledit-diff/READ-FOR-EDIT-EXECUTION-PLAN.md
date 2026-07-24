# Read for Edit 工作流优化执行计划

> 状态：已完成（实现与验证通过）
> 批准日期：2026-07-24
> 适用范围：`pi-hledit-diff` 扩展
> 用途：作为后续会话的执行依据；恢复工作时应先完整阅读本文，再检查工作区和测试状态。

## 1. 背景

当前扩展将普通文件读取与 stale-safe 锚点读取分为不同工具。已经明确要修改现有文件时，如果模型先调用普通 `read`，随后才调用 `hledit_read_anchors`，会重复读取目标内容。

此外，`hledit_read_anchors` 已支持 `grep` 和 `context`，CLI 也会在同一个 `LoadedTextFile` 快照上完成过滤、锚点生成和 raw-byte SHA-256 revision 计算，但扩展目前主动丢弃全部 grep 读取证据，因此 grep 定位后仍必须再读取一次明确范围。

本计划优化读取路由、grep 局部 proof、常驻 prompt 和 TUI 命名，不降低现有编辑安全性。

## 2. 已批准的四项改动

1. grep 返回的完整锚点行可以建立局部写入证明。
2. 已经明确要修改的目标文件，第一次读取就使用 `hledit_read_anchors`。
3. 精简常驻 `promptGuidelines`，删除由 schema、参数预处理和错误结果重复保证的说明。
4. 将面向用户的读取标签从 `Read Anchors` 改为 `Read for Edit`。

## 3. 不可变安全边界

本计划不得改变以下约束：

- 本计划保持 `hledit_read_anchors` 和 `hledit_apply_file_changes` 的注册名与锚点安全语义不变；后续独立加入的 `hledit_replace_once` 不依赖 read proof，其契约见 `README.md` 与 `MAINTENANCE.md`。
- 不覆盖 Pi 内置 `read`；普通 `read` 继续用于参考文件和探索。
- 不修改公开参数 schema、操作类型或结构化 result details。
- 不修改 `LN#HASH` 算法。
- 写入 proof 继续绑定目标文件 raw-byte SHA-256 revision。
- `replace_range` 和 `delete_range` 继续要求 proof 覆盖每个被消费的原始行。
- `insert_before` 和 `insert_after` 继续要求 proof 覆盖依附行。
- 提交的端点锚点必须与 evidence 中对应行的锚点完全一致。
- revision 改变时不得合并新旧 evidence。
- stale 后不得自动迁移锚点、自动重试或覆盖并发修改。
- 不修改 CLI 的原子批次、提交前 revision recheck 和原子替换流程。
- 不引入 ReadSeek 风格的文件级“已读”布尔状态、模糊替换或范围端点-only 验证。

如实现方案与以上任一条冲突，停止实现并重新设计，而不是放宽约束。

## 4. 目标工作流

### 4.1 已知目标位置

```text
hledit_read_anchors({ path, offset, limit })
→ hledit_apply_file_changes({ path, changes })
```

### 4.2 已知目标文件，但未知目标位置

```text
hledit_read_anchors({ path, grep, context })
→ 返回行完整覆盖修改依赖时直接 apply
→ coverage 不足时只补读缺失范围
→ apply
```

### 4.3 只读参考或尚未确定修改目标

```text
普通 read / grep / 其他探索工具
```

只有预计会修改的文件才需要优先进入 Read for Edit 流程。

## 5. Phase 1：grep 局部 proof

### 5.1 修改位置

- `src/read-evidence.ts`
- `test/read-evidence.test.ts`
- `test/activation.integration.test.ts`

### 5.2 当前行为

`ReadEvidenceStore.recordRead()` 当前在处理 revision 后直接跳过 grep：

```ts
if (read.requested.grep) return;
```

因此 grep 返回的锚点不会进入 `FileReadEvidence.lines`。

### 5.3 目标行为

删除对 grep 的整体跳过，复用现有 revision 与逐行 evidence 逻辑：

1. 先比较已存 evidence revision 与本次 read revision。
2. revision 不同则清除旧 evidence。
3. 同一 revision 的读取继续复用原有 `Map<number, EvidenceLine>`。
4. 遍历 `read.lines`，仅记录 `textTruncated !== true` 的行。
5. grep 行不要求连续；每个完整返回行都是独立的局部 proof。
6. `selectProof()` 保持现有逐行 coverage 和端点 anchor 检查，不增加 grep 特例。

不新增 bool、enum 或 options 模式；grep 与普通读取统一进入同一个“revision + 已完整观察行集合”模型。

### 5.4 明确的边界语义

#### 非连续结果

若 grep 只返回第 10 行和第 20 行：

- 可以分别修改第 10 行或第 20 行。
- 可以在第 10 行或第 20 行前后插入。
- 不可以提交覆盖第 10–20 行的范围修改，因为第 11–19 行没有 proof。

#### context 结果

若 `grep + context` 完整返回第 10–14 行，则覆盖第 10–14 行的范围修改可以通过 proof 选择；是否 stale 仍由 CLI 使用 revision 与锚点再次验证。

#### 全局分页与行内截断

- `read.truncated === true` 只表示还有匹配结果未返回；已经完整返回的行仍可作为局部 proof。
- `line.textTruncated === true` 表示该行源码内容没有被完整观察；该行不得新增 proof。
- 同一 revision 下，如果某行此前已经完整读取，后来又以截断形式出现，已有完整 proof 仍然有效，因为文件 revision 未变。

#### 无匹配结果

- 同一 revision 的无匹配 grep 不删除此前已建立的 evidence。
- 新 revision 的无匹配 grep 会使旧 revision evidence 失效，且不会建立新的行 proof。

#### branch 恢复

`restoreFromBranch()` 继续按 branch 中的工具结果顺序调用 `recordRead()`。成功 grep 读取应恢复其完整返回行；后续不同 revision 读取、apply 或不确定写入结果仍按现有规则替换或失效 evidence。

### 5.5 单元测试矩阵

在 `test/read-evidence.test.ts` 中将当前“grep 和行内截断都不建立 proof”的组合测试拆开，并至少覆盖：

| 场景 | 预期 |
|---|---|
| grep 返回单行，单行 replace | proof 成功 |
| grep 返回单行，insert_before / insert_after | proof 成功 |
| grep + context 覆盖整个范围 | proof 成功 |
| 范围内部缺少一行 | `insufficient_read_proof`，不允许提交 |
| 两个离散 grep 命中分别修改 | proof 成功 |
| 一个范围跨越两个离散命中间的空洞 | `insufficient_read_proof` |
| 普通读取与 grep 为同一 revision | evidence 合并 |
| 两次 grep 为同一 revision | evidence 合并 |
| 新 grep revision 与旧 evidence 不同 | 旧 evidence 清除 |
| 新 revision grep 无匹配行 | 没有可用 proof |
| 同一 revision grep 无匹配行 | 保留既有 proof |
| grep 行发生 `textTruncated` | 该行不新增 proof |
| grep 结果全局 `truncated`，返回行完整 | 返回行建立局部 proof |
| 提交 anchor 与 evidence anchor 不同 | `insufficient_read_proof` |
| session branch 恢复 grep 结果 | 恢复局部 proof |

测试应验证已有 error code `insufficient_read_proof`，不得为本计划新增含义重复的 error code。

### 5.6 集成测试

在 `test/activation.integration.test.ts` 增加一条完整路径：

```text
执行 hledit_read_anchors({ grep, context })
→ 确认 details.read 携带 revision 和 anchors
→ 不执行第二次非 grep 锚点读取
→ 执行 hledit_apply_file_changes
→ 修改成功
```

另增加 coverage 不足的集成断言：apply 应在扩展侧拒绝，且不得启动 CLI batch。

### 5.7 Phase 1 完成标准

- grep 能建立严格的局部 proof。
- 非连续结果不会被误认为连续窗口。
- revision 和逐行 coverage 语义没有弱化。
- 单元和集成测试均通过。

## 6. Phase 2：编辑意图路由

### 6.1 修改位置

- `index.ts`

### 6.2 目标规则

在 `hledit_read_anchors` 的 `promptGuidelines` 中明确：

> 任务已明确要求修改现有文件时，第一次读取预计会修改的目标文件就使用 `hledit_read_anchors`；普通 `read` 仅用于参考文件或尚未确定修改目标的探索。

同时补充 grep 局部 proof 的边界：

> 在已知文件中搜索修改位置时可使用 `grep` 和 `context`；返回的完整行只提供局部 proof，范围修改仍须覆盖范围内每个原始行。

不得将规则改成“所有文件都必须使用锚点读取”，否则会增加参考文件的 token 消耗。

### 6.3 Phase 2 完成标准

- 编辑任务与只读探索的工具选择边界清晰。
- 不再诱导先普通 read、再重复锚点读取。
- 不要求参考文件进入写入 proof 流程。

## 7. Phase 3：精简常驻 prompt

### 7.1 修改位置

- `index.ts`

Phase 2、Phase 3 和工具注册 label 修改必须合并为对 `index.ts` 的一次完整、互不冲突的原子修改。

### 7.2 精简原则

可删除由以下边界已经严格保证的重复说明：

- TypeBox schema 中的 operation 和字段结构。
- `prepareArguments` 对 `LN#HASH:text` 的处理。
- 本地单行范围扩展护栏。
- CLI 对非法字段、冲突、stale 和 batch 原子性的验证。
- 工具错误结果中已经包含的具体恢复模板。

不得删除 schema 无法表达、模型调用前必须知道的工作流约束。

### 7.3 最终必须保留的语义

常驻 guidelines 至少覆盖：

1. 明确修改目标时首次使用 `hledit_read_anchors`。
2. 已知位置时使用小范围 `offset/limit`；grep 只建立返回完整行的局部 proof。
3. 修改现有文件使用 `hledit_apply_file_changes`，不得用 `write` 整文件覆盖。
4. 同一文件的一组完整、互不冲突修改一次提交；`lines` 只包含原始文件文本。
5. 锚点必须逐字复制，不得编造。
6. stale、截断、快照不完整或 coverage 不足时显式核对并定向重读；不得自动修正或原样重试。

### 7.4 删除检查表

每条准备移除的旧 guideline 必须能指向至少一个替代 owner：

- schema；
- `prepareArguments`；
- 本地 guard；
- CLI validation；
- 结构化错误正文；
- 保留下来的更高层 guideline。

找不到替代 owner 的规则不得删除。

### 7.5 Phase 3 完成标准

- read/apply guidelines 不重复、不矛盾。
- 关键安全语义仍然自包含，不依赖本仓库之外的个人级 prompt。
- 常驻 guideline 数量和字符数明显下降。

## 8. Phase 4：Read for Edit 标签

### 8.1 修改位置

- `index.ts`
- `src/render.ts`
- `test/render.test.ts`
- 必要时 `test/activation.integration.test.ts`

### 8.2 修改内容

工具注册 label：

```text
Read Anchors
→ Read for Edit
```

自定义调用渲染标题：

```text
read anchors
→ read for edit
```

### 8.3 保持不变

- `HLEDIT_READ_ANCHORS_TOOL` 常量值。
- session 中的 `toolName`。
- schema、参数、details 和 CLI 命令。
- 历史工具结果的恢复逻辑。

### 8.4 测试

更新 `test/render.test.ts` 中的预期文本：

```text
read for edit src/a.ts 包含 "token"（上下文 ±2 行；从第 3 行开始；最多 5 行）
```

如扩展测试 harness 能稳定读取注册元数据，在 activation 集成测试中增加 label 断言，防止注册 label 与自定义 renderer 再次漂移。

### 8.5 Phase 4 完成标准

- TUI 中统一显示 `Read for Edit` / `read for edit`。
- 工具协议和历史 session 兼容性不变。

## 9. 文档同步

### 9.1 修改位置

- `README.md`
- `MAINTENANCE.md`

除非发现具有当前规范作用的矛盾说明，否则不重写仓库根目录历史性的 `IMPLEMENTATION-PLAN.md`。

### 9.2 README 必须说明

- grep 返回的完整行建立局部 proof。
- 全局匹配分页不会使已完整返回的行失效。
- 行内截断的行不建立 proof。
- 离散结果不会自动覆盖中间行。
- 范围修改仍要求每个消费行都有 proof。
- revision 改变会清除旧 proof。
- 推荐的首次 Read for Edit 路由。

### 9.3 MAINTENANCE 必须说明

- `ReadEvidenceStore` 的统一数据模型是“revision + 完整观察行集合”，而不是“连续窗口”或“grep 模式”。
- 普通读取可以添加连续行，grep 可以添加离散行；`selectProof()` 统一决定 coverage。
- `truncated` 与 `textTruncated` 的语义区别。
- branch 恢复、apply 成功、stale 和不确定写入结果如何替换或失效 evidence。

## 10. 逐文件原子修改安排

实施时遵守同一文件一次完整批次原则：

| 文件 | 同一批次包含的改动 |
|---|---|
| `src/read-evidence.ts` | 删除 grep 整体跳过；更新解释 proof 模型的必要注释 |
| `test/read-evidence.test.ts` | 完整 grep proof 单元测试矩阵 |
| `test/activation.integration.test.ts` | grep→apply 集成路径、coverage 拒绝、可选 label 断言 |
| `index.ts` | 首次读取路由、prompt 精简、注册 label 修改 |
| `src/render.ts` | 调用标题改为 `read for edit` |
| `test/render.test.ts` | 更新渲染预期 |
| `README.md` | 用户工作流与 proof 语义 |
| `MAINTENANCE.md` | 维护者不变量与恢复语义 |

在修改每个现有文件前重新定向调用 `hledit_read_anchors` 获取该文件受影响范围的最新锚点；不得复用本文中的行号作为编辑依据。

## 11. 实施顺序

1. 检查 `git status --short`，确认是否存在前一会话未完成改动。
2. 运行基线测试。
3. 先更新 grep proof 单元测试，使新预期在旧实现上失败。
4. 修改 `src/read-evidence.ts`，运行 proof 单元测试。
5. 增加并运行 grep→apply 集成测试。
6. 一次性修改 `index.ts` 中的路由、精简 prompt 和 label。
7. 修改 `src/render.ts` 与渲染测试。
8. 更新 README 与 MAINTENANCE。
9. 运行全部 TypeScript 和 Go 回归测试。
10. 检查 diff，逐项核对本文的不可变安全边界和完成清单。

## 12. 验证命令

### TypeScript 扩展

```bash
npm --prefix pi-hledit-diff run check
```

该命令覆盖：

```text
tsc -p tsconfig.json
node --test test/*.test.ts
```

### Go CLI 回归

CLI 预计不需要修改，但仍运行：

```bash
cd cli && go test ./...
```

### 补丁格式

```bash
git diff --check
```

项目当前没有独立 npm lint/build script，不新增虚假的验证步骤。

所有外部命令必须设置有界 timeout。

## 13. 完成清单

### 行为

- [x] grep 完整返回行可以建立局部 proof。
- [x] `grep + context` 完整覆盖范围时可以直接 apply。
- [x] 离散 grep 结果之间的空洞仍阻止范围 apply。
- [x] 行内截断行不建立 proof。
- [x] 全局分页不影响已完整返回行。
- [x] revision 改变清除旧 evidence。
- [x] branch 恢复能恢复 grep 局部 proof。
- [x] stale、原子提交和 updated anchors 行为不变。
- [x] proof 失败的定向读取建议覆盖完整首个缺口，不受 20 行展示上限影响。

### Prompt 与 UI

- [x] 编辑任务首次读取路由已加入。
- [x] 普通 read 的参考/探索用途仍明确保留。
- [x] 常驻 guidelines 已精简且安全语义自包含。
- [x] 工具注册 label 显示 `Read for Edit`。
- [x] 自定义调用标题显示 `read for edit`。
- [x] 工具注册名仍是 `hledit_read_anchors`。

### 测试与文档

- [x] proof 单元测试通过。
- [x] activation 集成测试通过。
- [x] renderer 测试通过。
- [x] TypeScript typecheck 通过。
- [x] 全部扩展测试通过。
- [x] Go CLI 回归测试通过。
- [x] `git diff --check` 通过。
- [x] README 已更新。
- [x] MAINTENANCE 已更新。

## 14. 后续会话恢复协议

后续会话继续本任务时，按以下顺序恢复，不依赖聊天摘要中的模糊记忆：

1. 完整阅读本文件。
2. 执行 `git status --short`，识别未提交或部分完成的修改。
3. 查看本文件“完成清单”，但以实际代码和测试为准；未验证的项目不得标记完成。
4. 如果工作区已有相关改动，先读取 diff 和受影响测试，禁止覆盖或重新实现。
5. 修改现有文件前重新获取最新锚点。
6. 每完成一个 Phase，运行该 Phase 的最小测试。
7. 只有最终验证全部通过后，才将计划状态改为“已完成”。
8. 未经用户明确要求，不执行 commit、建分支、rebase 或 push。

## 15. 决策记录

### 2026-07-24

- 用户批准本计划列出的四项 P0 优化。
- 选择吸收 ReadSeek 的“搜索结果可直接进入编辑流程”和“编辑意图路由”理念。
- 明确不吸收弱 hash、文件级已读 Set、自动/模糊锚点迁移、范围端点-only 验证和直接覆盖写入。
- 计划文件独立存放，避免与仓库根目录历史实施计划混合造成后续会话漂移。
- 实施中发现缺失行展示上限会截断定向 reread 建议；已改为独立保留完整首个缺口范围，超出单次读取上限时要求按 `nextOffset` 续读。

### 2026-07-24 后续集成

- 插件升级到 bundled CLI `2.1.0`，并新增独立 `hledit_replace_once` 工具；它以唯一精确内容匹配替代 anchor proof，不改变本计划的读取证据边界。
- 工具提示词与 JSON Schema 参数说明已改为英文；成功 UI、警告与历史中文 TUI 保持原样，失败正文和恢复指引使用英文。
- 运行时白名单已同步到 Pi 全局扩展目录，真实窗口验收通过；后续调优只依据可复现的会话摩擦进行。
