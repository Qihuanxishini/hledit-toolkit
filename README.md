# hledit-toolkit

面向 AI 编程代理的哈希锚点安全编辑工具集。仓库同时包含 `hledit` CLI 与对应的 Pi 编辑增强插件。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| [`cli/`](./cli/) | Go 编写的 `hledit` CLI：校验 `LN#HASH` 锚点、原子执行批量修改，并直接返回受限的新锚点窗口。 |
| [`pi-hledit-diff/`](./pi-hledit-diff/) | Pi 插件：注册严格的 `hledit_read_anchors` 与 `hledit_apply_file_changes` 工具，并提供 diff 渲染。 |

插件当前面向 Windows x64，仓库内附带 `pi-hledit-diff/bin/hledit.exe`。

## 核心特点

- 使用 `LN#HASH` 锚点检测读取后发生的文件变化，拒绝 stale 修改。
- 一次 batch 原子提交同一文件中的多个非冲突修改。
- 单次重建文件，避免多 edit 场景下反复复制整份内容。
- batch 成功后直接返回 `updatedAnchors`，无需再次启动 `read-range`。
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
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true
}
```

读取结果必须携带 `totalLines` 和严格截断元数据；batch 成功响应必须携带合法的 `updatedAnchors`。插件不保留旧 CLI 的读取或修改后回退路径。

## 开发仓库与运行目录

本仓库是独立开发工作区。Pi 的实际插件加载目录可以位于其他位置；克隆或更新本仓库不会自动改变 Pi 当前使用的插件目录。

## 上游与致谢

CLI 基于 [`dabito/hledit`](https://github.com/dabito/hledit) 修改并保留 MIT 许可证。本仓库增加了 patched batch 协议、内联新锚点响应、单次批处理重建，以及配套的 Pi 插件。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。
