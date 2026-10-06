# pi-hledit-diff 维护与升级说明

本文记录 `pi-hledit-diff` 0.2.x 与 patched `hledit` CLI 3.x 之间的硬性契约、验证方式和升级约束。当前运行契约以代码、测试、README 和本文为准；版本变更历史见 [`cli/CHANGELOG.md`](../cli/CHANGELOG.md)。

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

插件执行 `bin/hledit.exe capabilities`。兼容响应必须满足：

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
- 默认 `limit` 为 160，公开上限 2000；它只执行连续范围读取，不接受 grep、literal、context 或 ignore_case。
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
- 固定调用 `search`。结果额外包含 `totalMatches`，`nextOffset` 仍是物理行游标；零命中不生成新 proof：响应 revision 与现有 evidence 相同时保留旧证据并回显当前 `proof_id`，revision 不同时清除该 canonical path 的旧 proof。
- 搜索返回的完整匹配/上下文行可以贡献局部 proof；搜索结果不保证连续覆盖，范围编辑缺口由 apply 内部自动分页补读。

读取结果的 proof 规则：插件对非零命中或普通范围 read 生成 `proof_id`，同时写入模型正文与 `details.proofId`；分页或后续显式 read/search 发出新 id，同 revision 下合并已验证行，且该 revision 内发出过的所有 id 都可提交（id 只标识"哪次读"，准确性由 revision、逐行覆盖与 CLI 复检保证）；revision 变化时旧 id 全部作废。`textTruncated` 行不建立 proof。proof id 形态是 `<进程随机三字母前缀><单调计数>`（如 `kqz7`），由 `src/proof-id.ts` 单点发号；它只参与相等比较，不是安全边界。前缀不可去掉：`restoreFromBranch` 会把转录里的历史 proof id 重新载回 store，纯计数器在进程重启后会与旧 id 相撞。

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
- 公开 schema 要求 `proof_id`，但不暴露 raw revision 或 CLI `proof`；插件仅接受该 canonical path 当前 revision 内发出过的 id，再从 branch evidence 注入每个消费行或 insert 依附行的完整 hidden proof；
- proof id 无效或跨路径使用时不启动 CLI；proof 行覆盖不完整时，apply 在同一 canonical file queue 内规划整批实际缺口，合并相邻或重叠窗口，并允许跨接最多两行已知源码以避免零碎缺口耗尽页数预算，但不跨越大段已知源码。锚点不匹配或身份歧义的窗口保留确认上下文。补读经 `recoveredReads` 与最终 `proof_id` 返回源码，调用方审阅后显式重提 batch，不自动重放修改；
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

Evidence 以 resolved canonical path 为 key，每个文件状态包含当前 `proofId` generation、raw-byte revision、完整观察行、verified rename alias 和 ambiguous token：

- 普通范围和搜索结果同 revision 按行合并；新 revision 替换旧 state。`textTruncated` 行不建立 proof；
- 零命中搜索同 revision 时保留旧 proof，revision 变化时清除；非零显式 read/search 发出新 proof id，同 revision 下继续合并已验证窗口，该 revision 内所有已发 id 均可提交。`invalid_proof_id` 先校验目标证据：完整时只给当前 id 与重提指令，不要求重读；缺口或身份不明时只给对应的定向读取。成功 apply 产生的新 revision 延续同一 generation 与 id 集合，使受控更新锚点可继续使用；
- apply 成功后，消费区间 evidence 被删除，区间外行按已验证 `editDeltas` 平移并用 `anchor-hash.ts` 自校验重算，再合并 `updatedAnchorSpans`；
- verified rename 仅在目标唯一、非歧义、同 revision，且替换后完整 proof 再次成立时内部规范化；CLI 仍复验 raw revision、proof 和全部 anchors，成功结果通过 `details.resolvedAnchors` 报告映射；
- 持续存活且可验证平移的目标保留 verified rename；旧 token 被当前行重新占用，或其源行/alias 最终目标被消费失联时进入 ambiguous set 并持续到显式重读，以防立即或延迟复用。`selectProof` 在 CLI 启动前拒绝 ambiguous token；只有直接读取覆盖当前行时才删除同 token 的旧身份并建立当前语义。`updatedAnchorSpans` 不自动消歧；
- 任一结构化拒绝携带不同合法 `currentRevision` 时淘汰旧 state；同 revision 的确认零写入拒绝保留。`source_changed_before_commit` 与 `outcome_unknown` 总是失效；
- 只有带合法 `currentRevision` 的完整未截断 `currentAnchors` 可建立新 revision evidence；stale 返回对应 `proof_id`，实时登记与 branch replay 保留同一 id；
- read 与 apply 都持有 `withFileMutationQueue(canonical path)` 覆盖 CLI、校验和 evidence 更新。同文件串行、不同文件可并行；
- branch/session 恢复只重放当前 branch 的结构化 tool-result details，包括经过完整 shape、path、proof usability 验证的被拒绝 apply `recoveredReads`，不解析聊天正文。可携带补读结果的拒绝码由 `read-result.ts` 的 `READ_PROOF_RECOVERY_CODES` 单点定义；新增携带页面的终止分支时必须登记。`proof_recovery_source_changed` 不携带页面，只经 `currentRevision` 失效旧证据。截断页不进入补读的 `recoveredReads`，普通 read 的完整行仍可逐行贡献 evidence。

容量限制：

- 单文件最多 10,000 records 或 4 MiB logical UTF-8 payload；
- session 最多 50,000 records 或 16 MiB；
- records 包括行、rename alias、ambiguous token 和当前 revision 的 proof id，payload 计入 path/token/text/id UTF-8 bytes；
- 单文件溢出先清空全部 state；只有触发更新的显式 read 窗口可作为 fresh evidence 重建，updated-anchor 溢出必须保持无 evidence，避免在丢失历史 ambiguity 后重新接受复用 token；fresh read 窗口本身过大时也保持无 evidence；
- session 溢出按 tool-result 顺序的 deterministic file-level touch 淘汰完整文件；实时执行与 branch replay 使用同一规则。
- apply 先合并本次消费/依附区间；源码行数加最少一个 proof id 已超过单文件 record 上限时，返回 `evidence_capacity_exceeded`，不启动 CLI，也不提示继续分页。拆分 batch 会失去整批原子性，必须在语义与授权允许时采用；
- 显式 read 超限后保留 fresh window，同时记录当前 revision 曾发生容量淘汰；后续 proof 仍有缺口时返回 `read_evidence_evicted`，提供定向读取并提醒停止反复全文件分页。它不表示所有缺口都由淘汰造成，也不扩大缓存或放宽校验。

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

插件验证 revision、统计、warning、每项 `editDeltas` 与 `updatedAnchorSpans`：delta 条数、区间、物理顺序、总和必须与公开 change 一一对应；窗口数量、`offset` 与 `desiredLimit` 必须与由 `editDeltas` 换算出的非空产出区间逐项对应（纯删除无窗口）。窗口不带上下文行，共享 CLI 侧 80 行 / 16 KiB 预算；首行超过剩余字节预算时可返回 `textTruncated:true` 的部分行，预算耗尽后的窗口以空 `lines` + `truncated:true` 保持可计数。malformed 或 request-inconsistent success 属于 `outcome_unknown`，不得用于 evidence。`contentChanged:false` 不触碰文件，但仍合并同 revision anchor window。

CLI 写入保留非空结果的 BOM 与未修改行尾，真实空末行必要地补 terminator；正文以 CR 结尾的已终止行使用 CRLF，避免丢失正文 CR。会把首字符 U+FEFF 重新解释为 BOM 的修改在 check/apply 共同入口零写入拒绝，删除全部逻辑行则生成真正空文件。CLI 拒绝 multi-hardlink target，保留 symlink entry，并在 temp sync 后、atomic replace 前复检原始字节 revision。recheck 与 rename 之间仍有极短外部竞态，不宣称线性化 CAS。

Windows 使用 `windows-sys` 处理 DACL，创建临时文件时即传入目标权限与继承状态；已有目标由 `ReplaceFileW` 保留附加流，flags 为 0，不忽略权限或元数据合并失败。每次事务预留唯一恢复路径：成功后仅清理本次文件，清理失败以含路径的成功 warning 返回；1177 部分替换失败时以不覆盖方式把原文件移回目标路径，成功即为零写入 `io` 错误。移回失败，或文档外错误后目标缺失时，保留候选与恢复文件，CLI 非零退出并输出路径，使插件走 `outcome_unknown` 失效旧 proof，并指示模型不要重建或覆盖目标、把路径交给用户处理。未知结果必须禁用候选 TempPath 的 RAII 清理；禁止覆盖式回滚或按名称、时间清理其他文件。

## 失败与子进程语义

`details.disposition`：

```ts
"succeeded" | "rejected" | "unavailable" | "outcome_unknown"
```

- `findChangeShapeIssue` 在 `selectProof` 之前拦截仅凭请求即可判定的自相矛盾：区间锚点倒置（`reversed_anchor_range`）、`lines` 行首粘贴了本次提交过或当前证据中存在的锚点 token（`anchor_token_in_lines`，在 file queue 内对照 `anchorTokens(path)`）。这类问题重读文件无法修复，必须让模型改参数，因此不得落到 `insufficient_read_proof` 的补读指令上；正文明确声明重读无效并给出交换/删前缀的具体动作。检测即拒绝，不自动修正——与 `prepareArguments` 只服务 read 的约定一致；
- 三个工具在 `execute()` 返回边界直接设置 Pi `isError`：插件侧 `insufficient_read_proof` 是可恢复补读结果，设为 `false`；其他非成功结果设为 `true`，包括 `source_line_truncated`、`proof_recovery_read_failed`、`proof_recovery_budget_exceeded` 和 `proof_recovery_source_changed`，要求调用方按失败原因调整动作；
- 读取错误码全集为 `range` / `binary` / `encoding` / `directory` / `io` / `pattern` / `broad_pattern`，每个码都必须有本地化 message，落到兜底分支等于只把错误码丢给模型；message 本身说不清下一步动作时再补 hint（`range` / `directory` / `pattern` / `broad_pattern`）。`pattern` 转发 CLI 的 RE2 编译原文（出错位置本身就是要改的东西）并点名 RE2 不支持 lookahead/lookbehind/backreference；`broad_pattern` 指向 `hledit_read_anchors`；
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
- 模型正文列出全部产出窗口中的 updated anchors：窗口里的行都是本次编辑新写入、模型没有旧锚点可用的行；区间外的行已由 evidence 平移与 verified rename 覆盖，CLI 不再返回。纯删除没有窗口，不输出 anchor 块；不完整提示只在窗口被 CLI 预算截断或产出行自身文本被截断时追加；
- expanded updated-anchor rows 只来自 `details.updatedAnchorSpans`，不解析模型正文；
- diff 在 120 列切换 split/unified，主题色、布局和高亮缓存必须在 `invalidate()` 正确清理；
- 差异底色使用 `theme.colors`、Pi TUI `mixColors()` 和 `theme.style()`，从当前宿主主题派生；终端默认颜色解析与 truecolor/256-color 输出由 Pi 处理；
- `session_before_compact` 从三个工具的结构化结果补充 fileOps：read/search 成功 → read；带严格验证 `recoveredReads` 的零写入 apply → read；apply content change → modified；apply no-op → read；`outcome_unknown` → modified；其余确认零写入结果不记录。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 三工具注册、apply queue 主流程、错误升级与 active-tool 生命周期。 |
| `src/schema.ts` | 三工具的严格 schema 与参数类型。 |
| `src/proof-id.ts` | 单调短 proof id 生成器。 |
| `src/read-transaction.ts` | read/search CLI、结果校验和 evidence 更新的 canonical queue 事务。 |
| `src/read-recovery.ts` | 整批 proof 缺口分页补读、共享预算与 revision 变化处理。 |
| `src/read-evidence.ts` | revision proof、rename/ambiguity、容量、重映射、失效与 branch replay。 |
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
2. proof 缺失、stale、token 复用零写入、显式重读后成功；
3. session branch 切换与 `/reload` 后 evidence/active set；
4. mixed EOL、BOM、trailing newline、中文/emoji preview；
5. expanded TUI 从 details 显示 anchors，正文格式变化不影响渲染。

CLI 缺失/2.x/legacy residue fallback、`source_changed_before_commit`、`outcome_unknown`、read/apply race、强制终止和 cache eviction 由自动化测试覆盖。真实 Pi 验收与正式部署均需单独执行；本次仓库实现不自动改变运行目录。

## 升级原则

1. 不恢复内容匹配替换、旧单工具协议或隐式 compatibility layer。
2. 不恢复修改后的额外 `read-range` 子进程或全文件 diff snapshot。
3. 不把完整 diff 发送给 LLM。
4. 不绕过 canonical `withFileMutationQueue()`、read proof 或 CLI 原子 batch。
5. 不自动 stale 重试，不让旧 token ambiguity 静默消失。
6. 不解除定向补读的预算上限，也不自动重放补读后的修改：预算是单次工具结果对上下文窗口的唯一约束，那一趟往返是"模型必须看过被消费的行"的执行点。
7. 修改协议后同步更新 CLI、插件、tracked binary、端到端测试和当前文档。
