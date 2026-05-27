# 任务执行失败根因分析与根治方案

> 失败实例：`task-opq-mpdzidwi-uoz2w2fr / inst-opq-mpdzlwa6-ih4pvjwd`（"护照签证有效期确认清单" 一节）
> 现象：执行卡片显示 "执行失败 / 本地校验失败，任务没有产出可展示、可验收的结果"
> 关联代码：`goalTaskRunner.ts`、`jsonExtraction.ts`、`jsonRepair.ts`、`goalTaskAcceptancePrompt.ts`、`claude/transport.ts`

---

## 1. Summary

最终错误是 `Expected ',' or '}' after property value in JSON at position 3354/3356`，本地校验把它归类为 `json_parse_failed`，连带触发 `missing_task_result / missing_interactive_surface / missing_required_blocks / deliverable_check_invalid` 4 个派生告警，进入 2 轮 `format_repair`，全部失败，最终落入 `buildUnfinishedResult("本地校验失败...")`。

但**根因不是 Claude 在 3354 这个字节"打错了字"**，而是我们这条解析链对于"长 JSON + 内嵌大段中文 Markdown / 表格"的典型场景**先天容错不足，且修复 prompt 的提示工程没有把模型导向"修字符"，反而诱导它"重生成"**。下面分三层定位。

---

## 2. Current State Analysis

### 2.1 失败链路（从 raw 到失败卡片）

1. `streamPrompt` 把 stream-json 中 `result.result` 这段长字符串作为最终消息（[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L505-L520)）。
2. `runClaudePrompt` 把它当作 `finalMessage` 直接交给 `tryParseTaskRunnerResult`（[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1339-L1357)）。
3. `tryParseTaskRunnerResult` → `parseTaskRunnerResult` → `extractJsonObject`（基于 `extractBalancedJsonSnippet` 的括号深度扫描）→ 直接 `JSON.parse`（[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L917-L918) / [jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts#L48-L54)）。
4. 一旦 `JSON.parse` 失败，`tryParseTaskRunnerResult` 把整体置 `null`、把异常 message 当 `parseError`，校验器立即给出 `json_parse_failed` 等系列 issue（[result.json:148-180](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779270263266/tasks/task-opq-mpdzidwi-k3y7puou/inst-opq-mpeyr3gy-62ncr69k/result.json#L148-L180)）。
5. `runLocalRepairCycle` 进入两轮 `format_repair`，每轮**重新跑一次 Claude**：把"上一轮原始输出 + 校验报告"塞回 prompt，再要 Claude 输出"完整 JSON"（[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1551-L1622)、[goalTaskAcceptancePrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts#L85-L160)）。
6. 两轮修复都没过 → 失败卡片落地（[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1637-L1646)）。

### 2.2 真正的"raw"是什么样

观察实际 trajectory，可看到：

- `result.result` 的内容并不是 1 个大 JSON，而是**模型在最终消息里又把任务结果拼成了一个"大字符串"**——里面把 `task_result.blocks` 整个嵌进去，且把 `comparison_table.rows` 当成 `"|序号|姓名|...|"` 的纯字符串（`thought` 字段 trajectory index 4-6 都是同一份分片输出的累积）。
- 这种串里带了大量 `\\n`、中文全角符号、`|` 表格分隔符、`□`/`✅`/`emoji`，并有"summary 重复一份、final_message 重复一份"的现象。
- "Position 3354/3356" 指向的正是这种长字符串中第一个引号转义出错的位置，且**两轮修复后位置几乎不变**（3354 → 3356），强证模型每次都重新生成同款大模板，而不是修字符。

### 2.3 现有解析链的真实问题（按严重程度）

1. **解析层只用"括号深度扫描"取 JSON 段，没有任何"宽容解析 / 修复回退"。**
   - `extractBalancedJsonSnippet` 一旦遇到字符串里非法转义就和原生 `JSON.parse` 一起爆掉（[jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts#L1-L54)）。
   - `jsonRepair.ts` 里其实已有 `repairCommonJsonIssues / parseJsonWithCandidates / parseRepairedJsonText / buildJsonRepairPrompt`，**但 `parseTaskRunnerResult` 完全没用**。这是最大架构债：好的容错工具被旁路了。
2. **当 `JSON.parse` 失败时，丢掉了"已经成功收到的有效内容"。**
   - 失败实例的 trajectory 里其实有 `Write` 工具调用，已经把完整 Markdown 和 HTML 文件写到了 `passport_visa_checklist.md/.html`（[trajectory.json index 1-2](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779270263266/tasks/task-opq-mpdzidwi-k3y7puou/inst-opq-mpeyr3gy-62ncr69k/trajectory.json#L11-L40)）。
   - `parseTaskRunnerResult` 对此完全无知：它只看 stream 收到的 `result.result` 字符串，文件产物、artifacts、stream 中已稳定可解析的中间事件全部不被复用。
3. **修复 prompt 是"重做一次，整体输出完整 JSON"，而不是"只修字符"。**
   - [goalTaskAcceptancePrompt.ts:118](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts#L118) 明确要求 "返回一个完整 JSON 对象，不要只返回修改片段"。模型理所当然会重新拼一份，其中再次踩到同一种长字符串地雷。
   - 修复 prompt 里把校验报告 + 原始输出 + 解析结果一并塞入。原始输出里就有那段坏 JSON，经过 Claude 上下文截断后，**修复 Claude 看到的"原文"本身可能就是被截过的**——这是 3354/3356 几乎不变的另一面解释。
4. **校验器对"json_parse_failed"会派生大量级联告警。**
   - 一次 parse 失败 → 自动派生 `missing_task_result` / `missing_interactive_surface` / `missing_required_blocks` / `deliverable_check_invalid`。修复 prompt 里 5 条告警全列出来，模型会被牵着鼻子去"补 task_result/blocks/deliverable_check"，进一步加大重生内容量、加大踩雷概率。**真正应该做的是先把 parse 修了，再决定要不要派生告警。**
5. **诊断信息不够"原文级"。**
   - 失败时 `parseError.evidence` 只给了 "Expected ',' or '}' after property value in JSON at position 3354"，没有把那段 ±200 字节的上下文打到 trace。dev 端 Claude Trace 已经能拿到 raw stdout，但 result.json 里没有定位锚点，排查只能靠人工凑。

### 2.4 为什么"修复"没救回来（汇总）

- 第一性问题：**修复目标错位**——我们想"修 JSON 里的一个字符"，prompt 让模型"重新写一份完整 JSON"。
- 第二性问题：**修复输入的真实性问题**——"上一轮 raw" 在 prompt 里再被截断/转义一次，模型实际看到的不是"原文"。
- 第三性问题：**修复几乎没有确定性兜底**——只要这两轮 LLM 没自愈，就直接判死刑；本地的字符级修复、流事件回填、文件产物回填都不在链路里。
- 第四性问题：**没有"下沉解析能力"**——我们已经写了 `repairCommonJsonIssues` 和 `parseRepairedJsonText`，但只在别处被用，导致每次新 bug 都要求人去发现"哦原来有这个工具"。

---

## 3. Proposed Changes（根治方案，分 4 层 / 6 步）

按"先确定性、后概率性"的顺序解决。命名遵循现有约定，所有改动落在已有文件或就近新增；不引入新依赖。

### 3.1 解析层：把已存在的容错工具接入主链路（确定性兜底）

**文件：[src/lib/server/goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L917-L918)**

- 把 `parseTaskRunnerResult` 的入口从
  `JSON.parse(extractJsonObject(raw))`
  改造为先经过 `parseJsonWithCandidates(buildJsonParseCandidates(extractBalancedJsonSnippet(raw)), validator)`（已有于 [jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts#L65-L96)），按顺序尝试：
  1. primary
  2. balanced
  3. common_repair（去 BOM / 智能引号 / 尾随逗号 / 缺逗号）
  4. balanced + common_repair
- 仅当 4 个候选全部失败，才把 `parseError` 抛给上层。这样大量"模型最后一颗逗号 / 智能引号 / 全角引号"类问题被本地直接吃掉，不再消耗 Claude 重试名额。

**为什么这是根治而不是短视**：这是一次性把"已经在仓里写好但被旁路"的容错通路接回主线，符合项目 lessons-learned 里"统一采集优于散落埋点"的同款原则——**统一解析优于散落 try/catch**。

### 3.2 失败现场层：把"原文级"上下文落进 trace 与日志

**文件：新增 `extractParseFailureContext()` 工具于 [src/lib/server/jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts)；调用方 [goalTaskRunner.ts:1055-1066](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1055-L1066)；snapshot 写入复用 [conversationWorkspace.writePlanningParseFailureSnapshot](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/conversationWorkspace.ts) 的同款实现，在 task workspace 下落 `tasks/<taskId>/<instId>/parse-failures/`**

- 当解析失败：
  1. 用错误消息里的 `position N` 解析出 N，截取 `[max(0,N-200), min(len,N+200)]` 区间作为定位锚点。
  2. 在 result.json 的 `localValidationReport.issues[json_parse_failed].evidence` 里写入这段锚点（含 `^` 指针），而不是当前的纯英文 message。
  3. 同时把 raw、`balanced_snippet`、4 个候选解析结果、错误堆栈以 `parse-failure-<timestamp>.json` 的形式落盘到 task instance 目录下，并把相对路径回填到 issue.evidence 末尾。这与项目 lessons-learned 里的"保留原始现场"完全一致。
- Claude Trace 面板已支持 raw stdout，再加一个"Parse Failures"分类即可（参考 [ClaudeTracePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/dev/ClaudeTracePanel.tsx) 的现有 tab 结构，本期可只加 metadata 字段，UI 改造放后续）。

**为什么不是短视**：把"调试现场"从内存对象固化到磁盘，下一次出现 3354 类 bug，开发者 5 秒看到具体损坏的字符段，而不是再次猜测。

### 3.3 修复 prompt 层：从"重做"切换到"修字符"（最大可控性提升）

**文件：[src/lib/server/goalTaskAcceptancePrompt.ts:85-160](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts#L85-L160)**

把 `buildLocalValidationRepairPrompt` 拆成两个并按 `report.issues` 分流（在 [runLocalRepairCycle](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1551-L1622) 里选择）：

1. **`buildJsonCharacterRepairPrompt`**（仅用于 `json_parse_failed` 单条 issue 时）：
   - 直接复用已有的 [`buildJsonRepairPrompt`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts#L116-L126)（"只输出修复后的严格 JSON，不要改语义"）。
   - prompt 里**只塞 raw**，不塞解析结果、不塞校验报告里的派生告警，不许改字段语义。
   - 这一步一般在第一次重试就能解决"3354 字符"类问题，并避免触发"重生大模板"。
2. **`buildStructureRepairPrompt`**（保留原 prompt 语义，但前置条件变成"json 已可解析"）：
   - 处理 `missing_task_result / missing_required_blocks / deliverable_check_invalid` 等结构告警。
   - 仅当 1) 或 3.1 节确定性修复已经把 JSON 修通过后才允许进入。

**对应到 runLocalRepairCycle**：

```text
if 当前唯一/首要 issue 是 json_parse_failed:
    走 character-repair → 重新跑 validate
else:
    走 structure-repair（与现状一致）
```

并在该函数循环的第一轮**先做一次"本地确定性修复"**：用 3.1 的 candidates 跑一遍，过了就直接进入下一阶段（验收员），跳过 LLM 修复（节省 1 次 Claude 调用、降低尾延迟）。

**为什么不是短视**：分流让"语法层错误"和"结构层错误"用各自最自然的工具解决，避免互相污染（这是 3354 不变的核心原因）。`json_parse_failed` 的 prompt 不再列出派生告警，是把"指令污染"从 prompt 工程里切除。

### 3.4 流事件回填层：当 result.result 解析失败时，从 stream 已收到的 assistant content 中重建结果

**文件：[src/lib/server/claude/transport.ts:443-525](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L443-L525)**

`streamPrompt` 收到的每条 `assistant` 事件（payload.message.content[].text/thinking）已被记录到 trace。新增**事件聚合器**：

- 在 transport 内部保留一份 `aggregatedAssistantText`，每条 assistant content 增量追加。
- 当 `result` 事件抵达且 `payload.result` 解析失败（或为空）时，把 `aggregatedAssistantText` 作为 fallback 一起 emit 给上层（新增事件 `aggregated_message`，或在 `message` 事件里附带 `fallback: true`）。
- 上层 `runClaudePrompt` 在 `tryParseTaskRunnerResult(finalMessage)` 完全失败时，再回退尝试 `tryParseTaskRunnerResult(aggregatedAssistantText)`。

这个改动符合项目硬约束"统一在 transport.ts 进行采集，不下沉到业务层"。

**为什么不是短视**：3354 类损坏经常发生在最后 `result.result` 拼接时，但中途的 assistant content 反而是结构良好的——给业务层一个二次机会，是真正的"在最早可控边界恢复"。

### 3.5 文件产物回填层：当 JSON 修复仍失败但磁盘有产物时，转 awaiting_repair（不直接判失败）

**文件：[goalTaskRunner.ts:completeWithAcceptance / buildUnfinishedResult](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1624-L1646)**

- 在判定"本地校验失败"之前，扫描该 instance 工作目录（`input.taskWorkspaceDir`）下生成的文件（`*.md / *.html / *.json`）。
- 若存在已被 `Write` 工具落盘的产物（即 trajectory 中能看到对应 `tool_call: Write`），则：
  - 把状态改为 `needs_repair`（presentation_only），保留 `artifacts` 与 `files`，不让前端直接显示"执行失败"。
  - 让 acceptance 阶段的 prompt 知道"产物已落盘"——本来就是 prompt 第 7 条"允许 readonly 工具读取本地文件"的初衷，现在打通到判定层。
- 与现有"成功实例"对比即可看到：失败的那条 trajectory 里其实已经有 Write 工具调用，但它们没有进入修复 prompt 的视野。

**为什么不是短视**：这把"任务已经做出来了，只是 JSON 包错了"的情形从"用户看到红色失败"挽救到"系统自我恢复"。这不是一个一次性兜底，是在结构上**让磁盘成为可信状态源**——与项目偏好"server-authoritative state"一致。

### 3.6 校验告警层：派生告警闸门

**文件：[goalTaskRunner.ts validateTaskResultLocally 调用方](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1571-L1612) / 校验器实现处（按需新增）**

校验器在 `parseError` 存在时，**只**报 `json_parse_failed`，不再继续派生 `missing_task_result / blocks / deliverable_check`。理由：在 JSON 修通过之前，所有 missing\_\* 都是噪声，会污染 3.3 的修复 prompt。

只有 JSON 已成功解析，才进入"结构告警"通道。

---

## 4. Assumptions & Decisions

- 不为本次问题引入新依赖；优先复用 `jsonRepair.ts`、`jsonExtraction.ts`、`traceStore.ts`、`writePlanningParseFailureSnapshot`。
- 本期不动 acceptance judge 的 prompt（[goalTaskAcceptancePrompt.ts:162-225](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts#L162-L225)），仅修 local repair。
- transport 层"流事件回填"作为 fallback，不改默认 emit 顺序，向后兼容。
- 文件产物扫描限定在 `input.taskWorkspaceDir`（已知存在），不递归进会话根目录。
- "本地确定性修复"先跑、跑过则跳过 LLM 修复——这会减少 Claude 调用次数。若用户/产品希望保留 LLM 校对一遍，可加开关，但默认推荐跳过。

## 5. Verification

1. 复跑失败实例（手动重试 inst-opq-mpdzlwa6-ih4pvjwd 同款数据），期望：
   - 不再触发 `format_repair`，`localValidationReports` 中 strategy=common_repair 直接通过；或一次 LLM 字符修复就能通过。
   - `result.json.localValidationReport.issues[].evidence` 里包含 `±200 字节锚点`、`parse-failure-*.json` 相对路径。
2. 单元测试：在 `jsonRepair.ts` 旁新增几个 fixture（智能引号 / 缺逗号 / position 截断 / 大字符串内嵌 markdown 表格），断言 `parseJsonWithCandidates` 全部直通。
3. dev 面板 Claude Trace 中能看到该次调用的 raw stdout 和 parsed-events，且能在 `Metadata` 看到 `parse-failure-*.json` 的指针。
4. 跑现有 `pnpm verify` 套件（[package.json:14-16](file:///Users/bytedance/Documents/trae/long_horizon_agent/package.json#L14-L16)）确保 architecture / goal-commands / cursor 三个守护测试不退化。
5. 人工验证：触发一次更长的 markdown 任务（比如 30 行表格 + 中英混排），观察是否会再次出现 3354 类失败。

---

## 6. 风险与回滚

- 风险：`parseJsonWithCandidates` 中 `repairCommonJsonIssues` 的"补逗号"规则可能在极端边界引入语义偏差。缓解：保留 `primary` 候选优先，且新加 fixture 测试。
- 风险：transport 聚合 fallback 可能让上层在某些"模型主动放弃"的场景拿到半拉子内容。缓解：fallback 路径在解析失败后才启用，且打 `fallback: true` 标记，默认 acceptance 阶段会再过一遍校验。
- 回滚：所有改动都集中在解析与本地修复链路；如需回滚仅需还原 `parseTaskRunnerResult` 与 `runLocalRepairCycle`，不会影响数据格式与 SSE 协议。
