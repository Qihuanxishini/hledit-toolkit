# Snapline

Snapline 是面向 AI 编程代理的 snapshot-coordinate 文本编辑工具集。它把模型看到的行号坐标、插件内部的完整读取证据和 CLI 的原子提交组合为一个 fail-closed 工作流。

GitHub 仓库：[`Qihuanxishini/snapline`](https://github.com/Qihuanxishini/snapline)。

本仓库包含两个同步发布的组件：

| 目录 | 组件 | 用途 |
| --- | --- | --- |
| [`cli/`](./cli/) | Snapline CLI 1.0.0 | Go 编写的严格 wire-protocol-1 读取与事务提交后端。 |
| [`pi-snapline/`](./pi-snapline/) | pi-snapline 1.0.0 | Pi 扩展；提供统一读取、snapshot lineage、坐标迁移、恢复与 TUI diff。 |

Windows x64 bundled binary 位于 `pi-snapline/bin/snapline.exe`。

## 工作流

健康模式下，Pi 使用两个模型工具：

- `snapline_read_file`：读取文本并返回普通 `LINE:TEXT` 行，同时在结构化结果中建立 path-bound snapshot 和完整行证据；默认 160 行。
- `snapline_apply_changes`：以读取时的 snapshot 坐标提交 grouped replacements、deletions、insertions_before 和 insertions_after。

第一次成功的文本 snapshot read 后，apply 工具才会以纯 additive activation 方式启用。读取图片时，插件委托 Pi 原生图片处理，不建立文本 proof，也不启用 apply。

`write` 在健康模式下只可独占创建不存在的路径。任何已存在文件（包括零字节和仅 BOM 文件）都必须先读取，再通过 snapshot transaction 修改。CLI 不可用或不兼容时，插件恢复 Pi 原生 `read`、`edit` 和普通 `write`。

## 安全模型

- snapshot id 同时绑定 canonical path、raw-byte revision 和随机 occurrence nonce；它不是磁盘文件副本。
- 模型只能编辑提交 snapshot 自己暴露且在同一 typed tool result 中持久化的精确行。
- 插件仅沿自身已验证、未触碰的 lineage 迁移坐标；不使用模糊匹配，不猜测重复文本。
- CLI 再次验证 expected revision、完整 source-line proof、所有 group 冲突、目标与父目录身份，并在 commit 前复读 revision。
- 同一文件的 read/apply/recovery/create 持有 canonical `withFileMutationQueue` 覆盖整个事务；不同文件仍可并行。
- 任一 stale、proof gap、lineage conflict、容量淘汰或身份变化均停止原请求。插件可在同一队列内返回当前 bounded recovery snapshot，但不会自动重放旧修改。
- 已启动进程的异常结果按 `outcome_unknown` 处理；必须审阅新 snapshot，禁止原样重试。
- batch 中任一 change 失败时零 partial write；changed apply 使用 sibling temporary、sync、revision recheck 和 atomic replace。

## 字节与存储行为

- raw revision 是目标原始字节的 SHA-256；UTF-8 BOM、CRLF/LF 混合状态和末尾换行都会参与。
- 未修改行保留原 terminator；新行继承局部行尾策略；BOM 和 trailing-newline 状态保持。
- SnapshotLedger 仅保存在扩展内存和 Pi 已有的 tool-result JSONL details 中，不创建 snapshot 文件或缓存数据库。
- changed apply 临时使用一个 `.snapline-*` 同目录文件；正常 success/rejection 会清理。强制终止可能留下当前 invocation 的一个临时文件，不能仅凭前缀或 mtime 自动删除。
- no-op、read 和 rejected apply 不写目标文件。

## 协议边界

CLI 的唯一集成面是：

```text
snapline --version
snapline capabilities
snapline read     # one strict JSON document on stdin
snapline apply    # one strict JSON document on stdin
```

`capabilities` 必须报告 product `snapline`、1.x 版本和 wire protocol 1 的完整正 capability。CLI 没有旧名称 alias、anchor 命令或 standalone content-matching edit。

完整 wire 契约见 [`cli/SPEC.md`](./cli/SPEC.md)；Pi 生命周期、Ledger 和部署约束见 [`pi-snapline/MAINTENANCE.md`](./pi-snapline/MAINTENANCE.md)。

## 开发验证

CLI：

```bash
cd cli
gofmt -l *.go
go vet ./...
go test ./...
```

Pi 扩展：

```bash
cd pi-snapline
npm ci
npm run check
npm run test:bundled
```

重建 Windows bundled CLI：

```bash
cd cli
go build -trimpath -ldflags="-s -w" -o ../pi-snapline/bin/snapline.exe .
```

## Breaking migration

Snapline 1.0 是一次单向迁移：

- 扩展目录/包名改为 `pi-snapline`；工具改为 `snapline_read_file` 和 `snapline_apply_changes`；binary 改为 `snapline.exe`。
- 旧 anchor CLI、旧 Pi 工具、兼容 wrapper 和双注册均已删除。
- 旧 Pi session 的 anchor evidence 不会转换为 snapshot lineage；升级后必须重新读取目标文件。
- 依赖旧 CLI 的第三方 MCP 集成不兼容；应固定旧版本，或独立迁移到 wire protocol 1。
- 部署前先删除 Pi 实际扩展目录中的旧 `pi-hledit-diff`，再安装 `pi-snapline`，避免两套扩展同时注册。
- 若 Pi 中仍注册旧扩展工具，Snapline 会 fail closed 并进入原生 fallback，直到移除冲突并执行 `/snapline-status` 或重新加载。

仓库开发副本不会自动更新 Pi 实际加载目录。部署说明见 [`pi-snapline/README.md`](./pi-snapline/README.md)。

## 许可证与来源

MIT，见 [`LICENSE`](./LICENSE)。早期实现源自 [`dabito/hledit`](https://github.com/dabito/hledit)；历史版本保留在 [`cli/CHANGELOG.md`](./cli/CHANGELOG.md)。
