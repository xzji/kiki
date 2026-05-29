# Plan：任务生成切换为 Draft-first 架构（最终版）

## Summary
- **根因**：当前任务生成把 Claude 当成「最终内部 DTO 编码器」，让 LLM 直接生成 `expected_output / collaboration / required_blocks / executionMode` 等系统内部结构。失败原因不可穷举：写文件不返回、Markdown 包裹、未转义引号、字段缺失、字段命名漂移、字符串内嵌示例引号等等。
- **根治方向**：把任务生成切成 `Claude → 轻量语义 TaskDraft（Block 协议）→ 系统确定性编译 → DraftTask → 校验入库`。LLM 永远不输出系统内部字段。
- **失败粒度**：从「整个子目标失败」缩小到「单任务草稿失败」。任意单任务草稿坏了不再阻断子目标，被丢弃任务记入 telemetry，可单独重试或后续修复。
- **协议鲁棒性**：选用「行首锚点的 Block 协议」+ 单任务跳过解析；`<![CDATA[...]]>` 作为极端兜底；JSON 不再作为主协议。
- **单一真源**：所有结构推断（`expectedResult / requiredBlocks / collaboration / executionKind / presentation / primaryFormat / cadence` 校验）统一收敛到新 `taskCompiler.ts`，`goalFactory.ts` 与 `mocks/goals.ts` 复用同一组纯函数。
- **可观测性 + 测试**：parse-failure 快照按 stage 区分；新增最小 runner 覆盖 `blockProtocol` 与 `taskCompiler`。
- **代码状态**：单次实现内**只保留新方案**，删除 `TaskGenerationPayload`、`TaskGenerationSchemaError`、`validateTaskGeneration`、`buildTaskGenerationPrompt` 等仅服务旧 schema 的代码与分支。
- **schema 版本**：`GoalPlanningCheckpoint.version` 升级到 `2`，旧 checkpoint 自动失效（按 fall-through 处理）。

## Current State Analysis

### 现状关键文件
- 任务生成入口：[goalPlanning.ts L2123-L2166](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2123-L2166) `generateTasksForSubGoalWithClaude`。
- Prompt：[goalPlanning.ts L692-L811](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L692-L811) `buildTaskGenerationPrompt`。
- Schema：[goalPlanning.ts L74-L135](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L74-L135) `TaskGenerationPayload`。
- 校验：[goalPlanning.ts L1487-L1637](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1487-L1637) `validateTaskGeneration`。
- 解析与修复：[goalPlanning.ts L1149-L1356](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1149-L1356) `parseClaudeJson`。
- 落地映射：[goalPlanning.ts L2280-L2403](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2280-L2403) `applyTaskReview`。
- 重复的结构推断：
  - [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) `inferRequiredBlocks / inferPresentation / inferPrimaryFormat / inferExecutionKind / normalizeTaskCollaborationPayload`。
  - [goalFactory.ts L78-L92](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalFactory.ts#L78-L92) 自有 `expectedResultFor`。
  - [mocks/goals.ts L144-L246](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts#L144-L246) 自有 `inferRequiredBlocks / expectedResultFor`。
- Checkpoint：[goalPlanning.ts L163-L202](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L163-L202) `version: 1`，子目标级失败整段写 `partial`。

### 问题归纳
- **协议层错位**：让 LLM 输出系统内部结构，失败形态不可枚举。
- **失败粒度过粗**：1 个任务损坏 → 整个子目标重来。
- **修复路径不收敛**：JSON repair / schema-aware 修复 / artifact recovery / partial checkpoint 都是事后补救。
- **结构推断有 3 套副本**：goalPlanning / goalFactory / mocks/goals，演进容易漂移。
- **prompt 巨大**：单 prompt 同时塞了 5+ 类规则、嵌套 JSON schema。

## Proposed Changes

### 总体架构
```
Claude
  └── TaskDraftBatch (Block 协议, 仅语义字段)
       └── parseTaskDraftBatch  ──── 单任务解析失败 → repairSingleTaskDraft（最多 1 次）→ 仍失败则 drop
       └── reviewTaskDrafts ──────── 在草稿层评估对齐度（小输入、低失败面）
       └── compileTaskDraftsToDraftTasks ── 系统确定性产出 DraftTask + warnings
       └── validateDraftTasks ───── 系统层最终校验（Bug 防护）
            └── 入库 GoalBreakdownDraft
```

### 新模块（新增文件）

#### `src/lib/server/goalPlanning/taskDraftSchema.ts`
- 定义最小 schema：
  ```ts
  export type TaskDraft = {
    title: string;
    objective: string;
    deliverable: string;
    acceptanceCriteria: string[];
    cadence?: string;
    triggerCondition?: string;
    userInvolvement?: {
      mode?: "none" | "confirm" | "answer" | "collaborate";
      reason?: string;
      actionLabel?: string;
    };
    dependencyHints?: string[];
    priorityHint?: "critical" | "high" | "medium" | "low";
    estimatedMinutes?: number;
    notes?: string;
  };

  export type TaskDraftBatch = {
    subGoalSummary?: string;
    coverageNotes?: string[];
    risks?: string[];
    tasks: TaskDraft[];
    droppedTaskIndices?: number[];
    droppedReasons?: Array<{ index: number; missingFields: string[] }>;
  };
  ```
- `validateTaskDraftBatch`：必填 `title / objective / deliverable / acceptanceCriteria`；缺字段时单条任务被丢弃并记录到 `droppedReasons`，不抛整体异常；当 0 任务可用才抛 `TaskDraftBatchEmptyError`。

#### `src/lib/server/goalPlanning/blockProtocol.ts`
- **协议规范**（必须严格落地）：
  - 行首锚点：所有标签必须出现在行首（前导空白允许，不允许其它字符）。
  - 禁止嵌套：`<title>` 内的内容直到下一行首 `</title>` 都视作纯文本。
  - 缺尾标签可恢复：遇到下一个行首开标签时，前一个标签视为已隐式闭合，记录 warning。
  - 极端兜底：标签内容可以包裹 `<![CDATA[...]]>`，CDATA 内任意字符不解析。
  - 单任务隔离：`<task index="N">...</task>` 块内任意错误只丢弃该任务。
- 协议示例：
  ```text
  <task index="1">
  <title>
  面试节奏调度与进度看板管理
  </title>
  <objective>
  ...
  </objective>
  <acceptance>
  - 每周生成进度周报
  - 看板含 T1/T2/T3 分层
  </acceptance>
  <cadence>每周日 20:00 触发</cadence>
  <user-involvement mode="none" />
  <dependencies>1, 2</dependencies>
  <priority>high</priority>
  <duration-minutes>90</duration-minutes>
  </task>
  ```
- 单测必须覆盖：
  - 标准块解析。
  - 缺尾标签恢复。
  - CDATA 包裹。
  - 单 task 损坏只跳过。
  - 标签内空行保留。
  - `index` 缺失时按出现顺序重新编号。
  - 多 `<task>` 顺序解析。
  - 内容含 `</title>` 字面量但非行首时不被识别为闭合。

#### `src/lib/server/goalPlanning/taskDraftPrompt.ts`
- `buildTaskDraftPrompt(input)`：
  - 顶部 5 行硬约束：
    1. 只能输出 Block 协议，不允许 JSON / Markdown / 解释文字。
    2. 标签必须出现在行首。
    3. 不要输出 `expected_output / collaboration / required_blocks / format / presentation / executionMode / executionKind` 等内部字段。
    4. 内容包含 `</tag>` 字面量时使用 `<![CDATA[...]]>` 包裹。
    5. cadence 必须包含具体时间/间隔（如「每周日 20:00 触发」「每 3 小时触发」），不要使用「早上/出发前/晚上」等模糊词。
  - 给出一个完整正确示例 + 一个错误示例（用 ❌ 标注）。
  - `priorityHint`、`userInvolvement.mode` 取值集合显式列出。
  - 不再嵌入 `allowedExecutionKinds / allowedRequiredBlocks` 等系统枚举。

#### `src/lib/server/goalPlanning/taskCompiler.ts`（**单一真源**）
- 单一入口：
  ```ts
  export function compileTaskDraftsToDraftTasks(input: {
    drafts: TaskDraft[];
    subGoalContext: { id: number; name: string; description: string; criteria: string[] };
    taskIdBatchSeed: string;
    subGoalDraftId: string;
    subGoalIndex: number;
  }): { tasks: DraftTask[]; warnings: TaskCompileWarning[] };
  ```
- 暴露**纯函数**给其它模块复用：
  - `inferExecutionMode(draft)`、`inferTaskType(draft)`、`inferExecutionKind(draft)`。
  - `inferPresentation / inferPrimaryFormat / inferExportableFormats / inferRequiredBlocks(draft)`。
  - `buildExpectedResult(draft)` / `buildCollaboration(draft)`。
  - `validateCadence(draft)`：
    - `task_type === "repeat"` 必须包含具体时间或间隔（正则匹配 `\d{1,2}:\d{2}` 或「每…触发」）。
    - 否则记 warning，cadence 置空（不阻断编译）。
  - `resolveDependencies(draft, draftIndexById)`：支持 `["1", "2"]`、`["task-1"]`、`["面试节奏调度…"]`，解析失败置空。
  - `buildTaskId` 复用现有 [`buildDraftTaskId`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2262-L2278)。
- **替代** [goalFactory.ts L78-L92](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalFactory.ts#L78-L92) 与 [mocks/goals.ts L144-L246](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts#L144-L246) 中的同名实现，让两者直接 import 复用。

#### `src/lib/server/goalPlanning/taskDraftReview.ts`（新增）
- `buildTaskDraftReviewPrompt(input)`：直接对 `TaskDraft[]` 评估对齐度。
  - 输入 schema 比当前 review 小一半，prompt 失败面更小。
  - 输出沿用现有 `TaskReviewPayload`，但 `taskId` 改为 draft 的 `index`（系统侧再映射）。
- `applyDraftReview(drafts, review)`：在 draft 层做过滤、重排、依赖修复，再交给 compiler。

### 现有文件改动

#### `src/lib/server/goalPlanning.ts`
- **删除**：
  - `TaskGenerationPayload` / `TaskGenerationSchemaIssue` / `TaskGenerationSchemaError` / `isTaskGenerationSchemaError`。
  - `validateTaskGeneration` / `buildTaskGenerationPrompt` / `buildTaskReviewPrompt`。
  - `parseClaudeJson` 中两段 schema-aware 修复（[L1201-L1233](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1201-L1233)、[L1285-L1306](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1285-L1306)）。
  - `applyTaskReview` 中 LLM payload → DraftTask 的映射段 [L2280-L2403](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2280-L2403)。
  - `inferTaskType / inferTriggerRule / inferExecutionKind / inferUserInteractionType / normalizeTaskCollaborationPayload / inferRequiredBlocks / inferPresentation / inferPrimaryFormat` 中只服务旧 payload 的实现，迁移到 `taskCompiler.ts` 后删除。
- **新增**：
  - `generateTaskDraftBatchForSubGoalWithClaude(input)`：调用 `runClaudeJson`（保留 `--disallowedTools`），prompt 来自 `buildTaskDraftPrompt`。
  - `repairSingleTaskDraftWithClaude(input)`：输入参数包括失败 task 原始 block + 缺失字段列表 + 子目标上下文。重试上限 1 次。
  - `reviewTaskDraftsWithClaude(input)`：取代 `reviewTasksWithClaude`，输入是 `TaskDraft[]`。
- **修改**：
  - 子目标循环 [L2580-L2724](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2580-L2724)：
    1. `generateTaskDraftBatchForSubGoalWithClaude` → `TaskDraftBatch`。
    2. 失败 task 进入单任务重试队列（最多 1 次）。
    3. `reviewTaskDraftsWithClaude` 在草稿层 review。
    4. `compileTaskDraftsToDraftTasks` 产出 `DraftTask[]` 和 warnings。
    5. `validateDraftTasks` 做最终校验。
  - `GoalPlanningCheckpoint.version` 升到 `2`；`activeSubGoal.generatedTasks` 重命名为 `activeSubGoal.generatedDrafts`，类型 `TaskDraftBatch`。
  - `subGoalTaskGeneration` 增加：`failedTaskIndices?: number[]`、`recoveredTaskCount?: number`、`droppedReasons?: Array<{ index: number; missingFields: string[] }>`。
  - `partialFailure` 仅在 0 任务编译成功才标记。
  - 旧 checkpoint（version === 1 或字段不匹配）一律 fall-through 到从子目标重新生成 draft。

#### `src/lib/goalFactory.ts`
- 删除 [L78-L92 `expectedResultFor`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalFactory.ts#L78-L92)，改 import `taskCompiler` 暴露的纯函数。

#### `src/mocks/goals.ts`
- 删除 [L144-L246](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts#L144-L246) 中本地的 `inferRequiredBlocks / expectedResultFor`，改 import `taskCompiler`。

#### `src/lib/server/claude/jsonRepair.ts`
- 删除 `repairTaskGenerationSchemaWithClaude`（仅被任务生成使用）。
- 通用 JSON repair 仅服务于 decomposition / draft review / plan presentation。

#### `src/lib/server/claude/artifactRecovery.ts`
- 不删除（decomposition 等仍使用），但任务生成阶段不再调用。

#### `src/lib/server/workspace/conversationWorkspace.ts`
- `writePlanningParseFailureSnapshot` 扩展字段：
  ```ts
  payload: {
    stage: "draft_parse" | "draft_validate" | "compile" | "review" | "final_validate";
    successDraftCount?: number;
    failedDraftIndices?: number[];
    droppedReasons?: Array<{ index: number; missingFields: string[] }>;
    rawDraftBatch?: string;
    compiledTasksPreview?: unknown;
  };
  ```

#### `src/lib/api/goals.ts`
- `GoalPlanningCheckpointStatus` 增加：`failedTaskCount? / recoveredTaskCount? / schemaVersion?`。

### 可观测性基线（新增）
- `appendGoalLog` 在任务生成相关事件中携带：
  - `taskGenStage`：`draft_parse / draft_validate / compile / review / final_validate`。
  - `failureType`：`block_parse_error / missing_field / cadence_invalid / dependency_unresolved / compile_warning / review_misalign`。
- 用于事后聚合「draft 失败率 vs 旧失败率」的对比指标。

## Assumptions & Decisions

- **协议主体：Block，不退回 JSON**。如果 Block 解析失败，走单任务重试；不再用 JSON 兜底，避免出现「两套协议都需要维护」的复杂度。
- **任务级失败容忍**：单子目标只要 ≥ 1 个任务编译成功即视为成功；失败任务记入 `droppedReasons`。
- **系统拥有所有内部结构**：LLM 永远不输出 `expected_output / collaboration / required_blocks / presentation / primary_format / executionMode / executionKind / executionStrategy`。
- **重试反馈链路**：单任务重试必须把缺失字段列表 + 字段语义说明注入 prompt。
- **review 前移到 draft 层**：输入更小、失败面更小、节省一次结构化序列化。
- **单一真源**：所有结构推断函数集中在 `taskCompiler.ts`；`goalFactory.ts` 和 `mocks/goals.ts` 直接 import。
- **schema 版本号显式升级**：`GoalPlanningCheckpoint.version: 2`，旧 checkpoint 自动失效。
- **cadence 校验下移**：编译器内置 `validateCadence`，对周期任务的模糊触发时间记 warning 并清空。
- **`runClaudeJson` 工具约束保留**：继续禁用 `Write/Edit/MultiEdit/Bash/...`。
- **测试基础设施落地**：本次必须新增可执行的最小 spec runner（`tsx` 直接运行 `*.spec.ts`），覆盖 `blockProtocol` 和 `taskCompiler` ≥ 12 个用例。

## Verification

### 自动化校验
- `pnpm tsc --noEmit`。
- `pnpm verify`。
- 新增 `pnpm test:planning`（`tsx scripts/run-planning-specs.ts` 或现有 vitest 入口），运行：
  - `blockProtocol.spec.ts`（≥ 8 用例）。
  - `taskCompiler.spec.ts`（≥ 6 用例：cadence 校验、依赖解析、user-involvement → collaboration、execution_kind 推断、required_blocks 推断、缺字段编译降级）。

### 历史样本回放（dry-run 脚本）
- `scripts/replay-planning-failures.ts`：读取 `data/workspaces/conversations/conv-new-1779892704115/logs/...` 等历史 trace stdout，模拟跑 `parseTaskDraftBatch + compileTaskDraftsToDraftTasks`，期望：
  - `conv-new-1779883996052`：模型旧 stdout 是 Markdown 表格 → Block 解析失败 → 进入单任务重试路径（如能恢复就 ok，恢复不了至少要丢弃单任务而非整段失败）。
  - `conv-new-1779892704115`：模型旧 stdout 是带未转义引号的 JSON → 旧 schema 必失败；新方案对应 prompt 已不要求 JSON，这条样本作为「输入分布迁移」基线，不强制可解。

### 手工回归
- 本地 dev server 重新触发任务规划：
  - 验证子目标失败时 `partial` 仅在 0 任务成功时出现。
  - 验证某任务失败时 `subGoalTaskGeneration.failedTaskIndices / droppedReasons` 写入。
  - 验证生成的 `DraftTask` 中 `expectedResult / collaboration / requiredBlocks / executionMode` 全部由代码生成。
  - 验证 `goalFactory.ts` 与 `mocks/goals.ts` 调用同一组推断函数。

### 灰度策略
- 不做 feature flag。Block-only + 单任务重试 + 单一真源足够；旧 checkpoint 自动 fall-through。

## Out of Scope（明确不做）
- 重构 review 阶段为 Block 协议（draft review 仍是小 JSON）。
- 把 decomposition / plan presentation 也切到 Draft-first（本次只解任务生成，等观测一段时间再决定是否扩散）。
- 引入第二个 LLM 模型做 draft 校对。
- 实现「任务草稿手动编辑」UI。
- 引入指数退避或队列化重试。

## Implementation Order
1. 新增 `taskDraftSchema.ts / blockProtocol.ts / taskDraftPrompt.ts / taskCompiler.ts / taskDraftReview.ts`，附最小 spec runner + 单测。
2. 把 `goalFactory.ts` / `mocks/goals.ts` 中重复推断逻辑切到 `taskCompiler.ts` 暴露的纯函数（确保单一真源）。
3. 修改 `goalPlanning.ts`：删除旧 schema/prompt/校验/applyTaskReview 旧逻辑，接入新链路；checkpoint 升 version 2。
4. 同步 `conversationWorkspace.ts`、`api/goals.ts` 字段。
5. 写历史样本回放脚本（dry-run），跑通预期分支。
6. `pnpm tsc --noEmit` + `pnpm verify` + `pnpm test:planning`。
7. 本地 dev server 真实触发回归。

## Plan Self-Review & 补漏（最终版增订）

下列条目对原方案做"是否最佳/有无遗漏"的二次审查。结论：**架构方向最佳**（LLM 输出语义 Draft、系统拥有内部 DTO、单任务级失败容忍、单一真源）。但落地细节需补齐 8 处，确保零回归并避免下一轮"补丁式修复"。

### S1. 旧 checkpoint v1 的 fall-through 路径（接口契约）
- **问题**：[resume/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/plan/resume/route.ts) 与 [checkpoint/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/plan/checkpoint/route.ts) 当前直接读取 `GoalPlanningCheckpoint`。version 升到 2 后，磁盘上残留的 v1 文件需有明确处理，否则会导致前端"恢复"按钮指向脏数据。
- **补漏**：
  - `readGoalPlanningCheckpoint` 增加 `version !== 2` 时返回 `null` 并记 `appendGoalLog({ level: "warn", message: "discarded legacy checkpoint v1" })`。
  - `getGoalPlanningCheckpointStatus` 在 fall-through 时返回 `{ available: false, schemaVersion: 1, discarded: true }`，前端可显示「上次进度因协议升级失效，请重新规划」。

### S2. 0 任务子目标的失败语义
- **问题**：原 Plan 只说"≥1 个任务编译成功视为成功"，但若某子目标 0 任务可用，是 partial 还是抛错？子目标后续依赖会断链。
- **补漏**：
  - 任意子目标编译后 `tasks.length === 0` → 触发**子目标级 partial**（不影响其它子目标），写入 `subGoalTaskGeneration[i].status = "task_generation_failed"`、`taskCount = 0`、`droppedReasons` 完整保留。
  - 整体 `partialFailure.recoverable = true` 表示该子目标可单独重试。
  - 不允许"自动塞一个空任务凑数"——这是当前旧代码 `applyTaskReview` 的兜底反模式（[goalPlanning.ts L2356-L2402](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L2356-L2402)），新方案明确删除。

### S3. Block 协议对 Markdown 围栏的容忍
- **问题**：LLM 习惯把结构化输出包在 ```` ``` ```` 或 ` ```xml ` 围栏内。若 parser 严格遵守"行首锚点"，围栏行会让首个 `<task>` 被识别但内容被污染。
- **补漏**：在 `blockProtocol.ts` 解析前置一步 `stripFencedWrappers(raw)`：
  - 去掉首尾的 ```` ``` ````、` ```xml `、` ```text `、` ```markdown ` 等围栏。
  - 不删除 CDATA 内的围栏字面量。
  - 单测增加：「整段被 ```xml 包裹」「`<task>` 之间夹杂解释段落」两个用例。

### S4. Prompt 中英文混排与触发词正则
- **问题**：Block 标签英文、内容中文。`validateCadence` 正则需兼容中文「每周日」「每 3 小时」「每月 1 号」，不能仅匹配 `\d{1,2}:\d{2}`。
- **补漏**：`validateCadence` 接受以下任一形态视为合法：
  - 包含 `\d{1,2}:\d{2}` 的具体时间。
  - 中文模式 `/每[\s]*(\d+|周一|周二|...|周日|月|天|小时|分钟)/`。
  - `triggerCondition` 已显式写明事件源（如「机票出票后」「面试邀请到达后」）。
  - 否则 warning + 清空 cadence，不阻断编译。

### S5. `GoalBreakdownDraft` 下游消费方的字段不变性
- **问题**：执行器、UI（任务详情、执行卡片、Excel 导出）依赖 `DraftTask.expectedResult.requiredBlocks / presentation / primaryFormat / completionCriteria` 等字段。compiler 必须保证这些字段在所有路径下都被填充，否则 UI 会出现空白卡片。
- **补漏**：
  - `compileTaskDraftsToDraftTasks` 内每个 DraftTask 必须经过 `assertDraftTaskShape(task)` 终检（与 `validateDraftTasks` 区分：前者是字段非空+类型对、后者是业务一致性）。
  - 提供 `defaultExpectedResultFor(executionKind)` 兜底，确保 `presentation/primaryFormat/exportableFormats/requiredBlocks/completionCriteria` 永远非空。
  - `goalFactory.ts` 与 `mocks/goals.ts` 切到 compiler 后，跑一次 `pnpm tsc --noEmit` 确保签名一致。

### S6. `taskCompiler.ts` 的 server-only 隔离
- **问题**：`mocks/goals.ts` 用于客户端预览（包含 mock 数据），如果 `taskCompiler.ts` 被放在 `src/lib/server/`，会强制 mock 走服务端 bundle。
- **补漏**：
  - 把 `taskCompiler.ts` 中**纯函数部分**（无 fs/no Claude/no env 依赖）拆到 `src/lib/goalPlanning/taskCompiler.ts`（**非 server 目录**）。
  - 服务端的 `compileTaskDraftsToDraftTasks` 入口仍放在 `src/lib/server/goalPlanning/`，内部 import 上述纯函数。
  - 这样 `goalFactory.ts`（client-safe）与 `mocks/goals.ts` 都能直接 import 推断函数，不污染 server bundle。

### S7. Telemetry 落盘与对比指标
- **问题**：原方案有 `taskGenStage / failureType` 字段，但缺少能直接对比"新旧失败率"的入口。
- **补漏**：
  - `appendGoalLog` 新增 `details.taskDraftStats`：`{ requested: number; parsed: number; repaired: number; dropped: number; reviewMisaligned: number }`。
  - 子目标完成时输出一条 `phase: "reviewing_tasks", level: "info", message: "task_draft_stats"` 汇总。
  - 后续看板可直接基于该字段聚合「draft 失败率」与历史样本对比。

### S8. 前端类型同步
- **问题**：`GoalPlanningCheckpointStatus` 增加 `failedTaskCount / recoveredTaskCount / schemaVersion / discarded` 字段后，前端 `CheckpointBadge`、`PlanResumePrompt` 等组件需要同步消费，否则 TS 编译会失败但运行时不可见。
- **补漏**：
  - 在 `src/lib/api/goals.ts` 同时导出新字段类型。
  - `pnpm tsc --noEmit` 必须扫描 `src/components/**` 中所有引用点；如有缺失展示，至少在 PlanResumePrompt 文案中携带 `failedTaskCount`。
  - 不在本次 Plan 内做新 UI 组件，但**禁止使用 `as any` 绕过新增字段**。

### S9. 复用 `runPromptJson` 的工具约束 vs 文本协议的反差
- **问题**：[transport.ts L103](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L103) 的 `runPromptJson` 默认禁用工具，且要求模型走 stdout `result.result`。Block 协议是文本协议，不一定能放入 `result.result` 字符串字段。
- **补漏**：
  - 新增 `runPromptText`（薄封装 `runClaudeStreaming` 或当前已有的文本通道），同样应用 `--disallowedTools` 列表。
  - 在 `transport.ts` 暴露 `buildJsonToolArgs` 同时暴露 `buildTextToolArgs`（共用同一工具黑名单常量）。
  - `generateTaskDraftBatchForSubGoalWithClaude` 走 `runPromptText`，不走 `runPromptJson`。
  - **Hard Constraint 同步更新到项目记忆**：「Block 协议任务生成走 `runPromptText`，工具黑名单同 `runPromptJson`」。

---

### 是否还需要进一步外部澄清？
不需要。以上 9 项补漏均为内部决策，**不影响架构方向**，可在执行阶段落地。Plan 现已 decision-complete。
