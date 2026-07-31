# Snapline CLI

Snapline 是面向编程代理集成的严格 snapshot-bound 文本读取与提交后端。它在一个原始字节版本上提供行坐标，要求修改携带完整源行 proof，并把同一批 grouped changes 原子提交。

CLI 是 [`pi-snapline`](../pi-snapline/) 使用的后端。它不创建磁盘 snapshot、不维护缓存数据库、不做模糊匹配，也不为旧锚点协议提供兼容别名。

## 环境要求

- 从源码构建需要 Go 1.21 或更高版本。
- 操作系统必须受原子替换实现支持。
- 目标必须是已存在的常规 UTF-8 文件；CLI 不创建缺失文件。

Pi 随附的 Windows x64 binary 位于 `../pi-snapline/bin/snapline.exe`。

## 构建与验证

```bash
go build -o snapline .
./snapline --version
go test ./...
go vet ./...
```

POSIX 系统也可使用 `make build`、`make check` 和 `make install`。Go module 路径为 `github.com/Qihuanxishini/snapline/cli`，构建产物和公开命令均名为 `snapline`。

## 命令

```text
snapline --version
snapline capabilities
snapline read     # stdin 接收一个严格 JSON 请求
snapline apply    # stdin 接收一个严格 JSON 请求
```

`snapline --version` 精确输出：

```text
Snapline 1.0.0
```

`capabilities` 输出一个 JSON 对象。集成方必须要求 product `snapline`、经过审阅的 1.x 版本、wire protocol 1，以及全部安全 capability：

```json
{"ok":true,"product":"snapline","version":"1.0.0","wireProtocol":1,"rawRevision":"sha256","multiWindowRead":true,"boundedBinaryPreflight":true,"groupedAtomicApply":true,"completeReadProof":true,"preCommitRevisionCheck":true,"structuredEditEffects":true,"structuredRecoveryContexts":true}
```

## 读取

请求：

```json
{
  "protocolVersion": 1,
  "path": "C:/work/file.txt",
  "windows": [
    {"offset": 1, "limit": 80},
    {"offset": 500, "limit": 20}
  ]
}
```

成功响应包含 canonical 目标路径、精确原始字节 SHA-256 revision、逻辑行数、BOM 状态、合并后的 contexts 和明确 omissions：

```json
{
  "ok": true,
  "protocolVersion": 1,
  "path": "C:/work/file.txt",
  "revision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "totalLines": 3,
  "bom": false,
  "contexts": [{
    "offset": 1,
    "limit": 3,
    "start": 1,
    "end": 3,
    "complete": true,
    "nextOffset": 4,
    "lines": ["one", "two", "three"]
  }],
  "omittedRanges": []
}
```

读取规则：

- 请求包含 1 至 64 个正整数窗口；重叠或相邻窗口会归一化并合并。
- 一个响应最多收集 2,000 个完整行，以及 50 KiB 未转义 UTF-8 行内容。
- 放不下的行只返回最多 4,096 字节的 UTF-8 安全前缀，并标记 `line_too_long` 或 `byte_budget`；该前缀不构成 proof。
- `complete` 表示归一化窗口末尾之前的请求行全部完整返回；为 false 时，`nextOffset` 指向第一个不完整行。
- 空文件和仅 BOM 文件具有零个逻辑行，返回 `start:1,end:0` 的虚拟范围。
- 至多 8 KiB 的签名预检会把受支持图片报告为 `image_candidate`；文本候选仍会完整扫描 NUL、UTF-8 合法性和 raw revision。
- read stdin 上限为 1 MiB。

## 提交修改

请求：

```json
{
  "protocolVersion": 1,
  "path": "C:/work/file.txt",
  "expectedRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "proof": [{"start": 2, "lines": ["two"]}],
  "replacements": [{"start": 2, "end": 2, "text": "TWO"}],
  "deletions": [],
  "insertionsBefore": [],
  "insertionsAfter": []
}
```

四个 group 都是必需数组。坐标均为 1-based source-snapshot 坐标，replacement/deletion 的 `end` 包含在范围内。所有被消费行和 insertion 依附行都必须精确出现在 `proof` 中。

成功响应按 replacement、deletion、insertion-before、insertion-after 和各自输入顺序，为每个请求项返回一个确定性 effect：

```json
{
  "ok": true,
  "protocolVersion": 1,
  "path": "C:/work/file.txt",
  "outcome": "applied",
  "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "newRevision": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "contentChanged": true,
  "stats": {
    "requestedChanges": 1,
    "effectiveChanges": 1,
    "oldLineCount": 3,
    "newLineCount": 3,
    "insertedLines": 1,
    "deletedLines": 1
  },
  "effects": [{
    "group": "replacement",
    "groupIndex": 0,
    "changed": true,
    "oldStart": 2,
    "oldEnd": 2,
    "newLineCount": 1,
    "lineDelta": 0,
    "newStart": 2,
    "newEnd": 2
  }],
  "warnings": []
}
```

提交规则：

- 所有 group 都相对于同一提交 revision 同时解释。消费范围不得重叠；两个 insertion 不得共享同一物理 boundary；insertion 不得落入消费范围内部。
- 每组最多 100 项；单个请求最多 200 个 change、1 MiB replacement text 和 20,000 个产出逻辑行。
- Proof 最多 10,000 行和 4 MiB 行文本；apply stdin 上限为 32 MiB。
- 文本以 LF 分隔，禁止 CR 和 NUL。末尾一个 LF 只移除末尾 split segment，不额外产生空逻辑行。
- 空 replacement text 表示一个空逻辑行；删除范围必须使用 `deletions`。
- 零行目标只接受一个 line 1 的 `insertionsBefore`，且 proof 必须为空。仅此场景由 text 的末尾 LF 决定新文件 trailing newline。
- 单行 replacement 若首行重复源行并继续追加多行，且没有明确相邻 insertion，会按可疑范围扩展拒绝。
- 未变化 replacement 返回 `outcome:"no_op"`、相同 revision、`contentChanged:false`，且不触碰文件系统。

## 失败与退出契约

可信的逻辑拒绝使用退出码 0，并返回：

```json
{
  "ok": false,
  "protocolVersion": 1,
  "code": "snapshot_stale",
  "message": "expectedRevision does not match the current target",
  "targetCommitted": false,
  "currentRevision": "sha256:...",
  "requiredRanges": [{"start": 2, "end": 2}],
  "contexts": [],
  "omittedRanges": []
}
```

响应可附带 `group`、`groupIndex` 和 `conflictsWith`。恢复 context 可能受限或缺失；stale 坐标是 approximate，绝不能触发自动重放。

| 退出码 | 含义 |
| --- | --- |
| 0 | 有效 wire outcome；继续检查 `ok` 和 `outcome`/`code`。 |
| 1 | 基础设施失败或替换完成状态不确定；调用方必须把已启动 apply 视为 outcome unknown。 |
| 2 | 命令行使用错误；usage 写入 stderr。 |

输入对象拒绝 unknown、duplicate、missing、null 和 trailing fields。消息按 UTF-8 限制为 4,096 字节。

## 文件系统与字节保真

- Revision 哈希覆盖精确源字节，包括 UTF-8 BOM、混合 CRLF/LF terminator、作为文本的孤立 CR 和 trailing-newline 状态。
- 未修改源行保留自己的 terminator；生成行继承局部 terminator 策略；BOM 与 trailing-newline 状态保持稳定。
- 目标必须是单链接常规文件。symlink 会解析到真实目标并保留链接入口；hardlink 目标被拒绝。
- Changed apply 创建唯一 `.snapline-*` 同目录临时文件，保留权限、写入并同步，再复核目标/父目录身份及 raw revision，最后原子替换。
- 替换前检测到的竞态是确认零写入；无法确认替换结果时退出 1；提交后目录 durability 失败仍是 changed success，并带 `post_commit_durability` warning。
- Read、no-op 和 rejected apply 不创建临时文件；未知旧 `.snapline-*` 文件不会按前缀或时间被删除。

## 集成与迁移

受支持的 Pi 集成是 [`pi-snapline`](../pi-snapline/)。Snapline 1.0 有意移除了旧 anchor commands、旧 binary alias、内容匹配编辑以及旧 standalone/MCP wire contract。现有集成必须迁移到 wire protocol 1，或固定在旧版本。

规范见 [`SPEC.md`](./SPEC.md)，版本历史见 [`CHANGELOG.md`](./CHANGELOG.md)。
