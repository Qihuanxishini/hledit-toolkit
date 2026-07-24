# hledit-toolkit

面向 AI 编程代理的哈希锚点安全编辑工具集。仓库同时包含 `hledit` CLI 与对应的 Pi 编辑增强插件。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| [`cli/`](./cli/) | Go 编写的 `hledit` CLI：校验 v2 `LN#HASH`（三位 URL-safe Base64）锚点、原子执行批量修改或唯一精确内容替换，并返回受限的新锚点窗口。 |
| [`pi-hledit-diff/`](./pi-hledit-diff/) | Pi 插件：注册严格的 `hledit_read_anchors`、`hledit_apply_file_changes` 与 `hledit_replace_once` 工具，并提供 diff 渲染。 |

插件当前面向 Windows x64，仓库内附带 `pi-hledit-diff/bin/hledit.exe`。

## 核心特点

- 使用 v2 `LN#HASH`（三位 URL-safe Base64 hash）锚点检测读取后发生的文件变化，拒绝 stale 修改。
- 一次 batch 原子提交同一文件中的多个非冲突修改；`replace-once` 仅在旧内容块在当前文件中唯一时原子替换它。
- 单次重建文件，避免多 edit 场景下反复复制整份内容。
- batch 或 replace-once 成功后直接返回 `updatedAnchors`，无需再次启动 `read-range`。
- JSON 读取返回基于原始字节的 SHA-256 revision；插件维护连续或 grep 离散的完整已读行集合，并将隐藏 proof 注入 anchored batch。
- batch 与 replace-once 都在原子替换前复检 revision，检测规划期间的大部分外部修改；复检与 rename 之间仍保留极短竞争窗口。
- CLI 健康时，三个编辑工具始终替代内置 `edit`；apply 仍独立检查当前 branch 的读取证据，replace-once 以唯一精确内容为前置条件。
- 插件工具参数采用严格 schema，并将 logical failure 转换为真正的 Pi 工具错误。
- 插件内置主题自适应的锚点预览与统一/双栏 diff 渲染，不依赖其他显示插件。

## 开发验证

CLI：

```bash
cd cli
go test ./...
go vet ./...
```

Pi 插件：

```bash
cd pi-hledit-diff
npm ci
npm run check
```

## CLI 与插件契约

插件要求 bundled CLI 的 `capabilities` 至少包含：

```json
{
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true,
  "contentReplaceOnce": true
}
```

读取结果必须携带 `revision`、`totalLines` 和严格截断元数据。连续范围或完整返回的 grep 行都可形成局部写入证据；revision 与已读 anchors 保持在内部，不加入模型工具 schema。batch wire v3 中 `delete` 必须省略 `lines`，旧 `delete.lines:[]` 形状直接拒绝。成功 batch 与 replace-once 响应必须携带新 `revision` 与合法的 `updatedAnchors`；batch 失败可按需返回 `currentRevision` 和同一快照的 `currentAnchors`，replace-once 的未命中或歧义匹配均零写入。插件不保留旧 CLI、旧 wire、无 proof batch 写入或自动 stale 重试路径。

## 开发仓库与运行目录

本仓库是独立开发工作区。Pi 的实际插件加载目录可以位于其他位置；克隆或更新本仓库不会自动改变 Pi 当前使用的插件目录。

## 上游与致谢

CLI 基于 [`dabito/hledit`](https://github.com/dabito/hledit) 修改并保留 MIT 许可证。本仓库增加了 patched batch 协议、内联新锚点响应、单次批处理重建，以及配套的 Pi 插件。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。
