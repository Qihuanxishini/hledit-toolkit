# hledit-toolkit

面向 AI 编程代理的哈希锚点安全编辑工具集。仓库同时包含 `hledit` CLI 与对应的 Pi 编辑增强插件。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| [`cli/`](./cli/) | Rust 编写的 `hledit` CLI：只提供结构化 `read-range`、`search` 与原子 `batch` 协议；使用 v2 `LN#HASH`（三位 URL-safe Base64）锚点和 raw-byte revision。 |
| [`pi-hledit-diff/`](./pi-hledit-diff/) | Pi 插件：注册严格的 `hledit_read_anchors`、`hledit_search_anchors` 与 `hledit_apply_file_changes` 工具，并提供 evidence 管理和 diff 渲染。 |

插件当前面向 Windows x64，仓库内附带 `pi-hledit-diff/bin/hledit.exe`。

## 文档

- [`cli/README.md`](./cli/README.md)：CLI 安装、命令和使用说明。
- [`cli/SPEC.md`](./cli/SPEC.md)：CLI 的当前实现与协议契约。
- [`pi-hledit-diff/README.md`](./pi-hledit-diff/README.md)：Pi 插件工作流和安装说明。
- [`pi-hledit-diff/MAINTENANCE.md`](./pi-hledit-diff/MAINTENANCE.md)：插件与 bundled CLI 的维护约束。

## 核心特点

- **原子编辑**：一次 batch 验证同一文件全部变更，单次重建，并在替换前复检 raw-byte revision。
- **安全续编**：proof 与锚点共同定义目标身份。成功编辑返回新 proof；旧目标仅在可验证存续时迁移，不因 token 复用而误认新行。
- **有界证据与恢复**：完整源行形成 proof，缺口可定向补读；越界、截断或容量不足给出明确下一步，不自动重试写入。
- **结构化搜索**：RE2 兼容正则与字面量搜索，支持上下文、大小写选项及物理行分页。
- **编码与写入保护**：保留 BOM、局部行尾及 Windows 权限/附加流；未知写入结果保留恢复材料，不盲目覆盖。
- **Pi 集成**：分支证据重放、主题自适应锚点预览和统一/双栏 diff；CLI 不可用时恢复内置 `edit`。

## 开发验证

CLI：

```bash
cd cli
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Pi 插件：

```bash
cd pi-hledit-diff
npm ci
npm run check
```

构建产物更新、capability 门禁和完整验收流程见 [维护说明](./pi-hledit-diff/MAINTENANCE.md#验证与-binary-更新)。CLI wire 字段与错误语义以 [协议规范](./cli/SPEC.md) 为准。

## 开发仓库与运行目录

本仓库是独立开发工作区。Pi 的实际插件加载目录可以位于其他位置；克隆或更新本仓库不会自动改变 Pi 当前使用的插件目录。

## 上游与致谢

CLI 基于 [`dabito/hledit`](https://github.com/dabito/hledit) 修改并保留 MIT 许可证。本仓库增加了 patched batch 协议、内联新锚点响应、单次批处理重建，以及配套的 Pi 插件。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。
