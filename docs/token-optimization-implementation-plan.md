# 工具形式 Token 优化实施基线

> 状态：四项方案已在开发仓库实现，本文件继续作为后续修改与验收的约束。  
> 范围：`cli/` 与 `pi-hledit-diff/` 的锚点读取、成功编辑回包、工具定义及提示词。  
> 非目标：降低 proof/revision/原子写入/冲突检测的安全保证；为了罕见但无实际证据的第三方参数改写场景增加专门链路。

## 1. 目标与决策原则

本轮优化的目标是降低一次完整编辑任务进入模型上下文的总 token 消耗，而不是孤立压缩任意一个工具结果。优先消除已经被模型提交过、又在成功结果中重复出现的正文，并避免把多个远距离目标退化为整段源码读取。

以下是不可降低的正确性不变量：

1. `proof_id` 只代表已完整展示，或与实际提交文本逐行核对一致，且可保留的源行证据；截断源行绝不建立编辑 proof。
2. revision、每行锚点、批量冲突检测和原子写入保持现有契约；工具不得自动缩窄、拆分、改写或重新排序调用方表达的编辑语义。
3. 多窗口读取的所有可用窗口必须来自同一个 CLI `Snapshot` / raw-byte revision；不完整窗口不得被登记为 proof。
4. 成功编辑的紧凑回包只有在 CLI 实际返回的新行与插件实际执行的 `changes` 逐行一致、且无截断时才可用；否则必须回退到包含正文的现有回包。
5. `outcome_unknown`、写入被拒绝、证据不足、源行截断等状态仍须给模型明确、可操作的下一步。

当前 50 KiB 读取预算、80 行 / 16 KiB 后编辑回包预算属于资源预算，不是上述不变量。只要仍有明确的共享上限、截断状态和恢复路径，预算可为实现正确功能而上调。

本轮不追溯 Pi 会话中的模型原始 tool call，也不为其他扩展可能修改参数建立输入副本比对；本扩展以实际收到、规范化并交给 bundled CLI 的参数和 CLI 回执为准。

## 2. 方案一：成功编辑回包紧凑化

### 2.1 当前重复

`hledit_apply_file_changes` 成功后返回 `proof_id` 和 `Updated anchors` 正文。对于新增或替换的行，正文刚刚已经作为 `changes[].lines` 发出，再完整回灌通常没有新增信息；后续编辑真正需要的是新的 proof 和每项变更产出的锚点范围。

### 2.2 紧凑化前提

插件从批量结果读取 `updatedAnchorSpans` 与 `editDeltas` 后，必须先建立每项 producing change 的对应关系，并逐项验证：

- span 与 producing change 一一对应，且物理顺序和 `editDeltas` 一致；
- span 的行号范围与 delta 映射出的新坐标一致；
- span 行数与该 change 实际提交的输出行数一致；
- 每行 `text` 与实际传给 CLI 的输出文本完全一致；
- 所有相关 span 均未截断，且没有 `textTruncated`；
- CLI 回执的范围、数量和结构均可完整解析。

仅当全部条件成立时，模型可见正文改为：

```text
Applied N changes (+A -D lines).
proof_id: p_...
New output anchors (submitted text verified):
- change 1: 42#abc–45#jkl (4 lines)
- change 3: 71#mno (1 line)
```

纯删除没有新输出锚点，仍保留成功摘要和新 `proof_id`。后续若需引用或编辑未展示的中间新行，调用方必须使用 `hledit_read_anchors` 精确读取；不能凭紧凑摘要猜测正文。

仅紧凑化条件失败（正文不符、回执截断或无执行文本）时，使用有界 `Updated anchors` 正文和必要的“不完整，需重读”提示。原有成功协议校验失败（非法 delta、产出区间或结构）仍返回 `outcome_unknown`，不得降级成成功；绝不把无法验证的回执压缩成仅锚点。

### 2.3 证据与预算

完整、经验证的 `updatedAnchorSpans` 继续保存在工具 `details` / proof state 中，用于 branch replay、后续 anchor 迁移和渲染；紧凑化只改变模型可见 `content`，不丢失结构化证据。

CLI 对 `updatedAnchorSpans` 的共享预算需要从现有 80 行 / 16 KiB 上调为足以验证合理批量编辑的内部预算。初始目标为 **400 行 / 96 KiB**，同时保持 wrapper 的 1 MiB stdout 总上限。若最终 wire 序列化测得该值无法在既有总上限内安全容纳，则以不超过总上限的保守值实现，并在本文件记录调整原因。

回退路径的模型正文仍限制为 80 行 / 16 KiB，并明确标示不完整。回退时 `details.updatedAnchorSpans` 只保留实际显示的行及剩余范围元数据，未显示且未经逐行一致性验证的正文不得进入 proof。紧凑成功则保留全部已验证 span。

## 3. 方案二：减少重复读取与过大替换

这项只优化模型面对的工作流提示，不改变任何 edit 的业务语义：

1. 尚在浏览、尚未确定目标时可使用普通 `read`；目标已明确且计划编辑时，直接使用 `hledit_read_anchors` 获取完整 proof。
2. `replace_range` 必须消费真实需要替换、保留或删除的完整源范围；不因“少 token”自动缩小范围，也不把 replace 改写成 insert。
3. 同一文件中互不冲突的多项变更优先由调用方放入一个 atomic batch；插件不自动合并、拆分或重排操作。
4. 紧凑回包后若要继续操作新产出文本，按实际需要读取最小完整窗口；不预先重复回灌所有正文。

## 4. 方案三：Schema 与提示词职责去重

静态工具描述的收益低于消除源码正文重复，但可在不损失行为语义的前提下收敛。

| 位置 | 保留职责 |
| --- | --- |
| `src/schema.ts` | 字段类型、范围、必填性和本地格式 |
| `index.ts` 的 description | 工具用途及适用时机 |
| `promptGuidelines` | proof/revision 工作流、跨工具约束和关键失败语义 |
| 运行时错误结果 | 当前失败原因及下一步 |

可合并等价的路径、锚点、连续读取等描述；不可删除以下规则：完整 proof、截断源行不可用、`replace_range` 消费范围、`outcome_unknown` 不得盲目重放、拒绝与已写入的区别，以及原子批量冲突语义。

三个工具仍保持独立，不合并为带 `action` 的大工具，以免增加参数分支和误用概率。

## 5. 方案四：同文件多窗口锚点读取

### 5.1 调用形状

`hledit_read_anchors` 只接受 `{ path, windows }`，单窗口与多窗口使用同一种形状：

```ts
{ path, windows: [{ offset: 35, limit: 18 }] }

{
  path,
  windows: [
    { offset: 35, limit: 18 },
    { offset: 166, limit: 24 },
    { offset: 702, limit: 12 },
  ],
}
```

`windows` 必填，包含 1–8 个窗口；每项必须显式提供 `offset` 与 `limit`。不接受顶层 `offset` / `limit`，也不将旧调用转换为新形状。统一入口消除已实际出现的双参数冲突，不依赖对象 union 或条件 schema 表达互斥关系。

单窗口复用 `read-range` 的分页、输出与 proof 规则；多个窗口使用下述 `read-windows` 同快照协议。公开参数统一不改变 CLI wire 或历史结果回放格式。

### 5.2 CLI 协议

新增专用 `read-windows` CLI verb，而非让插件循环调用 `read-range`。它接收一个路径和 JSON stdin 中的窗口数组，CLI 仅加载一次 `Snapshot`，在同一份 UTF-8 / BOM / revision 判断结果上读取全部窗口。

CLI 对窗口执行如下规范化：

1. 每个窗口均为正的 1-indexed `offset` 与正 `limit`；最大窗口数为 **8**。
2. 窗口按物理行排序；重叠或相邻窗口合并为一个读取段，避免重复正文和重复 proof 行。
3. 结果保留每个原始请求窗口的身份；合并仅是内部读取优化，模型能清楚知道每个窗口的实际返回范围。
4. 所有窗口共同使用一份 revision 与输出预算；最终响应中每个完整窗口都携带可解析的 `lines`、`truncated`、必要时 `nextOffset`，不完整窗口明确标示未完成。
5. 二进制、编码、目录及路径错误与现有 read verb 一致；若任一请求窗口起点越界，返回结构化 `range` 失败，不发布混杂的部分 proof。

初始共享预算为 **2,000 行 / 96 KiB JSON 正文**，仍低于插件 wrapper 的 1 MiB 上限。单一超长源行沿用 `textTruncated:true`；这种行及所在不完整窗口不得作为 proof。

### 5.3 多窗口联合 proof 规则与回包

对于包含多个窗口的请求，插件仅在所有被返回、准备登记的窗口：

- 同属 CLI 回执中的一个 revision；
- 文本完整、无 `textTruncated`；
- 每个窗口的 `offset` / `limit` / `requestedWindows`、源行连续性和截断/续页状态均可验证；
- 所有模型可见的用于 proof 的行都已完整显示；

时创建一个新的 `proof_id` 并登记证据。

若任一窗口因共享预算或源行截断不完整，结果仍显示已完成窗口和明确的未完成窗口，但本次全部窗口均不登记 proof；调用方应分小批重新读取实际所需范围，包括之前已完成的窗口。这样不把“部分看到的文件片段”错误升级为可提交的联合证据。

## 6. 实施顺序

1. 复用现有验证入口并完善类型，实现成功回包紧凑化及 400 行 / 96 KiB updated-span 内部预算；不新增测试用例，仅同步受公开格式变化影响的既有断言。
2. 收敛 schema / guidance 的重复表述，并更新工具描述以指导精确读取和合理批量提交。
3. 实现 `read-windows` CLI wire、capability 门禁、插件 schema / parser / evidence 登记 / 显示格式。
4. 同步更新 `cli/SPEC.md`、README 中的公开能力说明，以及本文件中因实际实现而必要的数值调整。
5. 运行 CLI formatting、clippy、CLI tests、插件 check 与现有集成验证；按真实失败修正，不通过则不标记完成。

## 7. 验收标准

### 成功回包

- 完整一致的新增/替换回执只向模型返回摘要、proof 和 change→anchor 范围；结构化 span 保留在 details。
- 正文不符、span 截断或文本截断取消紧凑显示；非法顺序、delta、产出范围和结构仍按原有安全契约返回 `outcome_unknown`。
- 纯删除、no-op、`--check`、拒绝、stale 和 unknown-outcome 的既有语义不被误判为紧凑成功。
- 回放分支后的 evidence / proof 状态与实时执行状态一致。

### 多窗口读取

- 单窗口和多窗口均使用 `{ path, windows }`；旧顶层范围字段必须被拒绝。单窗口 CLI wire、分页与 proof 规则保持不变，续读建议必须使用新参数形状。
- 多个非邻接窗口在单次 CLI `Snapshot` 内返回同一 revision。
- 重叠、相邻和乱序请求都不会重复登记同一物理源行。
- 部分截断、超长源行、越界、二进制和文件变更均不能错误创建可写 proof。
- 后续 `hledit_apply_file_changes` 能使用多窗口完整证据覆盖的所有消费行；未覆盖行仍被拒绝并走现有定向补读。

### Token 与安全

- 优化的成功路径不再向模型重复同一批 `changes[].lines` 正文。
- 普通连续读取、错误诊断和必要恢复仍完整可操作；不能以删除信息换取表面 token 降低。
- 任何资源上调都有共享上限、截断标记与明确恢复路径，不产生无界工具回包。
