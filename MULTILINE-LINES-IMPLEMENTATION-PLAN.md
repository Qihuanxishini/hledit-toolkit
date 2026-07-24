# 多行 `lines` 输入优化实施计划

## 状态

- 状态：已完成；审计、实现、自动验证、运行时同步与真实 Pi 窗口测试均于 2026-07-24 通过。
- 范围：仅 `pi-hledit-diff/` 的公开工具输入、参数规范化、测试与文档。
- 非范围：CLI、锚点协议、read proof、revision、batch wire、多文件事务与自动 stale 重试；后续 `replace-once` 的 CLI/bundled binary 工作属于独立版本更新。

## 背景

插件的 `prepare-arguments.ts` 已能将字符串形式的 `lines` 按换行规范化为 `string[]`，但 `schema.ts` 只公开 `string[]`。模型在工具 schema 中看不到多行字符串这一合法且更适合大块编辑的表达，因此容易把数组构造成本误认为应通过脚本绕过。

本计划将多行字符串提升为正式公开输入，同时保持执行层只接收规范化后的 `string[]`。这只降低 payload 表达成本，不降低锚点、read proof、revision、stale 检测、原子 batch 或风险护栏。

## 目标

公开工具中的 replacement/insert `lines` 接受两种等价形式：

```ts
lines: "first line\nsecond line"
lines: ["first line", "second line"]
```

字符串形式是多行编辑的推荐写法；数组保留给小范围编辑和向后兼容。执行层、CLI batch request、diff、proof 与风险护栏只处理 `string[]`。

## 输入语义

| 输入 | 规范化结果 |
| --- | --- |
| `"a"` | `["a"]` |
| `"a\nb"` | `["a", "b"]` |
| `"a\nb\n"` | `["a", "b"]` |
| `""` | `[""]` |
| `"a\n\n"` | `["a", ""]` |
| `["a", "b"]` | 保持不变 |

- 字符串按 CRLF、CR 或 LF 分隔为原始文件行。
- 字符串末尾的一个换行只表示文本结束，不隐式生成空行。
- 数组中的每一项必须是一行，仍严格拒绝 CR/LF。
- 删除必须使用 `delete_range`，不通过空文本表达删除。
- 目标文件原有 BOM、CRLF/LF 与末尾换行语义继续由 CLI 保持。

## 实施阶段

### Phase 0：审计与基线

1. 记录工作区已有改动，不覆盖用户文件。
2. 核对 schema、参数规范化、工具注册、现有测试和维护文档。
3. 运行 `npm run check`，建立变更前基线。

### Phase 1：公开输入契约

1. 在 `src/schema.ts` 中使 `lines` 正式接受字符串或字符串数组，并说明推荐用法与换行语义。
2. 将公开输入类型与规范化后的内部执行类型分开，避免 `string | string[]` 扩散到 CLI request、diff、proof 和风险护栏。
3. 继续在 `prepare-arguments.ts` 将字符串转换为 canonical `string[]`。
4. 不新增 operation、工具、capability、feature flag 或兼容写路径。

### Phase 2：测试与文档

1. 覆盖多行、末尾换行、空行、CRLF、特殊字符和数组兼容性。
2. 验证字符串在规范化后能通过严格参数 schema，并由 request builder 输出 `string[]`。
3. 保留数组元素嵌入换行的拒绝测试。
4. 更新工具 schema 描述、`index.ts` prompt guideline、README 和维护文档。

### Phase 3：验证与人工验收

1. 运行 `npm run check` 与 `git diff --check`。
2. 在开发环境执行实际 Pi 工具 smoke test：局部替换、大块替换、特殊字符、同文件多片段、stale 恢复与单行范围扩展护栏。
3. 确认大块既有文件编辑不需要 shell、Python、PowerShell、临时脚本或 `write`。

## 验收条件

- 公开 schema 与工具提示都清楚表达多行字符串 `lines` 是推荐写法。
- `replace_range`、`insert_before`、`insert_after` 都接受两种形式；`delete_range` 不接受 `lines`。
- 执行层只接收规范化的 `string[]`。
- anchor、revision、proof、stale、原子 batch、updated anchors、diff 与范围风险护栏无回归。
- `npm run check` 和 `git diff --check` 通过。
- 本轮不改 `cli/`，不重建 bundled CLI。

## 部署与回滚门禁

开发工作区不等于 Pi 实际加载目录。本计划不包含自动部署。

仅在另行获得明确确认后，才可按 `pi-hledit-diff/MAINTENANCE.md` 的运行时白名单同步 `index.ts`、`src/`、`bin/` 与 `package.json`，随后 `/reload` 或新开会话并完成 smoke test。

部署前保留上一版运行时文件副本。若发现工具参数准备顺序、schema 解析或运行时兼容问题，恢复上一版运行时源码后 `/reload`；不删除用户文件，不自动重试或修复任何编辑结果。

实施记录：本计划自身未自动部署。后续获得主人明确授权后，运行时目录仅同步了白名单文件；用于首次同步的备份已按主人要求删除。当前回滚仍须先取得明确授权，并按维护文档验证 capability 与真实窗口行为。

## 观察期

部署后建议观察至少 10 次真实编辑任务，其中至少 5 次是 20 行以上替换。重点记录：

- 大块编辑是否使用 `hledit_apply_file_changes`；
- 是否仍出现 `lines[]` 构造类错误；
- 首次 apply 成功率；
- stale 是否都先重新读取；
- 是否存在安全机制回归。
