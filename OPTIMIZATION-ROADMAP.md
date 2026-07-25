# hledit Token、正确性与内存稳健性优化路线图

> 状态：实施中；Phase 1.1～1.3 已完成，后续按执行状态继续
> 记录日期：2026-07-25
> 范围：`cli/` 与 `pi-hledit-diff/` 的模型工具协议、结果正文、读取证据、compaction、diff、文本重建和原子提交链路
> 用途：作为后续优化实施、复审和会话恢复的权威执行基线，防止优先级、硬约束或方案边界随会话漂移

## 1. 文档权威性与冲突处理

本路线图描述**尚未完成的未来优化方向**。当前实际行为仍以代码、测试和维护文档为准。

发生文档冲突时按以下顺序判断：

1. 当前代码与自动测试决定“现在实际做什么”；
2. [`pi-hledit-diff/MAINTENANCE.md`](./pi-hledit-diff/MAINTENANCE.md) 与 [`cli/SPEC.md`](./cli/SPEC.md) 描述当前必须保持的运行契约；
3. 本文决定“下一阶段准备怎样优化”以及不得偏离的实施边界；
4. [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md)、[`MULTILINE-LINES-IMPLEMENTATION-PLAN.md`](./MULTILINE-LINES-IMPLEMENTATION-PLAN.md) 和 [`pi-hledit-diff/READ-FOR-EDIT-EXECUTION-PLAN.md`](./pi-hledit-diff/READ-FOR-EDIT-EXECUTION-PLAN.md) 是历史实施记录，不得覆盖本文的新决策。

任何阶段实现完成后，必须同步更新当前契约文档和本文状态。不得只改代码而让本文继续描述已失效的目标架构。

## 2. 优化目标与优先级

本轮优化按以下优先级排序：

1. 降低模型每轮常驻工具协议 Token；
2. 降低成功、失败和恢复正文的模型可见 Token；
3. 提高首次编辑成功率，减少不必要的补读、stale 和 proof failure；
4. 保证同文件并发、session branch 和 compaction 后的读取证据一致性；
5. 防止请求之外的字节变化，尤其是混合 CRLF/LF 文件的整文件规范化；
6. 让 diff 精确表示本次已验证提交，而不是两个独立读取时刻之间的任意文件变化；
7. 降低大文件编辑时的完整文件副本和累计分配，以内存稳健性为目标；
8. 执行延迟、CPU 时间和毫秒级 benchmark 只作为诊断数据，不作为主要优化目标。

## 3. 已确认的基线发现

### 3.1 常驻工具协议

首批执行前使用与回归测试相同的计算口径：`JSON.stringify(parameters)` 加上 `description`、`promptSnippet` 和全部 `promptGuidelines` 的字符数。

| 工具 | Schema 字符数 | prompt metadata 字符数 | 合计 |
| --- | ---: | ---: | ---: |
| `hledit_read_anchors` | 630 | 663 | 1293 |
| `hledit_apply_file_changes` | 5271 | 1416 | 6687 |
| `hledit_replace_once` | 1753 | 862 | 2615 |
| 合计 | 7654 | 2941 | 10595 |

按字符数除以 4 的粗略口径，首批执行前约为 2649 tokens。这些数字只用于比较优化前后变化，不宣称等同于任一具体 provider 的精确计费 Token。

### 3.2 模型可见结果

当前成功结果可能重复包含：

- 修改摘要；
- updated-anchor 局部窗口；
- 后续锚点使用说明；
- 截断和重读说明；
- `details` 中的 `updatedAnchors`、post-edit metadata、diff 与 patch。

`details` 通常不直接发送给模型，因此不得把 session/TUI details 与模型正文混为同一类 Token 成本。需要优化的是模型可见 `content` 的重复说明；details 的删除必须有真实消费者审计和迁移理由。

单行范围扩展护栏还可能同时回显完整 merged replacement 模板和完整 insert 模板。大 replacement 失败时，这会重复发送调用方刚刚提供的源码。

### 3.3 diff 和完整文件读取

当前成功编辑路径由 Node：

1. 在 CLI 前读取完整文件；
2. 调用 CLI；
3. 在 CLI 后读取完整文件；
4. 使用 `generateDiffString` 计算展示 diff；
5. 使用 `generateUnifiedPatch` 再计算一次 patch。

Go CLI 同时执行：

1. 完整读取与解析；
2. batch/replace-once 规划；
3. 完整输出重建；
4. 新 revision 计算；
5. 提交前完整 revision 复检；
6. 临时文件和原子替换。

Node 的前后读取不是 CLI 写入正确性的验证边界：post-read 不会重新计算并核对 CLI 返回的 revision。它们目前主要服务于单行范围护栏和 diff。

独立 10 MiB 编辑路径测量中，完整 Node pipeline 的 RSS 增量约为 96.53 MiB。该数字受 GC 和进程状态影响，只用于说明完整 diff 路径会放大内存，不作为严格峰值承诺。

### 3.4 Go 累计分配

临时 benchmark 在 10 MiB 文本上的结果：

| 操作 | 分配 |
| --- | ---: |
| `parseTextFile` | 13,041,909 B/op |
| 单项 `planBatchEdits` | 2,577,690 B/op |
| `JoinLines` | 20,987,904 B/op |
| join + revision hash | 31,482,069 B/op |
| join + hash + `[]byte` materialization | 41,976,021 B/op |
| 单次 byte builder 原型 | 10,493,952 B/op |
| byte builder + hash 原型 | 10,494,160 B/op |
| `os.ReadFile` revision 复检 | 10,496,834 B/op |
| 流式 revision 复检原型 | 33,560 B/op |

`B/op` 是累计分配，不等于同时驻留内存。`parseTextFile` 数据还不包含调用者准备原始输入的完整字节切片。

临时 benchmark 文件在测量后已删除，不属于仓库交付物。

### 3.5 读取证据与 session

已确认：

- evidence 更新发生在 anchored tool execute 内，但同一 tool result 还会被全局 `tool_result` handler 再处理一次；
- 文件 mutation queue 覆盖 proof selection、CLI 写入和 post-read，但 evidence 更新目前发生在 queue 放行之后；
- 同文件下一项调用可能在上一项 evidence 更新前进入 queue，造成不必要的 proof/stale 失败；
- `session_start` / `session_tree` 会重放当前 branch 结果恢复 evidence；
- Pi 内置 compaction 文件操作提取只识别名为 `read`、`write`、`edit` 的工具，不会自动记录三个自定义 hledit 工具；
- Pi 提供 `session_before_compact`，可补充自定义 readFiles/modifiedFiles。

### 3.6 当前字节正确性问题

当前 `LoadedTextFile` 只保存一个主导 `LineEnding`。混合 CRLF/LF 文件发生任意内容修改时，`JoinLines` 会使用单一行尾重建整份文件。

现有 warning 使该行为不静默，但仍会：

- 修改请求范围之外的字节；
- 产生巨大无关 diff；
- 改变未编辑区域 revision；
- 使“局部 operation preview”无法完整表示实际写入。

### 3.7 已知显示错误

`hledit_read_anchors` 未指定 `limit` 时实际默认读取 160 行；TUI 范围标签在部分路径使用最大值 2000，可能把实际 `1-160` 显示为 `1-2000`。

## 4. 必须保持的硬约束

后续任何实现都不得破坏以下不变量：

1. `hledit_read_anchors`、`hledit_apply_file_changes`、`hledit_replace_once` 三个工具保持独立、稳定且始终可见；
2. 不动态激活、延迟加载、隐藏或按 evidence 切换 apply 工具；
3. 不重新合并成带模式参数的万能编辑工具；
4. 不修改公开 operation 名或字段名，除非另行批准协议升级；
5. anchored apply 继续要求 read proof 覆盖每个消费行或 insert 依附行；
6. revision 继续基于原始文件字节；
7. 插件不直接写目标文件，不绕过 `withFileMutationQueue()`；
8. CLI 继续负责 stale、proof、物理冲突、规划、pre-commit revision recheck 和原子替换；
9. 可确认拒绝必须零写入；`outcome_unknown` 不得声称零写入或建议原样重试；
10. 不自动修正锚点、不自动 stale 重试、不模糊匹配、不覆盖外部修改；
11. 不擅自延长三字符 anchor；锚点协议升级仍属于单独审批的 Phase 4 研究；
12. 不在没有真实数据时降低默认 160 行读取窗口；
13. 不为减少延迟或内存而删除安全校验；
14. 不让展示数据构建失败把一个已确认成功的文件提交误报为零写入；
15. 正式部署仍只同步 `pi-hledit-diff/index.ts`、`package.json`、`bin/` 和 `src/`。

## 5. 设计决策

### D1：Token 和正确性优先于执行延迟

Schema、prompt、正文、补读次数、首次成功率和无关字节变化是主要指标。CPU、毫秒延迟和 session details 磁盘大小只在影响稳健性时进入优先队列。

### D2：稳定工具可见性高于动态 schema 节省

三个工具保持常驻。静态 Token 通过去重 Schema description、prompt snippet 和 prompt guidelines 解决，不通过工具集合变化解决。

### D3：模型正文与结构化 details 分开治理

- 模型正文只保留下一步决策所需内容；
- details 保留 TUI、session 和扩展 hook 所需的结构化信息；
- `details.patch` 的删除不是 P0 Token 优化；只有在 change-preview 迁移中确认无消费者后才可清理；
- 历史 `details.diff` 必须保留渲染回退。

### D4：diff 表示本次已验证操作，而不是任意前后快照差

当前 Node before/after diff 可能把外部进程在两个读取时刻之间的修改错误归因给 hledit。

目标架构使用：

- anchored apply：read evidence 中被消费的旧行、请求的新行、经验证的 `editDeltas`；
- replace-once：请求的 `old_lines`、`new_lines` 和 CLI 返回的 `firstChangedLine`；
- 只对单个变更块执行局部最小 diff；
- TUI 直接消费结构化 `changePreview`，历史结果回退到 `details.diff`。

CLI 暂不新增面向 TUI 的完整 `diffWindows` 协议。只有 standalone CLI 也需要 preview，或插件证据不足以建立准确 preview 时，才重新评估 CLI 结构化快照。

### D5：混合行尾保留是 operation preview 的前置条件

在整文件行尾规范化仍存在时，局部 preview 会遗漏真实写入副作用。因此必须先保留未修改行的原 terminator，再移除 Node 全文件 diff。

### D6：evidence 更新属于同文件 mutation 的完整操作

成功提交、结果验证、evidence 重映射和新窗口合并必须在同一个 canonical path mutation queue 内完成，之后才能允许同文件下一项操作开始。

实时执行结果只允许一个 owner 更新 evidence；全局 tool-result 路径保留 branch/session 重放职责，不得重复应用同一次实时结果。

### D7：compaction 必须认识自定义文件操作

通过 `session_before_compact` 将：

- `hledit_read_anchors` 记录为 readFiles；
- `hledit_apply_file_changes` 记录为 modifiedFiles；
- `hledit_replace_once` 记录为 modifiedFiles。

只从结构化 tool result 和 canonical path 提取，不从聊天正文猜测文件状态。

### D8：内存优化分为低风险 materialization 收敛与可选大文件重构

第一层直接复用单次输出 bytes、流式计算 current revision，不改变协议和 planner。

第二层 raw byte spans、projected document 和直接流式写临时文件只在大文件需求明确后实施，不与 Token/compaction 优化混成一次大重构。

## 6. 分阶段实施计划

## Phase 0：建立回归基线与测量工具

### 工作项

- 记录三个工具 Schema、description、prompt metadata 的字符数和粗略 Token 基线；
- 固定成功、no-op、stale、proof failure、single-line guard、outcome unknown 的模型正文 snapshot；
- 为 mutation queue、compaction、mixed EOL、change preview 增加缺失的测试骨架；
- 将分配 benchmark 以普通 Go benchmark 形式加入仓库，但不设置易受 Go 版本影响的硬阈值断言；
- 运行完整 Go、Node、TypeScript 基线。

### 完成条件

- 后续压缩有可比较的数字和正文快照；
- 不修改运行时行为；
- 临时脚本不进入仓库。

## Phase 1：常驻协议与模型正文压缩

### 1.1 Schema 和 prompt 去重

实施原则：

- 保持严格 discriminated union；
- 保持 `constrainedSampling: { type: "json_schema", strict: "prefer" }`；
- 保持三个工具及现有字段；
- 每条关键约束只保留一个权威位置；
- schema 能表达的字段形状不在多个 guidelines 中重复；
- 错误正文能提供的恢复细节不常驻于 prompt；
- 保留 schema 无法表达的工作流：首次 Read for Edit、proof coverage、stale 后定向重读、禁止整文件 write 覆盖。

目标：

- 常驻估算降低 500～800 tokens/轮；
- malformed tool call、首次 apply 成功率和补读次数不劣化。

### 1.2 成功正文压缩

正常成功正文只保留：

```text
Applied <N> changes; line delta: <delta>.
Updated anchors:
<LN#HASH:text window>
```

以下情况才附加指导：

- 窗口截断；
- text truncation；
- 部分目标未覆盖；
- warning；
- no-op；
- 结果未知。

updated anchors 必须保留在模型正文中一次，不能完全移入 details，因为后续工具调用需要可复制锚点。

### 1.3 失败正文使用增量修复说明

高风险单行范围扩展不再默认回显两份完整 payload。优先引用原 tool call：

```text
- change end_anchor to <verified anchor>
- remove change <N>
- keep lines unchanged
```

只有调用方无法通过字段级修复复用原参数时，才生成完整模板。

### 1.4 输出上限对齐

- 正常 CLI JSON/read 输出继续限制 50 KiB / 2000 行；
- Node wrapper 设置协议余量，但模型正文与 TUI preview 使用独立硬上限；
- 超限结果保留 disposition、error code、revision 和恢复动作；
- 已启动写入的输出超限继续按 `outcome_unknown` 处理，禁止假定零写入。

### 完成条件

- Token/字符基线下降达到目标区间，或有记录充分的正确性理由解释偏差；
- 正文 snapshot 只删除重复，不删除必要动作；
- 三个工具始终可见；
- 完整插件测试通过。

## Phase 2：evidence、并发和 compaction

### 2.1 evidence 更新进入 mutation queue

目标顺序：

```text
canonical path queue
  → select proof
  → guard/check
  → CLI mutation
  → validate result
  → remap/invalidate/record evidence
  → release queue
```

### 2.2 evidence 单一实时 owner

- execute 路径负责当前调用的 queue 内 evidence 更新；
- session/branch 重放路径负责从历史 tool results 重建；
- 同一次实时 tool result 不重复应用；
- no-op、stale、source_changed_before_commit、unavailable、outcome_unknown 分别保持当前失效规则。

### 2.3 compaction 文件追踪

在 `session_before_compact` 中根据当前待压缩消息和结构化 details 补充 canonical path：

| 工具 | 文件操作 |
| --- | --- |
| `hledit_read_anchors` | read |
| `hledit_apply_file_changes` | modified |
| `hledit_replace_once` | modified |

不得把 failed/unavailable 且未写入的 apply 记为已修改；`outcome_unknown` 必须以保守方式记录可能修改，并在 compaction 文本中保留需要重新读取的状态。

### 2.4 TUI 默认范围修复

未提供 `limit` 时，调用标题和结果摘要统一使用 `DEFAULT_READ_LIMIT = 160`，不得显示 2000。

### 完成条件

- 同文件连续调用在上一项返回后可立即看到新 evidence；
- 没有重复 evidence merge/remap；
- branch 切换和 compaction 测试通过；
- compaction 后 readFiles/modifiedFiles 准确；
- TUI 默认范围与真实 CLI 请求一致。

## Phase 3：逐行 terminator 与混合行尾保留

### 3.1 文件表示

第一阶段不直接引入 raw spans，而是在 `LoadedTextFile` 中保存逐行 terminator：

```go
type LineEnding uint8

const (
    NoLineEnding LineEnding = iota
    LFLineEnding
    CRLFLineEnding
)

type LoadedTextFile struct {
    Lines       []string
    LineEndings []LineEnding
    HasUTF8BOM  bool
    Revision    string
}
```

必须维持：

```text
len(Lines) == len(LineEndings)
```

孤立 `\r` 继续属于行文本，不是 terminator。

### 3.2 重建规则

- 未修改源行保留自己的 terminator；
- replacement 中间行使用目标附近的局部行尾；
- replacement 最后一行继承被替换范围最后一行的 terminator；
- insert 新行使用锚点附近的局部行尾；
- 原本无 terminator 的末行后插入内容时，为原末行选择局部 terminator，新末行继续无 terminator；
- 原文件 trailing newline 的存在性保持；
- 删除全部逻辑行仍生成真正空文件；
- UTF-8 BOM 保持。

### 3.3 当前文档迁移

实现完成前，README/MAINTENANCE 继续明确当前“混合行尾整体规范化”行为。完成后必须同步改为逐行保留，并删除不再适用的 mixed-line-ending warning 契约。

### 完成条件

- replace、delete、insert_before、insert_after、replace-once 均覆盖 mixed EOL；
- 首行、末行、到 EOF 范围、空文件、BOM 和 trailing newline 测试通过；
- 未触及行的 terminator 字节保持；
- result revision 等于最终文件实际 raw-byte SHA-256；
- 不再产生整文件行尾 normalization diff。

## Phase 4：提交绑定的局部 change preview

### 4.1 proof selection 返回消费行

成功的 proof selection 内部返回：

```ts
type ConsumedEvidenceLine = {
    line: number;
    anchor: string;
    text: string;
};
```

它只包含本次变化实际消费或依附的、同 revision 完整读取行，不进入公开工具 schema。

### 4.2 单行范围护栏改用 evidence

`findSingleLineRangeExpansionIssue` 不再接收完整文件字符串，只接收消费行集合并检查锚点行文本。

### 4.3 局部 preview 构建

建议结构：

```ts
type ChangePreviewLine = {
    kind: "context" | "remove" | "add";
    oldLine?: number;
    newLine?: number;
    text: string;
};

type VerifiedChangePreview = {
    lines: ChangePreviewLine[];
    truncated: boolean;
};
```

数据来源：

- anchored apply：消费行 + 请求输出 + 已验证 `editDeltas`；
- replace-once：请求 old/new + `firstChangedLine`；
- no-op：空 preview；
- stale/rejected：不生成成功 preview。

为了保留 replacement 块内部的最小 diff，可对单个块调用现有 `generateDiffString(oldBlock, newBlock, 0)`，然后分别偏移 old/new 行号。不得再对完整文件调用 diff。

### 4.4 preview 上限和失败语义

建议上限：

- 最多 2000 行；
- 最多 256 KiB；
- 超限时保留变更统计、首尾片段和 `truncated:true`；
- preview 构建失败不得改变已确认成功的文件 disposition。

### 4.5 TUI 和历史兼容

- 新结果优先渲染 `details.changePreview`；
- 历史 session 回退到 `details.diff`；
- migrated results 不同时保存等价的完整 diff、完整 patch 和完整 preview；
- `details.patch` 仅在确认无扩展消费者后删除；删除时更新测试和维护文档。

### 4.6 移除 Node 全文件前后读取

在护栏和 preview 均不再依赖完整文件后，删除 apply/replace-once 的 Node before/after read。

外部并发修改不得混入本次 change preview。成功后的 evidence 继续以 CLI revision、editDeltas 和 updated anchors 为依据。

### 完成条件

- 单行、小范围和大文件中的小范围修改只按变更块生成 preview；
- 外部在 Node 调用间隙修改其他区域时，不出现在本次 preview；
- 历史 diff 渲染测试通过；
- mixed-EOL 无隐藏副作用；
- Node 不再为成功 edit 读取两份完整文件。

## Phase 5：低风险内存 materialization 收敛

### 5.1 一次构建输出 bytes

将字符串 join、hash 转换和写入转换收敛为一次 byte builder：

```text
EncodeUTF8 once
  → rawFileRevision(encoded)
  → atomicWriteIfRevision(path, encoded, sourceRevision)
```

- 预估精确容量；
- 一次 append BOM、行文本和逐行 terminator；
- batch、replace-once 和仍保留的单项 CLI verb 复用同一编码职责；
- 不新增仅转发的 wrapper/helper 层。

### 5.2 replace-once 只构建一次结果

不再为 revision 和写入分别调用完整重建。

### 5.3 current revision 流式复检

提供职责明确的路径 hash 操作，例如：

```go
func rawFileRevisionFromPath(path string) (string, error)
```

使用 `os.Open` 与流式 SHA-256，保留当前错误映射和 pre-commit 时序。

### 5.4 结果切片预分配

对 replace-once 和 planner 可准确计算的输出行数预分配 header 容量，避免不必要扩容。不得为了微小分配引入复杂泛型或抽象层。

### 完成条件

- 10 MiB 输出 materialization 目标从约 41.98 MiB/op 降至约 11 MiB/op；
- pre-commit revision 分配目标低于 100 KiB/op；
- revision、BOM、逐行 EOL、trailing newline 和原子写入语义不变；
- Go 测试、vet 和 benchmark 通过。

## Phase 6：可选的大文件结构重构

仅在真实需求表明需要稳定处理几十或上百 MiB 文本时启动，必须单独复审。

候选设计：

```go
type LineSpan struct {
    TextStart int
    TextEnd   int
    End       int
}

type SourceSnapshot struct {
    Raw      []byte
    Lines    []LineSpan
    Revision string
}
```

以及：

```go
type PlannedDocument struct {
    source *SourceSnapshot
    edits  []PlannedBatchEdit
}
```

目标：

- 避免 `[]byte → string` 的整文件副本；
- 避免完整 `RebuiltLines` header 数组；
- updated anchors 只访问局部 projected lines；
- 直接将 planned document 流式写入临时文件；
- 写入同时计算新 revision；
- 峰值内存接近 source snapshot + line spans + replacement + 小型 I/O buffer。

停止条件：

- 若重构扩散到大量无关命令且职责边界难以命名，先停止并重新设计；
- 不允许用 mode flag 让一个函数同时承担 plan/check/apply；
- 不允许为了 span 结构削弱 UTF-8、anchor、proof 或 atomic write 契约。

## 7. 实施依赖与推荐顺序

```text
Phase 0 回归基线
  ↓
Phase 1 Token 与正文压缩
  ↓
Phase 2 evidence / compaction / TUI correctness
  ↓
Phase 3 mixed-EOL 字节保留
  ↓
Phase 4 commit-bound change preview
  ↓
Phase 5 低风险内存 materialization
  ↓
Phase 6 raw spans（可选、另行复审）
```

补充规则：

- Phase 5 的 byte builder 与流式 revision 技术上可独立于 Phase 4，但若 Phase 3 将改变输出编码表示，优先让 Phase 5 直接基于逐行 terminator 构建，避免短期实现两次；
- Phase 4 不得早于 Phase 3，否则 preview 会隐藏混合行尾 normalization；
- Phase 2 的 queue 和 compaction 测试必须在修改 owner 前先建立；
- 每个 Phase 独立实现、验证和记录，禁止一次性跨越全部阶段的大补丁。

## 8. 测试矩阵

| 类别 | 必测场景 | 预期 |
| --- | --- | --- |
| Schema Token | 三工具注册快照 | 字符数下降，结构与字段不变 |
| Prompt | 三工具始终可见 | 无动态激活或隐藏 |
| 成功正文 | 普通 apply | 摘要和 updated anchors 各出现一次 |
| 大失败正文 | 大 replacement 触发护栏 | 不重复回显两份源码 payload |
| 输出上限 | 读取/preview 超限 | 安全截断并给出下一步动作 |
| Queue | 同文件连续 apply | 后一项看到前一项新 evidence |
| Queue 并发 | 同路径别名并发 | canonical path 串行且无旧 evidence 窗口 |
| Evidence owner | 实时 result + tool_result | 同一结果只应用一次 |
| Compaction read | read anchors 后压缩 | 文件进入 readFiles |
| Compaction write | apply/replace 成功后压缩 | 文件进入 modifiedFiles |
| Compaction unknown | outcome unknown 后压缩 | 保留“可能修改、需重读”状态 |
| TUI 默认值 | limit 省略 | 显示实际 160 行范围 |
| Mixed EOL replace | 修改一行 | 未修改行 terminator 保持 |
| Mixed EOL insert | 首/中/末插入 | 新行采用局部风格，原行保持 |
| Mixed EOL delete | 删除至 EOF | trailing newline 语义保持 |
| BOM/empty | BOM 与删除全部行 | BOM/空文件契约正确 |
| Revision | 每次成功 | 返回 revision 等于最终实际字节 hash |
| Preview anchored | 多项非冲突修改 | 行号与 `editDeltas` 一致 |
| Preview replace-once | 唯一多行替换 | 使用 firstChangedLine 正确偏移 |
| Preview attribution | 外部修改其他区域 | 不出现在本次 preview |
| Preview compatibility | 历史 diff details | 仍可渲染 |
| Allocation | 10 MiB 单行修改 | materialization 达到阶段目标 |
| Atomicity | pre-commit 外部变化 | 仍拒绝且保留外部内容 |

## 9. 验收指标

主要指标：

- 每轮静态工具协议字符数和估算 Token；
- 每次成功/no-op/stale/guard/outcome-unknown 正文字符数；
- 首次 apply 成功率；
- 每次编辑平均补读次数；
- `insufficient_read_proof`、stale 和 `source_changed_before_commit` 比例；
- compaction 后 readFiles/modifiedFiles 准确率；
- 同文件连续编辑是否需要不必要的中间重读；
- 是否产生请求之外的字节变化；
- preview 是否只包含本次提交的变更；
- 大文件路径累计分配与异常结果比例。

非主要指标：

- CLI 启动毫秒数；
- 单次 diff 计算毫秒数；
- session_start capability probe 延迟；
- branch replay 的线性扫描时间。

只有这些延迟导致超时、内存异常或正确性问题时才升级优先级。

## 10. 明确不做或暂缓

以下项目不属于本路线图的实施内容：

- 动态激活、延迟加载或隐藏 `hledit_apply_file_changes`；
- 把三个工具合并为一个万能工具；
- 自动 stale 重试或模糊 anchor 修复；
- 自动合并外部并发修改；
- 未经数据支持降低默认读取行数；
- 仅为减少延迟而删除校验、revision recheck 或 mutation queue；
- 仅为 details/session 大小删除 diff/patch 正确信息；
- 使用 `executionMode: parallel` 并行同文件 mutation；
- 立即升级或加长 anchor hash；
- 将 pre-commit recheck 宣称为线性化 compare-and-swap；
- 为启动延迟缓存 capability，除非先证明缓存失效与 bundled binary 更新语义安全；
- 为 branch replay 的线性成本引入复杂增量索引，除非出现真实长会话问题。

## 11. 每阶段执行纪律

1. 开始前检查 `git status --short`，不得覆盖用户已有改动；
2. 修改现有文本文件前读取最新锚点；
3. 先增加能够暴露目标问题的最小测试，再修改实现；
4. 每个文件一次提交完整、互不冲突的编辑批次；
5. CLI capability 或 wire 变化必须同步源码、bundled binary、插件校验、测试和文档；
6. 每个 Phase 只做其明确范围，不顺手重构无关代码；
7. 每个 Phase 结束运行最小相关测试和完整回归；
8. 最终运行：

```bash
cd cli
go test ./...
go vet ./...

cd ../pi-hledit-diff
npm run check

cd ..
git diff --check
```

9. 未经明确要求，不 commit、建分支、rebase、push 或部署正式 Pi 运行目录；
10. 完成后在本文记录实际结果、偏离原因、剩余风险和验证数字。

## 12. 会话恢复协议

后续会话继续本路线图时：

1. 完整阅读本文；
2. 阅读 `pi-hledit-diff/MAINTENANCE.md` 和受影响 CLI 当前规范；
3. 检查本文状态和最近完成记录；
4. 执行 `git status --short` 并读取已有 diff；
5. 以代码和测试确认已完成项，不仅依赖勾选框或聊天摘要；
6. 从第一个未完成且依赖满足的 Phase 继续；
7. 若新发现与本文决策冲突，先更新设计记录并说明理由，再改代码；
8. 禁止悄然恢复“动态工具激活”等已否决方案。

## 13. 决策记录

### 2026-07-25

- 确认执行延迟不是主要优化目标，Token 与正确性优先；
- 明确禁止动态激活或延迟加载 apply 工具，三个工具必须稳定可见；
- 保留 Schema/prompt 去重、成功/失败正文压缩、evidence queue、compaction、mixed EOL、TUI 默认范围和回归指标等原优化项；
- 重新确认 P1 diff 架构和全文件分配优化仍有价值，其价值来自提交归因与内存稳健性，而不是毫秒延迟；
- diff 方案从“优先让 CLI 返回完整结构化 diff”细化为“插件使用已验证 evidence、请求和 CLI receipt 构建局部 change preview”，避免新增源码传输和成功响应超限风险；
- mixed-EOL 保留被确定为 change-preview 迁移前置条件；
- 10 MiB 原型确认单次 byte builder 和流式 revision 可显著降低累计分配；
- 本文被指定为后续优化执行的权威基线，避免后续会话只记住局部架构优化而遗漏 Token、compaction 和 correctness 项。

### 2026-07-25 首批执行

- 执行范围限定为 Phase 0 的工具注册预算和 Phase 1.1 的 Schema/prompt metadata 去重；未触及 CLI、proof、结果正文、工具可见性或写入路径；
- 新增注册协议字符预算回归，当前上限为 8000 字符；
- 移除三个与 description/guidelines 重复的 `promptSnippet`，保留严格 schema、constrained sampling 和关键工作流语义；
- 注册协议从 10595 降至 6736 字符，减少 3859 字符（36.4%），按字符数除以 4 粗略约减少 965 tokens/轮；
- `npm run check` 全量通过：TypeScript typecheck 与 152 个 Node 测试均通过；`git diff --check` 通过；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第二批执行

- 执行范围限定为 Phase 0 的结果正文预算回归和 Phase 1.2～1.3；未修改 CLI wire、proof、details、工具可见性、mutation queue 或写入语义；
- 普通成功正文改为一行变更统计加一份 `Updated anchors`，未截断窗口不再重复通用复用说明；截断时仍保留定向重读动作；
- 高风险单行范围护栏改为引用原 tool call 的字段级修复，移除 replacement/insert 完整 payload 回显；
- 代表性普通成功正文从 512 降至 69 字符，减少 443 字符（86.5%）；代表性 100×80 字符护栏从 18479 降至 728 字符，减少 17751 字符（96.1%）；
- 新增大 replacement 回归，护栏正文保持低于 1000 字符且不包含 payload 尾部；成功、warning、updated-anchor 和字段级恢复正文使用精确断言锁定；
- `npm run check` 全量通过：TypeScript typecheck 与 153 个 Node 测试均通过；
- Phase 1.4 未在本批实施：1 MiB wrapper 上限的收敛必须先覆盖合法最坏 JSON 转义膨胀和已启动写入 overflow 的 `outcome_unknown` 语义；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第三批执行

- 执行范围限定为 Phase 1.4：建立输出上限的两个正确性回归；未修改 CLI wire、正文格式、proof 或写入语义；
- 确认合法输出的最坏路径是 read JSON：CLI 的 50 KiB / 2000 行截断按转义前原始字节计数，二进制检测只拦 NUL，控制字符（如 0x01）是合法文本且经 JSON 转义膨胀 6 倍；实测最坏合法读取输出 303219 字节（约 296 KiB），占 1 MiB wrapper 上限的 28.9%；apply 成功响应受 updatedAnchors 20 行 / 4096 字节与 candidates 20 项上限约束，不构成更大的合法输出；
- 新增回归一（误杀防护）：真实 bundled CLI 读取全控制字符文件，断言转义后输出超过 CLI 原始预算 4 倍仍完整通过 wrapper（未来收窄余量至最坏体量以下会使该测试失败）；
- 新增回归二（outcome_unknown 语义）：`runHledit` 增加 `maxOutputBytes` 值参数（默认 1 MiB 不变，仅测试用）以覆盖 overflow 终止路径；用 64 字节上限驱动真实 batch，断言 CLI 已完成原子写入、run 标记 `started:true`、`applyFileChangesResult` 保持 `outcome_unknown` 并给出重读指引，正文不含任何零写入声明；
- 1 MiB wrapper 上限保留不变：实测余量充分（3.4 倍），收窄无 Token 收益，属可选后续项；若未来收窄，回归一即为安全下界证明；
- 超限结果无法保留 `revision` / error code 属结构性约束（overflow 时 stdout 已被丢弃）；disposition 与恢复动作已保留，`outcome_unknown` 强制重读会重建 revision，记为已接受偏差；
- MAINTENANCE.md 已补充协议余量的量化契约；
- `npm run check` 全量通过：TypeScript typecheck 与 155 个 Node 测试均通过；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第四批执行

- 执行范围限定为 Phase 0 收尾：失败正文完整 snapshot 与永久 Go 分配 benchmark；未修改任何运行时行为；
- 新增四个精确正文 snapshot 回归（整段 `assert.equal`）：插件侧 proof failure（301 字符）、CLI `insufficient_read_proof` 拒绝（176 字符）、带快照上下文与字段级恢复的 stale 拒绝（958 字符）、输出超限 `outcome_unknown`（245 字符）；后续正文压缩必须显式更新这些基线；
- snapshot 过程中发现 stale 正文存在一处语义重复（"This snapshot never retries…" 与 "Only reuse these anchors…" 两句几乎等价，约 170 字符），按 Phase 0 纪律未修改，记为 Phase 1 后续可选压缩项；
- 新增 `cli/allocation_bench_test.go` 六个永久 benchmark（10 MiB 语料，`b.ReportAllocs`，无硬阈值断言），实测与 §3.4 临时基线吻合：parseTextFile 12.56 MB/op、planBatchEdits 单项 2.09 MB/op、JoinLines 20.97 MB/op、join+revision 31.46 MB/op、batch 输出 materialization 41.94 MB/op、pre-commit recheck 10.49 MB/op；Phase 5 收敛以此对比；
- mutation queue、compaction、mixed EOL 与 change preview 的回归按 §7 纪律推迟到各自 Phase 首步建立（Phase 2/3/4 的第一项工作即先建测试），不预置空骨架；
- 完整基线通过：`go vet ./...`、`go test ./...`、`npm run check`（159 个 Node 测试）；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第五批执行

- 执行范围为 Phase 2 全部四项；未修改 CLI、schema、正文格式或 proof 语义；
- 2.1：apply 与 replace-once 的 evidence 更新（重映射/失效/记录）移入 `withFileMutationQueue` 回调，在队列放行前完成；同文件下一项排队调用的 `selectProof` 立即看到上一项结果。新增并发回归：insert 仍在 CLI 执行期间排队第二个 apply，断言第二项拿到插件侧 `renamesRestoreProof` 更名指引而不是把旧 proof 发给 CLI 换回 stale；
- 2.2：全局 `tool_result` handler 移除 evidence 重复应用（该事件仅在实时 `afterToolCall` 后触发，更新纯属重复），只保留失败升级；实时 owner = execute（mutation 在队列内、读取直接更新），重放 owner = `restoreFromBranch`；
- 2.3：新增 `src/compaction-files.ts` 与 `session_before_compact` handler，从待压缩消息（含分裂 turn 前缀）的结构化 tool result 补充 `preparation.fileOps`：读取成功 → read；apply/replace-once 成功且内容变更 → modified；成功 no-op（`contentChanged === false`，字节未变）→ read（比路线图表格更精确，已记录为有意偏差）；`outcome_unknown` → modified（保守）；`rejected`/`unavailable` 零写入不记录；
- 2.4：`renderHleditCall` 的读取范围标签在 `limit` 省略时改用 `DEFAULT_READ_LIMIT`（160），不再显示 1-2000；新增标签回归；
- 新增 3 个回归测试（queue 并发、compaction 提取、TUI 默认范围），`npm run check` 全量通过（162 个 Node 测试）；MAINTENANCE.md 已同步执行路径、单一 owner 与 compaction 契约；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第六批执行

- 执行范围为 Phase 3 全部三项（CLI 逐行 terminator 与混合行尾保留）；未修改锚点协议、batch wire、proof 或原子写入语义；
- 先建立 14 项 mixed-EOL 回归矩阵（`cli/mixed_eol_test.go`，覆盖 replace/range/expansion/insert 首中末/EOF 追加/删除至 EOF/删除末行/删除全部/多编辑/BOM/replace-once/单项 verb），红后实现转绿；
- `LoadedTextFile` 改为 `Lines + LineEndings + HasUTF8BOM + Revision`，`len(Lines) == len(LineEndings)` 不变量；trailing newline 存在性由末行 terminator 表达；孤立 `\r` 属于行文本（无换行末行的尾部 `\r` 不再被吞掉，属修正）；
- 重建规则统一实现为 `rebuiltLineEndings(source, editDeltas, count)`：以与 CLI `editDeltas` 相同的物理顺序区间驱动，batch、replace-once 与单项 verb 三条路径共用（单项 verb 的消费区间由 firstChanged + linesDeleted 唯一确定）；新行取消费区间附近局部行尾，replacement 末行继承被替换范围末行 terminator，原 EOF 无终止行获得后继内容时补局部行尾，trailing newline 存在性最终强制保持；
- 移除 `HasMixedLineEndings`、`mixedLineEndingWarning` 与整文件归一化；插件移除对应 warning 本地化与测试，混合行尾集成测试改为断言未触及行字节保持；
- CLI 版本 2.2.2 → 2.3.0（行为变更），bundled `bin/hledit.exe` 已重建，插件 capabilities 断言同步；
- `splitTextFile` 预分配精确容量：parseTextFile 分配 12.69 MB/op（基线 12.56，+130KB 为 LineEndings 数组固有成本）；materialization 42.08 MB/op（基线 41.94），Phase 5 目标不变；
- 文档迁移完成：SPEC.md 新增 §4.4 Line terminators，根 README 行尾契约改写，MAINTENANCE 行尾 bullet 与验收版本更新，CHANGELOG 记录 2.3.0；
- `go test ./...`、`go vet`、`npm run check`（162 个 Node 测试，对 rebuilt binary）全量通过；`git diff --check` 通过；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第七批执行

- 执行范围为 Phase 4 全部六项（提交绑定的局部 change preview）；未修改 CLI、公开 schema、模型正文或 proof/queue 语义；
- 4.1：`selectProof` 成功分支返回 `consumedLines`（行号/锚点/文本的内部消费行集合），不进入公开工具 schema；
- 4.2：`findSingleLineRangeExpansionIssue` 改为消费行证据入参，不再接收完整文件字符串——护栏判定与 CLI 校验的快照一致；
- 4.3/4.4：新增 `src/change-preview.ts`：anchored apply 由消费行 + 请求 payload 按与 `editDeltas` 同构的物理顺序区间构建，块内最小 diff 复用 `generateDiffString(…, 0)` 后平移行号；replace-once 用请求 old/new + CLI 已验证消费区间起点；no-op 空 preview；上限 2000 行 / 256 KiB，超限保留首尾片段并标记 truncated；构建失败降级为 `details.previewError`，不改变 disposition；
- 4.5：TUI 优先渲染结构化 `details.changePreview`（渲染前重验结构，经文本桥复用现有自适应 diff 组件），历史结果回退存量 `details.diff`；新成功结果不再保存 `diff`/`patch`（buildDiffDetails 与 mixed 时代的全文件 diff 生成一并删除）；
- 4.6：删除 apply/replace-once 的 Node 前后完整文件读取与 `readUtf8File`；外部并发修改依构造不可能混入 preview（不再存在前后快照 diff），`diffError` 仅作为历史字段保留渲染；
- 新增 10 个回归（7 个 preview 单元 + 2 个集成 + 1 个 TUI 优先渲染），成功结果断言不含 `diff`/`patch`；`npm run check` 全量通过（171 个 Node 测试）；
- MAINTENANCE.md 已同步执行路径、changePreview 契约、TUI 回退与文件职责表；
- 未部署正式 Pi 运行目录，未执行 commit。

### 2026-07-25 第八批执行

- 执行范围为 Phase 5 全部四项（低风险内存 materialization 收敛）；revision、BOM、逐行 EOL、trailing newline 与原子写入语义不变，无 wire 变化；
- 5.1/5.2：`JoinLines`（string）替换为 `EncodeContent`（[]byte，精确容量单次分配）；batch、replace-once 与单项 verb 三条写入路径复用同一编码职责，revision 计算与原子写入直接消费同一份切片，不再有 string/[]byte 往返；
- 5.3：`atomicWriteIfRevision` 的 pre-commit 复检改用 `rawFileRevisionFromPath`（os.Open + 流式 SHA-256），错误映射与提交时序保持；
- 5.4：replace-once 结果切片按可精确计算的输出行数预分配（planner 与 rebuiltLineEndings 此前已预分配）；
- 实测（10 MiB，对比第四批基线）：输出 materialization 41.94 MB/op → 10.62 MB/op（目标 ~11 MB 达成，5 allocs）；pre-commit recheck 10.49 MB/op → 33,560 B/op（目标 <100 KB 达成，与 §3.4 流式原型完全一致）；EncodeContent 单次 1 alloc 10.49 MB；
- CLI 版本 2.3.0 → 2.3.1（纯内部优化），bundled binary 重建，插件断言与 MAINTENANCE 验收版本同步；
- `go test ./...`、`go vet`、`npm run check`（171 个 Node 测试，对 rebuilt binary）全量通过；
- 未部署正式 Pi 运行目录，未执行 commit。

## 14. 执行状态

- [x] Phase 0：回归基线与测量工具（注册预算、成功/no-op/guard/stale/proof/outcome-unknown 正文 snapshot、永久 Go 分配 benchmark 均已建立；queue/compaction/mixed-EOL/preview 回归按 §7 纪律随各自 Phase 首步建立）
- [x] Phase 1：常驻协议与模型正文压缩（1.1～1.4 已完成；1.4 保留 1 MiB wrapper 上限并以回归锁定最坏转义膨胀与 overflow `outcome_unknown` 语义）
- [x] Phase 2：evidence、并发、compaction 与 TUI correctness（2.1～2.4 已完成；no-op 记录为 read 是相对 §2.3 表格的有意精确化）
- [x] Phase 3：逐行 terminator 与混合行尾保留（3.1～3.3 已完成；CLI 2.3.0，mixed warning 契约已移除）
- [x] Phase 4：提交绑定的局部 change preview（4.1～4.6 已完成；新结果只保存 changePreview，历史 diff 保留渲染回退）
- [x] Phase 5：低风险内存 materialization 收敛（5.1～5.4 已完成；materialization 10.62 MB/op、recheck 33.6 KB/op，均达标）
- [ ] Phase 6：raw spans / projected document（可选，未批准）

路线图的全部已批准阶段（Phase 0～5，八批执行）均已完成；尚未部署或提交。Phase 6（raw spans / projected document）保持可选状态，仅在出现真实的几十/上百 MiB 稳定编辑需求并单独复审后启动。后续维护以 MAINTENANCE.md 与 SPEC.md 的当前契约为准。
