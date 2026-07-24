# hledit 编辑可靠性与 Token 效率改进计划

> 状态：Phase 0～3 已于 2026-07-23 完成实施与验证；Phase 4 未批准、未执行
> 范围：`cli/` 与 `pi-hledit-diff/` 之间的单文件锚点读取、批量编辑、失败恢复和工具激活链路
> 执行记录以第 11 节完成定义为准；各 Phase 内的未勾选条目保留为原始计划清单，不表示当前执行状态。

## 1. 背景

当前实现已经具备以下可靠性基础：

- v2 `LN#HASH` 锚点和严格解析；
- 同一原始快照上的 batch 校验；
- 非重叠编辑的单次重建；
- 原子文件替换；
- stale 时整批拒绝并返回受限当前锚点；
- 插件侧严格 schema、真实工具错误和文件 mutation queue；
- 成功后由 CLI 直接返回 `updatedAnchors`；
- diff 只进入工具 `details` 和 TUI，不进入模型正文。

本计划不替换这些机制，而是在其上解决以下问题：

1. 范围编辑只验证首尾锚点，范围内部变化可能未被发现；
2. CLI 从完成校验到原子替换之间仍有外部并发窗口；
3. batch 子进程异常结束时，插件不能总是确定文件是否已经写入；
4. 默认锚点读取和部分成功/失败正文仍可进一步压缩；
5. 插件的模型意图护栏依赖额外 `batch --check` 保证 CLI 错误优先级，职责边界需明确保留；
6. CLI 底层 batch 请求对无关字段和同一物理插入点的约束不足。

## 2. 目标

### 2.1 可靠性

- 范围替换和删除必须证明目标范围的全部原始行仍与最近读取证据一致，而不只校验首尾行。
- 插件不得自动修正 stale 锚点、猜测范围或重试结果未知的 batch。
- 任一可确认的校验失败必须保证零写入；无法确认子进程结果时必须明确报告“结果未知”。
- CLI 的 stale、范围、冲突、check 和 apply 必须复用同一个规划核心；模型意图护栏继续由插件负责。

### 2.2 Token 效率

- 未显式指定 `limit` 的锚点读取默认只返回适合局部编辑的窗口。
- no-op、stale 和结果未知正文只包含下一步决策所需信息，不重复结构化细节。
- 新增并发证明不得要求模型复制文件 revision 或内部范围锚点；这些信息由插件维护并注入 CLI 请求。
- 不通过动态隐藏 apply 节省 schema token；专用局部编辑路径的稳定可见性优先于这部分 token 优化。

### 2.3 可维护性

- CLI 使用明确的 `parse → plan → commit` 边界；check 和 apply 是独立入口，不通过模式参数让一个函数承担两种行为。
- 文件状态、锚点和物理冲突由 CLI 判断；插件负责公开工具协议、读取证据、模型意图护栏、恢复正文和 TUI。
- 每个协议变化同时更新 CLI、bundled CLI、插件 capability、测试和维护文档。

## 3. 非目标

本计划不包含：

- AST、tree-sitter 或语义代码编辑；
- 多文件事务；
- ripgrep 集成；
- 写入后的语法或构建校验；
- 自动 stale 重试；
- 自动合并用户或外部编辑器的并发修改；
- 公共工具重新合并为带 `op` 参数的万能工具；
- 立即升级 v2 三字符锚点协议；
- 发布流程、GoReleaser 或跨平台发行矩阵建设。

## 4. 必须保持的不变量

1. 插件公开 `hledit_read_anchors`、`hledit_apply_file_changes` 与独立的 `hledit_replace_once`；前两者保持锚点 proof 语义，后者以唯一精确内容为前置条件。
2. 一次 apply 只修改一个文件，且整批原子成功或原子失败。
3. 所有模型提交的 anchor 必须来自工具输出，不得生成或模糊匹配。
4. 插件不直接写目标文件，不绕过 `withFileMutationQueue()`。
5. CLI 在同一原始快照上验证所有 change，再进行一次内容重建和一次原子替换。
6. `--check` 不写入文件，且与真实 apply 共享相同的规划和验证结果。
7. batch 拒绝只有在 CLI 能证明未进入写入阶段时才可声称“零写入”。
8. incompatible success、超时、取消、输出超限和异常退出不得建议原样重试。
9. diff 不进入模型正文；结构化详情继续放在 `details`。
10. 目标文件的 BOM、CRLF/LF 和末尾换行语义保持不变。
11. 正式 Pi 插件目录继续只部署 `index.ts`、`package.json`、`bin/` 和 `src/`。

## 5. 设计决策

### D1：分阶段实施，直接升级内部 wire protocol

先完成低风险正文和失败语义改进，并在同一阶段直接收紧内部 batch wire protocol；不保留旧 `delete.lines:[]` 形状或兼容分支。之后再重构 CLI planner，最后引入读取证明。每一阶段必须可独立验证和停止。

### D2：读取证明由插件自动维护

模型继续提交当前公开形状：

```ts
{
  path: string,
  changes: FileChange[],
}
```

revision 和目标范围内部锚点不加入 LLM 工具 schema。插件从已验证的读取结果、成功 batch 的 `updatedAnchors` 或完整 stale 快照中建立证据，并转换为内部 CLI 请求。

### D3：读取证明采用“文件 revision + read set”

文件 revision 对读取后发生的任意字节变化采取保守 stale；read set 则证明模型实际读取过目标范围的每一行，避免只复制首尾锚点就覆盖未读取的内部内容。因此内部 batch proof 同时包含：

```json
{
  "revision": "sha256:<digest>",
  "anchors": ["12#aB3", "13#Qw_", "14#xY7"]
}
```

规则：

- `replace` / `delete`：read set 必须覆盖原始范围中的每一行；
- `insert`：read set 必须覆盖插入所依附的锚点行；
- 多项 change 的 read set 去重后一次提交；
- CLI 必须验证 proof 覆盖全部 change，不能信任插件遗漏的行；
- 模型不可见 digest 和重复的内部锚点列表。

### D4：revision 基于目标文件原始字节

使用 Go 标准库 SHA-256 对目标文件原始字节计算 revision，避免 BOM、CRLF 和末尾换行归一化造成等价误判。revision 只用于并发前置条件，不替代现有锚点。

### D5：结果未知是独立失败类别

插件内部 disposition 扩展为：

```ts
"succeeded" | "rejected" | "unavailable" | "outcome_unknown"
```

- `rejected`：CLI 已确认在写入前拒绝，可声明零写入；
- `unavailable`：CLI/capability 在执行修改前不可用；
- `outcome_unknown`：已发起 batch，但插件不能证明是否写入，必须重新读取。

### D6：不夸大外部并发保证

revision 初始校验和写入前重新校验可以显著缩小外部修改窗口，但普通跨平台 rename 不能对不配合的外部写入者提供真正原子的 compare-and-swap。实现和文档必须明确：

- read set 能检测从读取证据到 CLI 加载快照之间的目标范围变化；
- pre-commit revision recheck 能检测规划期间发生的大部分变化；
- recheck 与 rename 之间仍有极短竞争窗口；
- 除非未来引入经过验证的平台锁定方案，否则不得宣称对任意外部进程实现线性化 CAS。

## 6. 分阶段实施

## Phase 0：执行前基线与文档对齐

### 工作项

- [ ] 确认工作区状态，记录与本计划无关的已有修改，不覆盖用户改动。
- [ ] 运行 CLI 和插件完整基线验证。
- [ ] 确认 bundled `hledit.exe` 的 capability 与源码一致。
- [ ] 核对 `cli/ROADMAP.md` 中“structured edits param”是否已由当前 `changes: object[]` 完成；若已完成，移除过期 deferred 项。
- [ ] 为内部 wire 直接升级预定 capability：`batchWireV3`；
- [ ] 为 Phase 3 读取证明预定 capability：`batchReadProof`。

### 验证命令

```bash
cd cli
go test ./...
go vet ./...

cd ../pi-hledit-diff
npm run check
```

### 完成条件

- 基线测试全部通过；
- 记录失败或环境限制；
- 未修改运行时行为。

---

## Phase 1：低风险优化与内部 wire 直接升级

Phase 1 不改变现有 CLI 成功响应的必需字段，也不引入读取证明；但会直接移除旧的内部 `delete.lines:[]` 形状，CLI 与插件必须同步更新，不提供旧 wire fallback。

### 1.1 降低默认读取窗口

目标文件：

- `pi-hledit-diff/src/read-args.ts`
- 对应 Node 测试

实施：

- [ ] 将默认读取量与硬上限拆开；
- [ ] `DEFAULT_READ_LIMIT = 160`；
- [ ] `MAX_READ_LIMIT = 2000` 保持不变；
- [ ] 显式 `limit` 继续允许 1～2000；
- [ ] 分页、`grep`、越界和 `nextOffset` 语义不变。

验收：

- 未传 `limit` 时 CLI 参数包含 `--limit 160`；
- 显式 `limit:2000` 仍被接受；
- 非法值仍在插件边界拒绝。

### 1.2 压缩 no-op 和 stale 正文

目标文件：

- `pi-hledit-diff/src/result.ts`
- `pi-hledit-diff/src/post-edit-context.ts`
- 对应正文和渲染测试

实施：

- [ ] `contentChanged:false` 时，模型正文只说明“无需修改；原锚点仍有效”及必要 warning；
- [ ] no-op 的结构化 `updatedAnchors` 继续保留在 `details`，TUI 可继续使用；
- [ ] stale 正文中同一 remap、当前锚点和当前源码行各只出现一次；
- [ ] 保留 change 编号、operation、字段名、提交锚点、当前锚点、当前文本、原子零写入和下一步动作；
- [ ] 截断或范围不完整时仍明确要求重新读取。

验收：

- no-op 不向模型重复发送 updated anchor 窗口；
- stale 恢复信息不因压缩而丢失；
- `details` 结构保持向后兼容。

### 1.3 规范化字符串形式的 `lines`

目标文件：

- `pi-hledit-diff/src/prepare-arguments.ts`
- 对应参数兼容测试

实施：

- [ ] 字符串形式的单个末尾 `\n` 或 `\r\n` 只表示文本终止，不隐式生成额外空行；
- [ ] 字符串内部的空行继续保留；
- [ ] 显式数组中的 `""` 继续表示调用方明确要求的空行；
- [ ] 数组元素包含 CR/LF 时继续拒绝，不静默拆分数组元素；
- [ ] 最多两层 JSON 结构解包约束不变。

### 1.4 直接重构 CLI batch wire 校验

目标文件：

- `cli/types.go` 与 `cli/edit.go`，Phase 2 后迁移到 batch request/planner 文件；
- `pi-hledit-diff/src/file-changes.ts`；
- `cli/PRD.md`、`pi-hledit-diff/MAINTENANCE.md` 和对应 Go/Node 协议测试。

实施：

- [ ] `delete` 请求必须省略 `lines` 字段；旧的 `lines:[]` 形状不再接受；
- [ ] 插件 `file-changes.ts` 生成 delete 时不再发送 `lines`；
- [ ] 非 `insert` 操作拒绝出现 `after` 字段，即使值为 `false`；
- [ ] `insert` 拒绝 `end_pos`；
- [ ] `insert` 要求非空 `lines`；
- [ ] `replace` 必须出现 `lines`；空数组继续表示删除；
- [ ] 使用能够区分字段缺失与空数组/零值的解析形状；
- [ ] 继续拒绝未知字段和尾随 JSON；
- [ ] 新 CLI 声明 `batchWireV3:true`，插件启动时将其列为必需 capability；
- [ ] 不实现旧 wire 的自动转换、降级或双格式发送。

验收：

- 所有非法字段组合在规划和写入前返回 `invalid`；
- 删除请求的唯一 canonical wire shape 是不含 `lines`；
- 拒绝路径不进入原子写入边界，目标文件内容与元数据保持不变。

### 1.5 识别结果未知

目标文件：

- `pi-hledit-diff/src/cli.ts`
- `pi-hledit-diff/src/result.ts`
- `pi-hledit-diff/index.ts`
- `pi-hledit-diff/src/render.ts`
- 对应进程失败、正文和 TUI 测试

实施：

- [ ] 只有在修改子进程尚未启动时才使用 `unavailable`；
- [ ] batch 启动后的超时、取消、输出超限、stdin 失败、无可验证 JSON 的异常退出和 incompatible success 归类为 `outcome_unknown`；
- [ ] 正文固定说明“文件可能已写入；禁止直接重试；先调用 `hledit_read_anchors`”；
- [ ] 不得在此路径声称零写入；
- [ ] `tool_result` 继续将其升级为 `isError:true`；
- [ ] mutation queue 继续等待子进程确认退出后再释放。

### Phase 1 完成条件

- [ ] Go 与 Node 测试全部通过；
- [ ] 新增边界测试覆盖上述每条规则；
- [ ] `git diff --check` 通过；
- [ ] `batchWireV3` 已在 CLI capability、插件 capability 校验、bundled CLI 和维护文档中同步；
- [ ] 不提供旧 `delete.lines:[]` 兼容或自动迁移；
- [ ] 不改变正常成功编辑的模型工作流。

---

## Phase 2：统一 CLI Batch Planner 与物理边界

### 2.1 建立纯规划核心

建议职责文件：

```text
cli/batch_request.go   # 严格解码和字段组合校验
cli/batch_plan.go      # 锚点、范围、物理冲突和单次重建规划
cli/batch_command.go   # check/apply 入口、写入和 JSON 结果
cli/edit.go            # 保留单项 CLI verb 或迁移其明确职责
```

最终文件名可按现有源码规模调整，但不得创建含糊的 `helpers.go`、`utils.go` 或仅转发的包装层。

核心形状：

```go
type BatchPlan struct {
    Edits          []PlannedEdit
    RebuiltLines   []string
    FirstChanged   int
    LastChanged    int
    LinesAdded     int
    LinesDeleted   int
    ContentChanged bool
}
```

实施：

- [ ] 解码请求后一次性建立不可变原始快照；
- [ ] 将 anchor 校验、范围合法性、物理边界冲突和重建统计收敛到 planner；
- [ ] `runBatchCheck` 与 `runBatchApply` 分别调用同一个 planner，不使用 `checkOnly bool` 控制两种行为；
- [ ] planner 不执行文件写入，也不判断仅对 LLM 调用有意义的编辑意图；
- [ ] apply 只消费成功 plan 并调用现有原子写入边界；
- [ ] 保留 no-op 不触碰目标文件的行为。

### 2.2 以物理插入边界检测冲突

规则：

```text
insert_before(line N) → boundary N-1
insert_after(line N)  → boundary N
```

实施：

- [ ] 两个 insert 映射到同一 boundary 时整批拒绝；
- [ ] insert boundary 落入 replace/delete 消费范围时整批拒绝；
- [ ] 错误返回涉及的 edit 序号和原始 anchor；
- [ ] 不自动决定多个 insert 的顺序或合并内容。

### 2.3 保持模型意图护栏在插件边界

单行 replacement 保留原行并追加多行在通用 CLI 语义上可能完全合法，但对 LLM 工具常表示误把单行范围当成代码块范围。因此该判断继续属于插件，而不是 CLI planner。

实施：

- [ ] 保留插件对“单行范围、输出多行且首行重复原行”的识别；
- [ ] 继续先执行一次 `batch --check`，确保 stale、冲突和非法请求优先于意图护栏返回；
- [ ] check 成功后只返回恢复指导，不继续执行真实 batch；
- [ ] 保留相邻显式 delete 放行、唯一后两行 delete 候选和真实 `insert_after` lines 行为；
- [ ] CLI planner 只提供通用编辑有效性，不为合法 CLI 操作增加面向模型的 `risky_edit` 拒绝；
- [ ] 不新增 `batchRiskDiagnostics` capability。

### Phase 2 完成条件

- [ ] check 与 apply 对相同请求给出同一 stale/conflict/invalid 结论；
- [ ] 物理边界冲突拒绝路径确认零写入；
- [ ] 插件意图护栏的错误优先级和恢复模板行为保持不变；
- [ ] planner 没有吸收 TUI、模型文案或插件公开 operation 的职责；
- [ ] bundled CLI、插件协议测试和 `MAINTENANCE.md` 同步更新；
- [ ] CLI 与插件完整测试通过。

---

## Phase 3：读取证据、revision 与范围内部校验

Phase 3 是本计划的核心安全升级，必须在 Phase 2 planner 稳定后实施。

### 3.1 扩展 CLI 协议

`read-range --json` 成功响应新增：

```json
{
  "revision": "sha256:<digest>"
}
```

插件发送的内部 batch 请求新增：

```json
{
  "proof": {
    "revision": "sha256:<digest>",
    "anchors": ["12#aB3", "13#Qw_", "14#xY7"]
  },
  "edits": []
}
```

成功 batch 的响应新增新文件 revision：

```json
{
  "revision": "sha256:<new-digest>"
}
```

stale/current snapshot 在可用时新增：

```json
{
  "currentRevision": "sha256:<current-digest>"
}
```

新增 capability：

```json
{
  "batchReadProof": true
}
```

兼容策略：

- 独立 CLI 可暂时接受不带 proof 的旧 batch，以保留现有命令行使用方式；
- 声明 `batchReadProof:true` 的 bundled CLI 必须完整实现 proof 校验；
- 插件一旦要求该 capability，所有 apply 都必须携带有效 proof，不提供降级写入路径；
- 是否在未来协议版本中让 proof 成为所有 CLI batch 的必需字段，另行决策。

### 3.2 CLI proof 校验顺序

planner 必须按以下顺序执行：

1. 严格解析请求；
2. 读取目标文件并计算原始字节 revision；
3. 比较请求 revision；
4. 验证 proof 中每个 anchor；
5. 验证 proof 覆盖每项 change 的全部原始消费范围或插入依附行；
6. 验证 edit anchor、范围和物理边界冲突；
7. 生成 `BatchPlan`；
8. `--check` 返回成功，不写入；
9. apply 在提交前重新读取或重新核对当前源文件 revision；
10. revision 变化则以 stale/changed-before-commit 拒绝；
11. revision 未变时执行现有原子替换；
12. 返回新 revision 与 `updatedAnchors`。

proof 规则：

- proof anchor 必须唯一、严格递增并属于同一文件 revision；
- 缺少任一目标范围内部行时返回 `insufficient_read_proof`；
- proof 中存在 stale、越界或格式错误 anchor 时整批拒绝；
- proof 不得扩展模型授权的编辑范围，只用于验证原始读取状态；
- no-op 也必须通过完整 proof 校验，但不触碰文件。

### 3.3 插件读取证据存储

建议新增：

```text
pi-hledit-diff/src/read-evidence.ts
```

职责：

- [ ] 记录成功 `hledit_read_anchors` 的 path、revision、返回行号和 anchors；
- [ ] 区分连续未过滤窗口与 `grep` 返回的离散行；
- [ ] 为每项 change 判断覆盖是否充分；
- [ ] 合并同一 revision 的多个读取窗口；
- [ ] revision 变化时丢弃该路径的旧证据；
- [ ] 成功 apply 后清除旧 revision 证据，只使用新 `updatedAnchors` 建立新证据；
- [ ] stale、outcome unknown 或不兼容响应后使旧证据失效；
- [ ] 只有完整 stale 当前窗口同时携带 `currentRevision` 且覆盖目标范围时，才允许其成为新证据；否则要求重新读取；
- [ ] 不把完整源码额外复制到模型正文。

证据恢复：

- [ ] `details.read` 保存 revision 和已验证窗口元数据；
- [ ] apply details 保存成功后的 revision 与 updated anchor 元数据；
- [ ] 在 Pi `session_start` / `session_tree` 中只从当前分支的有效工具结果重建证据；
- [ ] 发生 `/reload`、分支切换或无法证明状态时采用安全默认：要求重新读取；
- [ ] 不从普通聊天文本解析 anchor 或 revision。

### 3.4 锚点工具可见性与执行门控

实施前重新核对当前 Pi extension 文档和实际 provider 行为。

实施：

- [x] CLI capability 健康时始终启用 `hledit_read_anchors`、`hledit_apply_file_changes` 与 `hledit_replace_once`；读取证据只决定 apply 是否允许启动 batch，不决定工具是否可见。
- [x] 工具集合变化始终保留其他无关 active tools，并在锚点工具可用时继续替代内置 `edit`。
- [x] `session_tree` 后重新按当前分支恢复读取证据，但不沿用其他分支的证据，也不隐藏 apply。
- [x] 失败读取不建立写入证明；apply execute 独立验证目标 path 的证据，不能只依赖工具已激活。
- [x] 没有充分证据时返回直接可执行的定向读取建议，且不启动 batch。
- [x] provider 不支持原生 deferred tools 时仍保持功能正确，只是不保证 schema token 节省。
- [x] CLI capability 不可用时保留当前内置 `edit` fallback；该 fallback 不得被误记为锚点读取证据。

### 3.5 提交前 revision recheck

实施：

- [ ] 由原子写入边界在临时文件准备完成、目标替换开始前重新确认源文件 revision；
- [ ] recheck 失败返回结构化 `source_changed_before_commit`，清理本次临时文件并保持目标文件不变；
- [ ] 通过测试专用 seam 模拟 plan 与 commit 之间的外部修改，不增加生产配置开关；
- [ ] 保持 symlink 真实目标、普通文件和 hardlink 安全检查；
- [ ] 文档明确保留 D6 所述极短非原子竞争窗口。

### Phase 3 完成条件

- [ ] 修改范围内部任一行而保持首尾不变时，batch 必须 stale 且零写入；
- [ ] proof 不完整时 batch 必须拒绝且零写入；
- [ ] plan 和 commit 之间发生可检测外部修改时必须拒绝；
- [ ] revision、BOM、CRLF/LF 和末尾换行测试通过；
- [ ] 模型工具 schema 不新增 revision/read-set 字段；
- [ ] 没有读取证据时插件不会启动写入 batch；
- [ ] 成功 apply 后可使用其 updated anchor 证据进行受覆盖的后续编辑；
- [ ] capability、bundled CLI、插件、README、PRD 和维护文档同步更新；
- [ ] CLI、插件和 bundled CLI 端到端测试通过。

---

## Phase 4：v3 锚点协议评估，默认不执行

只有 Phase 1～3 完成并获得实际使用数据后，才决定是否启动。

评估项：

- 尾随空白是否应参与 hash；
- 三字符 18-bit hash 的实际碰撞风险；
- 四至六字符 hash 对模型 token 和复制错误率的影响；
- 是否需要把 capability 布尔集合收敛为明确协议版本；
- v2/v3 是否需要只读兼容，写入是否必须严格单版本。

约束：

- [ ] 不在 v2 中静默改变 hash 语义；
- [ ] 如实施，使用新 capability/协议版本并同时更新全部 fixture；
- [ ] 不长期维护多套自动降级写协议；
- [ ] 单独形成设计文档并再次复审后实施。

## 7. 依赖与执行顺序

```text
Phase 0
  ↓
Phase 1
  ↓
Phase 2 planner
  ↓
Phase 2 risk diagnostics
  ↓
Phase 3 CLI revision/proof
  ↓
Phase 3 plugin evidence
  ↓
Phase 3 dynamic activation
  ↓
Phase 4（可选、另行批准）
```

执行规则：

1. 每个 Phase 单独完成实现、测试和文档，再进入下一 Phase。
2. capability 变化必须在同一 Phase 内完成 CLI、bundled binary 和插件升级，禁止提交半兼容状态。
3. 每个 Phase 结束后记录实际改动、测试结果、偏离计划原因和剩余风险。
4. 若 planner 重构导致大量无关行为变化，停止并先缩小边界，不继续叠加 proof 协议。
5. 未经明确要求，不执行 git commit、分支、rebase、push 或正式插件目录部署。

## 8. 测试矩阵

| 类别 | 必测场景 | 预期 |
| --- | --- | --- |
| 读取默认值 | 未传 limit | 读取 160 行并返回正确 nextOffset |
| 读取上限 | 显式 limit 2000 | 接受并保持分页契约 |
| no-op | replacement 与原内容一致 | 不写文件，模型正文不重复新锚点 |
| stale 正文 | remap 与当前窗口重叠 | 每项事实只渲染一次，保留恢复动作 |
| lines 兼容 | `"a\nb\n"` | 归一化为 `a`、`b`，不增加隐式空行 |
| lines 显式空行 | `["a", ""]` | 保留调用方明确空行 |
| 非法 delete | delete 携带非空 lines | invalid，零写入 |
| 非法 after | replace/delete 出现 after | invalid，零写入 |
| 物理边界 | after N + before N+1 | conflict，零写入 |
| planner 一致性 | 相同请求 check/apply | 相同 stale/conflict/invalid 结论 |
| 高风险扩展 | 单行重复首行并扩成多行 | 插件在 check 成功后拒绝，返回真实修复建议 |
| 范围内部 stale | 中间行变化、首尾未变 | stale，零写入 |
| proof 缺失 | 少一个内部 anchor | insufficient_read_proof，零写入 |
| revision stale | 读取后任意字节变化 | stale，零写入 |
| pre-commit 变化 | 规划后、替换前修改源文件 | source_changed_before_commit |
| 结果未知 | batch 启动后超时/异常退出 | outcome_unknown，要求重新读取 |
| 取消纪律 | batch 被 abort | 等待子进程退出后释放 queue |
| 格式保留 | BOM、CRLF、末尾换行 | 修改后保持原语义 |
| no-op revision | proof 有效但内容不变 | 不触碰文件，返回当前 revision |
| 成功后证据 | 使用 updated anchors 二次编辑 | 覆盖充分时成功，否则要求读取 |
| session 分支 | 切到不含读取结果的分支 | 不复用另一分支证据 |
| grep 证据 | 离散 grep 行执行多行范围修改 | 证据不足，要求连续读取 |
| bundled E2E | 插件调用 bundled CLI | capability 和响应结构一致 |

## 9. 文档与部署清单

每个相关 Phase 同步检查：

- [ ] `README.md`
- [ ] `cli/PRD.md`
- [ ] `cli/ROADMAP.md`
- [ ] `pi-hledit-diff/README.md`
- [ ] `pi-hledit-diff/MAINTENANCE.md`
- [ ] CLI `capabilities` 输出及测试
- [ ] 插件 capability 要求及测试
- [ ] bundled `pi-hledit-diff/bin/hledit.exe`

部署时：

1. 从 `cli/` 源码构建 bundled binary；
2. 运行 CLI 完整测试和 capability 检查；
3. 运行插件 `npm run check`；
4. 仅按维护文档白名单同步运行时文件；
5. 在 Pi 中 `/reload` 或新开会话；
6. 执行真实 bundled CLI smoke test；
7. 不把测试、文档、lockfile、tsconfig 或 `node_modules` 部署到正式插件目录。

## 10. 风险与缓解

### 风险 A：默认读取窗口过小导致多一次读取

缓解：保留显式 `limit` 和 `nextOffset`；默认 160 是 token 与局部上下文的折中，执行后根据真实会话调整，而不增加自适应配置系统。

### 风险 B：正文压缩后模型缺少恢复信息

缓解：使用 golden tests 固定每类错误必须包含的字段和动作；只去重，不删除决策必要信息。

### 风险 C：planner 重构改变现有排序或 no-op 语义

缓解：先用现有测试锁定行为，再提取纯函数；Phase 2 不同时引入 proof wire protocol。

### 风险 D：隐藏证据状态与 Pi session 分支不一致

缓解：证据只从当前分支结构化 tool details 重建；无法证明时失效并要求重新读取，不从聊天文本恢复。

### 风险 E：capability 不匹配导致旧插件调用新 CLI 或反之

缓解：新增能力使用严格 capability；bundled CLI 与插件在同一 Phase 更新；不提供静默降级写路径。

### 风险 F：revision 被误解为完整跨进程 CAS

缓解：测试和文档明确 revision recheck 的能力边界；不对任意不配合外部写入者承诺线性化。

## 11. 全部完成定义

Phase 1～3 只有同时满足以下条件才视为完成：

- [x] 所有计划内代码和协议改动已实现；
- [x] CLI `go test ./...` 与 `go vet ./...` 通过；
- [x] 插件 `npm run check` 通过；
- [x] `git diff --check` 通过；
- [x] bundled CLI capability 与源码一致；
- [x] 新增测试覆盖 token、协议、风险、范围 proof、revision 和结果未知路径；
- [x] 文档与实际协议一致；
- [x] 没有恢复旧工具方言、自动 stale 重试或隐式兼容写路径；
- [x] 没有声称消除了 D6 中仍存在的极短外部竞争窗口；
- [x] 最终工作区差异经过人工复审；
- [x] Phase 1～3 原始完成记录未执行正式部署；后续版本的部署与真实窗口验收记录见第 13 节。

## 12. 复审记录

复审日期：2026-07-23。结论：Phase 1～3 可按顺序执行；Phase 4 仍需单独设计与批准。本次复审完成以下校正：

- [x] 安全性：区分可确认零写入的拒绝与 `outcome_unknown`，并明确 revision recheck 不是对任意外部进程的原子 CAS；
- [x] wire 决策：不保留现有 `delete.lines:[]` 兼容；直接使用不含 `lines` 的 canonical delete shape，并通过 `batchWireV3` 要求 CLI、插件和 bundled binary 同步交付；
- [x] 职责边界：撤回把 LLM 单行扩展意图护栏迁入通用 CLI 的初稿方案，护栏继续归插件，CLI planner 只处理文件事实和通用冲突；
- [x] 实施顺序：低风险压缩、planner、proof 三阶段相互隔离，每阶段均有独立停止点；
- [x] Session 行为：动态激活基于当前分支证据恢复；CLI 不可用时保留内置 `edit` fallback；
- [x] 测试充分性：覆盖成功、拒绝、no-op、stale、内部行变化、异常终止、物理边界和 session 分支；
- [x] 文档一致性：已在各 Phase 列出 README、PRD、ROADMAP、维护文档、capability 与 bundled binary 同步要求。

执行完成记录（2026-07-23）：Phase 0～3 已按复审顺序实施；最终验证为 201 个 Go 测试、`go vet ./...`、116 个 Node 测试、TypeScript typecheck、bundled capability 核对和 `git diff --check` 全部通过。正式 Pi 运行目录未部署。

复审后仍保留的已知限制：pre-commit revision recheck 与最终 rename 之间存在极短竞争窗口；在没有经过验证的平台锁定方案前，不宣称线性化 CAS。

## 13. 后续版本记录

### 2026-07-24

- 公开 `lines` 输入扩展为换行分隔字符串或单行字符串数组，执行层仍规范化为 `string[]`。
- CLI 与插件升级到 `2.1.0`：新增 `contentReplaceOnce:true` 和 `hledit_replace_once` / `replace-once`，严格要求唯一连续精确匹配、原子 revision 复检及零/多匹配零写入。
- 修复后段编辑的 `updatedAnchors` 局部窗口错误取自文件开头的问题；插件只在完整返回窗口覆盖目标时复用新锚点。
- 模型可见工具提示与 schema 描述使用英文；工具失败正文与恢复指引使用英文，成功 UI 和警告保留中文。
- 运行时白名单已同步到 Pi 全局扩展目录，bundled capability、自动回归和真实 Pi 窗口测试均通过。
