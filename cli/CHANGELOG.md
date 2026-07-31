# 更新日志

## [Unreleased]

## [1.0.0] — 2026-07-31

### 新增

- 引入 Snapline wire protocol 1 后端，只保留严格 `read` 和 source-snapshot-simultaneous grouped `apply`。
- 支持 bounded multi-window read、完整 source-line proof、确定性 edit effects/statistics、approximate recovery context 和零行文件事务插入。
- 引入绑定 raw revision、目标身份和父目录身份的原子替换，临时文件使用唯一 `.snapline-*` 同目录路径。
- 增加 projected-document property/fuzz、mixed-EOL/BOM、commit race、strict wire 和真实 bundled CLI 集成覆盖。

### 变更

- 产品、命令和 GitHub 仓库统一改名为 Snapline；仓库地址为 `Qihuanxishini/snapline`，Go module 为 `github.com/Qihuanxishini/snapline/cli`。
- Pi extension 改为 `pi-snapline` 1.0.0，提供 `snapline_read_file` 和 lazy activated `snapline_apply_changes`。
- Windows bundled binary 改为 `snapline.exe`。
- 模型侧从 line hash 改为 path-bound snapshot coordinates；hash、精确文本 proof、occurrence identity 与 raw revision 转为插件内部状态。
- 未触碰行逐行保留 terminator、UTF-8 BOM 和 trailing-newline 状态，并在 commit 前独立复核目标与 canonical parent identity。
- 命令行 misuse 退出 2，可信逻辑 outcome 退出 0，基础设施或不确定 commit outcome 退出 1。

### 移除

- 删除旧 anchor/read-range/standalone-edit/batch commands 与旧 binary alias。
- 删除 content matching、fuzzy recovery、compatibility wrapper、dual protocol registration 和自动 stale retry。
- 有意中断旧 standalone 与 MCP integration；使用方必须迁移到 wire protocol 1，或固定旧版本。

### 迁移

- 历史 session 的 anchor evidence 无法转换为 snapshot lineage；升级后必须重新读取每个目标。
- 旧工具与新工具不双注册。Pi 中检测到旧扩展冲突时，Snapline fail closed，并保留冲突扩展的 active set。
- `/snapline-status` 可在修复 CLI 或移除冲突后重新探测、保守 replay 当前 branch 并恢复健康工具集。

## 前身协议历史

以下内容仅记录本项目旧 anchor-based 实现的历史，不属于 Snapline 1.0 runtime contract。

| 版本 | 日期 | 主要变化 |
| --- | --- | --- |
| 3.0.0 | 2026-07-30 | 删除 `replace-once` 与 `contentReplaceOnce`；standalone write 增加 pre-commit raw revision recheck。 |
| 2.3.1 | 2026-07-25 | 最终文件只编码一次；10 MiB edit 显著降低分配；revision recheck 改为 streaming SHA-256。 |
| 2.3.0 | 2026-07-25 | 逐行保留 mixed CRLF/LF、BOM、孤立 CR 与 trailing-newline；删除 whole-file normalization warning。 |
| 2.2.2 | 2026-07-25 | 曾为 mixed-EOL normalization 增加显式 warning，随后在 2.3.0 被逐行保留策略取代。 |
| 2.2.1 | 2026-07-25 | 删除不安全的旧 `.hledit-*` mtime/prefix sweep，避免误删无归属文件。 |
| 2.2.0 | 2026-07-25 | 引入 `editDeltas`、case-insensitive read 与 physical-boundary planning。 |
| 2.1.0 | 2026-07-24 | 增加唯一 exact block replacement，后于 3.0.0 删除。 |
| 2.0.0 | 2026-07-21 | Anchor 从两字符升级为三字符，并收紧 annotated anchor 解析与 stale recovery。 |
| 1.5.0 | 2026-07-21 | Stale batch 返回 bounded current context，但不自动 retry。 |
| 1.4.0 | 2026-07-19 | 拒绝无效 UTF-8、保留 BOM、严格拒绝 unknown/trailing batch JSON。 |
| 1.3.0 | 2026-07-19 | 增加 no-op detection、symlink target preservation、unique temp、hardlink rejection 和 durability warning。 |
| 1.2.x | 2026-07-01 至 2026-07-18 | 增加 range metadata、updated context、line stats、pretty rendering 和多项边界修复。 |
| 1.1.x | 2026-06-29 至 2026-07-01 | 增加 grep/context、structured read 和 larger UTF-8 fixtures。 |
| 1.0.x | 2026-06-22 至 2026-06-28 | 首个稳定 anchor CLI、atomic batch 与 trailing-newline preservation。 |
| 0.1.x | 2026-06-21 | 初始 hash-anchored editor 与早期 Pi integration。 |
