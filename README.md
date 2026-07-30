# hledit-toolkit

面向 AI 编程代理的哈希锚点安全编辑工具集。仓库同时包含 `hledit` CLI 与对应的 Pi 编辑增强插件。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| [`cli/`](./cli/) | Go 编写的 `hledit` CLI：校验 v2 `LN#HASH`（三位 URL-safe Base64）锚点，原子执行单项或批量锚点修改，并返回受限的新锚点窗口。 |
| [`pi-hledit-diff/`](./pi-hledit-diff/) | Pi 插件：注册严格的 `hledit_read_anchors` 与 `hledit_apply_file_changes` 工具，并提供 evidence 管理和 diff 渲染。 |

插件当前面向 Windows x64，仓库内附带 `pi-hledit-diff/bin/hledit.exe`。

## 设计与优化路线

- [`ANCHOR-EDITING-HARDENING-PLAN.md`](./ANCHOR-EDITING-HARDENING-PLAN.md)：CLI 3.0 / 插件 0.2 的协议收敛与安全加固实施记录。
- [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md)、[`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) 及其他 execution plan 保留为历史实施记录；当前运行契约以代码、测试、README 和维护文档为准。

## 核心特点

- 使用 v2 `LN#HASH`（三位 URL-safe Base64 hash）锚点检测读取后发生的文件变化，拒绝 stale 修改。
- 一次 batch 原子提交同一文件中的多个非冲突修改，并在原子替换前复检原始字节 revision。
- 单次重建文件，避免多 edit 场景下反复复制整份内容。
- batch 成功后直接返回 `updatedAnchors` 与 `editDeltas`，无需再次启动 `read-range`；插件用 `editDeltas` 把未受影响行的读取证据平移到新行号，顺序多次编辑同一文件通常不再需要中间重读。
- 模型提交编辑前的旧锚点时，插件会对持续存活的平移目标给出 verified rename；若旧 token 被当前行重新占用，或其源行/alias 目标被消费失联，则在显式重读前拒绝立即与延迟复用。
- JSON 读取返回基于原始字节的 SHA-256 revision；插件在 canonical file queue 内维护有界 evidence，并将完整消费行 proof 注入 anchored batch。公开 change 只需复制首尾或依附行的 `LN#HASH` token。
- CLI 健康时，两个专用工具替代内置 `edit`；apply 始终独立检查当前 branch 的读取证据，CLI 缺失或不兼容时恢复内置 `edit`。
- 插件工具参数采用严格 schema 并启用 provider 侧 constrained sampling（`strict: prefer`，不支持的模型自动回落）；`insufficient_read_proof` 作为可恢复补读结果返回，其他失败继续转换为真正的 Pi 工具错误。
- `read` / `read-range` / `anchors` 支持 `--ignore-case` 子串过滤；插件 `hledit_read_anchors` 暴露 `ignore_case` 参数。
- replace/delete 范围的前后物理边界上允许位置确定的 insert（内容依附其锚点行）；落入范围内部边界的 insert 仍整批拒绝。
- 插件内置主题自适应的锚点预览与统一/双栏 diff 渲染；结构化 preview 按 UTF-8 字节限制，截断时显示 CLI 校验的完整增删统计。

### 行尾与编码行为

- revision 基于原始字节，BOM、CRLF/LF 与末尾换行差异都会改变 revision。
- 写入时逐行保留 terminator：未修改行的行尾字节保持原样，混合行尾文件不再被整体规范化，也不再产生 mixed line ending warning。编辑产生的新行使用编辑位置附近的局部行尾，replacement 最后一行继承被替换范围末行的 terminator。
- 孤立 `\r`（无 `\n`）属于行文本，不是行分隔符；UTF-8 BOM 与末尾换行的有无在写入时保持原状；删除全部逻辑行会生成真正的空文件。

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
  "version": "3.0.0",
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true,
  "batchEditDeltas": true,
  "readIgnoreCase": true
}
```

读取结果必须携带 `revision`、`totalLines` 和严格截断元数据。连续范围或完整返回的 grep 行都可形成局部写入证据；revision 与已读 anchors 保持在内部，不加入模型工具 schema。batch wire v3 中 `delete` 必须省略 `lines`，旧 `delete.lines:[]` 形状直接拒绝。成功 batch 响应必须携带新 `revision`、合法的 `updatedAnchors` 与非空且与请求一致的 `editDeltas`（插件逐项互核，内部矛盾按结果未知处理）；失败可按需返回 `currentRevision` 和同一快照的 `currentAnchors`。插件要求 CLI 3.x、拒绝已删除的 `contentReplaceOnce` 字段，并且不保留旧 CLI、旧 wire、无 proof batch 写入、内容匹配替换或自动 stale 重试路径。

## 开发仓库与运行目录

本仓库是独立开发工作区。Pi 的实际插件加载目录可以位于其他位置；克隆或更新本仓库不会自动改变 Pi 当前使用的插件目录。

## 上游与致谢

CLI 基于 [`dabito/hledit`](https://github.com/dabito/hledit) 修改并保留 MIT 许可证。本仓库增加了 patched batch 协议、内联新锚点响应、单次批处理重建，以及配套的 Pi 插件。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。
