# pi-hledit-diff 维护与升级说明

本文记录 `pi-hledit-diff` 0.2.x 与 Rust `hledit` CLI 3.x 之间的集成不变量、验证方式和升级约束。CLI wire 协议见 [SPEC.md](../cli/SPEC.md)，用户操作见 [README.md](./README.md)；历史变更通过 Git 查询。

## 仓库与部署边界

```text
hledit-toolkit/
├─ cli/                 # CLI 唯一维护源码
└─ pi-hledit-diff/      # Pi 插件开发源码与 bundled CLI
```

开发仓库不会自动更新 Pi 实际加载目录。正式部署只同步以下运行时白名单，之后执行 `/reload` 或开启新会话：

```text
pi-hledit-diff/
├─ index.ts
├─ package.json
├─ bin/
└─ src/
```

不得部署 `test/`、`node_modules/`、README、锁文件或 `tsconfig.json`；运行时依赖由 Pi 宿主提供，正式目录不执行 `npm install`。正式部署必须显式执行并逐文件核对，不由开发仓库自动完成。

## CLI capability 门禁

插件执行 `bin/hledit.exe capabilities`，按照 [CLI capability 规范](../cli/SPEC.md#2-capabilities) 验证响应。字段清单以该规范和 `src/cli.ts` 为准。

硬性规则：

- `version` 必须是 semver-like 3.x；2.x、未来未审阅 major 和 malformed version 均拒绝；
- 所有正 capability 必须严格为 `true`；
- 响应不得拥有已删除的 `contentReplaceOnce` 字段，即使其值为 `false`；
- 命令失败、非 JSON、缺字段或额外 legacy residue 都走现有内置 `edit` fallback；
- 不支持旧 CLI、旧 batch wire、旧 `delete.lines:[]`、无 proof 写入、内容匹配替换或自动 stale 重试。

## 工具协议与激活

插件注册三个 LLM 工具：

| 工具 | 职责 |
| --- | --- |
| `hledit_read_anchors` | 读取连续文本范围并返回 `LN#HASH` 锚点及结构化 snapshot。 |
| `hledit_search_anchors` | 按 RE2 正则或字面量模式搜索，并返回匹配/上下文锚点行。 |
| `hledit_apply_file_changes` | 对一个文件提交完整非冲突 change batch，原子应用并返回新锚点。 |

三个工具都声明 `constrainedSampling: { type: "json_schema", strict: "prefer" }`。CLI 健康时，active set 始终保留这三个工具、移除内置 `edit` 并保留无关工具；`session_tree` 和 `/reload` 后重新同步同一策略。CLI 不可用时恢复内置 `edit`。不存在 `/tools` 假设、动态 evidence 可见性、Plan Mode 联动或内置 `edit` 名称 override。

宿主基线为 Pi 0.99.0。三个工具均声明 `exposure: "model-only"`，保证读写结果进入模型转录并可按 branch 重放；Pi 的嵌套调用记录不保存完整工具结果，不能用于恢复 proof。read/search 的 annotations 声明本地只读，apply 声明本地破坏性写入；权限判断仍由宿主及权限扩展执行。

当前公开协议按 `JSON.stringify(parameters) + description + promptGuidelines` 计量，回归上限为 4,400 characters；精确值由测试输出和最终验证记录，不在文档中固化。

三个工具的路径在进入 CLI 与 canonical queue 前统一经 `normalizeToolPath` 处理：展开 `~` / `~/`（Windows 也支持 `~\`）、去除 `@` 前缀并转换 Windows MSYS 盘符。

### `hledit_read_anchors`

```ts
{
  path: string,
  offset?: number,
  limit?: number,
}
```

- 编辑现有非空可读文本文件前，使用该工具读取会被消费的全部连续原始行；普通 `read` 只用于参考或目标未定的探索。
- 默认 `limit` 为 160，公开上限 2000；仅省略参数时使用默认值，非法整数、非整数与超限值由 schema 拒绝。它只执行连续范围读取，不接受 grep、literal、context 或 ignore_case。
- 固定调用 `read-range`。响应验证 revision、总行数、连续性/递增顺序、锚点格式、分页和 source-line truncation；模型正文和 `details.read` 都由已验证结构生成。
- 单行超过 50 KiB JSON 页预算时仅返回截断文本；该行不建立 proof，但后续仍有物理行时提供 `nextOffset`。搜索同样在还有匹配/上下文行时提供续读游标。
- CLI 执行、响应验证和 evidence 更新是同一个 canonical file queue 事务。不得在队列外记录晚到 snapshot。

成功响应示例：

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

### `hledit_search_anchors`

```ts
{
  path: string,
  pattern: string,
  offset?: number,
  limit?: number,
  literal?: boolean,
  context?: number,
  ignore_case?: boolean,
}
```

- 默认 `pattern` 使用 RE2 兼容正则；Rust matcher 保留 ASCII Perl 类和词边界、Unicode 15.0 分类与大小写折叠。`literal:true` 切换为字面子串，`context` 添加匹配行前后的物理行，`ignore_case` 启用大小写不敏感匹配。
- 宽匹配模式会被 CLI 拒绝为 `broad_pattern`，不能用搜索工具伪装连续整文件读取；需要查看连续文件范围时改用 `hledit_read_anchors`。
- 固定调用 `search`。一次匹配遍历计算全文件 `totalMatches` 并收集有界页候选，随后按精确 JSON 字节预算渲染，不保存全文件命中索引。正文区分全文件匹配数和本页匹配/上下文源行数；offset 是返回源行下界，较早匹配仍可贡献后置上下文。零命中同 revision 保留旧证据并回显当前 proof，不同 revision 清除旧状态。
- 搜索返回的完整匹配/上下文行可以贡献局部 proof；搜索结果不保证连续覆盖，范围编辑缺口由 apply 内部自动分页补读。

读取结果的 proof 规则：非空 read/search 发出 `proof_id` 并写入正文与 `details.proofId`，同一证据代内合并完整行，保留尚未被容量淘汰的已发 id。proof 定义 token 的原始坐标空间，不能随编辑改为指向新目标；外部 revision 变化会失效旧状态，已验证 apply 则建立新代并保留受限的历史迁移。`textTruncated` 行不建立 proof。`src/proof-id.ts` 使用 96 位随机进程 nonce 加 BigInt 单调序号，降低重启后与历史 id 碰撞的风险；id 不是授权凭证，正确性仍依赖来源、逐行覆盖和 CLI revision 复检。

### `hledit_apply_file_changes`

```ts
{
  path: string,
  proof_id: string,
  changes: [
    { operation: "replace_range", start_anchor: "12#aB3", end_anchor: "18#xY7", lines: "new line\nanother line" },
    { operation: "delete_range", start_anchor: "24#nK2", end_anchor: "29#Qw_" },
    { operation: "insert_before", anchor: "30#xY7", lines: "before" },
    { operation: "insert_after", anchor: "31#Qw_", lines: "after" }
  ]
}
```

规则：

- 一次调用只修改一个文件，并包含该文件全部非冲突 change；
- 范围包含首尾，单行范围复制同一锚点两次；insert 只复制依附行锚点；
- `lines` 只接受换行分隔字符串；一个末尾换行只终止末行，空字符串代表一行空文本；`delete_range` 不接受 `lines`；
- apply 不接受数组 `lines`、序列化 `changes`、单 change 自动包装或带源码后缀的 anchor；旧 operation、别名和字段不迁移，object 使用严格额外字段拒绝；
- 单次 batch 限 1–200 个 changes，replacement 总量限 1 MiB UTF-8，输出总量限 20,000 行；
- batch stdin request 总大小限 8 MiB；`lines` 与 `proof.anchors` 的每个元素必须是 JSON 字符串，`null` 等类型会被拒绝；
- CLI 的每个 `lines` 元素必须是一行逻辑文本，拒绝实际 NUL 和内嵌 LF；公开工具仍用换行分隔字符串，由插件拆分成行数组。拒绝携带具体 change 与内容原因，不引导调用方无效重读；
- 公开 schema 要求 `proof_id`，不暴露 raw revision 或 CLI `proof`。先验证 canonical path 归属，再按该 proof 的坐标代解释端点、范围和覆盖；历史目标只有在逐行存续且映射连续时才规范化为当前坐标，并注入完整 hidden proof；
- 跨文件、未知 proof、目标越界或已消费时不启动编辑 CLI，并给出单一终止/重新定位动作。当前坐标的覆盖缺口才规划补读，合并相邻窗口并最多跨接两行已知源码；锚点不匹配保留确认上下文。结果返回 `recoveredReads` 与最终 proof，调用方审阅后显式重提，不自动重放修改；
- 定向补读共享硬预算（`src/read-recovery.ts`）：计划窗口累计 1,200 行（含确认上下文）、4 页、96 KiB 正文。累计行数超限时不启动子进程；页数或正文超限时保留已返回页面并列出剩余窗口，返回 `proof_recovery_budget_exceeded`。预算按整批计算，不按每个 change 重置，也不按远端窗口之间的距离计数；
- 多页补读正文不带中间页续读指令，由最终结果统一给出下一步。正文与 `details.proofId` 使用同一个最终 proof id；调用方在队列放行前经 `updateFromToolResult` 按返回页面顺序登记。实时执行与 branch replay 使用相同的登记顺序和容量淘汰规则；
- 补读 revision 与计划或先前页面不一致时，返回 `proof_recovery_source_changed`，丢弃此次所有补读页且不发出 proof id；错误携带 `currentRevision`，让实时状态和分支重放均失效旧 evidence，调用方必须重新确认目标。source-line truncation 返回终止性指导，read 失败通过 `recoveryReadError` 暴露；
- 仅对命中 `single_line_range_expansion` 启发式的请求先执行一次 `batch --check`，用于确认当前 revision、hidden proof、全部锚点与操作冲突后再返回字段级指导；普通 apply 直接执行非 check `batch`，CLI 在同一路径完整验证并于原子替换前复检 raw-byte revision。

内部请求：

```json
{
  "edits": [{"op":"replace","pos":"12#aB3","end_pos":"13#Qw_","lines":["new block"]}],
  "proof": {"revision":"sha256:<digest>","anchors":["12#aB3","13#Qw_"]}
}
```

## Evidence 与并发不变量

Evidence 以 resolved canonical path 为 key，文件状态包含当前证据代及有界历史；`proof_id + LN#HASH` 共同定义目标身份：

- 同代 read/search 合并完整行，零命中保留已有 proof；观察到不同外部 revision 时失效旧状态。相同 revision 的合法 id 不因后续读取而失效，容量淘汰除外；
- 实际改变文件的 apply 产生新 proof/证据代，完整且已保留的 Updated anchors 可立即使用。无变化批次不推进代；空文件没有虚构行锚点；
- 消费区间不向新代继承身份；未消费行按验证后的 `editDeltas` 平移并用 `anchor-hash.ts` 重算。历史保存原始证据及原坐标到当前坐标的直接映射，不追逐别名链；
- 历史范围必须每条原始行存续、顺序不变、映射连续；中间插入新行、替换或删除旧行均阻止范围迁移。单独存续目标仍可继续编辑，规范化通过 `details.resolvedAnchors` 报告；
- 被消费目标不因 token 复用或本地 A→B→A 字节恢复而复活。新 proof 配同字面 token 表示新目标；调用方不得混用不同代的 proof 与 token；
- 不同合法 `currentRevision`、`source_changed_before_commit`、`outcome_unknown` 失效旧状态；同 revision 零写入拒绝保留证据。stale 仅对完整未截断 `currentAnchors` 发布新 proof；
- read/apply 持有 canonical queue 覆盖 CLI、校验及证据发布。同文件串行，不同文件并行；提交成功与后续证据可用性分开报告，证据无法保留不改报写入失败；
- 实时和 branch replay 使用同一 reducer，消费 `evidenceVersion: 2`、`baseProofId`、新 `proofId` 及发布顺序 `evidenceOrder`。Pi 并行结果按请求顺序落盘，重放在同一工具批次及运行实例内按发布序排序，不跨消息或重启边界重排；
- 只恢复当前 branch 的结构化 details；合法旧读取可恢复，无法证明身份转换的旧 apply 使状态失效，要求重读，不建立旧 id 到新代的隐式别名。补读页面仍由 `READ_PROOF_RECOVERY_CODES` 单点校验。

容量限制：

- 单文件最多 10,000 records 或 4 MiB logical UTF-8 payload；
- session 最多 50,000 records 或 16 MiB；
- records 包括各代行记录、proof id 和历史坐标映射；字节计费包括 path/token/text/id、坐标与代元数据，共享证据对象不重复计费。额度不是 JavaScript 进程实际堆内存上限；
- 最多保留 32 个历史代，超限或超预算先淘汰最老历史。当前证据仍超额时保留本次发布窗口；恢复时优先保留整个所需目标，其次回退至可保留的新页面。已淘汰 id 过期，不改指向新坐标；
- session 按发布顺序的 deterministic file-level touch 淘汰完整文件，实时与重放一致；
- 整批源行加一个 proof 已超 record 上限时提前拒绝；补读完成前模拟同一容量转换，若所需完整文本仍不能同时保留，返回终态 `evidence_capacity_exceeded`，不得提示可以重提或继续盲目分页。拆分会失去原子性，不自动进行；
- 同代曾发生容量淘汰且仍有覆盖缺口时返回 `read_evidence_evicted`，给出局部重新定位动作；只有预算允许且确实能补齐的窗口才给续读指令。

## CLI batch 与结果契约

Batch wire v3 是唯一 canonical 形状：`replace` 必须带 `lines`（可为空），`delete` 必须省略 `lines`，`insert` 必须带非空 `lines`，`after` 只能在 insert 上以 `true` 出现。CLI 在同一 snapshot 上验证 proof、全部 anchor 和物理冲突，再按 boundary 排序单次重建。

必须零写入拒绝：空 batch、非法 shape、stale/越界 anchor、proof 缺失或 revision mismatch、重叠消费范围、同 boundary 多 insert，以及落入消费范围内部 boundary 的 insert。范围前后 boundary 上位置明确的 insert 可接受。

成功非 check batch 必须包含：

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "contentChanged": true,
  "editsApplied": 1,
  "linesAdded": 1,
  "linesDeleted": 1,
  "editDeltas": [{"oldStart":12,"oldEnd":12,"delta":0}],
  "updatedAnchorSpans": [
    {
      "lines": [{"line":12,"anchor":"12#aB3","text":"updated","textTruncated":false}],
      "offset": 12,
      "limit": 1,
      "desiredLimit": 1,
      "truncated": false
    }
  ]
}
```

插件验证 revision、统计、warning、每项 `editDeltas` 与 `updatedAnchorSpans`：delta 条数、区间、物理顺序、总和必须与公开 change 一一对应；窗口数量、`offset` 与 `desiredLimit` 必须与由 `editDeltas` 换算出的非空产出区间逐项对应（纯删除无窗口）。窗口不带上下文行，共享 CLI 侧 80 行 / 16 KiB 预算；首行超过剩余字节预算时可返回 `textTruncated:true` 的部分行，预算耗尽后的窗口以空 `lines` + `truncated:true` 保持可计数。malformed 或 request-inconsistent success 属于 `outcome_unknown`，不得用于 evidence。`contentChanged:false` 不触碰文件，不消费身份或推进 proof 代。

CLI 写入保留非空结果的 BOM 与未修改行尾，真实空末行必要地补 terminator；正文以 CR 结尾的已终止行使用 CRLF，避免丢失正文 CR。会把首字符 U+FEFF 重新解释为 BOM 的修改在 check/apply 共同入口零写入拒绝，删除全部逻辑行则生成真正空文件。CLI 拒绝 multi-hardlink target，保留 symlink entry，并在 temp sync 后、atomic replace 前复检原始字节 revision。recheck 与 rename 之间仍有极短外部竞态，不宣称线性化 CAS。

Windows 使用 `windows-sys` 处理 DACL，创建临时文件时即传入目标权限与继承状态。创建描述符只包含 DACL 及其继承控制标志，不直接复用查询返回的完整安全描述符；Owner/primary group 使用创建令牌默认值，替换不保证保留原值。已有目标由 `ReplaceFileW` 保留附加流，flags 为 0，不忽略权限或元数据合并失败。每次事务预留唯一恢复路径：成功后仅清理本次文件，清理失败以含路径的成功 warning 返回；1177 部分替换失败时以不覆盖方式把原文件移回目标路径，成功即为零写入 `io` 错误。移回失败，或文档外错误后目标缺失时，保留候选与恢复文件，CLI 非零退出并输出路径，使插件走 `outcome_unknown` 失效旧 proof，并指示模型不要重建或覆盖目标、把路径交给用户处理。未知结果必须禁用候选 TempPath 的 RAII 清理；禁止覆盖式回滚或按名称、时间清理其他文件。

## 失败与子进程语义

`details.disposition`：

```ts
"succeeded" | "rejected" | "unavailable" | "outcome_unknown"
```

- `findChangeShapeIssue` 在 `selectProof` 之前拦截仅凭请求即可判定的自相矛盾：区间锚点倒置（`reversed_anchor_range`）、`lines` 行首粘贴了本次提交过或当前证据中存在的锚点 token（`anchor_token_in_lines`，在 file queue 内对照 `anchorTokens(path)`）。这类问题重读文件无法修复，必须让模型改参数，因此不得落到 `insufficient_read_proof` 的补读指令上；正文明确声明重读无效并给出交换/删前缀的具体动作。检测即拒绝，不自动修正——与 `prepareArguments` 只服务 read 的约定一致；
- 三个工具在 `execute()` 返回边界直接设置 Pi `isError`：插件侧 `insufficient_read_proof` 是可恢复补读结果，设为 `false`；其他非成功结果设为 `true`，包括 `source_line_truncated`、`proof_recovery_read_failed`、`proof_recovery_budget_exceeded` 和 `proof_recovery_source_changed`，要求调用方按失败原因调整动作；
- 读取错误码全集为 `range` / `binary` / `encoding` / `directory` / `io` / `pattern` / `broad_pattern`，每个码都必须有本地化 message，落到兜底分支等于只把错误码丢给模型；message 本身说不清下一步动作时再补 hint（`range` / `directory` / `pattern` / `broad_pattern`）。`pattern` 转发 CLI 的 RE2 编译原文（出错位置本身就是要改的东西）并点名 RE2 不支持 lookahead/lookbehind/backreference；`broad_pattern` 指向 `hledit_read_anchors`；
- 读取和写入的 `io` 拒绝保留简洁英文摘要，并在正文追加 `Diagnostic: <rawMessage>`，原样保留操作阶段、系统原文与错误码；`details.error.rawMessage` 和 disposition 不变，不自动重试；
- revision mismatch 仍为 `stale`，但 `failed:-1` 表示整批版本失效；CLI 从同一当前 snapshot 返回首项请求附近的有界 `currentAnchors`，不把版本变化说成端点锚点错误。完整 snapshot 供显式复核与续编，缺失或截断时按请求范围定向重读；stale remap 与 snapshot 均不触发自动修正或重试；
- `source_changed_before_commit` 是确认零写入；CLI 从未启动使用 `unavailable`；
- 已启动进程的取消、超时、输出超限、stdin 错误、非零退出或响应不完整按 `outcome_unknown`，先重读，禁止原样重试。

`runHledit` 正常完成等待 `close` 收齐 stdout/stderr。终止路径分离“请求终止”与“确认退出”：

- `child.kill()` 返回 true 只代表请求发出；
- 只有 spawn 确认失败，或进程发出 `exit` / `close`，才可 settle 并释放 file queue；
- grace period 后 Windows 使用 `taskkill /T /F`，其他平台使用 `SIGKILL`；
- 确认退出后主动销毁本地 stdio handles，并清理 listener、abort listener 和 timer；
- 若 OS 始终不确认退出，宁可阻塞该文件队列，也不在进程仍可能写入时提前返回。

默认 wrapper 输出上限为 1 MiB，作为异常或不兼容 CLI 输出的进程级保护；read JSON 已按最终 UTF-8 序列化结果限制为 50 KiB，不依赖 wrapper 吸收控制字符转义膨胀。

## Preview、TUI 与 compaction

- `details.changePreview` 只由同 revision 消费行 evidence、请求 payload 和已验证 delta 构成；不读取全文件 before/after snapshot，也不注入模型正文；
- preview 上限 2000 行 / 256 KiB，所有计数使用 UTF-8 bytes。超长单行保留首尾及 `textTruncated:true`；
- TUI 从 `details.read`、`details.changePreview` 与 `details.updatedAnchorSpans` 渲染读取、差异和更新锚点；preview 截断或没有可渲染 change 行时使用 CLI `linesAdded` / `linesDeleted`，不显示局部推导的完整 hunk 数；
- 失败 TUI 区分待复核（未写入）、未写入、未执行与结果未知；只有已返回可用 proof 的恢复结果标为待复核。展开错误正文使用终端换行，保留完整路径与指令；折叠摘要仍有单行宽度限制，模型正文不受影响；
- 模型正文展示产出窗口的 Updated anchors，完整且保留的行配合新 proof 可继续编辑；区间外存续目标由历史 proof/token 对迁移，CLI 不额外返回。纯删除没有窗口，不输出 anchor 块。截断或容量导致证据不完整时明确说明后续可用性，不能把展示当作完整 proof，也不能改报提交失败；
- expanded updated-anchor rows 只来自 `details.updatedAnchorSpans`，不解析模型正文；
- diff 按组件净宽扣除行号、标记和中缝后，每侧至少保留 60 列代码才切为 split；两位行号时需 141 列，行号更宽时相应提高。纯单侧或缺少操作关联的旧预览保持 unified；双栏左旧右新并保留独立行号与续行对齐；
- 两种布局沿用 `changePreview.lines` 的原文件操作位置顺序，只配对同一 `changeIndex` 的连续片段；单栏按每对旧行、新行依次展开，上下文仅显示一次，多出的行单独显示。双栏复用同一配对；不跨操作同文匹配，也不把 `oldLine` / `newLine` 混为同一套坐标排序。缺少操作关联的旧预览保持原始顺序；
- 差异使用按深浅主题和 truecolor/256-color 模式选择的独立整行红绿底色，保留语法高亮，不叠加字词级底色；摘要、上下文、空栏、中缝、省略行、边框和折叠提示固定使用 `#283228` 并填满宽度（取自 `pi-tool-display` 使用的 `classic-dark.toolSuccessBg`，256 色模式由宿主量化）。续行留空标记与行号，不显示箭头。`theme.style()` 处理内部 reset，单元格末尾恢复工具容器背景；主题色、布局和高亮缓存必须在 `invalidate()` 正确清理；
- `session_before_compact` 从三个工具的结构化结果补充 fileOps：read/search 成功 → read；带严格验证 `recoveredReads` 的零写入 apply → read；apply content change → modified；apply no-op → read；`outcome_unknown` → modified；其余确认零写入结果不记录。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 三工具注册、apply queue 主流程、错误升级与 active-tool 生命周期。 |
| `src/schema.ts` | 三工具的严格 schema 与参数类型。 |
| `src/proof-id.ts` | 96 位进程 nonce 与单调序号 proof id 生成器。 |
| `src/read-transaction.ts` | read/search CLI、结果校验和 evidence 更新的 canonical queue 事务。 |
| `src/read-recovery.ts` | 整批 proof 缺口分页补读、共享预算与 revision 变化处理。 |
| `src/read-evidence.ts` | proof 选择、目标迁移、恢复决策及发布/重放统一 reducer。 |
| `src/proof-state.ts` | 证据代、历史坐标转换、容量计费及淘汰。 |
| `src/file-changes.ts` | 四种公开 change → CLI batch、请求护栏及其拒绝信息。 |
| `src/cli.ts` | CLI 3.x capability 门禁、bounded output 和 exit-confirmed 进程终止。 |
| `src/result.ts` | 共享结果类型、disposition、edit delta 校验与结果构造器。 |
| `src/read-result.ts` | 读取响应校验、补读 metadata 校验及读取正文和错误提示。 |
| `src/apply-result.ts` | 写入响应校验、stale 诊断与写入结果正文；校验得到的 delta/span 直接用于 details 和更新锚点正文。 |
| `src/anchor.ts` / `src/anchor-hash.ts` | 规范锚点语法、行号提取与 hash 算法。 |
| `src/read-args.ts` | 工具路径归一化、读取/搜索参数与补读窗口。 |
| `src/change-preview.ts` | 提交绑定 preview、UTF-8 cap、结构重验和 diff 文本桥。 |
| `src/post-edit-context.ts` | `updatedAnchorSpans` 验证与模型正文格式化。 |
| `src/render.ts` / `src/diff-renderer.ts` | 结构化锚点与自适应 diff TUI；读取预览折叠时最多显示 12 个源码屏幕行，展开保留完整页面，模型正文与 proof 不受展示裁剪影响。 |
| `src/syntax-highlight.ts` | 两套 TUI 共用的语言解析与按行高亮缓存。 |
| `src/compaction-files.ts` | 三工具结构化结果的 compaction fileOps。 |

## 验证与 binary 更新

在覆盖 tracked binary 前验证仓库中的现有 binary：

```bash
cd pi-hledit-diff
npm ci
npm run test:bundled
```

随后执行：

```bash
cd ../cli
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
pwsh -NoProfile -File build-bundle.ps1
pwsh -NoProfile -File build-bundle.ps1 -VerifyOnly
cd ../pi-hledit-diff
npm run test:bundled
npm run check
```

`test:bundled` 必须覆盖 CLI contract、anchor hash 对拍、三工具激活与 tool-result 集成。Rust 工具链和依赖分别固定在 `rust-toolchain.toml` 与 `Cargo.lock`，Windows release 使用 Rust 随附 linker 与静态 CRT。构建脚本同步生成 binary、第三方许可和 `hledit.build.json`，后者记录规范化源码指纹、binary SHA-256、许可摘要与工具链。CI 在覆盖 tracked binary 前核对指纹并运行 bundled tests，再从源码构建并运行同一契约与 full check。平台运行库可能随构建机不同，不能把源码指纹检查描述成跨主机逐字节可复现或真实性签名；源码、锁文件、构建脚本或产物变化后必须重新构建与核对。

## 真实 Pi 验收

不复制到正式扩展目录时，可从仓库根目录隔离启动：

```bash
pi --no-extensions -e ./pi-hledit-diff/index.ts
```

用 `/hledit-status` 确认 CLI 3.4.0 与 capability 健康，并覆盖：

1. 连续 range read、正则/字面量 search/context 和四种 anchored operation；
2. 新 proof 链式续编、旧 proof 消费目标拒绝、存续目标迁移、stale 与容量恢复；
3. session branch 切换与 `/reload` 后 evidence/active set；
4. mixed EOL、BOM、trailing newline、中文/emoji preview；
5. expanded TUI 从 details 显示 anchors，正文格式变化不影响渲染。

CLI 缺失/2.x/legacy residue fallback、`source_changed_before_commit`、`outcome_unknown`、read/apply race、强制终止和 cache eviction 由自动化测试覆盖。真实 Pi 验收与正式部署均需单独执行；开发仓库不自动改变运行目录。

## 升级原则

1. 不恢复内容匹配替换、旧单工具协议或隐式 compatibility layer。
2. 不恢复修改后的额外 `read-range` 子进程或全文件 diff snapshot。
3. 不把完整 diff 发送给 LLM。
4. 不绕过 canonical `withFileMutationQueue()`、read proof 或 CLI 原子 batch。
5. 不自动 stale 重试，不把旧 proof 的已消费目标改解释成当前同字面 token。
6. 不解除定向补读的预算上限，也不自动重放补读后的修改：预算是单次工具结果对上下文窗口的唯一约束，那一趟往返是"模型必须看过被消费的行"的执行点。
7. 修改协议后同步更新 CLI、插件、tracked binary、端到端测试和当前文档。
