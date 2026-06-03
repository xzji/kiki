# 方案：Thread=板块 / Task 自持频率 / 双循环执行机制

## Summary

把系统执行模型从「Thread 持有执行频率、每 tick 派发 one_shot Task」**反转**为：

- **Thread = 需求的一个维度 / 阶段 / 板块**，是「组织 + 上下文 + 记忆」的容器，**不持有执行频率**。
- **Task = 真正的执行单元**，每个 Task **自带调度**（one_shot / repeat + triggerRule），同一 Thread 下的 Task 频率可各不相同；频率可被 tick 治理修改。
- 系统跑**两个职责正交的循环**：
  - **循环 1 · Task 执行循环**：按每个 Task 自己的频率到期执行。（代码已存在 = `goalSchedulerEngine` + `isTaskTriggerDue`）
  - **循环 2 · Thread 治理循环**：不执行 Task，只对本板块的 Task 集合做增/改/删/调频，外加发板块小结。触发方式 = **事件为主（本板块 Task 完成）+ 低频 review 兜底**（用户选定方案 2）。

关键认知：**「重复」100% 在 Task；「该有哪些 Task、要不要调整」在 Thread。** Thread 的 tick 不再驱动执行，只做治理，其 cadence 退化为「低频 review 节拍」，与「执行频率」彻底解耦。

---

## 目标模型：三层职责 + 双循环

### 三层职责

| 层 | 角色 | 持有 | 不持有 |
|---|---|---|---|
| **Topic** | 整个需求 | title/summary、threads[] | — |
| **Thread** | 维度/阶段/板块 | intent、memory、status、terminationCondition?、**reviewInterval（治理节拍，非执行频率）** | ❌ 执行频率 |
| **Task** | 一件可执行的事 | **自己的调度**（taskType + triggerRule）、objective、deliverable、状态 | — |

美股例子在新模型下：
```
Topic: 美股投资关注
├─ Thread「市场环境」(reviewInterval=weekly)      ← 板块
│   ├─ Task 大盘指数巡检   (repeat, 每天 09:00)
│   └─ Task 宏观数据日历   (repeat, 每周一)
├─ Thread「个股 watchlist」(reviewInterval=weekly)
│   ├─ Task 跟踪 NVDA      (repeat, 每天)
│   ├─ Task NVDA 财报分析  (one_shot, 条件:财报发布 → 降级为每日巡检评估)
│   └─ Task 跟踪 AAPL      (repeat, 每天)
└─ Thread「风险预警」(reviewInterval=daily)
    └─ Task 大幅波动监测   (repeat, 每小时)
```

### 双循环执行机制

```
┌────────────── 循环1 · Task 执行（频率在此，已存在）──────────────┐
│ goalSchedulerEngine 每帧扫描所有 active Task：                  │
│   对每个 Task → isTaskTriggerDue(task, now)（按 task 自己的     │
│   taskType+triggerRule）→ 到期则 createInstance + startTaskAttempt│
│ Task 执行完 → 写结果 → 发出「task 完成」信号                     │
└───────────────────────────┬────────────────────────────────────┘
                            │ 事件桥：本板块某 Task 完成
                            │ → 置 thread.nextTickAt = now（请求一次治理）
                            ▼
┌────────────── 循环2 · Thread 治理（适应在此）──────────────────┐
│ threadLoopDaemon 每帧 selectDueThreads：                       │
│   due 条件 = (nextTickAt ≤ now 事件触发) 或 (reviewInterval 到期)│
│ 对 due thread → runThreadTick（治理决策，不执行 Task）：        │
│   读 intent + 本板块 Task 列表&结果 + memory → 输出动作：        │
│     create_task / update_task / cancel_task（含调频）           │
│     post_message（板块小结） / silent / memoryDelta            │
└─────────────────────────────────────────────────────────────────┘
```

两循环通过 **SQLite 状态快照**解耦：循环 1 写 Task 结果，循环 2 读 Task 结果。事件桥只是「Task 完成时把所属 thread 的 `nextTickAt` 设为 now」，让既有 `selectDueThreads` 顺带把它选中——**不引入新的事件总线**。

---

## Task 生命周期：初始种子 + tick 增量演进

> 这是本方案的核心原则之一：**Task 集合不是一次性定死的，而是「初始播种 + 运行时持续演进」**。Planner 只负责播下初始种子，板块内 Task 的后续增删改由 Thread 治理 tick 现场推理决定。

### 阶段 A · 初始播种（Planner，规划时一次性）

- Planner 在拆 Thread（板块）的同时，为每个板块产出 **0~N 个种子 Task**，每个种子自带 `taskType` + 频率（`cadence`/`triggerCondition`）。
- **明确允许种子不全**：种子只覆盖「当下已能确定的事」。尤其 monitoring 类板块，很多 Task 要等首次运行拿到信息后才知道该建什么（如先建「拉取 watchlist」，跑完才知道要为哪几只股票各建跟踪 Task）。
- 不再用 `fallbackTaskForSubGoal` 塞占位空 Task；某板块可以合法地以 `tasks=[]` 起步，由首次治理 tick 补全。

### 阶段 B · 增量演进（Thread 治理 tick，运行时持续）

每次治理 tick（事件触发或低频 review）读「intent + 本板块当前 Task 列表&最近结果 + memory」，对 Task 集合做差异化治理，四类动作：

| 动作 | 触发判断 | 落地 |
|---|---|---|
| **新增 create** | intent 覆盖但现有 Task 未覆盖的新关注点（含「上一个 Task 跑出来才暴露的子任务」） | `dispatch_task` + 指定合适 taskType/频率 |
| **修改 update** | 关注对象仍在，但目标/频率/触发条件需调整（如盯盘从每天改每周） | `update_task`，patch 仅含变化字段（含调频） |
| **删除 cancel** | 关注点消失 / 已永久完成 / 重复冗余 | `cancel_task` + reason |
| **不动 keep** | 无结构性变化，仅例行小结或暂无可做 | `post_message` / `silent` |

### 边界划分（谁负责什么）

- **「这个板块该有哪些 Task、要不要调整」** → Thread 治理 tick（阶段 A 种子 + 阶段 B 演进）。
- **「某个 Task 何时该执行」** → Task 自己的 `taskType+triggerRule`，由循环 1 判定，治理层不参与。
- 即：**结构（有哪些 Task）由治理层演进，节奏（何时跑）由 Task 自持**——这正是双循环职责正交的体现。

> 落地映射：阶段 A = 改动 6（Planner 产种子 + 废弃 fallback）；阶段 B = 改动 2（动作契约扩 update/cancel）+ 改动 5（tick 决策原则写进 prompt）+ 改动 4（事件触发让演进及时发生）。

---

## Current State Analysis

| 关注点 | 现状 | 与目标的差距 |
|---|---|---|
| Task 执行循环 | ✅ [goalSchedulerEngine](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts#L78-L90) 已按 `isTaskTriggerDue` 逐 Task 调度，支持 interval/daily/weekly | 仅 gate 在 `workflow.phase∈{executing,monitoring} && planDecision=confirmed`（[L52-58](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts#L52-L58)）；需确保 saga 产出的 Topic 进入该状态 |
| Task 自持频率 | ✅ `Task.taskType: "repeat"\|"one_shot"` + `triggerRule`（[kiki.ts L373-374](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L373)） | 字段已具备，无需新增 |
| Thread 频率 | ❌ `Thread.loopInterval` 被当成执行频率驱动 tick；tick 派 Task 强制 one_shot（[dispatchTaskFromThread L77-81](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/dispatchTaskFromThread.ts#L77-L81)） | 需把 loopInterval 语义改为「治理 review 节拍」；去掉 one_shot 强制 |
| tick 动作 | ❌ 只有 dispatch_task/post_message/silent（[topic.ts L97-113](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/topic.ts#L97-L113)） | 需增 update_task / cancel_task |
| 事件触发治理 | ❌ 无；thread 只按 loopInterval 周期 tick | 需加「Task 完成 → 置 thread.nextTickAt=now」事件桥 |
| 初始 Task | ❌ Planner 不产 Task，靠 [fallbackTaskForSubGoal](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/sagaDraftAdapter.ts#L93-L111) 每板块兜底塞 1 个占位 | 需 Planner 产真实种子 Task（含各自频率），废弃占位 |
| 底层增删改命令 | ✅ `create/update/delete_task` 已在 [topicCommandService L129-148](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/topicCommandService.ts#L129-L148) | 无需新增，tick 直接复用 |

> 结论：**执行能力（双循环、Task 频率、增删改命令）几乎都已存在**，本方案主要做三件事：① 摆正 Thread/Task 职责（频率下沉）；② 给 Thread 治理循环加事件触发；③ 让 Planner 产真实种子 Task。

---

## Proposed Changes

### 改动 1 · Thread 数据模型：loopInterval 语义改为「治理节拍」+ 新增终止条件

**文件**：[topic.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/topic.ts#L27-L45)

- 保留 `loopInterval` 字段名（避免大范围改 scheduler/repository），但**重新定义其语义为「Thread 治理 review 节拍」**，在类型注释中明确「这不是执行频率；执行频率由各 Task 的 triggerRule 决定」。取值仍用现有 `ThreadLoopInterval`：
  - monitoring 板块默认 `weekly`（低频兜底 review）；
  - achievement 板块默认 `one_shot`（创建后做一次治理，之后只靠事件触发）；
  - 高敏感板块（如风险预警）可 `daily`。
- 新增可选字段 `terminationCondition?: string`：板块「做到什么算完」。monitoring 留空（永不自然终止），achievement 填完成条件，供治理 tick 判断是否 archive 本 Thread。

### 改动 2 · 扩展 tick 动作契约：支持 Task 增/改/删

**文件 A**：[topic.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/topic.ts#L97-L113) `ThreadTickAction`
- 在现有 `dispatch_task`（=create）/`post_message`/`silent` 基础上新增：
  - `update_task`：`{ kind:"update_task", threadId, taskId, patch: Partial<TaskDraft> }`（patch 可含 cadence/triggerCondition/objective 等，**含调频**）
  - `cancel_task`：`{ kind:"cancel_task", threadId, taskId, reason }`
- `dispatch_task` 的 `taskDraft` 允许携带 `cadence`/`triggerCondition`（已在 [TaskDraft schema](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftSchema.ts#L3-L20)），不再被强制成 one_shot。

**文件 B**：[dispatchActions.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/dispatchActions.ts)
- 去掉 `DispatchTaskRequest.taskType: "one_shot"` 硬字段（[L32-34](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/dispatchActions.ts#L32-L34)），改由 taskDraft 推断（见改动 5）。
- 新增 `UpdateTaskCallback` / `CancelTaskCallback` 两个回调契约，在 `dispatchThreadActions` 中按「先 create → 再 update → 再 cancel → 再 post_message」顺序执行，沿用现有 errors[] 容错收集模式。

**文件 C**：解析层 `parseThreadTickOutput`（在 `src/lib/server/thread/` 下，与 `threadRunner` 同目录）
- 扩展校验：接受 `update_task`/`cancel_task`，校验 `taskId` 非空、`threadId` 与当前 thread 一致（沿用第 7 条跨 thread 护栏）。

### 改动 3 · 去掉 one_shot 强制，派发 Task 按 draft 自带频率

**文件**：[dispatchTaskFromThread.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/dispatchTaskFromThread.ts)
- 删除 `taskType !== "one_shot"` 断言（[L77-81](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/dispatchTaskFromThread.ts#L77-L81)）。
- `buildTaskCommandInput`（[L42-55](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/dispatchTaskFromThread.ts#L42-L55)）改为按 draft 推断：
  - 有 `cadence` 或 `triggerCondition` → `taskType="repeat"`，`triggerRule = cadence || "满足条件：" + triggerCondition`；
  - 否则 → `taskType="one_shot"`，`triggerRule = triggerCondition || "立即触发"`。
  - 复用 [normalizeConcreteTriggerRule](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskTriggerTime.ts#L150-L162) 归一化，保证 `isTaskTriggerDue` 能解析。
- 新增 `updateTaskFromThread` / `cancelTaskFromThread` 两个薄服务，分别映射到 `applyTopicCommand({type:"update_task"|"delete_task"})`（底层已支持）。

### 改动 4 · Thread 治理循环：调度依据从「执行频率」改为「事件 + 低频 review」

**文件 A**：[threadLoopScheduler.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadLoopScheduler.ts) `isThreadDue`
- 语义注释更新为「治理 due 判定」。逻辑基本保留（nextTickAt ≤ now 即 due），但增加优先级：
  - **事件触发**：`nextTickAt` 被事件桥置为 now/过去 → 立即 due（reason 增加 `"event_triggered"`）。
  - **低频 review**：无事件时按 `loopInterval`（=reviewInterval）到期 due（沿用现有 interval 逻辑）。
  - `one_shot` 治理：仅首次 due（创建后做一次治理），之后只靠事件触发（与现有 one_shot 分支 [L55-58](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadLoopScheduler.ts#L55-L58) 一致，无需改）。

**文件 B**：事件桥（新增最小逻辑）— 在 Task 执行完成的落点写一处
- 位置：Task 实例完成的统一落点（`startTaskAttempt` 完成回写 / 或 `taskDispatchWorker` 完成处）。在 Task 状态置为 `completed`/`failed` 后，定位其所属 `subGoalId`(=threadId)，调 `threadsRepository.updateThread` 把该 thread 的 `nextTickAt` 置为 `now`（携 baseRevision 乐观锁）。
- 这样下一帧 `threadLoopDaemon` 的 `selectDueThreads` 自然选中该 thread 触发治理 tick。**不新建事件总线、不改 daemon 主循环结构。**
- 幂等：若 thread 已 due（nextTickAt 已 ≤ now），跳过写入，避免重复。

### 改动 5 · tick 决策原则写进 ThreadRunner prompt（增/改/删的判断逻辑）

**文件**：[threadRunnerPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadRunnerPrompt.ts)
- 角色说明从「决策下一步动作」改为「**治理本板块的 Task 集合**」，明确「你不执行 Task，只决定该有哪些 Task 以及它们的配置」。
- 注入新上下文：**本 Thread 当前的 Task 列表**（id/title/taskType/triggerRule/最近结果），让模型能对照 intent 做差异判断。
- 写入「Task 治理规则」（问题 3 的判断原则）：
  1. **新增（create/dispatch_task）**：intent 覆盖、但现有 Task 未覆盖的新关注点 → 新建 Task，并**为它指定合适的 taskType+频率**（持续关注→repeat+节拍；一次性→one_shot；事件型→repeat+较密节拍并在 objective 写明判断条件）。
  2. **修改（update_task）**：关注对象仍在但目标/频率/触发条件需变化（如盯盘频率从每天改每周）→ update，patch 仅含变化字段。
  3. **删除（cancel_task）**：关注点消失或已永久完成 → cancel。
  4. **不动（post_message/silent）**：无结构性变化，仅例行小结或无事可做。
- 护栏：只能动 `threadId` 绑定的本板块 Task；payload ≤ 8KB；post_message ≤ 500 字（沿用现有约束）。

### 改动 6 · Planner 产真实种子 Task（含各自频率），废弃 fallback 占位

**文件 A**：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L448-L530) `buildDecomposePrompt`
- 人设改为中立「规划编排器」：先按**维度/阶段/板块**（MECE，≤5）拆 Thread；为每个 Thread 给 `intent`、`reviewInterval`、`terminationCondition?`。
- 为每个 Thread 产出 **0~N 个种子 Task**，每个种子 Task 自带 `taskType`(repeat/one_shot) + `cadence`/`triggerCondition`。**明确允许种子不全**（尤其 monitoring 板块），其余靠 tick 治理补全。
- 输出 schema 的 subGoal 项新增 `reviewInterval`、`terminationCondition`、`tasks[]`（含频率字段）。同步更新 [buildDecompositionNormalizationPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L532-L588) 的 schema。

**文件 B**：[sagaDraftAdapter.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/sagaDraftAdapter.ts#L93-L154)
- `normalizeSubGoals`：透传 `reviewInterval`(→ 后续写入 Thread.loopInterval)、`terminationCondition`；读取 Planner 给的 `tasks[]`（含 taskType/triggerRule）。
- **删除 `fallbackTaskForSubGoal` 兜底**（[L93-111](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/sagaDraftAdapter.ts#L93-L111)）；当 Planner 没给某板块 Task 时，允许该 Thread 的 `tasks=[]`（治理循环首次 tick 会补）。

### 改动 7 · 频率/节拍透传通路（draft → Goal → Thread）

| 文件 | 改动 |
|---|---|
| [kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L530-L573) | `GoalBreakdownDraft.subGoals[]` 加 `reviewInterval?`、`terminationCondition?`；`SubGoal`（[L397-409](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L397-L409)）加同名可选字段 |
| [goalFactory.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalFactory.ts#L161-L171) | `buildGoalFromDraft` 透传 `reviewInterval`/`terminationCondition` 到 SubGoal；Task 已透传 taskType/triggerRule，无需改 |
| [legacyGoalToTopic.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/migration/legacyGoalToTopic.ts#L30-L32) | 调 `legacySubGoalToThread` 时传 `loopInterval: sub.reviewInterval`、`terminationCondition: sub.terminationCondition` |
| [legacySubGoalToThread.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/migration/legacySubGoalToThread.ts#L34) | 接收并写入 `loopInterval`(=review 节拍)、`terminationCondition`；默认仍 `?? "weekly"`（monitoring 兜底） |

### 改动 8 · 确保 saga Topic 进入 Task 执行循环

**文件**：[goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts#L52-L58) 的 gate 条件 / 或 saga 落库时的 workflow 初值
- 确认 saga `adaptTopicInitSagaToGoalDraft` → `commitGoalDraftToStores` 后，Goal 的 `workflow.phase` 进入 `executing`/`monitoring` 且 `planDecision=confirmed`，使其 Task 被循环 1 调度。
- 若当前 saga 落库后停在 `presenting_plan`（[commitGoalDraftToStores](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalWorkflow.ts#L188-L235)），需在用户确认计划后推进到执行态（沿用既有 confirm 流程，不新建）。此点在实施时按实际 workflow 状态机微调。

---

## Assumptions & Decisions

- **D1**：Thread **不持有执行频率**；频率属于 Task。Thread 的 `loopInterval` 重定义为「治理 review 节拍」。
- **D2（用户选定）**：Thread 治理触发 = **事件为主（本板块 Task 完成）+ 低频 review 兜底**。事件桥用「置 thread.nextTickAt=now + 复用 selectDueThreads」实现，不引入事件总线。
- **D3**：种子 Task 由 Planner 真实产出（含各自 taskType+频率），可不全；废弃 fallback 占位。
- **D4**：tick 可对本板块 Task 做 create/update（含调频）/cancel；只能动本 threadId 绑定的 Task。
- **D5**：事件触发型需求（如「股价大跌提醒」）**降级为周期巡检**——建一个较密节拍的 repeat Task，在执行时评估条件，不新建事件源/cron 解析器。
- **D6**：复用既有 Task 执行循环（`goalSchedulerEngine`+`isTaskTriggerDue`）与底层 `create/update/delete_task` 命令，不另起调度器。
- **D7**：新增字段（reviewInterval/terminationCondition、新动作）均向后兼容；`/goal` 旧链路缺省时按 `one_shot` 板块 + 现有行为回落。

---

## Verification

1. **类型与编译**：`pnpm tsc --noEmit`，确认 ThreadTickAction 扩展、新字段无类型错误。
2. **单测** `pnpm test:planning`，重点：
   - `dispatchTaskFromThread`：repeat draft 正确映射为 repeat + triggerRule（不再被强制 one_shot）。
   - `parseThreadTickOutput`：接受并校验 update_task/cancel_task。
   - `sagaDraftAdapter`：透传 reviewInterval/terminationCondition/种子 tasks；无 fallback 占位。
   - `legacyGoalToTopic`/`legacySubGoalToThread`：reviewInterval 正确写入 Thread.loopInterval。
   - `isThreadDue`：事件触发（nextTickAt=now）与低频 review 两条路径。
3. **双循环隔离单测**：构造一个 Topic（含 repeat/one_shot 混合 Task），验证：
   - 循环 1 按各 Task 频率到期生成 instance；
   - Task 完成后事件桥置 thread.nextTickAt，循环 2 下一帧 due 并执行治理。
4. **真实 Saga Smoke**：
   - 「我在做美股投资，帮我关注下」→ 产出多板块 Thread + 各自含不同频率的种子 Task；观察循环 1 按频率产出、循环 2 在 Task 完成后治理（增/改/删）。
   - 「准备托福 110 分」→ achievement 板块、one_shot review、阶段性 Task，验证未被错误长期化。
5. **运行时验收**：DevPanel/daemon 观察 `goalSchedulerEngine` 按 Task 频率派发 + `threadLoopDaemon` 仅在事件/review 时治理，两循环节奏独立、互不绑定。

---

## 不做的事（避免过度设计）

- 不新建事件总线 / 事件源监听 / cron 解析器（事件触发用 nextTickAt 复用 + 条件型降级为周期巡检，D2/D5）。
- 不另起 Task 调度器（复用 `goalSchedulerEngine`，D6）。
- 不新增持久化表（沿用 goals/topics envelope）。
- 不在本轮重写 Critic⇄Refiner 闭环（与本次执行机制正交，单列后续）。
