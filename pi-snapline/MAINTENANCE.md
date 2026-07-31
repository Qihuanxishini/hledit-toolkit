# pi-snapline 维护与升级说明

本文记录 `pi-snapline` 1.0.0 与 Snapline CLI 1.x / wire protocol 1 的硬性契约、运行不变量、验证方式和升级约束。当前行为以源码、测试、[`README.md`](./README.md) 和 [`cli/SPEC.md`](../cli/SPEC.md) 为准。

## 仓库与部署边界

```text
snapline/
├─ cli/                 # Snapline CLI 唯一维护源码
└─ pi-snapline/         # Pi extension 源码与 bundled CLI
```

GitHub 仓库为 `Qihuanxishini/snapline`，Go module 为 `github.com/Qihuanxishini/snapline/cli`。

开发仓库不会自动更新 Pi 实际加载目录。正式部署只同步：

```text
pi-snapline/
├─ index.ts
├─ package.json
├─ bin/
└─ src/
```

不得部署 `test/`、`node_modules/`、README、锁文件或 `tsconfig.json`；运行时依赖由 Pi 宿主提供，正式目录不执行 `npm install`。同步后执行 `/reload` 或开启新会话。

## CLI capability 门禁

插件固定执行 `bin/snapline.exe capabilities`。兼容响应必须只含以下字段，并满足全部值：

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

硬性规则：

- `version` 必须是经过审阅的 semver-like 1.x；旧 major、未来未审阅 major 和 malformed version 均拒绝。
- 所有正 capability 必须严格为 `true`，unknown/missing field 均拒绝。
- CLI 缺失、无法启动、非零 capabilities、非 JSON 或不兼容响应进入 fallback。
- 不支持旧 command、旧 wire、binary alias、内容匹配、双注册或自动 stale retry。

CLI wrapper 默认 timeout 30 秒、combined output 上限 1 MiB、termination grace 250 ms。Windows grace 后使用 `taskkill /T /F`；其他平台使用 `SIGKILL`。终止请求不等于退出确认：必须等子进程确认 exit 后才能释放同文件 queue；无法确认时宁可阻塞，也不允许仍可能完成的进程与后续 mutation 并发。

## 公开工具与 schema

### `snapline_read_file`

```ts
{
  path: string,
  offset?: integer >= 1,
  limit?: integer 1..2000
}
```

默认 `offset=1`、`limit=160`。`prepareArguments` 只修复安全整数的非正 offset/limit 和超过 2,000 的 limit；无效类型与 unknown field 留给严格 schema 拒绝。

### `snapline_apply_changes`

```ts
{
  path: string,
  snapshot: "s_<96-bit short id or expanded full id>",
  replacements?: Array<{ start: integer, end: integer, text: string }>,
  deletions?: Array<{ start: integer, end: integer }>,
  insertions_before?: Array<{ line: integer, text: string }>,
  insertions_after?: Array<{ line: integer, text: string }>
}
```

每组 schema 上限 100 项。至少一个 group、总计 200 changes、1 MiB text、20,000 produced lines、CR/NUL 和冲突等约束由 runtime 一次验证。

两项 schema 均使用 `constrainedSampling: { type:"json_schema", strict:"prefer" }`。当前公开协议按 description 加 `JSON.stringify(parameters)` 实测合计 2,647 characters，release 回归上限为 3,000；不得通过恢复兼容字段扩大协议。

## 路径身份与 mutation queue

所有 path tool 只剥离一次模型误加的 leading `@`，并通过同一个 canonical resolver：

- 已存在目标：`realpath` 后得到 `canonicalTargetPath`；
- 缺失目标：解析最近 real ancestor，再附加剩余 suffix；
- `canonicalFileKey` 在 Windows 统一大小写和 separator；
- queue 使用 `canonicalFileKey`，确保 Windows missing-path 大小写别名不会进入不同队列；
- 获取 queue 后重新解析路径并要求 canonical identity 未变化。

Read、apply、recovery 与 guarded create 都让 `withFileMutationQueue` 覆盖完整 read/validate/CLI/write/Ledger 窗口。同文件事务串行，不同 canonical 文件仍可并行。不得只包住最终 write。

## SnapshotLedger

Snapshot 是内存中的 occurrence-bound lineage node，不是文件副本。Node 记录：

- canonical file key；
- raw-byte revision 与 total line count；
- 128-bit random occurrence nonce；
- SHA-256 occurrence digest 和公开 snapshot id；
- exact `verifiedLines`；
- 可由当前 snapshot 参数直接编辑的 `exposedCoverage` 或 zero-line virtual boundary；
- parent 与 changed-only effects。

公开 id 默认使用 digest 的 96-bit base64url 前缀。若两个完整 digest 共享前缀，所有 collider 都确定性扩展为完整 id；已发出的短 id保持 ambiguous 并 fail closed。清除一个 collider 后短 id可恢复，同时先前发出的完整 id仍可 lookup。

关键授权不变量：

- `verifiedLines` 是内部 proof；`exposedCoverage` 是模型授权，两者不得混同。
- 新 child 可以沿 verified changed effects 继承未触碰 proof，但绝不继承 parent exposure。
- Apply 只能使用 submitted snapshot 自己在同一个 typed tool result delta 中持久化的 exposure。
- Truncated prefix、omitted line、runtime-only proof 和 approximate recovery context 都不建立 exposure。
- Approximate recovery snapshot 也不暴露 zero-line virtual boundary；必须 fresh read 后才能 apply。
- Lineage 只保存 `changed:true` effects；no-op effect 仅用于成功结果交叉验证。

容量：

- 每文件最多 32 个 lineage nodes、10,000 verified lines、4 MiB UTF-8 evidence；
- session 最多 50,000 lines、16 MiB evidence；
- 单个 typed replay delta 的 `JSON.stringify` 上限 64 KiB；
- 超出每文件 lineage 容量时 rebase 为新的 nonce-bound root，优先保留当前结果可重放的 exposure；旧 ancestry 进入 review；
- session 超限按 LRU 淘汰完整 file lineage，不保留断裂 ancestry。

Snapshot 不落盘。持久化只使用 Pi 已有 session JSONL 中的 typed tool-result details；内存 LRU 不回写或压缩历史 JSONL。

## Read 事务

文本 read 的 canonical queue 流程：

1. 归一化模型参数和目标身份。
2. 调用一次 CLI protocol-1 multi-window read；不先调用 Pi native text read。
3. 严格验证 canonical path、revision、totalLines、contexts、omissions、连续性和预算。
4. 将完整非 approximate 行加入 proof；在 50 KiB 模型正文和 64 KiB replay delta 预算内选择 exposure。
5. 原子 commit Ledger stage，并返回 numbered source 和 typed delta。
6. 第一个可编辑 snapshot 后，以纯 additive active-set 更新启用 apply。

CLI collection 最多 2,000 行、50 KiB 未转义内容和 64 windows；插件格式化正文独立限制为 50 KiB。长行 prefix 可显示但不授权。图片候选只委托一次 Pi native read，由 Pi 完成 MIME、缩放、vision content block 和 TUI；图片不创建文本 Ledger state，也不激活 apply。

## Apply 事务

Apply 的 canonical queue 流程：

1. Lookup submitted snapshot，并确认它位于当前 head ancestry。
2. 验证 exposure、empty-file boundary、group shape、text 与 source-snapshot conflict。
3. 只沿插件已验证 lineage 翻译未触碰 range/boundary；任何 touched range、重复 boundary 或断裂 lineage 都停止。
4. 从 source node 收集完整 exact proof，构造 CLI wire request。
5. CLI 验证 expected revision、proof、range、conflict、target/parent identity 和原子提交。
6. 插件独立重算每个 expected effect、new coordinate、stats、outcome 与 revision，并要求与 CLI 精确一致。
7. Changed success 构造 commit-bound preview，保存 changed child；no-op 保留 submitted snapshot。

一次 apply 最多调用一次真正的 CLI apply，不自动 retry。CLI `applied` 必须有 changed effect、不同 revision 和 `contentChanged:true`；`no_op` 必须全部 unchanged、revision 相同且不写文件。

提交后若 preview 或 Ledger persistence 失败，文件已经 changed，结果仍必须报告 changed success，并附 `snapshot_persistence_failed`，绝不能伪装为零写入错误。

## Recovery 与 disposition

Read details：

```ts
"succeeded" | "rejected" | "unavailable"
```

Apply details：

```ts
"succeeded" | "rejected" | "needs_review" | "unavailable" | "outcome_unknown"
```

- Proof miss、unknown/ambiguous/evicted snapshot、lineage conflict、external stale 和确认零写入 race 可在同一 queue 内执行一次 bounded current read，并返回 `needs_review`；旧请求绝不重放。
- Recovery 根据每个 change 单独构造窗口，避免远距离 change 被一个 min-to-max 大窗口吞掉；最多归一化为 64 windows。
- 返回的 stale-coordinate context 标记 `approximate`，只用于人工 relocation；Ledger delta 不持久化这些行的 proof/exposure。
- 目标删除、不可读、binary、超长行或预算不足时，recovery 可明确失败或报告 omitted range，不保证总能返回 context。
- 已启动 apply 的 timeout、cancel、output limit、stdin error、非零退出或 malformed response 归类 `outcome_unknown`；清除受影响 file lineage，尝试新 occurrence recovery，并明确禁止 identical retry。

`tool_result` handler 根据结构化 details 修正 Pi `isError`：read 非成功为 error；apply `needs_review` 保持非 error；其他非成功 apply 为 error。

## Lifecycle、active tools 与 replay

只依赖 Pi 的真实事件：

- `session_start`：探测 capability，清空并从当前 branch 重建 Ledger，同步模式；
- `session_tree`：从 typed details 重建 branch-correct state；pending fallback 时不恢复 healthy；
- `before_agent_start`：不做 I/O 或 health probe，只修复可能被 host reset 的 active set；
- `agent_settled`：应用 runtime health failure 计划的 fallback；
- `session_shutdown`：清理 runtime state。

模式：

- Healthy：移除内置 text `read`/`edit`，启用 Snapline read，存在 exposure 时启用 apply；同名 guarded write 只创建缺失目标。
- Fallback：移除 Snapline tools，恢复 native read/edit/write。
- Legacy conflict：只移除 Snapline tools，不改动竞争扩展自己的 active set。

`/snapline-status` 重新探测 CLI；健康后先清 Ledger，再从当前 branch 保守 replay，最后同步工具。

Replay 只接受 `protocolVersion:1`、匹配 tool name 的 `operation` discriminator 和严格 typed delta。它重新验证 canonical key、snapshot、revision、line count、capacity marker、effect shape/order/formula、stats 和 parent attachment。Malformed changed apply 会清除受影响 file lineage；无法确定文件时才全局清除。

任意成功或 outcome-unknown 的非 Snapline `write`/`edit`，以及 legacy mutation unknown，构成外部 mutation barrier。Replay 从 barrier 后重新建立状态；绝不解析模型正文或旧 tool arguments 推断 proof。

## Guarded write

Healthy write：

1. canonical resolve 缺失 candidate；
2. 在 canonical queue 内复核；
3. 创建父目录后再次复核；
4. 使用 `wx` exclusive create；
5. write、sync、close 完成后返回；
6. 一旦 exclusive open 成功即清除该文件 Ledger，即使后续 abort/sync/close 失败也不能保留旧 proof。

任何已存在 entry、dangling symlink、目录、alias race 或外部预创建都会拒绝。Fallback 直接委托 native write。

## Preview、TUI 与 compaction

- `details.preview` 只由 revision-bound proof、请求生成文本和 CLI-validated effects 构成，不读取无绑定 before/after 全文件。
- Preview 上限 2,000 行 / 256 KiB UTF-8；超长单行保留首尾并标记 truncated。
- Model-visible changed receipt 上限 8 KiB，只列 snapshot、stats、produced ranges 和 warning，不发送详细 diff。
- TUI 对远距离 changes 显示独立 hunks，并按宽度切换 split/unified rendering。
- Compaction 只根据 matching operation 的 typed details 记录 read、modified、no-op/recovery 和 outcome-unknown fileOps。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工具注册、模式/lifecycle、image delegate、status、isError 与 compaction。 |
| `src/schema.ts` | 两项公开严格 schema 和协议预算。 |
| `src/canonical-path.ts` | leading-@、real ancestor、canonical key 与 identity。 |
| `src/cli.ts` / `src/wire.ts` | capability、bounded process、strict protocol-1 response。 |
| `src/read-transaction.ts` | Unified read canonical queue transaction。 |
| `src/apply-transaction.ts` / `src/apply-validation.ts` | Apply validation、wire、recovery 与 commit。 |
| `src/coordinate-translation.ts` | 公开 batch 验证和 conservative lineage translation。 |
| `src/snapshot-ledger.ts` | Occurrence identity、proof/exposure、lineage、delta 与容量。 |
| `src/snapshot-format.ts` / `src/apply-format.ts` | 模型正文、授权预算与 typed delta commit。 |
| `src/recovery.ts` | 多窗口 approximate current-context recovery。 |
| `src/replay.ts` | Branch typed-delta replay 与 mutation barriers。 |
| `src/guarded-write.ts` | Healthy missing-file-only exclusive create。 |
| `src/change-preview.ts` / `src/render.ts` / `src/diff-renderer.ts` | Commit-bound preview 与 TUI。 |
| `src/compaction-files.ts` | 结构化 fileOps 分类。 |

## 验证与 bundled binary 更新

先验证 tracked binary：

```bash
cd pi-snapline
npm ci
npm run test:bundled
```

随后执行：

```bash
cd ../cli
gofmt -l *.go
go vet ./...
go test ./...
go build -trimpath -ldflags="-s -w" -o ../pi-snapline/bin/snapline.exe .
cd ../pi-snapline
npm run test:bundled
npm run check
```

`test:bundled` 使用真实 `bin/snapline.exe` 覆盖 capability、read/apply、recovery、guarded write、branch replay、parallel serialization 和 empty-file transaction。CI 必须在覆盖 binary 前验证 tracked artifact，重建后再次运行 bundled 与 full check。

Go planner 还需运行 property test 和有界 fuzz；race gate 在 Windows 需要 CGO 与 gcc，环境缺失时必须明确记录为阻塞，不能默报通过。

## 真实 Pi 验收

仓库隔离启动：

```bash
pi --no-extensions -e ./pi-snapline/index.ts
```

使用 `/snapline-status` 确认 1.0.0 / wire protocol 1 健康，并至少覆盖：

1. numbered read、lazy apply 和四种 group；
2. proof gap、external stale、approximate recovery、fresh read 后成功；
3. same-file parallel untouched translation 与 touched conflict；
4. session branch、compaction、`/reload` 与 native mutation barrier；
5. mixed EOL、BOM、trailing newline、中文/emoji 和 distant TUI hunks；
6. image delegate、zero-line snapshot 与 guarded missing-file create；
7. CLI missing/incompatible、legacy conflict、`/snapline-status` recovery 和 deferred fallback。

Release gate 应分别覆盖 Anthropic/OpenAI 的 deferred-tool 模型，以及 Google 或其他非 deferred provider。无法在本地自动执行 provider smoke 时必须明确记录，不得用单元测试替代该声明。

## 升级原则

1. 不恢复旧工具、binary alias、内容匹配、模糊迁移或 compatibility layer。
2. 不把 approximate context、truncated prefix 或 runtime-only proof 变成 editable exposure。
3. 不自动 replay stale/outcome-unknown request。
4. 不绕过 canonical mutation queue、CLI complete proof 或 pre-commit revision/identity recheck。
5. 不把完整 diff 或 full-file snapshot 发送给模型，也不创建磁盘 snapshot cache。
6. 协议变更必须同步更新 CLI、插件、tracked binary、schema budget、端到端测试和中文文档。
