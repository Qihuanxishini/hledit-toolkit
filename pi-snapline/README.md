# pi-snapline

`pi-snapline` 1.0.0 是为 Pi 提供 snapshot-bound 事务文本编辑的扩展。它用一次编号读取同时建立 hidden proof，避免原生 read 后再重复读取，并通过 bundled Snapline CLI 提交 grouped line-coordinate changes。

## 环境要求

- 与 Pi 0.82.x 兼容的 extension API。
- 仓库测试使用 Node.js 24。
- Windows x64 bundled CLI：`bin/snapline.exe`。

本扩展执行单向迁移：不注册旧工具名、不携带 binary alias，也不转换历史 anchor evidence。
升级已有安装时，先删除 Pi 实际扩展目录中的旧 `pi-hledit-diff`，再复制 `pi-snapline`，避免两套工具同时注册。

## 模型工具

健康模式提供：

### `snapline_read_file`

```ts
{
  path: string,
  offset?: integer >= 1,       // 默认 1
  limit?: integer 1..2000      // 默认 160
}
```

文本结果使用普通 `LINE:TEXT` 行和紧凑 receipt：

```text
12:const value = load();
13:return value;

[snapshot:s_xxxxxxxxxxxxxxxx lines:12-13/80 next:14]
```

成功文本读取会为完整返回行建立或合并 exact proof 与可重放 exposure。长行前缀和省略行可以展示，但不能编辑。图片委托 Pi 原生 reader，不创建文本 snapshot。

### `snapline_apply_changes`

```ts
{
  path: string,
  snapshot: string,
  replacements?: [{ start: 12, end: 13, text: "new line\nanother line" }],
  deletions?: [{ start: 20, end: 22 }],
  insertions_before?: [{ line: 30, text: "before" }],
  insertions_after?: [{ line: 31, text: "after" }]
}
```

规则：

- 坐标属于提交的 snapshot；replacement/deletion 的 `end` 包含在范围内。
- 一次调用包含同一文件的全部非冲突 change，且至少提供一个 group。
- 每组最多 100 项；运行时限制为总计 200 个 change、1 MiB text 和 20,000 个产出行。
- Text 用 LF 分隔并拒绝 CR/NUL。空 replacement text 产生一个空行；删除必须使用 `deletions`。
- 已存在的零行文件通过 snapshot 修改：在虚拟 line 1 前精确插入一次。
- 模型只能定位该 snapshot 自己暴露的行。插件内部提供完整 proof，并独立验证 CLI 的每个 effect、坐标、统计和 revision。
- Changed batch 原子提交；no-op 不触碰目标。

第一次获得可编辑文本 snapshot 后，apply 才会 lazy activate。对支持 deferred tool 的模型，该纯 additive activation 可立即用于下一次模型请求；其他 provider 在下一次正常 active-tool 同步后获得该工具。

## 健康模式下的 write

同名 `write` override 只能独占创建缺失路径，并拒绝所有已存在 entry，包括零字节和仅 BOM 文件。创建后必须先 read，再继续修改。

该约束防止 whole-file overwrite 绕过 snapshot proof。Fallback mode 会恢复 Pi 原生 `write` 行为。

## 安全与恢复

- Snapshot id 绑定 canonical file identity、raw-byte revision 和随机 occurrence nonce；snapshot 是内存 lineage record，不是磁盘副本。
- 坐标只沿插件已知的 changed effects 迁移，并要求目标行和 insertion boundary 均未被触碰；不使用模糊或文本匹配迁移。
- Read、apply、recovery 和 guarded create 在完整事务期间持有 Pi canonical file mutation queue。
- CLI 验证当前目标/父目录身份、精确 source proof、冲突和 raw revision，并在 atomic replace 前再次复核 revision。
- Proof gap、未知或被淘汰 snapshot、lineage conflict、external stale 和 commit race 都会停止旧请求；安全情况下可返回 bounded current context，但不会重放写入。
- Recovery 行明确标记 `approximate`，只用于人工重定位，不建立 proof 或 editable exposure；apply 前必须 fresh read。
- 已启动进程的 timeout、cancel、output overflow、非零退出或 malformed apply response 归类为 `outcome_unknown`，禁止原样重试。
- 同文件 sibling call 串行执行。先完成的 sibling 若未触碰后续坐标，后者可安全迁移；触碰冲突则返回 `needs_review`。

## 运行模式

| 模式 | Active behavior |
| --- | --- |
| Healthy | Snapline read、lazy apply、create-only write；移除原生文本 read/edit。 |
| Fallback | 移除 Snapline tools；恢复原生 read/edit/write。 |
| Legacy conflict | 只移除 Snapline 自身工具，让冲突扩展继续控制自己的 active set。 |

启动和 branch navigation 只从当前 branch 的 typed tool-result details 重建 SnapshotLedger。成功或 outcome-unknown 的非 Snapline mutation 构成 replay barrier。Runtime health failure 会先完成当前结构化 outcome，直到 `agent_settled` 才切换 fallback。

使用 `/snapline-status` 查看健康状态，或在修复 bundled CLI、移除 legacy conflict 后重新验证 capability。该命令会清空 runtime state、保守重放当前 branch，并重新同步工具。

## TUI 与 compaction

- Read 显示带 snapshot 和 omission metadata 的编号语法高亮源码。
- Changed apply 显示 commit-bound、revision-validated 局部 diff hunks；preview 上限为 2,000 行和 256 KiB。
- 紧凑模型正文不携带详细 diff；持久化结构化 details 用于 expanded rendering 和 branch replay。
- Compaction 只根据 typed protocol-1 details 记录成功 read、changed/no-op apply、review recovery 和 outcome-unknown 文件活动。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run test:bundled
# 或一次运行 TypeScript 与全部 Node 检查：
npm run check
```

从 `../cli` 重建 tracked Windows CLI：

```bash
go test ./...
go vet ./...
go build -trimpath -ldflags="-s -w" -o ../pi-snapline/bin/snapline.exe .
cd ../pi-snapline
npm run test:bundled
npm run check
```

## 运行与部署

从仓库执行隔离 smoke：

```bash
pi --no-extensions -e ./pi-snapline/index.ts
```

正式 Pi extension 目录只需要以下 runtime whitelist：

```text
pi-snapline/
├─ index.ts
├─ package.json
├─ bin/
└─ src/
```

不要部署 `test/`、`node_modules/`、文档、`package-lock.json` 或 `tsconfig.json`。运行时依赖由 Pi 提供，不要在正式扩展目录执行 `npm install`。同步后执行 `/reload` 或开启新会话。

仓库改动不会自动更新 Pi 已安装的 extension copy。生命周期、Ledger、协议、验证和发布约束见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
