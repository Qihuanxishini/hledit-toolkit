# 锚点编辑收敛与可靠性加固计划

> 状态：计划已编写，尚未开始实现
> 日期：2026-07-30
> 范围：`cli/`、`pi-hledit-diff/`、bundled CLI、当前协议文档与 CI
> 前置决策：完整移除 `replace-once`；正常修改非空且可完整读取的文本文件时，锚点读取与原子 batch 编辑继续作为唯一受支持路径

## 1. 背景

当前实现已经具备完整 read proof、raw-byte revision、单文件 mutation queue、提交前 revision 复检、原子 batch、混合行尾保留、成功后 evidence 重映射和 commit-bound preview。这些机制是项目的核心，不在本轮重写。

本轮解决以下已确认问题：

1. `hledit_replace_once` 与锚点编辑重叠，常驻协议成本和跨层维护成本高，且绕开 read proof；
2. 旧锚点 token 在一次成功编辑后可能被新内容重新占用，导致旧调用命中错误行；
3. `hledit_read_anchors` 的读取和 evidence 更新没有与同文件 mutation 共用队列，晚到的旧读取可能覆盖新 evidence；
4. evidence 没有内存上限；结构化零写入拒绝携带 `currentRevision` 时，插件也没有统一据此淘汰过期 evidence；
5. TUI 从模型正文反向解析 `updatedAnchors`，preview 的字节上限没有按 UTF-8 计算；
6. CLI 终止后只等待 `close`，kill 失败或流关闭异常时可能长期占用 mutation queue；
7. Windows CI 在测试前覆盖 bundled binary，不能先证明仓库中提交的 `hledit.exe` 与当前插件协议一致。

## 2. 目标

### 2.1 编辑协议收敛

- 删除 `replace-once` CLI verb、`contentReplaceOnce` capability 和 `hledit_replace_once` Pi 工具。
- 正常修改非空且可完整读取的文本文件时只使用锚点读取与原子 batch 编辑；既有空文件/source-line truncation 的 `write` 例外不变。
- 不把内容匹配重新塞入 batch schema，不新增模式字段或隐式 fallback。
- 删除专属于内容匹配的 schema、参数归一化、错误码、恢复正文、preview、render、compaction、evidence 和测试分支。

### 2.2 正确性

- 编辑后旧锚点 token 被当前其他行重新占用时，不得把旧调用解释为当前行调用。
- 同一文件的锚点读取、证据提交和修改提交必须按同一 canonical path 排序。
- evidence 失效只能导致补读，不得产生自动重试、模糊匹配或错误写入。

### 2.3 Pi 集成

- capability 健康时继续使用独立的 `hledit_read_anchors` 与 `hledit_apply_file_changes`，关闭 Pi 内置 `edit`。
- capability 不可用时停用插件工具并保留或恢复 Pi 内置 `edit`。
- 不新增工具选择命令，不覆盖标准 `edit` 名称，不在本轮重构现有 active-tool 同步与 fallback 生命周期。

### 2.4 有界资源与可诊断性

- evidence 使用有界缓存，超限时以失效/淘汰安全降级。
- preview 的 256 KiB 限制按 UTF-8 字节执行，超长单行仍保留明确截断信息和真实统计。
- mutation 子进程只有在确认未启动或已经退出后才释放队列。
- CI 在覆盖 bundled binary 前先验证仓库中已提交 binary 的当前协议。

## 3. 非目标

本计划不包含：

- AST、tree-sitter 或语义编辑；
- 多文件事务；
- v3 锚点 hash 协议；
- Phase 6 raw-span / projected-document 大文件重构；
- Linux、macOS、ARM binary 发行矩阵；
- npm 公共发布、GoReleaser 或安装器；
- 自动 stale 重试；
- 工具选择 UI、Plan Mode/第三方只读扩展联动或 active-tool 策略重构；
- 自动合并外部编辑；
- 写入后的语法、lint、构建或测试自动执行；
- 消除 revision recheck 与最终 rename 之间已知的极短竞争窗口。

## 4. 关键设计决策

### D1：`replace-once` 完整删除，不保留隐藏或 opt-in 路径

删除范围包括：

- `hledit replace-once <file>` 命令；
- `contentReplaceOnce` capability；
- `hledit_replace_once` 工具注册；
- 内容匹配请求、响应和错误类型；
- `content_not_found` / `content_ambiguous` 专用恢复链路；
- replace-once 专用 preview 和 evidence 更新；
- 当前 README、CLI README、PRD、SPEC 和维护文档中的有效契约；
- 专用生产文件和测试文件。

历史 `CHANGELOG.md` 中 2.1.0～2.3.1 的事实记录保留，不改写历史。`IMPLEMENTATION-PLAN.md`、`MULTILINE-LINES-IMPLEMENTATION-PLAN.md`、`OPTIMIZATION-ROADMAP.md` 与 `pi-hledit-diff/READ-FOR-EDIT-EXECUTION-PLAN.md` 保留原始记录，但在顶部增加“当前约束已被本计划取代”的说明。

升级后不保留旧 `hledit_replace_once` tool result 的专用渲染、compaction 分类或 evidence replay。恢复旧 session 时，这类历史结果按未知旧工具安全降级；若文件已变化，后续 batch 的 revision proof 会零写入拒绝并要求重读。

### D2：CLI 升级到 3.0.0

删除公开 verb 和 capability 属于 breaking change：

- CLI：`2.3.1` → `3.0.0`；
- Pi extension：`0.1.0` → `0.2.0`，并同步 `package-lock.json` 根包版本；
- capability JSON 不再输出 `contentReplaceOnce`；
- 插件 capability 类型和测试不再读取该字段；
- bundled `hledit.exe` 必须从当前 3.0.0 源码重建。

不增加“功能已删除”布尔 capability。为防止旧 2.x bundled binary 在删除该 capability 要求后被误判为健康，运行时门禁必须同时要求：CLI version 属于 3.x、全部剩余正向 capability 成立，并且响应自身不含 `contentReplaceOnce` 字段。2.x、任一剩余 capability 缺失、旧字段残留或 malformed 响应均走现有 built-in `edit` fallback；未来 major version 必须经显式兼容性复审后再放行。

### D3：保留专用工具名和现有 active-tool 策略

项目锁定的 Pi 0.82.x 文档与本计划审计时的宿主 Pi 0.83.0 都没有内置 `/tools` 命令；该命令只存在于需用户另行安装的 `examples/extensions/tools.ts` 示例中，本项目也不捆绑该示例。因此本计划不以 `/tools` 为前提，也不新增工具选择 UI。

Pi 虽支持扩展用同名工具覆盖 built-in，但官方文档要求 override 匹配 built-in 的精确结果形状（包括 `details`）。锚点 batch 的参数、错误恢复、evidence 和结果详情与内置 exact-text edit 明显不同，所以不覆盖标准 `edit`。

继续注册：

- `hledit_read_anchors`：专用读取工具；
- `hledit_apply_file_changes`：锚点 batch 修改工具。

删除 replace-once 后保留当前 active-tool 生命周期：

- capability 健康时，`preferAnchoredEditingTools` 移除 built-in/legacy edit 名称并确保两个 hledit 工具 active；
- `session_start` 完成 capability 探测后，以及 read、apply 和 `session_tree` 后，继续同步该健康工具集合；
- capability 不可用时，`preferBuiltInEditFallback` 停用 hledit 工具并恢复 built-in `edit`；
- 本轮只把健康工具集合从三个收敛为两个，不改变同步时机、权限策略或 fallback 语义。

### D4：锚点 token 复用视为歧义，不猜测身份

当旧锚点 `A` 因行号平移被验证映射到 `B`，或者 `A` 所属源行已被消费、当前或后续 evidence 又出现 token `A` 时，`A` 的身份都不再唯一，可能表示：

- 编辑前的旧目标；
- 编辑后当前坐标上的另一行。

插件必须将 `A` 标记为歧义 token：

- 使用 `A` 的 apply 在启动 CLI 前拒绝；
- 正文要求对当前目标执行显式 `hledit_read_anchors`；
- 一次覆盖当前行的明确新读取可以解除该 token 的歧义，并删除 `A` 作为旧 rename alias 的语义，以新读取语义为准；
- `updatedAnchors` 不能自动解除歧义，因为模型可能仍持有旧 token；
- 普通、不冲突的旧锚点继续返回 verified rename 提示。

### D5：读取也是 evidence 状态事务

`hledit_read_anchors` 虽不修改文件，但其“读取 CLI → 校验响应 → 更新 evidence”必须作为一个完整操作进入与写入相同的 canonical-path queue。

- 同文件 read/apply 串行；
- 不同文件仍可并行；
- queue 在 evidence 更新完成后释放；
- 失败读取不覆盖已有可验证 evidence；
- branch replay 继续按 session entry 顺序重建，不使用墙钟时间推断新旧 revision。

### D6：evidence 超限采用整文件安全淘汰

避免复杂的行级 LRU：

- 单文件最多保存 10,000 个 evidence records 或 4 MiB logical evidence payload；
- session 总 evidence 最多保存 50,000 个 records 或 16 MiB logical evidence payload；
- records 包括已读行、rename alias 和 ambiguous token；logical payload 计入 path、anchor/alias token 与行文本的 UTF-8 字节，避免大量短行或长期 rename 链绕过限制；
- 单文件超限时先删除该文件全部 state；只有触发更新的最新显式 read 窗口可作为 fresh evidence 尝试缓存，updated-anchor 窗口必须保持无 evidence 以免丢失 token reuse ambiguity；fresh read 自身超限也保持无 evidence；
- session 超限时按可重放的最近使用顺序淘汰完整文件 evidence；read/apply tool result 的 session 顺序负责 touch，不使用墙钟时间；
- 淘汰后 apply 返回定向补读，不启动 CLI batch；
- branch replay 执行同一套计数、touch 和淘汰规则，保证实时状态与恢复状态一致。

这些常量是内部安全缓存限制，不进入模型 schema。

### D7：结构化 details 是渲染真源

- TUI 直接使用 `details.updatedAnchors` 及其 offset/limit/truncated 元数据，不再从模型正文解析锚点；
- change preview 按 `Buffer.byteLength(..., "utf8")` 计费；
- 超长单行保留首尾裁剪和明确 truncation 元数据；
- diff 被截断时仍显示 CLI 已验证的 `linesAdded` / `linesDeleted`，不得出现误导性的 `+0 -0`；截断 preview 不把局部解析出的 hunk 数冒充完整 diff 统计；
- stale 正文中的重复复用警告只保留一份。

## 5. 分阶段实施

### Phase 0：基线、引用清单与版本门禁

#### 工作项

- [ ] 确认除本计划文件外工作区无预存改动，并记录当前 branch 与预期 untracked 状态。
- [ ] 运行 Go tests、`gofmt -l`、Go vet、Node check 和 `git diff --check` 基线。
- [ ] 用 `git grep` 建立 replace-once 生产代码、测试、当前文档、历史文档和 binary capability 引用清单。
- [ ] 记录当前公开工具协议字符数，删除后重新测量。
- [ ] 在 `cli/CHANGELOG.md` 中预定 3.0.0 breaking removal 条目；Phase 1 完成时转为正式版本段。

#### 完成条件

- 基线全部通过；
- 删除边界完整；
- 尚未改变运行时行为。

---

### Phase 1：完整移除 replace-once

#### 1.1 CLI

目标文件包括但不限于：

- `cli/main.go`
- `cli/replace_once.go`
- `cli/replace_once_test.go`
- `cli/types.go`
- `cli/mixed_eol_test.go`
- `cli/README.md`
- `cli/PRD.md`
- `cli/SPEC.md`
- `cli/CHANGELOG.md`

实施：

- [ ] 删除 `replace-once` dispatch、usage 和专用生产文件。
- [ ] 删除请求/错误/candidate 类型和仅由该命令使用的函数。
- [ ] 删除 `contentReplaceOnce` capability 和测试断言。
- [ ] 删除专用功能、竞态和 mixed-EOL 测试分支；共享 no-op/原子写入测试继续由 batch 与锚点 replace 覆盖，现有分配 benchmark 继续覆盖 batch 主路径。
- [ ] CLI 版本改为 3.0.0。
- [ ] 增加 Go 与 bundled-binary 负向测试：`replace-once` 被视为未知 verb，按 CLI misuse 返回 exit 2。
- [ ] 保留 batch、单项 replace/replace-range/insert 的公共 CLI 能力。
- [ ] 完成 CLI 删除与版本更新后立即按 release flags 重建仓库内 `pi-hledit-diff/bin/hledit.exe`，使本 Phase 的 Node 验收不依赖旧 2.3.1 binary。

#### 1.2 Pi extension

目标模块包括：

- `pi-hledit-diff/index.ts`
- `src/active-tools.ts`
- `src/schema.ts`
- `src/prepare-arguments.ts`
- `src/cli.ts`
- `src/file-changes.ts`
- `src/result.ts`
- `src/change-preview.ts`
- `src/read-evidence.ts`
- `src/compaction-files.ts`
- `src/render.ts`
- 对应测试文件

实施：

- [ ] 删除工具常量、schema、prompt、注册和 execute 路径。
- [ ] 删除 `runReplaceOnceWithDiff`、line-count 互核和单 delta 专用验证。
- [ ] 删除内容匹配错误码、候选范围和恢复正文。
- [ ] 删除 replace-once preview 构建和 TUI label/render 分支。
- [ ] 删除 evidence/branch replay/compaction 对该工具的识别。
- [ ] 删除专用测试文件，并从共享测试中删除相关 case。
- [ ] 将 capability 门禁改为 D2 的 3.x + 剩余正向 capability + 旧字段缺席规则，并覆盖旧 2.x 拒绝测试。
- [ ] 将 `package.json` 与 `package-lock.json` 根包版本同步到 0.2.0。
- [ ] capability 健康时的工具协议只剩锚点读取和 batch 编辑。
- [ ] 将工具协议预算测试更新到删除后的实际基线，并把两工具总协议预算锁定在不高于 6,600 字符（删除前实测 7,749）。

#### 1.3 当前文档

- [ ] 更新根 `README.md`。
- [ ] 更新 `pi-hledit-diff/README.md`。
- [ ] 更新 `pi-hledit-diff/MAINTENANCE.md`，同时纠正 `session_tree` active-tool 同步说明。
- [ ] 更新 `cli/README.md`、`cli/PRD.md` 与 `cli/SPEC.md` 当前命令、响应和文件布局。
- [ ] 给四份历史计划文档增加本计划的 superseded 说明，不删除历史执行记录。
- [ ] 历史 Changelog 保留旧版本曾有 replace-once 的记录，并新增 3.0.0 Removed 说明。

#### Phase 1 验收

- 当前生产代码和有效协议文档不再提供 replace-once；允许残留仅限历史 Changelog、superseded 历史计划、本计划、3.0 migration/removal 说明和“未知 verb”负向回归；
- CLI capability 不含 `contentReplaceOnce`，插件拒绝仍带该字段或 version 2.x 的响应；
- 插件只注册两个编辑相关定义；
- 仓库 bundled binary 已是 3.0.0，Go 与 Node 全量测试通过。

---

### Phase 2：修复 evidence 正确性和资源边界

#### 2.1 锚点 token 重新占用

目标：`pi-hledit-diff/src/read-evidence.ts`

实施：

- [ ] 在单文件 evidence 中记录 verified renames 和 ambiguous reused tokens。
- [ ] remap 与 `updatedAnchors` 合并后重新计算 alias/token 冲突。
- [ ] `selectProof` 在直接 endpoint 相等判断之前拒绝歧义 token。
- [ ] 明确的新 read 可解除其覆盖行上的歧义，并删除同 token 的旧 rename alias；`updatedAnchors` 不可解除。
- [ ] 恢复正文区分“旧锚点可直接替换为新锚点”与“token 身份歧义，必须重读”。

回归测试：

1. store 单元场景中，verified rename `A → B` 与当前 evidence token `A` 并存时标记歧义；
2. 端到端在目标行前插入相同文本后，旧 token 拒绝且不得修改新插入行；
3. 已消费行的 token 被移位重复行重新占用时拒绝；alias 最终目标被后续编辑消费后，延迟复用仍拒绝；
4. 显式重读后可以编辑当前行；
5. 无 token 复用且目标持续存活的普通平移仍返回可链接的 rename；
6. session branch replay 得到相同歧义状态。

#### 2.2 读取与 mutation queue

目标：`pi-hledit-diff/index.ts` 及相关执行测试。

实施：

- [ ] 在运行 read CLI 前解析 canonical evidence path。
- [ ] 将 CLI 读取、结果校验和 `ReadEvidenceStore` 更新放进同一文件队列。
- [ ] 不把 UI 渲染、通知或无关工具同步放在队列内。
- [ ] 增加受控并发测试，证明晚启动/晚完成的读取不能把成功 apply 后的新 evidence 回退到旧 revision。

#### 2.3 evidence 有界缓存

实施：

- [ ] 按 D6 增加每文件和 session 级 record 数、UTF-8 logical payload 计数。
- [ ] 使用可由 session entry 顺序重放的 file-level LRU/touch，不依赖 `Date.now()`。
- [ ] 超限按完整文件淘汰，不保留部分旧范围造成误解；最新窗口自身超限时也不缓存。
- [ ] `selectProof` 对淘汰证据返回现有定向补读结构。
- [ ] branch replay、成功 apply、stale snapshot 和普通 read 都经过同一容量入口。

#### 2.4 利用拒绝结果 revision

删除 replace-once 后，保留以下通用规则：

- [ ] 任一结构化拒绝如果携带合法 `currentRevision`，且与现有 evidence revision 不同，则立即失效旧 evidence；
- [ ] revision 相同的可确认零写入拒绝保留 evidence；
- [ ] `outcome_unknown` 和 `source_changed_before_commit` 继续失效；
- [ ] 只有完整、未截断 current anchor context 才建立新 evidence。

#### Phase 2 验收

- 已复现的错误行修改场景变为零写入拒绝；
- 同文件 read/apply 顺序稳定；
- evidence 超限只增加补读，不允许无 proof 写入；
- 实时执行与 branch replay 状态一致。

---

### Phase 3：结果渲染、终止纪律与 CI 加固

#### 3.1 结构化渲染

- [ ] `render.ts` 直接消费 `details.updatedAnchors`。
- [ ] 模型正文格式变化不影响 expanded TUI 的锚点窗口。
- [ ] legacy `details.diff` fallback 继续保留，直到历史 session 不再需要。

#### 3.2 preview UTF-8 上限

- [ ] 所有 preview byte 计算使用 `Buffer.byteLength`。
- [ ] 单行超过预算时保留裁剪后的首尾和 truncation 标记。
- [ ] TUI 在 preview 截断或没有可渲染 change 行时使用 CLI 统计，避免伪 `+0 -0`；截断时不展示由局部 preview 推导的完整 hunk 数。
- [ ] 增加中文、emoji、超长单行和“截断后统计仍来自 CLI”测试。

#### 3.3 stale 正文去重

- [ ] stale/current anchor snapshot 后只保留一次确认与重读要求。
- [ ] 不删除 failed change、operation、remap、零写入和下一步动作。
- [ ] 更新正文 golden tests。

#### 3.4 CLI 子进程退出

目标：`pi-hledit-diff/src/cli.ts`

- [ ] 分离“请求终止”“进程已 exit”“stdio 已 close”状态。
- [ ] 正常成功/失败仍等待 `close` 收齐 stdout/stderr；终止路径只把 `exit` 或 `close` 视为已退出确认。
- [ ] `error` 仅在 spawn 从未成功时证明“未启动”；已启动后的 kill/stream error 只记录诊断，不能单独释放 queue。
- [ ] 超时/abort/output overflow 后先请求终止；若短 grace period 内没有确认 exit，则执行平台强制终止（Windows process tree / POSIX `SIGKILL`）。
- [ ] `child.kill()` 返回 true 只表示信号请求已发出，不视为退出确认。
- [ ] 终止请求后的进程已 exit 时，不因 stdio `close` 事件迟到而永久占用 mutation queue；主动销毁剩余本地 stdio handles、清理 listener/timer 后再 settle。
- [ ] 未确认进程退出前不得释放同文件 queue。
- [ ] 结果继续归类为 `outcome_unknown`，要求重读，禁止原样重试。

测试覆盖正常退出、spawn 失败、首次 kill 生效、首次 kill 未生效后强制终止、abort、输出超限，以及 exit/close/error 的不同事件顺序。

#### 3.5 bundled binary CI

目标：`.github/workflows/ci.yml`、`pi-hledit-diff/package.json` 与 bundled contract tests。

调整 Windows job 顺序：

1. checkout、setup Go、setup Node、`npm ci`；
2. 对仓库内 tracked `bin/hledit.exe` 运行 `npm run test:bundled`，不得先写入该文件；
3. 从当前 Go 源码用与 release 相同的 flags 重新构建 `bin/hledit.exe`；
4. 运行 Windows Go tests 和插件全量 `npm run check`。

新增约束：

- [ ] `test:bundled` 至少覆盖 `cli.test.ts`、`anchor-hash.test.ts`、`activation.integration.test.ts` 与 `tool-result.integration.test.ts`；
- [ ] focused test 必须断言 CLI 3.0.0、完整剩余 capabilities、旧字段缺席、未知 `replace-once` 和两工具激活；
- [ ] tracked binary 若仍是 2.3.1 或仍暴露内容替换协议，CI 在覆盖前失败；
- [ ] 每次 CLI 公共行为变化必须同步版本、Changelog、binary 和 contract test；
- [ ] 不要求跨 Go patch version 的二进制逐字节可复现。

#### Phase 3 验收

- TUI 不依赖正文反解析；
- preview 真正满足 UTF-8 byte cap；
- 终止路径不会因为只等 `close` 而永久悬挂；
- CI 能在重新构建前发现 stale bundled binary。

---

### Phase 4：最终协议、binary、文档与真实 Pi 验收

#### 工作项

- [ ] 从 `cli/` 当前源码使用 release flags（`-trimpath -ldflags "-s -w"`）构建 `pi-hledit-diff/bin/hledit.exe`。
- [ ] 先运行 tracked-binary focused tests，再重建并运行 rebuilt-binary 全量测试。
- [ ] 更新所有当前文档、版本文件和安装白名单说明。
- [ ] 记录删除后的实际工具协议字符数，并确认两工具总预算不高于 6,600（删除前 7,749）。
- [ ] 使用 `pi --no-extensions -e ./pi-hledit-diff/index.ts` 启动隔离的真实 Pi smoke session；不复制到正式 extension 目录。

#### 真实 Pi smoke

1. `/hledit-status` 报告 CLI 3.0.x，模型可调用 `hledit_read_anchors` 与 `hledit_apply_file_changes`；
2. 完成一次 range replace、delete、insert before/after，确认实际工具调用均走两个专用工具；active-set 的精确断言由 activation integration test 锁定；
3. 触发一次 token 复用拒绝，确认零写入，显式重读后再成功编辑当前目标；
4. 切换 session branch 并执行 `/reload`，确认当前 branch evidence 与两个健康工具保持正确；
5. 检查 mixed CRLF/LF、BOM、末尾换行及中文/emoji preview 的代表性场景。

以下场景由自动化覆盖，不通过修改正式运行目录来模拟：CLI 缺失/2.x/旧字段残留时的 built-in edit fallback、`source_changed_before_commit`、`outcome_unknown`、受控 read/apply race、进程强制终止和大规模 cache eviction。

本计划不包含正式 Pi 运行目录部署。部署仍需单独明确授权。

## 6. 文件影响矩阵

| 区域 | 删除 | 修改 |
| --- | --- | --- |
| CLI 命令 | `replace_once.go`、专用测试 | `main.go`、`types.go`、版本、capability、tracked binary |
| 插件工具 | replace-once schema/execute/prompt | 保留专用 read/apply 与现有 active-tool/fallback 策略 |
| Package | 无 | `package.json`、`package-lock.json` 版本与 `test:bundled` script |
| Evidence | replace-once replay/更新 | token 歧义、read queue、容量、revision 失效 |
| Result/TUI | 内容匹配错误与 preview 分支 | details 真源、UTF-8 cap、stale 去重 |
| Compaction | replace-once 分类 | 保留自定义工具 fileOps 补充，记录 tree-summary 宿主限制 |
| 文档 | 当前 replace-once 契约 | 3.0.0、两工具工作流、策略说明、历史 superseded 链接 |
| CI | 无 | tracked binary 前置验证、release-flags 重建后全量验证 |

实际实施前以 `git grep` 清单为准；不得只按本表删除而遗漏共享类型或测试 fixture。

## 7. 测试矩阵

| 类别 | 场景 | 预期 |
| --- | --- | --- |
| 命令删除 | 调用 `replace-once` | exit 2，未知 verb，无写入 |
| capability | 运行 3.0.0 `capabilities` | version 3.0.0，无 `contentReplaceOnce` |
| 旧 binary 门禁 | 2.x 或仍带旧字段 | capability 不健康，built-in `edit` fallback |
| 工具集合 | 健康 CLI | 两个 hledit 工具 active，built-in edit inactive |
| 工具同步 | start/read/apply/tree/reload | 健康工具集合保持为两个专用工具 |
| fallback | CLI 缺失/malformed/不兼容 | hledit 工具 inactive，built-in `edit` 恢复 |
| token 复用 | 插入与目标相同文本 | 旧 token 拒绝且零写入 |
| token 消歧 | 对当前行显式重读 | 旧 alias 被移除，当前 token 可重新使用 |
| 普通 remap | 行平移但 token 未复用 | 返回 verified rename |
| read/apply race | 旧 read 晚完成 | 新 evidence 不回退 |
| 单文件上限 | 超出 record 数或字节限制 | 整文件 evidence 清除并要求补读 |
| session 上限 | 大量极短行、rename churn 或多文件超限 | deterministic file-level eviction |
| branch replay | 重放同一序列 | 与实时 evidence 状态一致 |
| render | 正文不含 anchor window | TUI 仍从 details 正常显示 |
| UTF-8 preview | 中文/emoji/超长单行超限 | 实际字节有界，CLI 统计正确，无伪 hunk |
| process abort | exit 早于 close | 确认 exit 后释放 queue |
| process kill | 首次终止未生效 | 强制终止后 outcome_unknown；确认 exit 前不放行 |
| binary parity | tracked exe 版本旧 | CI 在覆盖前失败 |
| 格式保留 | BOM/mixed EOL/trailing newline | 修改后原语义保持 |

## 8. 验证命令

```bash
cd pi-hledit-diff
npm ci
npm run test:bundled

cd ../cli
test -z "$(gofmt -l *.go)"
go test ./...
go vet ./...
go build -trimpath -ldflags "-s -w" -o ../pi-hledit-diff/bin/hledit.exe .

cd ../pi-hledit-diff
npm run test:bundled
npm run check

cd ..
git diff --check
! grep -nE '[[:blank:]]+$' ANCHOR-EDITING-HARDENING-PLAN.md
git status --short
```

第一次 `test:bundled` 验证仓库 checkout 中原有 tracked binary，必须发生在 rebuild 之前；第二次验证重建产物。`test:bundled` 使用 `package.json` 中的单一命名脚本，CI 不复制测试文件列表。

## 9. 风险与缓解

### 风险 A：token 歧义状态过于保守

缓解：只对身份已因平移后复用、源行消费或 alias 最终目标失联而不再唯一的 token 触发；仍可验证存活的 rename chain 继续提供恢复提示。歧义持续到覆盖当前行的明确重读，宁可增加一次读取，不允许猜测目标身份。

### 风险 B：evidence 淘汰增加重复读取

缓解：上限远高于单次 50 KiB/2,000 行读取，并把已读行、alias 与 ambiguous token 一并计入 record/byte 限制；按完整文件淘汰保持实现简单和状态清晰。观察真实会话后再调整常量，不增加配置系统。

### 风险 C：旧 session 的 replace-once 历史体验退化

缓解：不保留已删除工具的专用 renderer、compaction 或 replay 代码。旧 session 仍可浏览原始 tool result，但恢复后的 evidence 可能需要一次重读；raw revision proof 保证这种降级不会静默写错文件。

### 风险 D：自定义工具的 branch summary 文件标签不完整

缓解：compaction 继续由插件补充结构化 fileOps；tree-summary 缺少通用扩展入口属于宿主限制。该提示完整性不足不影响 revision、proof 或写入安全，不以不匹配 built-in result 契约的 edit override 换取自动标签。

### 风险 E：强制终止无法保证杀死 OS 级不可终止进程

缓解：释放队列的条件保持为“未启动或已确认 exit”；grace timeout 只升级终止手段。若 OS 仍未确认退出，宁可保持该文件队列阻塞并给出诊断，也不在进程可能写入时提前返回。

### 风险 F：删除历史内容导致版本记录失真

缓解：只删除当前有效协议，保留旧 Changelog 和计划执行记录，并增加 superseded 链接。

## 10. 完成定义

只有全部满足以下条件，本计划才视为完成：

- [x] replace-once 生产路径、公开工具、capability 和当前协议文档完整删除；
- [x] CLI 3.0.0、extension 0.2.0、`package-lock.json` 与 bundled binary 同步；
- [x] capability 门禁拒绝 2.x、旧字段残留、任一剩余 capability 缺失和 malformed 响应；
- [x] 旧锚点 token 的立即、消费后和延迟重新占用场景均零写入拒绝；存活 rename chain 保持可用，显式重读可以消歧；
- [x] read/evidence 与 mutation 使用同文件 canonical queue；
- [x] evidence 的 record 数与 UTF-8 logical payload 容量有界，alias/ambiguity 状态不能绕过限制，超限安全降级且 branch replay 一致；
- [x] 删除 replace-once 后，健康 active-tool 集合收敛为 read/apply 两个专用工具，现有同步与 fallback 语义不变；
- [x] 两工具公开协议预算不高于 6,600 字符，并记录实际测量值；
- [x] TUI 只从结构化 details 获取 updated anchors；
- [x] preview UTF-8 字节限制、超长行和截断统计显示正确；
- [x] 进程终止等待已确认 exit，不再只依赖 `close`；
- [x] CI 在覆盖前验证 tracked bundled binary；
- [x] Go tests、gofmt、Go vet、TypeScript typecheck、Node tests、bundled E2E 和 `git diff --check` 全部通过；
- [x] 当前 README、CLI README、PRD、SPEC、MAINTENANCE、Changelog 和四份历史计划 superseded 说明一致；
- [x] 未引入内容匹配 fallback、模式参数、自动 stale 重试，也未扩大既有空文件/source-line truncation 的 `write` 例外；
- [x] 未执行 commit、push、正式 Pi 部署或跨平台发行。

## 11. 实施记录

实施于 2026-07-30 完成：

- 删除 CLI `replace_once.go` / `replace_once_test.go`、Pi `test/replace-once.test.ts`，并移除 CLI verb/capability、插件 schema/execute/result/evidence/renderer/compaction 分支及当前文档契约；历史 Changelog 与四份计划仅增加 superseded 说明；
- CLI 升级到 3.0.0，插件与 lockfile 升级到 0.2.0；以 `-trimpath -ldflags="-s -w"` 重建 `pi-hledit-diff/bin/hledit.exe`，最终 capability 为 3.0.0、全部剩余正字段存在、`contentReplaceOnce` 不存在；
- 新增 token 立即/消费后/延迟复用歧义、存活 rename chain、显式读取消歧、canonical read transaction、容量与 revision 失效实现及测试；remap 或 updated-anchor overflow 均不得抹除旧身份歧义；新增 `src/read-transaction.ts` 封装 CLI read + 结果验证 + evidence 更新这一完整 queue 操作；
- 新增结构化 updated-anchor TUI、UTF-8 preview cap/超长行裁剪、CLI 完整统计、stale 正文去重，以及 exit-confirmed 子进程终止与 forced termination 测试；
- CI 在 build 前运行 tracked binary contract，build 后再次运行 bundled contract 与 full check；两工具协议实测 6,098 characters（read 1,312；apply 4,786）；
- 最终验证：Go 243 tests、`go vet ./...`、gofmt check；Node 195 tests、TypeScript typecheck；bundled contract 34 tests；`git diff --check` 全部通过；
- 与计划的实现偏离：无协议或安全语义偏离。为可单测完整 read queue 事务增加一个有职责的模块；历史 `details.diff` fallback 按计划保留，历史模型正文不再用于 updated-anchor 渲染；
- 剩余风险：OS 级不可终止进程仍会按安全策略阻塞对应 file queue；recheck 与 rename 之间的既有极短竞态仍存在；Pi tree-summary 对自定义工具的通用识别仍是宿主限制；
- 未执行交互式真实 Pi 工具循环或正式运行目录部署。工具注册、active set、branch replay、bundled CLI 与 tool-result 路径由隔离集成测试覆盖；如需正式部署与人工窗口验收，必须另行明确执行。
