# pi-hledit-diff

为 Pi 提供 stale-safe 哈希锚点编辑能力的本地扩展。

当前开发与验证基线为 Pi 1.6.1，依赖宿主的动态工具注册、原生读取定义与文件事务队列 API。

## 工具

插件接管日常读取和编辑，注册四个工具：

- `read({path, offset?, limit?})`：保留原生单段读取参数；模型直接读取文本时，同时返回源码、`LN#HASH` 和 `proof_id`，读完即可编辑。默认从第 1 行读取，最多 2,000 行，单页 50 KiB CLI JSON 预算。
- `read_windows({path, windows})`：读取同文件 1–8 段范围，一次快照共用一份 proof；不接受顶层 `offset/limit`。
- `hledit_search_anchors`：按 RE2 正则或字面量搜索，完整返回的匹配/上下文行可直接用于编辑。
- `edit({path, proof_id, changes})`：对一个文件原子提交非冲突修改，返回 diff、新 proof 和可复用的更新锚点。

`read` 保持可嵌套调用，但嵌套读取委托原生实现，不建立编辑证据；其余三个工具使用 `model-only`，确保用于 proof 的内容进入会话。图片、空文件和不支持锚点的内容仍由原生读取处理，不发可编辑 proof、不转换文件编码。旧专用读取和编辑名称只识别历史结果，不注册调用别名；历史会话不改写。

Hash 与 Snow 等其他 read/edit 覆盖后端互斥，必须只启用一套。宿主通过 `--tools read` 或 `--exclude-tools edit` 过滤编辑工具不属于覆盖冲突：读取仍可使用并提供 proof，编辑工具保持不可用。普通 `grep/find/ls/write` 不受影响。

编辑语义：

- 工具统一展开 `~`、`~/` 主目录路径（Windows 同时支持 `~\`），并处理 `@` 前缀、file URL 和 Windows MSYS 盘符路径。每次工具输入只归一化一次；字面 `@target.txt` 使用 `@@target.txt`，file URL 解码后的 Unicode 空白保留。原生读取委托保留原始输入，图片缩放遵守当前 `images.autoResize` 设置（包括嵌套读取）。
- 编辑现有非空文本前，使用 `read`、`read_windows` 或 `hledit_search_anchors` 完整读取会被消费的原始行；不为已读的完整范围再取一次锚点。`write` 只用于新文件、空文件或读取工具报告 source-line truncation 的例外场景。
- 规范锚点是 `LN#[A-Za-z0-9_-]{3}` token。公开 change 只复制范围首尾或 insert 依附行；区间内部 proof 由插件从 evidence 注入。apply 使用严格输入，不剥离带源码后缀的 anchor，也不迁移旧字段或包装形状。
- 公开修改协议由单一有序数组 `changes` 表达，每项统一必填 `action`（`replace`、`insert_before`、`insert_after`）、`anchors` 和 `lines`。单行替换/删除推荐一个 token，也接受相同双端点；两个端点表示替换/删除的首尾闭区间。插入必须只有一个锚点且文本非空。`replace` 使用 `lines: ""` 表示删除，不接受缺省文本。普通 JSON Schema 无需可选字段或 anyOf 对象联合，不要求额外模型/provider 模式；不接受旧 `anchor/end_anchor` 字段。
- 所有项都使用本批编辑前的快照坐标；提交顺序不要求按文件位置排列，回包 delta 按物理位置给出。`replace` 精确替换指定范围或删除；`insert_before` / `insert_after` 依附于锚点行前/后插入，不消费依附行。
- `lines` 接受换行分隔字符串；一个末尾换行仅终止末行，无尾换行也合法；单独一个 `"\n"` 写入一行空行。`replace` 中显式空字符串表示删除目标范围。
- `changes` 数组限 1–200 项、1 MiB replacement UTF-8 bytes 和 20,000 个输出行；单次提交原子 batch，任一项非法、冲突、proof 不完整或 stale 时均不写入。
- change 编号与 `changes` 数组下标（`changes[0]`, `changes[1]` 等）1:1 严格对齐，回包与诊断信息直观清晰。
- proof 归属优先校验：跨文件使用时只报告归属错误，未知或被淘汰的 proof 要求重新获取目标证据，不把旧锚点配上当前 proof 猜测执行。revision 过期返回目标附近的当前快照，完整快照附带可续编的 `proof_id`；审阅后显式提交，插件不会自动重试。
- `insufficient_read_proof` 会在同一 canonical file queue 内自动分页执行定向只读，直到目标缺口完整覆盖或触及恢复预算。结果返回全部 `recoveredReads`、最新 evidence 和一个权威 `proof_id`，但不会自动重放修改；审阅当前源码与端点锚点后再显式重提 apply。
- 定向补读按整批实际缺口规划，共享 1,200 行、4 页、96 KiB 正文预算；预算耗尽后保留已返回页并列出合法的剩余窗口。目标越界、被消费或旧范围不再连续时停止计划，要求重新定位；补读期间 revision 变化则丢弃本次页面并失效旧证据。截断源码不可建立 proof，补读不会自动执行编辑。
- 读取错误给出可操作正文：`pattern` 转发 RE2 编译原文并说明 RE2 不支持 lookahead/lookbehind/backreference（可改用 `literal:true`），`broad_pattern` 指向 `read`。
- `read` 使用可选顶层 `offset/limit`；`read_windows` 每个窗口必须显式提供 `offset/limit`，不混用两种参数形状。`read` 的非锚点范围语义委托原生读取并明确无 proof；窗口和搜索范围按各自 schema 校验。搜索区分全文件匹配数与本页源行数；offset 是返回源行下界，前面的匹配仍可贡献后置上下文。
- 单窗口复用连续读取的分页和 proof 规则。多个窗口由 CLI 单次加载 `Snapshot`，按物理位置合并重叠或相邻窗口，并共享 2,000 行 / 96 KiB JSON 预算。只有所有请求段均完整返回时才登记联合证据；任一段不完整则本次结果仅供预览，不发 proof，应分小批重新读取，包括先前已完成段。
- 超过单页预算的源行会标记 `textTruncated`，不能作为编辑 proof；若后面还有待读行或匹配，结果仍提供 `nextOffset` 和续读提示。
- CLI 在临时文件同步后、原子替换前复检原始字节 revision。`source_changed_before_commit` 是确认零写入；已启动进程的取消、超时、输出超限或异常响应属于 `outcome_unknown`，必须重新读取。
- 改变文件的成功 apply 建立新证据代并返回新 `proof_id`。CLI span 与实际执行文本逐行一致且完整时，仅回显 `changes[i].anchors` JSON 数组（单行一个 token，多行首尾两个 token）和行数，可直接复用输入语法；完整 span 保存在 `details`。返回的端点可直接续编，中间新行按需精确读取。旧 proof/token 对只迁移逐行存续且连续的目标；已消费身份不会因内容恢复而复活，无变化批次不推进证据代。
- 后编辑内部 span 预算为 400 行 / 96 KiB；不满足紧凑条件时，模型正文及对应 evidence 限为实际显示的 80 行 / 16 KiB，并明确标示不完整。非法 delta、产出范围或结构仍属于 `outcome_unknown`，不能退成成功正文。
- 读取、proof 选择、CLI mutation 与 evidence 更新按 canonical real path 使用同一 file mutation queue。同文件状态事务串行，不同文件仍可并行。
- evidence 有界：单文件 10,000 records / 4 MiB 计费额度，session 50,000 records / 16 MiB；历史坐标、proof 与行证据共同计费，最多保留 32 个历史代。优先淘汰历史，其次保留当前发布窗口或恢复目标。整批必需证据无法容纳时终止为 `evidence_capacity_exceeded`，不让补读循环；拆分写入必须接受失去整批原子性的代价。重放使用记录的发布顺序，而不是 Pi 并行结果的请求顺序。
- 仅接受有效 UTF-8 且不含 NUL 的文本；revision 基于原始字节。非空结果保留既有 BOM，拒绝会把首字符 U+FEFF 重新解释为 BOM 的修改。孤立 CR 作为正文保留；空末行必要地补行尾，其余按局部规则保留行尾与末尾换行状态。
- Windows 写入保留目标 DACL、继承状态和 NTFS 附加流；Owner 和 primary group 不保证保持原值。替换中途失败时先以不覆盖方式移回原文件，成功即为零写入失败；无法移回时返回 `outcome_unknown` 并保留、报告恢复文件，须先检查文件状态；已成功写入但恢复副本清理失败则返回成功及含路径的 warning。

CLI 3.x capability 健康且不存在 read/edit 覆盖冲突时，插件在 `session_start` 注册工具，激活状态由宿主管理。启动时 CLI 不可用则不接管；接管后故障必须拒绝编辑，不回退到无 proof 写入。`/hledit-status` 可重新检查并启用宿主允许的锚点工具，不突破工具过滤。`session_start` 与 `session_tree` 重建当前分支 evidence。压缩摘要按实际结果记录文件操作：无变化或补读不算修改，拒写不污染修改列表，同时保留既有真实修改记录。

## 独立 TUI 渲染

插件自行渲染锚点读取和编辑结果，不依赖其他显示扩展；原生图片及只读回退沿用宿主渲染：

- `read` / `read_windows` 的 TUI 标题统一为 `read`，折叠仅显示单行摘要；`hledit_search_anchors` 折叠保留最多 12 个源码屏幕行的预览，溢出时提示展开。展开后显示本次返回页面的源码、`LN#HASH` gutter 与语法高亮；展示裁剪不影响模型正文或 proof。
- 读取摘要显示实际范围和总行数，单窗口显示 EOF 或下一 offset，多窗口显示请求窗口数。搜索全文件匹配数保存在 `details.read.totalMatches`。
- 文件修改始终使用单栏差异预览，多项修改在标题中分别显示范围；每行使用 `+/- 行号 │ 代码`，窄屏自动隐藏行号，长行按字素硬折行并保留空白，续行不重复行号。
- 新增／删除行从当前主题派生淡绿／淡红底色，同一操作中配对行的变化片段加深，保留语法高亮；上下文使用当前主题的工具背景。摘要显示 `↳ diff`、增删计数、变更块数和红绿增删比例色条；空间不足时优先保留计数和局部预览状态。
- 变更块沿用结构化预览的文件位置顺序，同一连续变更段先显示删除行、再显示新增行；行内强调只配对同一操作的连续片段，不跨操作同文匹配。缺少操作关联的旧预览保留原始顺序，不猜测配对。
- 差异预览折叠态最多显示 24 个屏幕行，并优先露出增删内容；展开态保留 2,000 个屏幕行的展示上限。实际隐藏内容时显示提示，不影响模型正文或编辑证据。
- `details.changePreview` 是提交绑定的结构化局部 diff；上限为 2,000 行 / 256 KiB UTF-8，超长单行保留首尾并标记截断。截断统计使用 CLI 验证的 `linesAdded` / `linesDeleted`，不把局部 hunk 数冒充完整统计。
- 单窗口／搜索、多窗口、差异预览和 expanded 更新锚点分别消费 `details.read`、`details.windowsRead`、`details.changePreview`、`details.updatedAnchorSpans`；展示与证据恢复共用结构化结果。
- 组件缓存同宽布局与语法高亮，并从当前 Pi theme 派生颜色。
- 只读错误显示“读取失败”；编辑错误区分待复核（未写入）、未写入、未执行与结果未知。I/O 和补读失败优先展示具体原因；冲突诊断指出双方操作编号。展开后按终端宽度换行，完整显示恢复路径和操作指令。

## CLI 要求

插件固定调用自身目录下的 Windows x64 binary：

```text
bin/hledit.exe
```

兼容响应必须包含 3.x 版本及全部正 capability，并且不得包含 `contentReplaceOnce`：

完整字段见 [CLI capability 规范](../cli/SPEC.md#2-capabilities)；门禁与失败处理见 [维护说明](./MAINTENANCE.md#cli-capability-门禁)。

成功 JSON 读取包含合法 `revision`、`totalLines`、锚点行和截断状态。内部 batch 携带 `{revision, anchors}` proof；CLI 重新验证逐行覆盖、锚点和当前原始字节 revision。成功 batch 包含新 `revision`、`updatedAnchorSpans`、`editDeltas`、`linesAdded` 与 `linesDeleted`，插件逐项核对请求区间、产出 span 和统计；不兼容成功响应按结果未知处理。batch wire v3 中 `replace` 省略或传空 `lines` 即为删除。

## 开发

```bash
npm ci
npm run check
```

`npm run check` 包含类型检查与全部测试，已覆盖 `test:bundled` 的 CLI、hash、激活和工具结果契约用例。`npm run test:bundled` 可单独验证当前 bundled binary；CI 必须在覆盖 tracked binary 前执行它。

## 更新 bundled CLI

在仓库根目录执行：

```bash
cd pi-hledit-diff
npm run test:bundled
cd ../cli
cargo test --locked
pwsh -NoProfile -File build-bundle.ps1
pwsh -NoProfile -File build-bundle.ps1 -VerifyOnly
cd ../pi-hledit-diff
npm run check
```

Rust 版本固定在 `cli/rust-toolchain.toml`，依赖固定在 `cli/Cargo.lock`。构建脚本生成静态 CRT 的 Windows x64 CLI、依赖许可及 `hledit.build.json`；`-VerifyOnly` 核对源码指纹、binary SHA-256 和许可摘要。该检查用于检测过期或错配制品，不证明跨机器逐字节可复现，也不是真实性签名。CI 分别验证 tracked 与源码重建产物的同一插件协议。

修改 TypeScript 源码后，需要在 Pi 中执行 `/reload` 或开启新会话。仅替换 `bin/hledit.exe` 时，后续工具调用会直接使用新 binary。

## 安装说明

本目录是开发源码。正式部署到 Pi 扩展目录时只同步运行时白名单：`index.ts`、`src/`、`bin/` 和 `package.json`；不得携带 `test/`、`node_modules/`、开发文档、锁文件或 `tsconfig.json`。运行时依赖由 Pi 宿主提供，部署目录不执行 `npm install`。同步后执行 `/reload` 或开启新会话。

详细协议和维护约束参见 [`MAINTENANCE.md`](./MAINTENANCE.md)。
