# Snapline CLI — Wire Protocol 1 规范

本文是 Snapline 1.x 的规范性契约。JSON 属性名和枚举值区分大小写。除非另有说明，行坐标从 1 开始，范围末端包含在范围内。

## 1. 进程接口

```text
snapline --version
snapline capabilities
snapline read
snapline apply
```

- `snapline --version` 输出 `Snapline 1.0.0\n`。
- `capabilities`、`read` 和 `apply` 向 stdout 输出一个 JSON 对象及末尾换行。
- `read` 与 `apply` 从 stdin 接收且只接收一个 UTF-8 JSON 对象。
- 逻辑成功和可确认零提交的拒绝退出 0。
- 基础设施失败或提交状态不确定退出 1。
- 命令行形状错误退出 2，并向 stderr 输出 usage。

不存在命令别名、anchor command、内容匹配操作、check mode 或兼容 wire。

## 2. Capability 门禁

兼容的 1.0.0 实现精确报告：

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

集成方必须拒绝未审阅的 major version、缺失或为 false 的 capability、未知字段以及 malformed output。

## 3. 严格 JSON 规则

每个请求对象及嵌套对象：

- 必须包含其 shape 定义的全部字段；
- 拒绝 unknown、duplicate、missing 和 null fields；
- 拒绝第二个或 trailing JSON value；
- integer field 必须能解码为平台 `int`；
- path 必须非空且不含 NUL；
- 必须使用 `protocolVersion:1`。

Read stdin 上限为 1 MiB，apply stdin 上限为 32 MiB。无效 UTF-8 以逻辑 `invalid_request` 或 `size_limit` 拒绝。

## 4. 原始文本模型

目标被解析为：

- 可选 UTF-8 BOM；
- 零个或多个 UTF-8 逻辑行；
- 每行一个 terminator：LF、CRLF，或末尾未终止行的 none。

未跟随 LF 的孤立 CR 属于行文本。Revision 为 `sha256:` 加 64 个小写十六进制字符，哈希对象是 BOM 或换行解析前的精确原始字节。

零字节或仅 BOM 文件包含零个逻辑行。完整目标任意位置出现 NUL 都拒绝文本处理；无效 UTF-8 同样拒绝。

## 5. Read 请求

```ts
{
  protocolVersion: 1,
  path: string,
  windows: Array<{ offset: integer >= 1, limit: integer >= 1 }>
}
```

`windows` 包含 1 至 64 项。窗口会被截到当前文件范围，随后排序，并在重叠或相邻时合并。EOF 之后的请求定位到当前最后一行；零行目标定位到虚拟区间 `start:1,end:0`。

### 5.1 Read 成功结果

```ts
{
  ok: true,
  protocolVersion: 1,
  path: string,                  // canonical target path
  revision: "sha256:<64 hex>",
  totalLines: integer >= 0,
  bom: boolean,
  contexts: Array<{
    offset: integer,
    limit: integer,
    start: integer,
    end: integer,
    complete: boolean,
    nextOffset: integer,
    lines: string[],
    truncatedLine?: {
      line: integer,
      prefix: string,
      originalUtf8Bytes: integer
    }
  }>,
  omittedRanges: Array<{
    start: integer,
    end: integer,
    reason: "line_limit" | "byte_budget" | "line_too_long"
  }>
}
```

对完整行，`end = start + lines.length - 1`，`nextOffset = end + 1`。`complete:true` 表示归一化窗口末端之前的每个请求行均完整返回；否则 `nextOffset` 标识第一个不完整行。

所有窗口共享以下收集上限：

- 2,000 个完整行；
- 50 KiB 未转义 UTF-8 行内容；
- 每个 context 最多一个 UTF-8 安全截断前缀，且不超过 4,096 字节。

截断前缀绝不构成 source proof。省略后缀必须显式报告，不得静默丢弃。

### 5.2 文件分类

完整文本解析前，Snapline 只读取足以识别 Pi 支持图片家族的前缀：排除 JPEG-LS 的 JPEG、非动画 PNG、GIF、WebP 和经验证的 BMP。候选图片返回逻辑 code `image_candidate`；Pi 插件负责原生 MIME 确认与图片处理。

非图片目标会完整扫描。NUL 返回 `unsupported_file`，无效 UTF-8 返回 `invalid_utf8`。Apply 把图片候选映射为 `unsupported_file`，因为图片不能作为文本修改。

## 6. Apply 请求

```ts
{
  protocolVersion: 1,
  path: string,
  expectedRevision: "sha256:<64 lowercase hex>",
  proof: Array<{ start: integer >= 1, lines: string[] }>,
  replacements: Array<{ start: integer >= 1, end: integer >= 1, text: string }>,
  deletions: Array<{ start: integer >= 1, end: integer >= 1 }>,
  insertionsBefore: Array<{ line: integer >= 1, text: string }>,
  insertionsAfter: Array<{ line: integer >= 1, text: string }>
}
```

所有 group array 都是必需字段，且至少包含一个 change。

限制：

- 每组最多 100 项，总计最多 200 项；
- UTF-8 change text 合计最多 1 MiB；
- 最多产出 20,000 个逻辑行；
- proof 最多 10,000 行和 4 MiB 文本。

与目标内容无关的 shape 和 payload 限制必须在目标 I/O 前完成验证。

### 6.1 Replacement text

Text 用 LF 分隔逻辑行，并拒绝 CR 与 NUL。若 text 以 LF 结尾，split 后精确移除一个末尾 segment：

| Text | 逻辑行 |
| --- | --- |
| `""` | 一个空行 |
| `"a"` | `a` |
| `"a\n"` | `a` |
| `"a\n\n"` | `a`、一个空行 |

删除只能由 `deletions` 表达；空 replacement text 不是删除。源文件非空时，text 的末尾 LF 不单独控制目标 trailing-newline 状态。

零行目标只接受 line 1 的一个 insertion-before，不接受其他 change，且 proof 为空。其原始 insertion text 不得为空；只有此场景由末尾 LF 决定新文件 trailing newline。

### 6.2 Source-snapshot 同时语义

所有 change 都引用同一 source snapshot：

- replacement/deletion 必须满足 `start <= end <= oldLineCount`；
- 消费范围不得重叠；
- insertion 必须依附现有源行；
- 两个 insertion 不得映射到同一物理 boundary；
- insertion boundary 严格落入消费范围内部时冲突；
- 消费范围首尾 boundary 上的 insertion 位置确定，可以接受。

如果单行 replacement 把原行重复为多行输出的首行，则按 `suspicious_range_expansion` 拒绝；只有显式相邻 insertion 能消除该意图歧义。

### 6.3 完整 proof

Proof range 必须非空、位于文件内且互不重叠；proof text 必须与当前逻辑源文本完全相同。

- Replacement/deletion 消费的每一行都需要 proof。
- Insertion-before 需要依附行 proof。
- Insertion-after 需要依附行 proof。
- 零行 insertion 要求空 proof。

缺少覆盖返回 `insufficient_read_proof`，文本不同返回 `proof_mismatch`；两者均不写目标。

## 7. Apply effects 与统计

每个请求项返回一个 effect，顺序固定为 `replacement`、`deletion`、`insertion_before`、`insertion_after`，同组内按 input index：

```ts
{
  group: string,
  groupIndex: integer,
  changed: boolean,
  oldStart: integer,
  oldEnd: integer,
  newLineCount: integer,
  lineDelta: integer,
  newStart: integer,
  newEnd: integer
}
```

Insertion 使用 `oldEnd = oldStart - 1` 的空源区间。`changed:false` 的 `lineDelta` 为零。对 changed effect：

```text
consumed       = max(0, oldEnd - oldStart + 1)
lineDelta      = newLineCount - consumed
newEnd         = newStart + newLineCount - 1
newLineCount'  = oldLineCount + insertedLines - deletedLines
```

`newStart` 只累计 source-simultaneous 输出中物理位于该 effect 之前的 changed effect delta。消费 effect 计入满足 `oldEnd < oldStart` 的先前消费区间及 boundary `< oldStart` 的 insertion；boundary 为 `b` 的 insertion 计入满足 `oldEnd <= b` 的消费区间及 boundary `< b` 的 insertion。

除 `requestedChanges` 外，统计只计算 changed effects：

```ts
{
  requestedChanges: integer,
  effectiveChanges: integer,
  oldLineCount: integer,
  newLineCount: integer,
  insertedLines: integer,
  deletedLines: integer
}
```

## 8. Apply 成功结果

```ts
{
  ok: true,
  protocolVersion: 1,
  path: string,
  outcome: "applied" | "no_op",
  sourceRevision: string,
  newRevision: string,
  contentChanged: boolean,
  stats: ApplyStats,
  effects: EditEffect[],
  warnings: Array<{ code: string, message: string }>
}
```

`applied` 要求至少一个 changed effect、不同且合法的两个 revision，以及 `contentChanged:true`。`no_op` 要求所有 effect 均 unchanged、revision 相同、`contentChanged:false`、无 warning，并且没有临时写入。

原子替换已提交后若父目录 durability 同步失败，结果仍为 `applied`，并携带 warning code `post_commit_durability`。

## 9. 逻辑失败结果

可信的非提交 outcome 使用：

```ts
{
  ok: false,
  protocolVersion: 1,
  path?: string,
  code: string,
  message: string,
  targetCommitted: false,
  currentRevision?: string,
  requiredRanges?: Array<{ start: integer, end: integer }>,
  contexts?: ReadContext[],
  omittedRanges?: OmittedRange[],
  group?: string,
  groupIndex?: integer,
  conflictsWith?: { group: string, groupIndex: integer }
}
```

Message 按 UTF-8 限制为 4,096 字节。常见 code 包括 `invalid_request`、`size_limit`、`target_not_regular`、`unsupported_file`、`invalid_utf8`、`snapshot_stale`、`range_out_of_bounds`、`overlapping_changes`、`duplicate_insertion_boundary`、`suspicious_range_expansion`、`insufficient_read_proof`、`proof_mismatch`、`hardlink_target`、`source_changed_before_commit` 和 `write_failed_before_replace`。

目标被删除、不可读、属于 binary，或 context 无法安全放入预算时，恢复 context 可以缺失。Stale 请求的 context 是 approximate，绝不能授权自动重放。

如果已经调用 replacement 却无法证明 commit 状态，Snapline 不会伪造 `targetCommitted:false` envelope，而是退出 1，让调用方按 outcome unknown 处理。

## 10. 原子提交与身份

Changed apply 依次执行：

1. 解析现有目标和 canonical parent，拒绝非常规文件与 hardlink。
2. 读取时捕获目标身份、父目录身份和 raw revision。
3. 在保留 BOM 与逐行 terminator 的前提下构建输出。
4. 创建唯一 `.snapline-*` 同目录文件，保留权限，写入、sync 并关闭。
5. 再次验证 canonical target、目标身份、父目录身份和 raw revision。
6. 原子替换真实目标。Windows 使用 replace-existing/write-through；受支持的 POSIX 系统执行 rename 后 sync 父目录。
7. 所有确认的提交前失败都删除本次调用拥有的临时文件。

因此，即使内容相同的 inode swap 或父目录替换也会 fail closed。未知的前缀匹配临时文件绝不会被扫描删除。

未触碰源行与 unchanged replacement effect 不参与重建，避免 mixed-EOL 被归一化。新行继承局部 terminator；BOM 与 trailing-newline 状态保持。删除所有逻辑行会产生零行文件，同时保留原有 BOM。

## 11. 源码布局

| 文件 | 职责 |
| --- | --- |
| `main.go` | 版本、capability、命令路由与退出码。 |
| `snapline_wire.go` | 严格 protocol-1 请求/结果类型与 JSON 解码。 |
| `snapline_file.go` | Canonical 目标读取、身份复核和图片/文本分类。 |
| `snapline_read.go` | 窗口归一化、收集预算、omission 与恢复 context。 |
| `snapline_apply.go` | Payload、proof、冲突规划、effects 与重建。 |
| `textfile.go` | BOM、逻辑行、逐行行尾、精确编码与 revision。 |
| `write.go` / `write_platform_*.go` | Revision-bound 原子替换。 |
| `*_test.go` | 单元、集成、property、fuzz、mixed-EOL、竞态边界与 benchmark 覆盖。 |
