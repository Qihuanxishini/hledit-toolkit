# Snapline 1.0 一次性重构实施方案

> 状态：**待实现的正式设计，不代表当前仓库行为**
> 文档版本：1.0
> 目标版本：Snapline CLI `1.0.0`、Pi 插件 `pi-snapline@1.0.0`、wire protocol `1`
> 当前基线：`hledit` CLI `3.0.0`、`pi-hledit-diff@0.2.0`、模型可见 `LN#HASH` 协议
> 发布方式：一次性 breaking cutover；不并行注册旧协议，不提供旧命令别名，不做 v3 会话迁移

## 1. 决策摘要

本方案把当前“模型读取并迁移 `LN#HASH` 锚点”的架构替换为“模型持有 opaque snapshot id 与该 snapshot 的行坐标，插件持有路径、revision、读取证据和编辑谱系”的架构。

最终公开命名如下：

| 层级 | 当前名称 | Snapline 1.0 名称 |
|---|---|---|
| 产品/CLI | `hledit` | `snapline` |
| Windows binary | `hledit.exe` | `snapline.exe` |
| Pi 插件目录/package | `pi-hledit-diff` | `pi-snapline` |
| Pi 插件显示名 | Hledit Diff | Snapline |
| 读取工具 | `hledit_read_anchors` | `snapline_read_file` |
| 编辑工具 | `hledit_apply_file_changes` | `snapline_apply_changes` |
| 模型编辑身份 | `LN#HASH` anchor | path-bound `snapshot` id + line coordinates |
| 插件状态 | `ReadEvidenceStore` | `SnapshotLedger` |

以下名称在新版本中不作为兼容入口保留：

- `hledit` / `hledit.exe`
- `pi-hledit-diff`
- `hledit_read_anchors`
- `hledit_apply_file_changes`
- `anchorProtocolV2`、`batchWireV3` 及其模型侧协议

源码仓库远端名称和本地通用目录 `cli/` 不属于运行时 API。方案评审时远端改名被保留为单独的外部高风险发布操作；2026-07-31 经用户另行确认，GitHub 仓库已改为 `Qihuanxishini/snapline`，Go module 同步为 `github.com/Qihuanxishini/snapline/cli`。运行时、帮助文本、binary、package、文档标题和工具名全部使用 Snapline。

## 2. 为什么要一次性替换

当前实现已经具备可靠的安全基础：

- raw-byte SHA-256 revision；
- 完整读取证据；
- 单文件原子 batch；
- commit 前 revision 二次检查；
- canonical-path 文件队列；
- started-process 异常后的 `outcome_unknown`；
- UTF-8、BOM、mixed EOL、末尾换行和原子替换保证；
- branch replay、容量边界与 compaction 集成。

剩余成本主要来自模型可见锚点，而不是底层写入：

1. 当前两个工具的 description、schema 与 prompt guidance 合计约 **6,098 characters**，其中 apply 约 **4,786 characters（78.5%）**。
2. 行移动后需要维护 anchor rename chain、token reuse ambiguity 和显式 disambiguation；安全拒绝会造成额外 read/fix/apply 回合。
3. 远距离 batch 只能返回一个连续 updated-anchor window，后续编辑位置容易失去可用证据。
4. 插件为了兼容历史参数形态承担了与新协议无关的 normalization 和错误分支。

最终候选 schema 已按 `description + JSON.stringify(parameters)` 的既有口径实测为 **2,652 characters**：read 470、apply 2,182。相对 6,098 静态协议下降约 **56.5%**；首个文本读取前只激活 read 时，Snapline 增量协议为 **470 characters**。

采用双协议、feature flag 或长期 compatibility wrapper 会同时保留两套状态机和两套提示，不满足本次“彻底、一步到位”的目标。因此 Snapline 1.0 只实现一个模型协议。

## 3. 目标与非目标

### 3.1 必须达到

1. 模型只看见 opaque snapshot id（通常为短 id，碰撞时为 full id）、行号和原始文本，不看见 hash、revision 或 proof payload。
2. 普通编辑维持两次模型工具调用：一次 read、一次 apply。
3. proof 缺失、谱系冲突、external stale 和 outcome unknown 都在当前 apply 调用内尝试恢复；目标仍是可读文本且窗口装得下预算时返回新 snapshot/context，否则返回明确 recovery failure/omitted ranges；绝不自动重试写入。
4. 同一文件的 resolve/read/translate/check/write/recovery 全窗口串行化。
5. 仍然由 CLI 执行 raw revision 检查、proof 校验、batch 规划、commit 前复查和原子写入。
6. 路径别名、符号链接、branch replay、容量淘汰、process cancellation 和插件 fallback 行为有明确契约。
7. 健康模式完全替换 Pi 内置 text read/edit；图片读取仍保持 Pi 原生能力。
8. 新版本不包含旧工具、旧 CLI 命令或旧会话兼容代码。

### 3.2 明确不做

- 不实现跨文件原子事务；每个文件独立原子。
- 不在 external stale 后自动重放或写入。
- 不在 outcome unknown 后自动提交相同请求。
- 不把完整文件文本复制到每个 snapshot node。
- 不实现 Phase 6 raw-spans/projected-document 大文件重构；除非真实指标证明有几十到几百 MiB 文件需求。
- 不覆盖 Pi 的 `grep`；保留 `write` 的公共名称/schema，但健康模式同名 override 只以 exclusive create 创建不存在的文件，防止绕过 snapshot 覆盖任何既有文本。既有空文件由 empty snapshot 的虚拟 boundary 进入 Snapline 原子事务；CLI unavailable fallback 才恢复 Pi 原生 `write` 语义。
- 不自动重命名远端仓库、发布账号或第三方 `hledit-mcp` 仓库。
- 不承诺旧 `hledit` standalone 命令、旧 MCP 客户端或旧 Pi session 可继续工作。

## 4. 不可削弱的安全不变量

实现前后都必须满足以下条件；任何优化若破坏其中一项必须停止：

1. **路径绑定**：snapshot 只属于一个 canonical target；同内容的两个文件也必须产生不同 id。
2. **读取后编辑**：模型只能修改在所提交 snapshot 下明确展示过的源行，或 apply receipt 明确映射出的新生成行；端点证据不能替代中间行证据。
3. **一致 snapshot**：一个 apply 中所有坐标都来自同一个 snapshot。
4. **原子 batch**：任一 change 无效、重叠、缺 proof、stale 或 pre-commit 失败时，整个文件零写入。
5. **双重 stale 防护**：CLI 先验证请求中的 raw revision，规划完成后、commit 前再次流式计算目标 raw revision。
6. **外部变化不翻译**：只有插件自己收到并验证成功结果的 edit lineage 才能用于坐标迁移；磁盘外部变化必须建立新 snapshot。
7. **目标被触及即拒绝**：历史编辑消费目标源行、在目标范围内部插入，或改变同一 insertion boundary 时，不自动迁移。
8. **不确定结果不重试**：进程已启动后超时、取消、超限、异常退出、不可解析或 success contract 不匹配，均按 `outcome_unknown` 处理。
9. **队列覆盖全过程**：canonical target 的 read-modify-write-recovery 在同一个 `withFileMutationQueue` 临界区内完成。
10. **字节属性保持**：UTF-8 BOM、每条原有行的 CRLF/LF 风格、末尾换行语义和权限/原子替换契约不回退。
11. **硬链接策略不回退**：若当前 CLI 会拒绝多硬链接目标，新版本继续拒绝；不能用 path snapshot 绕过。
12. **结果必须交叉验证**：插件只有在 source/new revision、effects、统计量、`contentChanged` 与请求全部相符时才接受 apply success。
13. **可见坐标不继承**：child snapshot 可以继承内部已验证文本，但不得自动继承 parent 的模型可见坐标范围；旧行号误配新 snapshot 必须因 exposure 缺失而拒绝。
14. **occurrence 唯一**：每个 changed apply 和外部恢复 root 都创建新的 occurrence-bound snapshot id；revision 离开后再回到相同字节也不得复用旧 lineage node。
15. **空文件仍受 snapshot 约束**：只有已展示的 zero-line snapshot 可在虚拟 before-line-1 boundary 创建内容；不存在的路径才允许 guarded `write` exclusive create。
16. **持久化降级必须保守**：任何 model-exposed line/empty boundary 都必须完整进入同一 tool result 的 bounded typed delta；delta 放不下的源码不展示为可编辑 exposure。runtime-only proof 在 branch replay 后可消失，且不能从模型正文或旧 tool arguments 猜回。

## 5. 总体架构

```text
Model
  │
  ├─ snapline_read_file(path, offset, limit)
  │      模型得到：snapshot id + 行坐标 + 文本
  │
  └─ snapline_apply_changes(path, snapshot, grouped changes)
         模型提交：snapshot id + 行坐标 + text
         │
Pi plugin: pi-snapline
  ├─ canonicalFileKey + withFileMutationQueue
  ├─ SnapshotLedger（隐藏 revision/proof/lineage）
  ├─ 坐标安全迁移与请求交叉验证
  ├─ CLI lifecycle / fallback / branch replay / compaction
  └─ TUI diff/result renderer
         │
Snapline CLI 1.0
  ├─ raw-byte load/revision
  ├─ proof 与 grouped batch validation
  ├─ deterministic plan / pre-commit revision recheck
  ├─ atomic write
  └─ structured effects/recovery contexts
```

职责边界：

- 模型负责选择它读过的行并描述目标变更。
- 插件负责证明这些行确实读过、将安全坐标映射到当前插件 lineage、串行化进程并验证 CLI 结果。
- CLI 负责信任边界内的文件解析、raw revision、batch 规划和原子提交。
- Pi 内置 read 只作为图片读取实现和 CLI 不可用时的 fallback，不参与 Snapline 文本证据。

## 6. 模型可见工具协议

### 6.1 `snapline_read_file`

公开参数固定为：

```ts
{
  path: string;
  offset?: integer; // 1-based，默认 1
  limit?: integer;  // 默认 160，必须 > 0
}
```

执行边界规则：

- `offset`/`limit` 的公开 schema 使用 strict integer；`offset < 1` 归一为 `1` 并记录 repair。
- 未提供 `limit` 时使用 `160`；`limit <= 0` 归一为默认值，`limit > 2,000` clamp 为 `2,000`，均进入 details/telemetry。
- 非空文件的 `offset > totalLines` 返回 `range_out_of_bounds`、总行数和建议范围；不创建可编辑 exposure，也不激活 apply。
- CLI 单次最多采集 2,000 个完整逻辑行，并以 50 KiB 未转义 UTF-8 行内容作为第一层上限；插件再按实际 `line:text`、notice 与 receipt 的 UTF-8 字节精确裁到 50 KiB 模型正文。只对最终完整展示的行建立 exposure，任何被第二层裁掉的尾部都进入 `omittedRanges`。
- 一条完整行放不下时只显示显式标记的 prefix，`next_offset` 仍指向该行；prefix 不能形成 proof。
- 文本行采用紧凑格式 `line:text`，不输出每行 hash；成功 body 末尾附短 receipt，例如：

```text
41:export function parseRequest(input: unknown) {
42:  // ...

[snapshot:s_Y7h2WvQ0mF4dK8p3 lines:41-120/387 next:121]
```

- snapshot id 是 opaque occurrence token；行坐标必须始终与展示它的 snapshot 配对，不能把旧行号改贴到 changed/recovery 返回的新 snapshot。
- 空文件返回 `total_lines: 0`、有效 snapshot 与一个 exposed virtual boundary；read 成功后激活 apply，且只允许 `insertions_before: [{line:1,...}]` 创建内容。不存在的路径才使用 guarded `write`。
- 插件的 text 路径先调用 bundled `snapline read`。CLI 只按 magic bytes 做最多 8 KiB 的 bounded binary/image preflight；若返回 `image_candidate`，插件才调用 Pi exported built-in read definition 完成受支持 MIME 的确认、缩放、vision content 和 renderer。
- 只有 Pi 原生结果实际包含 image content 时才作为成功图片读取返回；非图片 binary、NUL text 与 invalid UTF-8 返回结构化拒绝，不回退成 native text read。
- 图片读取不创建 snapshot、不增加 exposure，也不激活 apply。

### 6.2 `snapline_apply_changes`

公开参数固定为：

```ts
{
  path: string;
  snapshot: string;
  replacements?: Array<{
    start: integer;
    end: integer;
    text: string;
  }>;
  deletions?: Array<{
    start: integer;
    end: integer;
  }>;
  insertions_before?: Array<{
    line: integer;
    text: string;
  }>;
  insertions_after?: Array<{
    line: integer;
    text: string;
  }>;
}
```

- 所有公开 object 都是 strict object（`additionalProperties:false`）；四个 group 至少一个非空，不使用 operation discriminated union。
- `start`/`end`/`line` 都是所提交 snapshot 上的 1-based 行坐标；消费 range 必须被 `exposedCoverage` 完整覆盖，insertion 的 attachment line 必须已展示，且 `start <= end <= total_lines`。
- 唯一例外是 `total_lines === 0` 且该 node 的 virtual boundary 已展示：batch 只能含一项 `insertions_before(line=1)`，不需要虚构 proof line；空 `text` 在该分支因字节级 no-op 而拒绝。
- replacement/insertion 的 `text` 只使用 `\n` 分隔逻辑行；含 `\r` 或 NUL 时拒绝，避免输入换行风格和 binary 状态混淆。
- `text === ""` 在非空 source 表示一个空逻辑行，不表示删除；删除只能进入 `deletions`。
- 解码同时保留 `endsWithLF`，并精确移除一个 terminal empty segment：`"a\n" -> ["a"]`，`"a\n\n" -> ["a", ""]`，`"\n\n" -> ["", ""]`。非空 source 仍保持原 trailing-newline 状态；zero-line virtual insertion 才由 `endsWithLF` 定义新文件的 trailing newline。
- 不接受 string-array，不展开数组元素内的换行，不解析 JSON 包裹字符串，不接受旧 anchor 或旧 operation 对象。
- 每组最多 100 项，单次总 change 最多 200；所有 text 的 UTF-8 总量最多 1 MiB，解码后总 produced logical lines 最多 20,000。插件与 CLI 都验证。
- 所有 change 都相对于同一个 source snapshot 同时解释，不按 group 或数组书写顺序串行套用。

同 batch 冲突规则：

- replacement/deletion 消费区间不得重叠。
- insertion physical boundary 不得重复。`insertions_after(line=N)` 与 `insertions_before(line=N+1)` 是同一 boundary，必须拒绝。
- insertion boundary 不得位于 replacement/deletion 区间内部。
- 位于消费区间外侧边界的 insertion 允许：before `start` 在新内容前，after `end` 在新内容后。
- 规划按 source coordinates 确定后从文件尾部应用，结果不依赖 group 或数组顺序。

普通 changed success body 返回新 snapshot，并对可继续使用的新生成行给出有界映射：

```text
Applied 3 changes atomically. snapshot:s_p8M0v2xQ4nR6tY1a
produced:r0=41-42,ia0=81-82
```

`r`、`ib`、`ia` 分别表示 replacement、insertion-before、insertion-after 的 0-based group index。只有 receipt 中完整列出、且 exact generated text 已装入本次 `<=64 KiB` typed replay delta 的 produced range 才成为 child snapshot 的 model-exposed coverage；删除没有 produced range。receipt 最多 8 KiB，超出时列出 `produced_truncated`，未列出的范围必须 fresh read 后才能用 child snapshot 编辑。

旧读取坐标继续与原 source snapshot 配对，由插件沿 lineage 安全迁移；每次 changed apply 都返回不同 occurrence id，不得把旧坐标直接配上新 id。详细 effects、统计、revision 和 proof remap 只进入 typed details。no-op 必须准确报告，不创建伪 child 或伪 exposure。

### 6.3 工具描述预算

计数口径固定为每个工具的 `description.length + JSON.stringify(parameters).length`；两个 custom tools 都省略 `promptSnippet`/`promptGuidelines`，避免 apply additive activation 重建 system prompt 并破坏 native deferred cache。

公开 description 冻结为：

- read：`Read a text file and return numbered source plus a path-bound snapshot for safe editing. Images use Pi's native reader.`
- apply：`Atomically apply one non-overlapping batch to lines exposed by one snapshot. Keep coordinates with that snapshot; ranges are 1-based and inclusive. Invalid, conflicting, or stale requests write nothing. Text uses \n between logical lines. For an empty snapshot, insert before line 1; its final \n sets the new trailing newline.`

TypeBox structural options 也属于 golden contract：root/nested object 均 `additionalProperties:false`；path `minLength:1`；所有 coordinate integer `minimum:1`；limit `maximum:2000`；snapshot pattern 为 `^s_[A-Za-z0-9_-]{16}(?:[A-Za-z0-9_-]{27})?$`；四个 array 均 `minItems:1,maxItems:100`。字段 description 固定为 `Text file path.`、`First line (1-based; default 1).`、`Maximum lines (default 160; 2,000 max).`、`Snapshot returned by snapline_read_file.`、`First source line (inclusive).`、`Last source line (inclusive).`、`Source attachment line.` 和 `New logical lines separated by \n.`。数组 description 固定为 `Replace inclusive source ranges.`、`Delete inclusive source ranges.`、`Insert before source lines.`、`Insert after source lines.`。

按上述 schema 的稳定序列化原型实测：read **470**、apply **2,182**、合计 **2,652 characters**。门禁仍留余量：read `<=600`、apply `<=2,400`、合计 `<=3,000`。CI 必须用同一计数函数做 exact-description golden/budget test；不得通过删除安全契约而压预算。

## 7. Snapshot 身份与 Ledger

### 7.1 snapshot id

插件为每个新 lineage occurrence 生成 128-bit random nonce，并得到：

```text
canonicalFileKey = canonicalized real target identity
revision         = "sha256:" + 64 lowercase hex(SHA-256(raw file bytes))
nonce            = base64url(16 cryptographically random bytes)
digest           = SHA-256(UTF8("snapline\0" + canonicalFileKey + "\0" + revision + "\0" + nonce))
snapshot id      = "s_" + base64url(digest)[0:16]
```

16 个 base64url 字符提供 96-bit 前缀；nonce/digest/id 都写入 bounded typed details，随机源可在测试中注入。Ledger 保留完整 digest 与 occurrence node：

- 同一 head revision 的重复 read 合并到当前 occurrence，复用 id；
- 每次 changed apply、external-stale root 和 outcome-unknown recovery root 都使用新 nonce，即使 raw revision 曾出现过也得到新 id；
- 相同内容的不同 canonical target 得到不同 digest；
- 若一个 96-bit prefix 对应不同 full digest，所有碰撞 occurrence 改用完整 43 字符 digest id，短 prefix 标记为 ambiguous；已发出的短 token 只会安全拒绝并要求 fresh read，绝不继续绑定其中一个对象；
- apply 同时验证传入 path 的 canonical key、snapshot occurrence 和当前 branch ancestry，不能只凭短 id 查找。

snapshot id 不是安全 secret，也不是 revision 的替代品；真正 stale check 始终使用隐藏的完整 raw revision。

### 7.2 `SnapshotLedger` 数据

每个文件 lineage 至少保存：

```ts
type SnapshotNode = {
  key: string;                  // internal full occurrence digest
  id: string;                   // short or collision-expanded public token
  fullDigest: string;
  occurrenceNonce: string;
  revision: string;
  totalLines: number;
  parentKey?: string;
  effectsFromParent?: readonly EditEffect[];
  exposedCoverage: IntervalSet;
  exposedEmptyBoundary: boolean;
  verifiedLines: Map<number, string>;
  touchedAt: number;
};
```

`verifiedLines` 是该 occurrence revision 上由 CLI 完整返回、或由已验证 success 确定的内部文本；它可用于构造 CLI proof。`exposedCoverage`/`exposedEmptyBoundary` 是模型在**这个 occurrence id 下**明确看到或通过 bounded produced receipt 得到的坐标授权。两者不能混为一谈，截断 prefix 不进入任何一项。

状态规则：

1. apply 的消费行和 insertion anchor 先由 source node 的 exposure 授权；随后插件才沿 parent-key lineage 映射到 head 的 `verifiedLines`。zero-line virtual insertion 只检查 `exposedEmptyBoundary`。
2. 只有磁盘 revision 与当前 head 相同且没有 external/unknown/capacity-cut 边界时，read 才合并到同一 occurrence；只有同时装入 `<=50 KiB` 模型正文与 `<=64 KiB` typed delta 的完整行/empty boundary 才加入 exposure。CLI 多返回但未展示的完整行可作为 runtime-only `verifiedLines`。
3. changed apply 总是创建新 occurrence；通常它是 child，并按 validated `changed:true` effects 重映射 parent 的 `verifiedLines` 与加入新 text。它**不继承 parent exposure**，只有满足 receipt/replay-delta 上限的 produced ranges 加入 child exposure；容量切断时该 occurrence 直接成为 root。
4. no-op 不创建 child；原 node 的 exposure 保持不变。
5. external revision、outcome-unknown recovery、容量切断或无法证明 lineage 的 read 创建带新 nonce 的 root；只有实际返回且持久化的完整行/空 boundary 具有 exposure。
6. short id 必须在当前 Ledger 中唯一，并且 source node 必须位于当前 head ancestry；unknown、ambiguous 或旁支 occurrence 一律 fail closed。
7. branch replay 只从当前 branch 的 validated tool-result details 重建 occurrence；不得解析正文中的 snapshot-like 字符串。单个 result 只持久化 bounded node delta，不持久化完整 Ledger。

### 7.3 容量边界

硬边界固定为：每文件最多 32 个 lineage nodes；每文件最多 10,000 个 exact evidence lines 或 4 MiB UTF-8 文本；每 session 最多 50,000 行或 16 MiB 文本，均以先到者为准。

容量处理只有两种，不允许留下断裂 parent 指针：

1. **per-file rebase**：若加入本次 read/apply 会越过任一 per-file 上限，当前结果创建一个新 nonce 的 head root，并在 details 标记 `capacityRebased:true`。优先保留本次实际展示/receipt 授权的 exposure 及其 exact text，再按剩余预算保留 current-head runtime proof；旧 ancestry 整体移除，旧 snapshot 后续只能进入 `needs_review` recovery。
2. **session LRU eviction**：全局上限超出时，按 file-level LRU 淘汰其他文件的完整 lineage；不能只删其中几个 node。当前调用刚创建的 bounded root 不得立即被自身淘汰。

read formatter 在输出前联合计算 `Buffer.byteLength(modelBody,"utf8") <= 50 KiB` 与 `Buffer.byteLength(JSON.stringify(snapshotDelta),"utf8") <= 64 KiB`；放不下的尾部进入 `omittedRanges`，不得先授权后截断。apply 也先确定能持久化 exact generated text 的 receipt subset。capacity rebase/eviction 后 apply 不猜 proof，直接进入同调用恢复读取路径。

### 7.4 存储与磁盘 I/O 契约

“snapshot”是逻辑身份，不是磁盘文件副本。实现必须满足：

- `SnapshotLedger` 只存在于插件内存与 Pi 已有的 tool-result session 记录中；不得创建 `.snapshots/`、SQLite、索引数据库、后台 checkpoint 或每 revision 文件副本。
- `snapline_read_file` 不创建临时文件、不修改 target；为了生成 raw revision，基线实现会顺序读取完整目标，即便模型只请求 160 行。大文件连续读取会产生读 I/O，但通常可命中 OS page cache，且不会产生文件写放大。
- changed apply 继续使用完整 projected bytes + 同目录单个 `.snapline-*` 临时文件 + `Sync` + pre-commit revision 流式复读 + atomic replace。对大小为 `N` 的文件，一次普通成功修改约产生 `2N` target 读取和 `N` 临时文件写入（不计 OS journal、杀毒软件与文件系统内部放大）；修改一行也不会退化为非原子的 in-place write。
- no-op apply 必须零临时文件、零 target replace。参数/proof/overlap 等在规划期发现的 rejection 也必须零临时文件；只有发生在临时文件准备后的 pre-commit race 或 started-process 异常才可能已经写过临时字节。
- 正常 success、rejection、stale 和可控错误路径都必须删除未提交临时文件。进程被强制终止时，单个 CLI invocation 最多遗留一个不超过 projected target 大小的 `.snapline-*` 文件；多次异常终止仍可能累积。不能凭前缀和 mtime 自动删除未知文件，发布文档必须给出“先检查、再由用户确认删除”的诊断步骤。
- Pi 会把标准 tool result 追加到 session JSONL；这是 snapshot 唯一的常规持久化写入。不得额外 `appendEntry` 一份 Ledger 或源码。单次 read 模型正文保持 `<=50 KiB`，typed snapshot delta 按 `Buffer.byteLength(JSON.stringify(delta),"utf8")` 保持 `<=64 KiB`；任何 exposure 的 exact text/empty-boundary marker 必须完整位于该 delta。运行时可额外保留 CLI 返回但未暴露的完整行作为 proof 优化；resume/tree replay 后这部分可以消失并触发 proof recovery。apply preview 保持既有 `2,000 lines / 256 KiB` 上限。
- `4 MiB/file` 与 `16 MiB/session` 是运行时 Ledger 上限，不会追溯压缩 Pi 已写入的历史 JSONL。session 文件仍随真实工具结果累计增长；文档与 telemetry 必须把它与“无 snapshot 文件副本”明确区分。
- 若指标显示频繁编辑超大文件导致不可接受的全文件 atomic-write I/O，必须单独设计并证明新的投影/写入方案；不得为减少写放大而改成可能 partial write 的原地修改。

## 8. 坐标迁移规则

### 8.1 标准化 effect

CLI 每个已接受 change 返回一个可交叉验证的 source splice：

```ts
type EditEffect = {
  group: "replacement" | "deletion" | "insertion_before" | "insertion_after";
  groupIndex: number;
  changed: boolean;
  oldStart: number;
  oldEnd: number;      // insertion 时 oldEnd === oldStart - 1
  newLineCount: number;
  lineDelta: number;
  newStart: number;
  newEnd: number;      // deletion 可为 newStart - 1
};
```

纯 insertion 的 physical boundary 是 `p = oldEnd`：

- before line `N`：`oldStart=N, oldEnd=N-1, p=N-1`；
- after line `N`：`oldStart=N+1, oldEnd=N, p=N`；
- zero-line virtual before-line-1：`oldStart=1, oldEnd=0, p=0`。

`lineDelta` 对非空 splice 为 `newLineCount - (oldEnd-oldStart+1)`，对 insertion 为 `newLineCount`。所有 effects 都相对同一 source document；post-edit 坐标使用以下唯一公式：

- 非空 effect `[s,e]`：`newStart = s + Σ(nonempty.lineDelta where oldEnd < s) + Σ(insertion.lineDelta where p < s)`；
- insertion boundary `p`：`newStart = p+1 + Σ(nonempty.lineDelta where oldEnd <= p) + Σ(other insertion.lineDelta where boundary < p)`；
- `newEnd = newStart + newLineCount - 1`，所以 deletion 为 `newStart-1`。

这也固定了共享外侧 boundary 的顺序：before insertion、consumer、after insertion。duplicate insertion boundary 仍拒绝。插件逐项验证全部 effects、公式、原始 grouped change、总行数变化和 CLI stats；只有 `changed:true` effects 进入 `effectsFromParent` 并参与后续 touched/conflict/translation，`changed:false` effect 仅用于本次结果完整性校验，不能制造伪谱系冲突。

迁移前先验证模型 targets 被 source occurrence exposure 完整覆盖。`verifiedLines` 即使已在 child 中重映射，也不能反向授权模型使用它从未在该 child id 下看到的坐标。每个 parent→child batch 独立转换一次，不能把不同 revision 的 effects 扁平化后排序。

### 8.2 允许迁移

从 source snapshot 沿插件已验证的 child chain 迁移 target：

- 历史 splice 严格位于 target 前方：按累计 `lineDelta` 平移。
- 历史 splice 严格位于 target 后方：坐标不变。
- insertion 位于 target 外侧 boundary：允许；目标成员不变。
- replacement/deletion 位于 insertion anchor 前后且 anchor 行本身未被消费：允许平移 anchor。

### 8.3 必须拒绝迁移

以下情况返回 `needs_review` 并在同一 apply 调用内读取当前局部 context：

- 历史 replacement/deletion 与 target source range 有任何交集；
- 历史 insertion boundary 位于 target range 内部；
- 历史编辑消费了 insertion 所依赖的 anchor 行；
- 历史 insertion 使用同一个 physical boundary；
- source snapshot 不在当前 file lineage 上；
- lineage node/effect 因容量淘汰而不完整；
- supplied path 解析到另一 canonical target；
- 磁盘 revision 不是当前 lineage head；
- 任一坐标或 effect 无法唯一解释。

不采用“文本恰好相同就继续”的 heuristic，也不进行模糊匹配。

### 8.4 参考迁移算法

对 ancestry 中每一个 parent→child batch，所有 effects 都以该 parent 坐标解释。对进入该 batch 的 range `[a,b]`，先用原始 `[a,b]` 检查整批 effects，再一次加入累计 shift：

1. 非空 splice `[s,e]` 与 `[a,b]` 相交：拒绝；`e < a` 时计入前方 shift，`s > b` 时不影响。
2. 纯 insertion boundary `p` 满足 `a <= p < b`：拒绝；`p < a` 时计入前方 shift，`p >= b` 时不影响。
3. 检查完整批次后执行 `a += sum(lineDeltaBefore)`、`b += sum(lineDeltaBefore)`，再进入下一个 child batch。
4. 不得边遍历同一 batch 边修改 `[a,b]` 后再比较其余 source-coordinate effects。

对 insertion anchor，先将其转成“proof anchor line + physical boundary”，分别迁移；anchor 被消费或 boundary 被复用即拒绝。

必须用独立的朴素 projected-document reference model 做 property test，而不是只测试手写样例。

## 9. Snapline CLI 1.0 wire contract

### 9.1 命令面

新 CLI 只提供以下集成命令：

```text
snapline --version
snapline capabilities
snapline read       # stdin JSON request，stdout JSON result
snapline apply      # stdin JSON request，stdout JSON result
```

`snapline --version` 的 stdout golden 固定为 `Snapline 1.0.0\n`；`capabilities` 的 product 字段仍使用机器可读小写 `snapline`。命令误用写 stderr 并 exit 2，逻辑 wire result 写 stdout 并 exit 0，基础设施/不确定故障 exit 1。


不保留 `hledit` binary、shell alias、anchor read、standalone replace、replace-range、insert 或 batch v3 兼容入口。旧命令用户必须固定旧 release 或迁移到 wire protocol 1 客户端。

stdin/stdout 使用 UTF-8 JSON；日志只写 stderr，绝不污染 stdout JSON。

### 9.2 capabilities

```json
{
  "ok": true,
  "product": "snapline",
  "version": "1.0.0",
  "wireProtocol": 1,
  "rawRevision": "sha256",
  "multiWindowRead": true,
  "boundedBinaryPreflight": true,
  "groupedAtomicApply": true,
  "completeReadProof": true,
  "preCommitRevisionCheck": true,
  "structuredEditEffects": true,
  "structuredRecoveryContexts": true
}
```

插件要求：

- `product === "snapline"`；
- semver major 恰为 `1`；
- `wireProtocol === 1`；
- 上述 capability 全部为 `true`；
- 出现旧 `anchorProtocolV2`、`batchWireV3` 等字段不作为兼容信号；插件不能因此进入旧模式。

### 9.3 read request/result

CLI read 支持一次读取多个局部 window，以便 apply recovery 一次进程拿到多个冲突位置：

```json
{
  "protocolVersion": 1,
  "path": "C:/repo/src/file.ts",
  "windows": [
    { "offset": 1, "limit": 160 },
    { "offset": 800, "limit": 20 }
  ]
}
```

最多接受 64 个 window；CLI 加载后把 window clamp 到文件边界、排序并合并重叠/相邻范围。public plugin wrapper 仍按 6.1 把原始 `offset > totalLines` 转成 `range_out_of_bounds` 且不授权 CLI 为诊断而返回的 clamp context；recovery wrapper 可以使用该 context 并标记 approximate。

CLI 先读最多 8 KiB：PNG/JPEG/GIF/WebP/BMP 等受支持族的 magic 候选返回 `image_candidate` 且不做 full-file read；preflight NUL 立即返回 `unsupported_file`。文本路径才完整加载，并再次对**全部字节**拒绝 NUL、验证 UTF-8、计算 raw revision，再按 2,000 完整行与 50 KiB 未转义行内容预算收集 contexts。image detector 必须用 fixture 与 Pi native detector 的支持集合做 parity test；最终是否可渲染仍由 Pi native reader 确认。

```json
{
  "ok": true,
  "protocolVersion": 1,
  "path": "C:/repo/src/file.ts",
  "revision": "sha256:<64 lowercase hex>",
  "totalLines": 387,
  "bom": false,
  "contexts": [
    {
      "offset": 1,
      "limit": 160,
      "start": 1,
      "end": 160,
      "complete": true,
      "nextOffset": 161,
      "lines": ["...", "..."]
    }
  ],
  "omittedRanges": []
}
```

每个 `lines` 元素是无 CR/LF 的完整逻辑行；`start/end` 精确描述该数组。空文件或下一条完整行放不下时允许 `start > end`。长行 prefix 位于对应 context 内：

```json
{
  "offset": 161,
  "limit": 1,
  "start": 161,
  "end": 160,
  "complete": false,
  "nextOffset": 161,
  "lines": [],
  "truncatedLine": {"line":161,"prefix":"...","originalUtf8Bytes":90000}
}
```

`complete:true` 表示该 normalized requested window 在 EOF 前的所有行都以完整行返回；`nextOffset` 在 EOF 前为下一次应读取的行，partial context 时必须指向第一条未完整返回的行。CLI `omittedRanges` 元素固定为 `{start,end,reason}`，reason 是 `line_limit | byte_budget | line_too_long`；插件可增加 `replay_delta_budget` reason，并在 stale/unknown recovery 增加 `approximate:true`。每个未完整返回的 requested span 都必须列出，且不得声称端点代表中间内容。

`truncatedLine` prefix 只用于展示，永不进入 proof、`verifiedLines` 或 exposure。插件按最终模型格式再次执行 50 KiB cap，必要时缩短 contexts、同步更新 `complete/nextOffset/omittedRanges`，再验证 revision 与范围一致性。CLI JSON stdout 受 1 MiB process cap，read/apply stdin 分别受 1 MiB/32 MiB cap；所有 cap 按 UTF-8/实际 JSON bytes 计算，测试覆盖 JSON escaping 放大。

### 9.4 apply request

插件把模型请求迁移到当前 lineage head 后，向 CLI 发送：

```json
{
  "protocolVersion": 1,
  "path": "C:/repo/src/file.ts",
  "expectedRevision": "sha256:<64 lowercase hex>",
  "proof": [
    { "start": 41, "lines": ["exact line 41", "exact line 42"] }
  ],
  "replacements": [
    { "start": 41, "end": 42, "text": "new line 41\nnew line 42" }
  ],
  "deletions": [],
  "insertionsBefore": [],
  "insertionsAfter": []
}
```

CLI 独立验证：

1. stdin 在 decode 前是有效 UTF-8 且 `<=32 MiB`，顶层/嵌套 object 字段闭合、required/null/type 正确，并且只有一个 JSON document；
2. group/总 change、text UTF-8 bytes、produced lines、proof logical lines `<=10,000` 与 proof raw text `<=4 MiB`；
3. command 入口只解析一次现存 symlink 得到 canonical target，随后要求该 captured target/parent 仍指向普通可写文件而非 symlink/reparse point，hardlink 策略与平台限制满足；
4. 初始 raw revision 等于 `expectedRevision`；
5. proof ranges 非重叠、内容完整并逐字匹配当前逻辑行；
6. 每个消费 range 的所有行都有 proof，每个普通 insertion 的 anchor 行有 proof；zero-line virtual insertion 只允许唯一 before-line-1 且 revision/protocol 条件成立；
7. 所有 requested changes（包括 no-op candidate）的 grouped conflict、replacement text 与 single-line expansion guard 均通过；
8. projected line/byte count 无整数溢出；
9. 每个 replacement 在 source coordinates 上比较 normalized logical lines。完全相同则 effect 为 `changed:false`；mixed batch rebuild/EOL 只应用 `changed:true` effective changes，确保 no-op range 不会顺带规范化 mixed EOL；
10. 全部 effective changes 为空时，在创建临时文件前返回 no-op；
11. commit 前再次验证 captured target/parent identity、普通文件/hardlink 状态，并流式确认 raw revision 仍等于初始 revision。

行尾与字节重建沿用 v3 已验证契约：未被 effective change 触及的源行保留各自 terminator；replacement 新行采用消费区间附近的 local ending，最后一条继承被替换末行 terminator；普通 pure insertion 使用 anchor 附近 ending；原 unterminated EOF 被推到中间时补 local ending，新 EOF 仍 unterminated；原 trailing-newline 状态和 UTF-8 BOM 保持，删除所有逻辑行得到真正空文件（若原有 BOM 则只保留 BOM）。唯一 creation 例外是 zero-line virtual insertion：使用 LF 分隔新行，并由 `endsWithLF` 决定新 trailing newline，同时保留原 BOM。

### 9.5 单行意外扩张 guard

保留现有“模型本想插入却误替换单行”的保护，并改为坐标协议：

- replacement 消费恰好一行；
- replacement 生成多行；
- 新文本第一行与被消费的原行完全相同；
- 同 batch 没有明确改变该 boundary 的相邻操作；

则整个 batch 返回 `suspicious_range_expansion`，提示改用 `insertions_after` 或扩大真实 replacement range。该 guard 不能自动改写请求。

### 9.6 apply success

```json
{
  "ok": true,
  "protocolVersion": 1,
  "path": "C:/repo/src/file.ts",
  "outcome": "applied",
  "sourceRevision": "sha256:<64 lowercase hex>",
  "newRevision": "sha256:<64 lowercase hex>",
  "contentChanged": true,
  "stats": {
    "requestedChanges": 1,
    "effectiveChanges": 1,
    "oldLineCount": 387,
    "newLineCount": 387,
    "insertedLines": 2,
    "deletedLines": 2
  },
  "effects": [
    {
      "group": "replacement",
      "groupIndex": 0,
      "changed": true,
      "oldStart": 41,
      "oldEnd": 42,
      "newLineCount": 2,
      "lineDelta": 0,
      "newStart": 41,
      "newEnd": 42
    }
  ],
  "warnings": []
}
```

成功结果必须为每个 requested change 返回且只返回一个 `(group, groupIndex)` effect。effect 数组顺序固定为 `replacement`、`deletion`、`insertion_before`、`insertion_after`，各组按原 input index；插件验证 canonical `path`、`sourceRevision === head.revision`、effect 坐标公式、请求/总行数变化和无缺失重复。

stats 定义唯一化：`requestedChanges` 是全部请求数；`effectiveChanges` 是 `changed:true` 数；`insertedLines`/`deletedLines` 只累加 effective effects 的 produced/consumed 行；`newLineCount = oldLineCount + insertedLines - deletedLines`。`newStart/newEnd` 的 shift 求和也只使用 effective effects；no-op effect 自身 `lineDelta:0`。插件独立重算全部字段。

`newRevision` 必须符合 `sha256:<64hex>`；其 committed-byte 正确性由 CLI atomic-write contract 和 CLI tests 保证。child 的内部 `verifiedLines` 可由旧 proof、请求 text 和 effective effects 构造；只有 exact generated text 完整持久化在本次 `<=64 KiB` typed delta 中的 produced range 才能进入 receipt/child exposure。

`contentChanged` 为必填，并与 `outcome` 一一对应：

- `true`：`outcome === "applied"`，至少一个 effect `changed:true`，`newRevision !== sourceRevision`，成功提交后不得再把结果归类为 zero-write rejection；
- `false`：`outcome === "no_op"`，所有 effect `changed:false`，不得创建临时文件或替换 target，`newRevision === sourceRevision`；
- `warnings` 是 strict `{code,message}` object array；正常为空。post-commit directory durability 失败时 target 已替换，仍返回 changed success，并给出唯一稳定 code `post_commit_durability`；replace 调用本身若无法证明是否发生则不得返回 logical rejection，必须非零退出并由插件归为 `outcome_unknown`。

### 9.7 logical rejection 与 recovery context

可预期结果使用如下 strict envelope，并明确保证 target 未提交：

```json
{
  "ok": false,
  "protocolVersion": 1,
  "path": "C:/repo/src/file.ts",
  "code": "snapshot_stale",
  "message": "...",
  "targetCommitted": false
}
```

稳定 code：

- `invalid_request`
- `range_out_of_bounds`
- `target_not_found`
- `target_not_regular`
- `permission_denied`
- `image_candidate`（read only，触发 Pi native image delegate）
- `unsupported_file`
- `invalid_utf8`
- `hardlink_target`
- `size_limit`
- `snapshot_stale`
- `insufficient_read_proof`
- `proof_mismatch`
- `overlapping_changes`
- `duplicate_insertion_boundary`
- `suspicious_range_expansion`
- `source_changed_before_commit`
- `write_failed_before_replace`

`protocolVersion/code/message/targetCommitted:false` 始终必填；安全解析出 target 后 `path` 必填，否则可省略。若 CLI 已安全加载当前文件，可附 bounded `currentRevision`、`requiredRanges:[{start,end}]`、`contexts` 和 `omittedRanges`。每个 change 错误必须包含精确 `group/groupIndex`；冲突错误还包含 `conflictsWith:{group,groupIndex}`。external-stale context 沿旧数值位置取得时必须标为 `approximate:true`，仅供人工重新定位，绝不能视作坐标迁移证明。

逻辑 rejection 使用 exit code 0，表示 wire 成功且 `targetCommitted:false` 可被信任；调用语法、无法编码响应、panic、replace 阶段不确定或任何无法证明写入状态的内部故障使用非零 exit。插件不能只凭 exit code 猜测结果，仍严格验证 JSON contract；started nonzero/malformed outcome 一律进入 `outcome_unknown`。

## 10. Apply 流程与恢复语义

### 10.1 正常路径

在 canonical file queue 内顺序执行：

1. canonicalize supplied path，查询 snapshot 并验证 path binding。
2. 若 snapshot 不是 head，沿完整已验证 lineage 迁移所有 targets；任一 target 不安全则停止。
3. 从 head node 提取 target 完整 proof；构造 CLI request。
4. CLI 检查、规划、pre-commit recheck、atomic write。
5. 插件严格解析并交叉验证 success。
6. changed success 创建新的 child occurrence 并生成短 receipt；no-op 保留原 occurrence。随后更新 TUI/compaction details。
7. 释放 queue。

### 10.2 缺 proof

缺 proof 不是自动写入机会：

- 插件发现 source exposure 或 head proof 不足时，不故意发送一个已知无效的 apply request。
- 它在同一 canonical queue 内调用 `snapline read` multi-window，读取并合并所有能在 64-window/50-KiB 预算内返回的 target ranges。
- 本次 apply 以 `needs_review` 结束；若 target 仍为可读文本，则把完整 contexts 合并进当前 head occurrence（id 可复用）并返回其 snapshot 与任何 `omittedRanges`。只有 external/unknown 边界才创建新 root occurrence。旧请求零写入且绝不自动重放。
- 在预算内覆盖全部 required ranges 时，模型不需要额外显式 read；超预算、长行 incomplete、文件不可读或被删除时返回明确 recovery failure，并要求 targeted follow-up read 或人工处理，不能虚报“已恢复”。
- CLI 仍独立实现 `insufficient_read_proof`，用于防御插件 bug 和其他 wire clients。

### 10.3 谱系冲突

插件在启动 apply CLI 前发现目标被历史编辑触及时：

1. 不构造“猜测后的”写请求；
2. 在同一 queue 内对当前 head 的冲突 target 读取多窗口 context；
3. target 可读且预算允许时，把 context 暴露到 current head occurrence 并返回 `needs_review`；否则返回明确 recovery failure/omitted ranges；
4. 旧请求零写入。

### 10.4 external stale / pre-commit stale

- 插件在同一 queue 内重新读取当前 target；external 任意改写都关闭旧 lineage并建立新 root。
- 旧坐标在新文件中的同数值窗口只能标记为 approximate review context，不能自动对应原语义位置。
- 当前 target 仍为可读 UTF-8 时返回新 snapshot/context；删除、权限失败、binary 或超预算时返回 recovery failure 与 `omittedRanges`，不伪造 snapshot。
- 不做 fuzzy 定位、坐标猜测或自动 retry。

### 10.5 `outcome_unknown`

以下 started-process outcome 均归类为 `outcome_unknown`：

- timeout；
- abort/cancel；
- stdout+stderr 超过 1 MiB；
- 进程异常退出；
- JSON 不可解析；
- success response 缺字段或交叉验证失败；
- 无法确认 atomic replace 是否发生。

process wrapper 必须先确认子进程退出（Windows 继续使用 process-tree termination 与 250 ms grace）再释放 queue。随后在同一 queue 中尝试读取当前 target contexts；成功时建立 recovery root snapshot，并明确返回：

```text
Outcome unknown. Current file state was reread as snapshot:<id>.
Do not retry the identical request without reviewing the returned lines.
```

recovery read 若成功，只有实际返回的完整行获得新 root exposure；若 target 已删除、不可读或不再是文本，结果保留 `outcome_unknown` 并附 recovery failure。对可能已经应用的请求，review windows 应覆盖旧 target 与 projected-new target 的有界并集并标注 approximate，不声称它们一定是受影响位置。

compaction 将该文件标记为 edited，因为不能证明零写入。

### 10.6 插件 disposition 与稳定 code

插件 details 使用 `succeeded | needs_review | rejected | outcome_unknown | unavailable`，并至少区分 `snapshot_unknown`、`snapshot_path_mismatch`、`snapshot_id_ambiguous`、`source_not_exposed`、`lineage_unavailable`、`lineage_conflict`、`head_proof_missing`、`external_stale`、`invalid_cli_response` 和 `cli_unavailable`。

已确认零写入且成功返回 recovery context 的 `needs_review` 不标 Pi tool error；参数/路径绑定等不可恢复 rejection、`outcome_unknown` 与 unavailable 标为 error。path mismatch 不自动读取另一 canonical target；snapshot unknown/evicted 可把提交的数值 ranges 仅作为 `approximate:true` recovery hints。

## 11. 路径、并发与文件身份

### 11.1 canonical target

唯一 helper 必须返回 `{ canonicalFileKey, canonicalTargetPath }`：key 同时用于 snapshot path binding、Ledger、queue identity 和 compaction；path 是传给 CLI 或 exclusive create 的已捕获绝对路径。两者不能靠各调用方分别拼接。

- 对现存 target：`canonicalTargetPath = realpath(target)`；key 由该路径做平台规范化得到。
- 对不存在的候选：先用 `lstat` 排除 dangling symlink 或任何已存在目录项，再取最近现存祖先的 `realpath` 并拼接未解析 suffix；该结果是 candidate path/key。
- Windows key 对完整路径执行大小写无关规范化，并统一 drive、separator 与不影响身份的尾分隔符；保留一个可用于 I/O 的 captured path spelling。POSIX key 保持大小写敏感。

因此 `C:\x\a.ts`、`c:/x/a.ts`、missing-path case aliases 和经 symlink parent 指向同一位置的路径不能形成双队列。

安全顺序：

1. queue 外只解析一次 candidate identity；
2. 以 `canonicalFileKey`（Windows 为大小写归一后的 absolute path）作为参数进入官方 `withFileMutationQueue`；`canonicalTargetPath` 只用于 I/O；
3. queue 内重新解析 supplied path 并要求 key 仍等于捕获值，否则零写入拒绝；
4. 所有 CLI 调用使用 queue 内确认后的 `canonicalTargetPath`，不重新跟随原 symlink；
5. apply 再验证 snapshot path binding；healthy guarded `write` 在必要的 parent mkdir 后再次验证 parent/candidate identity，并以 no-follow/exclusive-create 语义打开最终路径。任何既有目录项、dangling symlink 或外部抢先创建都必须拒绝，绝不能覆盖。

### 11.2 并发

- 同 canonical file 的 Snapline read/apply/recovery 与 guarded Pi `write` override 必须共享官方 `withFileMutationQueue`；guarded write 的检查和最终 write 都位于同一 queue callback，不能先检查后排队。
- 不同文件可并行。
- 工具实现不得只给写入阶段加锁；完整 read-modify-write window 必须在队列内。
- CLI 本身仍保留 revision/pre-commit 检查，不能信任插件队列可以阻止外部进程。

## 12. Pi 插件生命周期

### 12.1 健康模式工具集

CLI capability 通过且未检测到 legacy Hledit extension 冲突时：

- 禁用 Pi 内置 `read` 和 `edit`；启用 `snapline_read_file`；保留内置 `grep`。
- 用 Pi exported `createWriteToolDefinition` 继承 `write` schema/renderer/result shape，但 override `execute`：healthy backend 只为不存在且无 dangling-symlink/目录项占位的 canonical candidate 创建父目录并以 exclusive create 写入；任何既有 target（包括零字节/BOM-only）都拒绝并指向 Snapline。创建后继续编辑前必须 fresh read。
- custom `write` 使用静态 description/guideline 同时明示 healthy=create-only、fallback=native overwrite；fallback execute 直接委托 Pi native definition。healthy 的解析、检查、parent mkdir 后复核、exclusive write 与 Ledger invalidation 位于同一 canonical queue。
- 文本 `grep` 只负责定位，不建立 snapshot/exposure；编辑前必须对目标范围调用一次 `snapline_read_file`。
- 图片分支调用保留但不激活的 Pi built-in read definition；模型仍只发起一次 `snapline_read_file`。
- `snapline_read_file`/`snapline_apply_changes` 均不设置 `promptSnippet` 或 `promptGuidelines`；lazy apply 的 activation 因而保持纯 schema additive。

### 12.2 activation、lifecycle 与 fallback

首次成功建立可编辑 occurrence（至少一个完整 exposed line，或 exposed zero-line virtual boundary）时，read execute 内调用纯 additive `setActiveTools` 启用 `snapline_apply_changes`。普通线性 branch 一旦启用不反复移除。

真实生命周期边界只有：`session_start` reason `startup | reload | new | resume | fork`，以及 `/tree` 后的 `session_tree`。Pi 没有 post `session_switch`/`session_fork` 事件。`session_start` 只做一次 capabilities check 和 branch replay；`session_tree` 不重复 spawn，只重建当前 branch，并可在该边界按是否存在可编辑 occurrence 非 additive 地增删 apply。

CLI 缺失、不兼容或 health check 失败时进入 unavailable fallback：移除 Snapline tools，启用 Pi 内置 `read`/`edit`，custom `write` 切到 native execute，并给出 bundled binary 安装提示。若检测到旧 Hledit extension tool source，则进入 conflict mode：移除 Snapline tools、让 write 使用 native execute，但不与旧扩展争夺其 active set；提示用户移除其中一套并 `/reload`。

插件注册 `/snapline-status`；只在 idle command 或新 `session_start` 运行 capabilities 并原子重算 active set。运行中确定 spawn-unavailable 时先结束当前 outcome/recovery，再在 `agent_settled` 切换 fallback，绝不在文件临界区内换 backend。`before_agent_start` 只校正被其他扩展意外重新启用的 built-in read/edit，不执行 I/O 或 health probe。

### 12.3 session replay

结构化 details 至少包含：protocol version、canonical path、occurrence nonce/key/id/full digest/revision/total lines、本次 bounded `verifiedLines` delta、明确的 line/empty-boundary exposure delta、apply parent/new occurrence、validated request summary/effects、produced receipt 覆盖、outcome classification 与 compaction disposition。

重放规则：

- 只接受当前 Snapline protocol 1 typed details；重新计算 occurrence digest/id，验证 revision 格式、parent-key ancestry、effect index/统计和所有容量边界。
- 不解析模型正文、普通 assistant text 或旧 tool arguments 中的 snapshot-like 字符串，也不接受旧 `hledit` details 或未知 future protocol。
- result 的 exposure delta 必须自包含其 exact source text 或 empty-boundary marker；缺失、超 64-KiB 或指向未持久化文本的 exposure 使该 result delta 无效。runtime-only proof 不在 replay 后恢复，必须 fresh read 或走同调用 recovery。
- branch replay 按顺序处理；遇到任意非 Snapline `write`/`edit` 成功或结果未知时，先把全部 Ledger 当作 external barrier 清空，再只重建其后的 protocol-1 Snapline results。healthy guarded `write` execute 仍实时按 file key invalidation；全局 replay barrier 是无法从 built-in result details 可靠恢复 path 时的保守策略。
- `resume/fork/tree` 只有在 protocol-1 branch 能完整重建时才复用；新会话、旧 v3 session、fallback health recovery 或断裂 lineage 首次编辑前必须调用 `snapline_read_file`。`/snapline-status` 从 fallback 恢复健康时先清空 runtime Ledger，再按上述 barrier 规则 replay。

### 12.4 compaction

- 成功文本 read：`read`。
- apply changed success：`edited`。
- apply no-op success：`read`。
- zero-write rejection 且带 recovery snapshot：`read`。
- `outcome_unknown`：`edited`。
- unavailable/参数校验失败且无文件读取：不记录。

### 12.5 参数准备

`prepareArguments` 只做 Pi 明确支持的轻量 normalization：移除单个 UI `@` path marker，以及把 read 的缺省/非正 limit 修为 160、超大 limit clamp 到 2,000、非正 offset clamp 到 1。所有 repair 进入 typed details/telemetry。禁止：

- 解析旧 anchor 或旧 operation；
- 接受 singleton change union；
- 把 JSON string 重新 parse 成 object；
- 把 string-array 拼成 text；
- 接受 boolean/numeric string 作为兼容协议；
- 静默改变 change mode、坐标或 snapshot id。

除上述 read range repair 外，strict schema/runtime validation 必须看到模型提交的原始语义。

## 13. TUI 与模型结果

### 13.1 read renderer

- compact 模式只显示 receipt、范围和 truncation。
- expanded 模式显示带行号源码、snapshot id、coverage 与 next offset。
- 图片交给 Pi image content/render contract。

### 13.2 apply renderer

调用阶段的 provisional preview 只使用 source snapshot 的 exposed text 与模型 request，**不得在 renderer 中另行读盘**；Ledger 不足时只显示结构化 change summary。成功结果再用 validated effects/stats 生成 committed preview，两者必须明确区分，失败结果不能沿用 provisional diff 冒充已提交。

committed preview 保持：多 hunk；最多 2,000 行/256 KiB；长行按 UTF-8 byte budget 截断；整体保留 head/tail。模型正文只返回紧凑 receipt/produced mapping，不回显大段 diff。rejection/recovery expanded view 按每个冲突 change 显示多个 bounded local windows，而不是压成一个巨大 span，并明确标记 incomplete、omitted 和 approximate。

## 14. Telemetry 与可量化验收

Telemetry 只记录计数、类别、字节数和耗时，不记录 path 或源码正文。至少包含：

- 注册/激活工具 schema characters；
- 每次 read/apply 的 model-visible characters；
- 每次成功写入的工具调用数与显式 reread 数；
- snapshot translation 成功/拒绝次数；
- proof miss、capacity eviction、external stale、outcome unknown 分类；
- recovery contexts 数、行数、字节数；
- CLI elapsed/process outcome；
- snapshot short-id collision（应始终为 0）。
- CLI source bytes read、temporary bytes written、target replaces 与 orphan-temp abnormal outcomes；
- 每个 tool result 的正文/details bytes，以及当前 branch 和 session JSONL 的可观测大小（Pi 未提供可靠值时明确标为 unavailable）。

验收目标：

| 指标 | Snapline 1.0 目标 |
|---|---:|
| 两工具完整协议 | 实测 `2,652 chars`，门禁 `<=3,000` |
| 首次文本 read 前 Snapline 协议 | 实测 `470 chars`，门禁 `<=600` |
| 默认 160 行 read 的格式开销 | 比 v3 少约 600 chars |
| 普通编辑工具调用 | 2（read + apply） |
| proof miss 的额外显式 read | required ranges 能装入 64-window/50-KiB 预算时为 0；overflow 必须明确分页 |
| distant batch 后可继续编辑 | 所有位置有 validated effect/internal proof；只有 receipt 完整暴露的位置可直接用 child id，其余 fresh read |
| 错文件写入 | 0 |
| partial batch write | 0 |
| external stale 自动 retry | 0 |
| outcome unknown 相同请求自动 retry | 0 |

性能不得显著回退当前基线：

- 10 MiB batch output materialization 约 10.62 MB/op、5 allocs/op；
- 10 MiB pre-commit revision recheck 约 33.6 KiB/op、9 allocs/op。

允许因新 structured effect 产生小幅常数变化，但任何大于 10% 的时间或 allocation 回退都必须解释并获得批准。

## 15. 迁移与影响面

### 15.1 破坏性迁移矩阵

| 使用者 | 影响 | 迁移 |
|---|---|---|
| Pi 新会话 | 自动使用 Snapline | 安装 `pi-snapline` 并开启新会话 |
| Pi 旧 session | 旧 tool details 不重放 | 首次编辑前 `snapline_read_file` |
| 调用旧工具名的 prompt/skill | 工具不存在 | 更新为两个 Snapline 工具 |
| `pi-hledit-diff` 安装路径 | 不再加载 | 移除旧安装，安装 `pi-snapline` |
| `hledit.exe` 脚本 | 命令不存在 | 改用 `snapline` wire protocol 1 |
| standalone anchor 用户 | 旧命令删除 | 固定旧 release，或编写 Snapline 客户端 |
| `hledit-mcp` 等第三方集成 | v3 capability/命令不兼容 | 独立升级到 Snapline protocol 1；本仓库不提供 shim |
| CI/build script | 旧目录/binary 失效 | 更新到 `pi-snapline/bin/snapline.exe` |

安装文档必须要求删除旧 `pi-hledit-diff` 目录，避免 Pi 同时发现两套扩展。实现过程不会自动删除用户目录；发布说明给出人工步骤。

### 15.2 源码目录与文件变更

计划中的仓库级改名：

```text
pi-hledit-diff/  -> pi-snapline/
.../bin/hledit.exe -> .../bin/snapline.exe
```

`cli/` 作为通用源码角色目录可保留，但其中所有产品名称、help、version 与构建产物改为 Snapline。`cli/go.mod` 的旧远端 module path 只有在远端仓库改名并确认 redirect/发布策略后才能更新；不能先写一个不存在的 module URL。

CLI 主要改动：

- `main.go`：Snapline 1.0 命令面与 version。
- `types.go` / 新 wire types：protocol 1 request/result。
- `read.go`：multi-window structured read 与完整行 proof 输出。
- `batch_request.go` / `batch_plan.go`：改为 grouped line-coordinate planner，或以职责清晰的新文件替换。
- `textfile.go`、`write.go`、platform write：复用并保持字节/原子契约。
- 删除不再被新 wire 使用的公开 anchor/hash/updated-anchor command 路径；只在底层确有不变量价值时保留中性内部 primitive。
- 更新 `README.md`、`SPEC.md`、`CHANGELOG.md`、golden 与所有 Go tests。

Pi 插件主要改动：

- `index.ts`：注册新工具、内置工具 override、动态 activation、lifecycle。
- `index.ts` 同时创建 create-only guarded `write` override 和保留的 Pi image-read definition；不得复制 Pi 图片解码/缩放实现，fallback 必须委托 native definitions。
- `src/schema.ts`：唯一 grouped schema 与预算。
- `src/read-evidence.ts`：由 `src/snapshot-ledger.ts` 替换。
- `src/anchor-hash.ts`：删除。
- `src/file-changes.ts`：改为 snapshot translation + CLI wire mapping；职责过大时拆成 `coordinate-translation.ts` 与 `apply-transaction.ts`。
- `src/read-transaction.ts`：canonical queued snapshot read/multi-window recovery。
- `src/post-edit-context.ts`：由 structured recovery contexts/validated effects 替代旧 anchor context 语义。
- `src/cli.ts`：`runSnapline`、新 binary path、product/capability validation；保留 process safety。
- `src/prepare-arguments.ts`：删除旧兼容形态。
- `src/active-tools.ts`、`compaction-files.ts`、renderer/result：更新新 lifecycle/details。
- 全部 test 文件按新职责重命名或重写，不能只做字符串替换。

仓库级改动：

- 根 `README.md`、`.gitignore`、CI workflow、构建命令、package-lock、发布说明。
- `package.json` 名称/版本/description 改为 `pi-snapline@1.0.0`。
- bundled Windows x64 binary 必须由同一 source revision 重建并由 integration test 验证 capabilities。

## 16. 实施顺序：一个发布，不是多协议阶段

以下顺序用于控制开发风险，但中间状态不发布、不长期保留 feature flag：

1. **冻结 golden contract**：把本文中的 public schema、CLI JSON、错误码、effect 和 budget 写成 failing golden tests。
2. **实现 CLI wire 1**：复用 text/atomic primitives，完成 multi-window read、grouped apply、effects/recovery 与全部 Go tests。
3. **实现 SnapshotLedger**：先用纯单元/property tests 验证 proof、lineage、translation、eviction、branch replay。
4. **接入 transaction**：canonical queue 内串起 read/apply/recovery/process uncertainty，并严格验证 CLI result。
5. **接入 Pi lifecycle**：工具注册、deferred activation、built-in fallback/image、compaction 和 TUI。
6. **删除旧协议**：删除旧工具、anchor evidence、compat arguments、旧 CLI command 与旧 tests；全仓 grep 确认只在 migration/changelog 中出现旧名。
7. **全栈改名**：目录、package、binary、帮助、CI、文档、bundled artifact 一次完成。
8. **全量验收**：Go、Node、schema budget、real Pi providers、diff/worktree 检查全部通过后才标记 release-ready。

任一步发现安全不变量必须依赖旧模型 anchor 才能成立时，应回到 CLI/plugin 边界重新设计，而不是加入隐藏 compatibility mode。

## 17. 测试矩阵

### 17.1 Go CLI

必须覆盖：

- capabilities/product/version/wire golden；
- multi-window clamp/merge、两层 50-KiB cap、`omittedRanges`、长行 incomplete proof；
- bounded image/binary preflight 对候选最多读取 8 KiB，`image_candidate` 不做 full text read；
- empty/BOM/UTF-8/invalid UTF-8/NUL binary 与 zero-line virtual insertion；
- revision wire 精确使用 `sha256:<64 lowercase hex>`；read stdout `<=1 MiB`、read/apply stdin `<=1/32 MiB`，覆盖 JSON escaping 放大；
- text 最后一个 `\n` 解码、empty-source trailing newline、produced-lines/text/proof size 上限与 local EOL 重建；
- LF、CRLF、mixed EOL、末尾有/无 newline；
- replacement/deletion/before/after 与所有 boundary 组合；
- group 间 overlap、duplicate physical boundary、post-coordinate 公式和错误 group index；
- proof gap、proof mismatch、stale initial revision、pre-commit race；
- single-line expansion guard；
- no-op replacement 与 mixed changed batch 不改变 no-op range 的 EOL，stats/effects/order exactness；
- hardlink、final/parent symlink/reparse、identity recheck、permission、atomic rename/replace-uncertainty failure；
- 10 MiB allocation benchmarks；
- read/no-op/planning rejection 不创建临时文件，正常 success/rejection 清理临时文件；
- forced-termination 注入最多遗留当前 invocation 的一个临时文件，且绝不自动清理无法证明归属的旧文件；
- 10 MiB changed apply 的 source-read/temp-write 字节计数符合约 `2N/N` 契约；
- fuzz/property：batch planner 对比朴素 projected-document reference。

命令：

```text
cd cli
gofmt -w <changed-go-files>
go test ./...
go vet ./...
go test -run '^$' -bench 'Benchmark(BatchOutputMaterialization10MiB|PreCommitRevisionRecheck10MiB)' -benchmem
go build -trimpath -ldflags="-s -w" -o ../pi-snapline/bin/snapline.exe .
```

### 17.2 Pi 插件

必须覆盖：

- schema exact-description golden、strict objects、实测 470/2,182/2,652 与 `<=3,000` budget；
- occurrence-bound path snapshot id、unchanged-head reuse、same-revision recurrence 新 nonce、ambiguous-prefix collision branch；
- `verifiedLines`/line+empty exposure 分离：child 不继承，旧坐标+新 id 被拒绝，source snapshot 安全迁移；
- zero-line read 激活 apply、唯一 before-line-1 创建、BOM/trailing-newline 语义；
- produced receipt 只授权完整持久化的新 ranges；receipt/delta 截断后要求 fresh read；
- read model-body 与 replay exposure 严格一致；runtime-only proof 在 resume 后保守触发 proof miss；
- long-line incomplete、64-window/two-stage 50-KiB/64-KiB overflow、per-file root rebase、session file-LRU eviction；
- safe before/after translation、duplicate lines、同 revision cycle 与所有 conflict rejection；
- property test：Ledger translation 对比独立 reference document；
- same-file parallel calls 完整串行，不同文件可并行，existing/missing symlink/case aliases 使用同 queue；
- guarded `write` healthy 只 exclusive-create missing target，既有空/非空都拒绝；外部抢先创建不覆盖，fallback 委托 native；
- result effects/stats/contentChanged/revision 交叉验证；malformed success -> outcome unknown -> recovery；
- timeout/cancel/output limit/process-tree termination；
- proof miss/external stale/conflict 返回 bounded contexts、omitted/approximate 标记且零自动写入；
- `session_start(startup|reload|new|resume|fork)`、`session_tree` replay/active recompute 与 additive activation；不得依赖不存在的 post-switch/post-fork event；
- CLI unhealthy/legacy-extension conflict、`/snapline-status`、native mutator replay barrier、`agent_settled` fallback 与恢复健康；
- text read 不先调用 native read；image candidate 只委托一次 Pi image implementation；非图片 binary 拒绝；
- compaction 分类、provisional/committed TUI、UTF-8 preview budget；
- bundled `snapline.exe` capabilities 与真实 apply smoke。

命令：

```text
cd pi-snapline
npm run typecheck
npm test
npm run check
```

### 17.3 Real Pi smoke

至少真实验证：

1. Anthropic deferred-tools 模型：初始只有 read，成功 snapshot 后 additive 激活 apply。
2. OpenAI `gpt-5.4+` deferred-tools 模型：同上，确认 native deferred schema。
3. Google 或另一不支持 deferred schema 的 provider：工具行为正确，且文档说明它仍会发送完整 active list。
4. 新 session、resume、fork、tree 切换。
5. 正常 edit、distant batch、proof miss、external stale、outcome unknown 注入、图片 read、CLI unavailable fallback。

真实 smoke 必须记录模型、provider、Pi version、命令、结果和可见协议字符，不只写“手测通过”。

### 17.4 仓库验收

```text
git diff --check
git status --short
```

并执行受控全仓搜索：

- 新版本不得注册、构建或发布旧 binary、package、tool 名；
- 旧字符串只允许出现在 migration/changelog/history、未改名远端对应的 `cli/go.mod` module path、legacy-extension conflict detector，以及验证拒绝/迁移行为的定向 tests/fixtures；
- 每个 allowlist match 都要人工确认，不得以 broad grep ignore 掩盖旧 runtime 路径；
- 不得提交临时 schema budget、测试输出或未重建的 stale binary。

## 18. 发布与回滚

发布前：

1. 标记最后一个 `hledit`/`pi-hledit-diff` release，记录固定版本与下载方式。
2. 发布 breaking migration guide，明确无 alias、无旧 session replay、第三方 MCP 不兼容。
3. 生成 Snapline 1.0 source artifact 与 Windows x64 `snapline.exe`，核对 hash。
   Git 仓库已有历史 `v1.x` tag 时，Snapline release 使用产品前缀 tag `snapline-v1.0.0`，不得覆盖旧 tag；asset 使用 `snapline_1.0.0_windows_amd64.zip` 等 Snapline 名称。
4. 安装包只包含 `pi-snapline`，不能同时携带旧插件目录。
5. 新 release notes 给出旧目录人工移除、新目录安装和首次 fresh read 步骤。

回滚不是运行时协议切换。若 Snapline 1.0 出现阻断问题：

- 停止分发 Snapline release；
- 用户卸载 `pi-snapline` 并安装已固定的旧 `pi-hledit-diff` release；
- 开启新 Pi session；
- 不尝试让同一个 session 在两种 details 协议间切换。

## 19. 风险登记

| 风险 | 后果 | 控制 |
|---|---|---|
| 行坐标被错误迁移 | 写错位置 | 仅翻译插件 lineage；目标被触及即拒绝；property/reference tests |
| snapshot id 碰撞 | 绑定错误 | 96-bit prefix + full digest；所有 colliders 升级 full id，短 token 变 ambiguous 并 fail closed |
| revision 再次出现形成 lineage cycle | parent chain/授权混淆 | 每个 changed/recovery occurrence 新 128-bit nonce；parent 使用 full occurrence key |
| path alias 形成双队列 | lost update | 单一 canonicalFileKey helper + alias concurrency tests |
| proof/capacity eviction 后继续编辑 | 未读写入或断裂 lineage | per-file 新 nonce root rebase、session 完整 file eviction；同调用 recovery；不猜测 |
| CLI malformed success 被接受 | Ledger 与磁盘分叉 | source/new revision、effects、stats、contentChanged 全交叉验证 |
| process kill 后实际已写 | 重复写入 | outcome_unknown + confirmed exit + reread + no automatic retry |
| 图片能力随 read override 丢失 | 功能回退 | 调用 Pi exported built-in read definition；真实 image test |
| dynamic activation 缓存抖动 | token/延迟上升 | 普通路径只 additive；lifecycle 边界才重算 |
| 旧插件与新插件同时加载 | 重复工具/队列分裂 | 安装文档要求移除旧目录；启动时检测旧 tool collision 并告警 |
| standalone/MCP 用户无意中断 | 外部生态破坏 | 显式 breaking matrix、固定旧 release、提前发布迁移说明 |
| schema 为省 token 隐去关键约束 | 调用失败或误写 | golden budget + safety contract review，不以删除安全语义达标 |
| 大文件 Ledger 内存增长 | session 膨胀 | 32 nodes/file、4/16 MiB、LRU；Phase 6 仅按指标启动 |
| 频繁编辑超大文件 | 全文件临时写与 pre-commit 复读造成 I/O 压力 | 明确约 `2N` read/`N` write 契约、计量 telemetry；不以非原子 in-place write 优化 |
| 强制终止遗留临时文件 | 多次异常后占用磁盘 | 正常路径清理；每 invocation 最多一个；不自动删除未知文件；文档化人工确认流程 |
| Pi session JSONL 长期增长 | 会话占用磁盘 | 无额外 snapshot 存储；read delta `<=64 KiB`；暴露结果/session bytes；明确 LRU 不追溯压缩历史 |
| 旧行号误配 child snapshot | 在前方位移后指向另一行 | `verifiedLines` 与 `exposedCoverage` 分离；child exposure 不继承；错误配对 fail closed |
| recovery context 被误当迁移结果 | external rewrite 后继续错位请求 | stale/unknown windows 标 `approximate`；只授权实际展示行；绝不自动重放 |
| unrestricted `write` 绕过 snapshot | 非空文件被直接覆盖 | healthy 同名 override 只 create missing path；fallback 边界明确；与 Snapline 共用 queue |
| guarded `write` 与外部 create 竞争 | 意外覆盖刚创建文件 | canonical missing-path queue + exclusive create；EEXIST 必须拒绝 |

## 20. 完成定义

只有以下项目全部满足，Snapline 1.0 才能标记完成：

- [ ] 两个公开工具名称、schema、description 与本文一致。
- [ ] CLI/product/binary/package/display 全部使用 Snapline，无运行时旧别名。
- [ ] 模型结果不出现 raw revision、`LN#HASH`/line hash 或 proof payload；opaque snapshot id 除外。
- [ ] 路径绑定、完整 proof、原子 batch、pre-commit recheck 全部有测试。
- [ ] safe translation 有 reference-model property tests。
- [ ] proof miss/stale/conflict/outcome unknown 在 target 可读且预算允许时返回新 context；否则返回明确 recovery failure，所有路径都不自动写入。
- [ ] same-file queue 覆盖完整 read-modify-write-recovery。
- [ ] branch replay/eviction/compaction 行为有 integration tests。
- [ ] image、fallback、health recovery 有 integration tests。
- [ ] 完整 schema `<= 3,000 characters`，初始 active `<= 600 characters`。
- [ ] `go test ./...`、`go vet ./...`、benchmark、`npm run check` 全通过。
- [ ] bundled `snapline.exe` 由当前 source 重建并通过真实 smoke。
- [ ] Anthropic、OpenAI、非 deferred provider 三类 smoke 有记录。
- [ ] README、SPEC、CHANGELOG、MAINTENANCE、CI、package-lock 全更新。
- [ ] migration guide 明确旧 session、旧 CLI 与 MCP 的破坏性影响。
- [ ] 不创建 snapshot/cache 数据库；read/no-op 不写临时文件，changed apply 的 I/O 与临时文件清理契约有测试。
- [ ] 每个 exposed line/empty boundary 都完整位于同 result 的 `<= 64 KiB` typed delta；runtime-only proof 的 replay 降级、per-file root rebase 和 session file-LRU 有 integration tests。
- [ ] produced receipt、long-line/多窗口 overflow、approximate recovery、empty virtual boundary 和 create-only guarded `write` 有 integration tests。
- [ ] 文本读取不会先执行 Pi native read；图片只复用 Pi 原生 image content/render implementation。
- [ ] `git diff --check` 通过，worktree 只含预期发布改动。

## 21. 实施前审查问题

正式编码前必须逐项回答“是”，否则先修订本文：

1. 任意模型 change 是否都能唯一映射为 source splice？
2. Ledger 是否能在不保存每版全文的情况下证明每个被编辑源行？
3. 任意 external write 是否都会切断自动 translation lineage？
4. 任意 CLI started abnormal outcome 是否都不会被自动重试？
5. canonical path queue 是否覆盖 read、translation、CLI write、recovery read？
6. apply success 是否能在不信任 CLI 文本描述的情况下被结构化交叉验证？
7. 远距离 batch 是否不依赖单个连续 post-edit context？
8. branch replay 是否只消费 typed details，不消费模型正文？
9. CLI 不可用和恢复健康是否都能得到确定 active tool set？
10. 删除旧命令后，release/migration 文档是否足以让 standalone/MCP 用户做出明确选择？
11. child snapshot 是否只授权模型在该 id 下真正看到或由 receipt 明确映射的坐标？
12. proof/recovery 超出 long-line、window 或 byte budget 时，是否明确 fail closed 而非虚报覆盖？
13. healthy/fallback 两种模式下，`write` 是否分别遵守 guarded/unrestricted 的明确边界？
14. snapshot 是否保持内存/标准 session-result 语义，不产生未声明的持久文件副本？
15. changed/recovery occurrence 是否即使回到相同 raw revision 也获得新 nonce/id，从而不形成 public-id lineage cycle？
16. zero-line snapshot、guarded exclusive create 与外部 create race 是否都有唯一且可验证的所有权边界？
17. read model-body、runtime Ledger、64-KiB replay delta 和 CLI JSON cap 是否分别计量并在任一 overflow 时保守降级？
18. per-file 容量超限是否创建新的 bounded head root，而不是留下断裂 parent 或先授权后截断 exposure？

### 21.1 独立复审结论（2026-07-31）

| 维度 | 结论 | 编码门禁 |
|---|---|---|
| 安全性 | 通过设计审查 | exposure 与 verified proof 分离且 exposure 可完整重放；目标被触及、stale、unknown、容量切断全部 fail closed |
| CLI 可实现性 | 通过设计审查 | revision/text/EOL/effect/error/long-line wire 已唯一化，并由 Go golden/property tests 固定 |
| Pi 生命周期 | 通过设计审查 | 仅使用真实 `session_start`/`session_tree`/`agent_settled`，additive activation、image delegate、guarded write 与 health recovery 均有边界 |
| token 与 I/O | 通过设计审查 | 精确 schema 实测 470/2,182/2,652；模型只收局部行；无磁盘 snapshot；全文件 read/atomic-write 成本显式计量 |
| 迁移与外部影响 | 通过设计审查 | Snapline 全栈改名、无 legacy runtime、旧 session/MCP/tag/install/rollback 均显式处理 |
| 测试与发布 | 通过设计审查 | CLI/插件/reference model/真实 provider/bundled binary/仓库检查构成 release gate |

上述“通过”表示方案内部已闭合，不表示实现已经完成。任何编码结果与本表门禁冲突时，先修订设计或实现，不以兼容 shim、模糊匹配或自动 retry 绕过。
