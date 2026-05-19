# 方案 A · Sprint 4 实施规划：前端切命令式 API + Bridge 替换 + Sync 写路径下线

> 对应方案 A v2 中尚未交付的最后三件事：
> 1. 前端动作（暂停 / 恢复 / 取消 / 用户回答）全量切到命令式 API（`/transition`、`/respond`、`/cancel`）
> 2. `RuntimeStateBridge` 完全替换为 `RuntimeEventBridge`（事件流驱动 + 服务端 snapshot 只读拉取）
> 3. 旧 `/api/runtime/state/sync` 写路径下线（先收窄、再删除）
>
> 这三件事强耦合：只切 1 不动 2，浏览器 store 变化仍会被 Bridge 反向写回 sync 路径，命令式 API 写入的状态会被覆盖；只动 2 不切 3，sync 写路径仍是潜在的回归点。因此打包成 Sprint 4 完整执行。

---

## 1. 摘要（Summary）

- **目标**：让所有"用户对任务的命令"以事件形式入账（`goal_event_log`），让浏览器只读不写 snapshot，彻底关掉"前端 Zustand → snapshot → 服务端"的反向写路径。
- **范围**：前端动作调用链路（`taskExecution.ts` / `AwaitingUserResumePanel`）、`RuntimeStateBridge`、`/api/runtime/state/sync`、`runtime-daemon.ts` API helper、`app-providers.tsx`。
- **不在范围**：daemon 调度器主循环、`goal_event_log` schema、命令式 API 自身实现、事件回放 UI（这些已在 Sprint 1–3 完成或有独立计划）。
- **完成定义**：
  1. 浏览器没有任何路径调用 `syncRuntimeStateSnapshot`；
  2. `cancelTaskRun` / `resumeTaskRun` / 浏览器 watchdog 的状态写入都改走命令式 API；
  3. `/api/runtime/state/sync` 路由文件被删除；
  4. 关闭浏览器一段时间后再打开，UI 通过"快照拉取 + 事件流追赶"完整恢复。

---

## 2. 现状分析（Current State Analysis）

### 2.1 关键文件与行为

- [RuntimeStateBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L162-L339)：当前同时承担三件事——
  - 启动时拉取 snapshot 灌注 `goalStore` / `runtimeEnvStore` / `scheduleStore`（[L179-L241](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L179-L241)）
  - 拉取 `goal_event_log` 历史 + 订阅 SSE，把 `notification.delivered` 事件落到 inbox / 会话（[L243-L291](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L243-L291)）
  - 监听本地 store 变化，反向 `syncRuntimeStateSnapshot`（[L293-L336](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L293-L336)）
- [taskExecution.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts)：暂停 → `cancelTaskRun` + `goalStore.stopTaskInstanceRun`（[L21-L25](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts#L21-L25)）；执行启动失败 → `markInstanceStatus(...,"error")`（[L113](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts#L113)）。
- [taskRuns.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/taskRuns.ts)：`cancelTaskRun` 走 `/api/goals/tasks/cancel`、`resumeTaskRun` 走 `/api/goals/tasks/resume`（旧路由，仍有效但与命令式 API 重复）。
- [AwaitingUserResumePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx#L275-L320)：用户提交 awaiting_user 反馈走 `resumeTaskRun`，未触发命令式 `/respond`，事件流缺 `instance.user_response`。
- [GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx#L296-L336)：浏览器 watchdog 检测 `in_progress` 超时直接 `markInstanceStatus("paused")`，未走事件路径；浏览器调度路径 catch 分支也直接写 `markInstanceStatus("error")`（[L443](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx#L443)）。
- [/api/runtime/state/sync/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/runtime/state/sync/route.ts)：唯一仍在被前端写入的 snapshot 入口；GET 端 [/api/runtime/state/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/runtime/state/route.ts) 只读，可保留。

### 2.2 命令式 API 已就绪

- [transition](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/instances/[instanceId]/transition/route.ts)：写 `instance.status_changed` + `instance.user_command`，再 `markGoalInstanceStatusSnapshot` → 落 snapshot。
- [respond](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/instances/[instanceId]/respond/route.ts)：写 `instance.user_response`，把 awaiting `runtime_jobs` 重排回 `queued`。
- [cancel](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/instances/[instanceId]/cancel/route.ts)：写状态事件 + `cancelRuntimeJobByTaskRun` + `instance.user_command`。

### 2.3 真正需要"切流"的调用点（盘点）

| # | 调用点 | 当前行为 | 目标行为 |
|---|---|---|---|
| A1 | `taskExecution.ts` pause 分支 | `cancelTaskRun` + `goalStore.stopTaskInstanceRun` | `POST /transition`（status=paused）；删除 `stopTaskInstanceRun` 直写 |
| A2 | `taskExecution.ts` start 失败 catch | `markInstanceStatus(error)` | `POST /transition`（status=error，reason=启动失败信息） |
| A3 | `AwaitingUserResumePanel` 用户提交 | `resumeTaskRun` | `POST /respond`（含 responseSummary、approved、fields），并依赖 daemon 重排 job |
| A4 | `GoalSchedulerRuntime` watchdog 超时 | `markInstanceStatus(paused)` | `POST /transition`（status=paused，reason=超时） |
| A5 | `GoalSchedulerRuntime` 浏览器调度 catch（默认关闭） | `markInstanceStatus(error)` | `POST /transition`（status=error） |
| A6 | 旧路由 `/api/goals/tasks/cancel`、`/api/goals/tasks/resume` | 仍被 `cancelTaskRun` / `resumeTaskRun` 调用 | 保留路由本身（daemon side 也可能用），但前端不再调用 |
| B1 | `RuntimeStateBridge` snapshot 灌注 | 拉 GET → 灌 store | 保留（只读） |
| B2 | `RuntimeStateBridge` 5s 轮询 GET snapshot | 仍然有效兜底 | 保留（只读，频率可调） |
| B3 | `RuntimeStateBridge` 事件流消费 | 已实现 | 保留 |
| B4 | `RuntimeStateBridge` 反向 sync | 监听 store 变化 → POST sync | **删除** |
| C1 | `/api/runtime/state/sync` POST | 接受 goals/runtimeEnvironments/scheduleEvents 全量覆盖 | 阶段性收窄 → 最终删除 |

### 2.4 风险点

- 浏览器 `goalStore` 仍有大量 mutator（`startTaskInstanceRun`、`stopTaskInstanceRun`、`syncTaskInstanceRun`、`updateGoalWorkflow` 等）会被 React 调用——这些"乐观更新"过去依赖 sync 路径回灌。切流后，需要确认浏览器对这些本地 mutate 的依赖：
  - 若是"等命令式 API + 事件流回灌再渲染"，则 mutator 调用需删除或改为只读（不影响 store）。
  - 若是"先乐观、再被服务端 snapshot/事件覆盖"，则保留 mutator，但**不能**反向写 sync。
- `AwaitingUserResumePanel` 的 resumeTaskRun 同步返回 progress/logs/trajectory，被用来即时刷新 UI。命令式 `/respond` 当前不返回这些。需要保证 daemon 的事件流 + telemetry 能在 1–2s 内追上 UI（已有 SSE）。
- 浏览器调度器虽然默认关闭，但环境变量打开时仍会跑；切流必须覆盖该路径，避免被开发模式打开后破坏一致性。

### 2.5 ⚠️ 关键阻塞：纯本地的"上行写"路径

这是 v1 计划遗漏、复审时发现的硬卡点。下列三类数据**只在浏览器 zustand 创建**，过去都是靠 sync 反向写到服务端 SQLite 的；如果直接下线 sync 而没有替代写入路径，daemon 将永远看不到它们：

| 数据 | 入口 | 当前写路径 | sync 下线后 |
|---|---|---|---|
| Goal（含 subGoals/tasks） | `createGoalFromInput`（[goals/new/page.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/goals/new/page.tsx#L50)）+ `createGoalFromDraft`（[goalWorkflow.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalWorkflow.ts#L189)） | zustand → `RuntimeStateBridge` → sync POST | **断链**：服务端 `runtime_state_snapshots.goals` 不再更新，daemon scheduler 看到的 goals 永远是首次拉取或 mocks |
| RuntimeEnvironment | `addEnvironment` / `setActiveEnvironment` / `setPermissionMode` / `updateEnvironment`（[RuntimeEnvironmentPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/RuntimeEnvironmentPanel.tsx)） | zustand → sync POST | **断链**：daemon `readRuntimeEnvironmentsSnapshot` 拿不到新增/激活的本地环境 |
| AgentEvent（日程） | `addEvent`（[SchedulePage.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/schedule/SchedulePage.tsx#L64)） | zustand → sync POST | **断链**：日程视图同步丢失（daemon 也通过 `schedule.event_synthesized` 事件派生，但用户手动添加的日程不在事件流里） |

> 补充：浏览器侧 `useGoalStore` 启用了 zustand `persist`（[goalStore.ts:582](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts#L582)），意味着即使没有 sync，本地仍能持久化 goals。但这只是浏览器的局部一致性，跨设备/daemon 完全失效。

**结论**：**第 3 项（sync 下线）必须在替代写路径就绪后才能做**。本 Sprint 范围因此被一分为二：
- **Sprint 4-A（本 Sprint 必做）**：第 1 项（前端动作切命令式 API）+ 第 2 项（Bridge 反向写删除）。**第 3 项只做"收窄"**：禁止 `goals` 字段经 sync 写入（强制走命令式 API），允许 `runtimeEnvironments` / `scheduleEvents` 继续走 sync 作为过渡。
- **Sprint 4-B（独立任务、本规划列出但不执行）**：补齐 goal 创建/更新、runtimeEnv 增删改、scheduleEvent 增加的命令式 API，再彻底删除 sync 路由。

---

## 3. 决策与假设（Assumptions & Decisions）

1. **乐观更新策略（修订）**：保留前端"按下按钮立刻置灰/置 paused"的本地 mutator 行为，但**不再反向写 sync**。本 Sprint 采用**保守方案**：先 `await` 命令式 API 成功，再触发本地 mutator；按钮在等待 API 返回时显示 pending。事件流回灌时若与本地不同则以服务端为准（`RuntimeStateBridge` 在事件消费阶段已处理冲突）。
2. **goalStore 持久化的处理**：保留 zustand `persist`，但 Bridge 启动时仍然先 GET snapshot 灌注（服务端为准）。本地持久化只是离线兜底，不与服务端竞争权威。
3. **`syncTaskInstanceRun` 保持不变**：被 `ConversationView` / `TaskDetailBody` / `ExecutionResultBody` / `AwaitingUserResumePanel` 用于轮询 `/api/goals/tasks/progress` 的回灌，**只写本地 store，不触发 sync**。本 Sprint 不动这条链路；后续切到 SSE telemetry 是独立工作。
4. **旧 `/api/goals/tasks/cancel|resume` 路由**：本 Sprint 不删除，仅停止前端调用；后续若 daemon 内部不再依赖再单独清理。`taskRuns.ts` 中保留 `cancelTaskRun` / `resumeTaskRun` 函数体但加上 `@deprecated` 注释；前端不再调用，但函数本身保留以避免影响其它静态引用。
5. **Idempotency-Key 约定**：前端命令式 API 调用统一带 `Idempotency-Key`：
   - transition：`instance.status_changed:${instanceId}:${prevStatus}->${nextStatus}:${actionId}`
   - respond：`instance.user_response:${instanceId}:${resumeToken || responseId}`（resumeToken 是 daemon 派发 awaiting_user 时签发的稳定 token，天然适合做去重键）
   - cancel：`instance.status_changed:cancel:${instanceId}:${actionId}`
   `actionId` 由前端按钮单次点击维度生成（`makeId('action')`），避免重试时重复入账。
6. **Sync 写路径下线分两阶段**（修订）：
   - **Step 1（本 Sprint）**：sync POST 入参中**只拒绝 `goals` 字段**——若 body 含 `goals`，返回 410；`runtimeEnvironments` / `scheduleEvents` 继续接受。这样命令式 API 已覆盖的链路（task 状态变化）彻底切流，而尚未覆盖的写路径（创建 goal、增改 runtimeEnv、加日程）保持暂时可用。
   - **Step 2（Sprint 4-B，本 Sprint 不做）**：补齐其余写路径的命令式 API 后彻底删除 sync 路由 + 删除 `syncRuntimeStateSnapshot` helper + 删除 `upsertRuntimeEnvironmentsSnapshot` / `upsertScheduleEventsSnapshot`。`upsertGoalsSnapshot` 一直保留（命令式 API、scheduler、worker 内部使用）。
7. **`RuntimeStateBridge` → `RuntimeEventBridge`**：原文件改名为 `RuntimeEventBridge.tsx`，导出名同步改为 `RuntimeEventBridge`，`app-providers.tsx` 引用更新。git rename 通过两步（先 cp 再 rm）也可保留历史，但简化方案直接 mv（git 的 rename detection 会自动识别）。
8. **轮询频率**：snapshot GET 兜底轮询从 5s 调整为 30s（事件流是主路径，GET 仅在 SSE 断线时托底）。
9. **`AwaitingUserResumePanel` UI 兼容**：`/respond` 调用后立刻把本地 instance.awaitingUser 置 false 并设 status=`in_progress`（乐观），由事件流 + 轮询 telemetry 后续覆盖；UI 不再依赖 resumeTaskRun 同步回包的 progress/logs。
10. **浏览器 watchdog 与 daemon watchdog 共存**：本 Sprint 仍保留浏览器 `runExecutionWatchdogs`，仅把状态写从 `markInstanceStatus` 改为命令式 `transitionGoalInstance`。daemon watchdog 已并行存在，靠 Idempotency-Key 去重。后续"默认开关切 daemon"时再删除浏览器 watchdog（独立任务）。

---

## 4. 提议变更（Proposed Changes）

### 4.1 新增前端命令式 API helper

- **文件**：[/Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/goal-commands.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/goal-commands.ts)（新建）
- **导出**：
  ```ts
  export class GoalCommandError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  }
  export async function transitionGoalInstance(input: { instanceId: string; status: TaskInstanceStatus; reason?: string; idempotencyKey?: string }): Promise<{ ok: true; event: GoalEventRecord }>;
  export async function respondGoalInstance(input: { instanceId: string; responseId?: string; responseSummary?: string; approved?: boolean; fields?: Record<string,string>; idempotencyKey?: string }): Promise<{ ok: true; resumed: boolean; event: GoalEventRecord }>;
  export async function cancelGoalInstance(input: { instanceId: string; reason?: string; idempotencyKey?: string }): Promise<{ ok: true; event: GoalEventRecord }>;
  ```
- **错误处理约定**：
  - 非 2xx 响应统一抛 `GoalCommandError(status, reason)`，调用方按 §4.2 A2 的策略区分 4xx / 5xx / 网络错误。
  - 409（Idempotency-Key 冲突）由调用方决定是否吞掉——通常意味着同样的命令已写入，可视为成功并刷新本地状态。
- **为什么**：集中维护命令式 API URL 与 Idempotency-Key 生成逻辑，避免每个调用点重复样板。
- **注意**：本仓不存在 `cancelGoalInstance` 这一独立的"取消"语义场景的命令式调用点（A1 用 cancel 取消、A2 用 cancel 兜底失败），因此 `cancelGoalInstance` 实际复用 `/cancel` 路由；含 reason 时透传给 `instance.user_command.payload.reason`。

### 4.2 改造 `taskExecution.ts`

- 文件：[taskExecution.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts)
- 改动：
  - **A1 pause 分支（L15-L27）**：去掉 `cancelTaskRun` + `goalStore.stopTaskInstanceRun`，改为 `await cancelGoalInstance({ instanceId, reason: "用户暂停" })`；保留 store 乐观更新（`stopTaskInstanceRun` 仍可调用，因为它只改本地 instance.status，不再触发 sync）。
  - **A2 catch 分支（L112-L115）**：语义辨析——这是"前端调用 execute API 抛错"路径，**execute API 抛错意味着服务端没有接管该 instance**（lease/job 没建立或建立后立即失败已写事件）。因此前端不应再 transition→error 双写；改为：
    - 若错误是 HTTP 4xx（参数/依赖问题）：`await cancelGoalInstance({ instanceId, reason: errorMessage })`，语义 = 用户启动失败、回到取消队列。
    - 若错误是网络/5xx：仅本地 `markInstanceStatus("error")`，不写服务端（避免与 daemon 已写状态冲突）。事件流后续会回灌真实状态。
    - 通过 catch 中 `error.status` / `error instanceof TypeError`（fetch 网络层错误）判别。
  - **保留**：`startTaskRun` 流程不变（已经走 `/api/goals/tasks/execute`，daemon 内部双写事件）。

### 4.3 改造 `AwaitingUserResumePanel.tsx`

- 文件：[AwaitingUserResumePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx#L275-L320)
- 改动（A3）：
  - 替换 `resumeTaskRun(...)` 调用为 `respondGoalInstance({ instanceId, responseId: blocker.resumeToken, responseSummary: normalizedFeedback, approved, fields: feedbackFields })`。
  - 移除对 `state.progress / state.logs / state.trajectory` 的直接 `syncTaskInstanceRun` 写入；改为乐观地把本地 instance.awaitingUser 置 false，依赖事件流 + telemetry 回灌。
  - `onRunning` 回调判定改为：`respond` 返回 `resumed === true` 即视为已重新进入运行队列。

### 4.4 改造 `GoalSchedulerRuntime.tsx`

- 文件：[GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx)
- 改动：
  - **A4 watchdog 超时（L307-L319）**：`goalStore.markInstanceStatus(...,"paused")` → `transitionGoalInstance({ instanceId, status: "paused", reason: "执行超时" })`，保留 inbox reminder 写入（reminder 是浏览器 UI 兜底，daemon watchdog 已是主链路，本调用作为浏览器在线时的第二道兜底）。
  - **A5 浏览器调度 catch（L434-L445）**：`markInstanceStatus(...,"error")` → `transitionGoalInstance(...,"error")`。
  - 注意：浏览器 watchdog 默认仍开启（与调度器开关解耦），切流后这条路径会和 daemon watchdog 双写——通过 Idempotency-Key（`instance.status_changed:${instanceId}:in_progress->paused:timeout`）保证幂等。
  - daemon 切流的进一步收敛（关闭浏览器 watchdog）放到独立的"默认开关切 daemon"工作中，本 Sprint 不动。

### 4.5 重构 `RuntimeStateBridge.tsx` → `RuntimeEventBridge`

- 文件：[RuntimeStateBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx)
- 重命名导出为 `RuntimeEventBridge`，文件重命名为 `RuntimeEventBridge.tsx`。
- **修改**反向 sync `useEffect`（[L293-L336](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L293-L336)）：
  - **不再发送 `goals` 字段**：`syncRuntimeStateSnapshot` 调用入参只传 `runtimeEnvironments` 和 `scheduleEvents`，删除 goals 部分。
  - 删除 `currentGoalsKey` 作为依赖项（goals 变化不再触发反向 sync）。
  - 删除 `mergeRemoteSnapshotWithLocalGoals`、`mergeSyncRevision` 中针对 goals 的部分；catch 分支不再回灌 goals。
  - 这是 §4.8 的"过渡保护"实现——为 Sprint 4-B 之前的低频写路径（runtimeEnv / schedule）保留兜底通路。
- **保留**：
  - 启动 hydrate（GET snapshot 一次）。
  - 5s 轮询 GET snapshot（频率从 5s 调整为 30s）——遇到 SSE 中断或长时间未变化时托底。
  - `isApplyingRemoteRef` 仍需保留（避免 GET 回灌时再次触发反向 sync）。
  - 事件流消费（`fetchGoalEvents` + `createGoalEventsSource`）。
- 更新 [app-providers.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/app-providers.tsx#L7-L13) 的 import 与 JSX。
- 在文件头加注释说明：`runtimeEnvironments` / `scheduleEvents` 的反向 sync 是 Sprint 4-A → 4-B 的过渡形态，Sprint 4-B 完成后整段删除。

### 4.6 收窄 `/api/runtime/state/sync`（本 Sprint）+ 完全下线（Sprint 4-B）

- **本 Sprint Step 1**：在 [/api/runtime/state/sync/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/runtime/state/sync/route.ts) POST 函数最前面增加守卫：
  ```ts
  if (body.goals !== undefined) {
    return NextResponse.json(
      {
        ok: false,
        reason: "/api/runtime/state/sync 不再接受 goals 字段；请使用 /api/goals/instances/:id/{transition|respond|cancel} 命令式 API",
      },
      { status: 410 },
    );
  }
  ```
  保留 `runtimeEnvironments` / `scheduleEvents` 通路。
- **本 Sprint** 同步从 [RuntimeStateBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeStateBridge.tsx#L293-L336) 删除 goals 字段的反向写——但 4.5 已经把整段 sync useEffect 删掉，实际效果是**本 Sprint 后浏览器再也不写 sync**（runtimeEnv / schedule 的创建路径在 Sprint 4-B 之前没有 sync 写入，会成为暂时性"写不进去"的状态——见 §4.8）。
- **Sprint 4-B（不在本 Sprint）**：删除 route.ts、删除 `syncRuntimeStateSnapshot` helper、删除 `upsertRuntimeEnvironmentsSnapshot` / `upsertScheduleEventsSnapshot`。

### 4.7 `goalStore` mutator 的处理

- **不删除** `markInstanceStatus`、`stopTaskInstanceRun` 等 mutator——它们仍为命令式 API 调用前/后的本地刷新提供能力。
- 调用方（4.2 / 4.3 / 4.4）改为：先 `await` 命令式 API，成功后再触发本地 mutator；UI 在等待 API 返回时显示 pending 灰态。错误时不写本地（保留原状态）。
- 仍然被允许的本地写：`syncTaskInstanceRun`（轮询 progress 回灌）、`startTaskInstanceRun`（execute API 成功后立刻置 in_progress）、`failTaskInstanceRun`（execute 抛错时本地兜底）、`generateInstance` / `generateRerunInstance`（创建本地 instance；服务端在 execute API 内通过 `instance.created` 事件 + snapshot 写入也覆盖）。

### 4.8 ⚠️ 已知遗留：runtimeEnv / scheduleEvent / 新建 Goal 写入路径

§4.5 保留了**仅 runtimeEnv / scheduleEvent** 的反向 sync useEffect，这两类低频用户操作仍能写入服务端 SQLite。

**新建 Goal 的特殊处理**（这是真正的回归点）：
- 复核确认：[/api/goals/plan/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/plan/route.ts) 只生成 plan 文本返回前端，**不写 snapshot**；plan 确认后 goal 创建仍发生在浏览器（`createGoalFromDraft`）。
- [/api/goals/tasks/execute/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/execute/route.ts#L100) 接受 `body.goal` 并 `upsertGoalsSnapshot`，所以**用户至少手动 execute 一次**后 daemon 才能看到该 goal。
- **回归**：本 Sprint 完成后，用户创建 goal → 确认 plan → 不点 execute（依赖 daemon scheduler 自动派发）的链路会"卡住"——daemon 永不感知新 goal。
- **本 Sprint 的最小缓解**：在 [GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx) 中新增一个 `useEffect`：当 goals 中存在 `workflow.planDecision === "confirmed"` 但 `runtime_state_snapshots` 中没有该 goal 时（通过比较 GET snapshot 与本地 store），调用一次"goal 物化" API。
  - **方案 A（推荐，简单）**：在本 Sprint 新增最小 `POST /api/goals/materialize` 接口，body 接受单个 goal 整体，内部调用 `upsertGoalsSnapshot(mergeGoalIntoSnapshot(...))`。仅供 Bridge 在检测到新 goal 时调用一次。
  - **方案 B（更保守）**：保留 Bridge 反向 sync useEffect 同时也允许 `goals` 字段，§4.6 改为**只统计/告警 goals 字段写入**而非拒绝（监控用，便于 Sprint 4-B 判断何时下线）。
  - **本规划采用方案 A**，因为它给"goal 进入服务端"提供了一条独立、可观测的路径，避免 sync 路径继续承担"权威写"角色。

**Sprint 4-B 完整工作清单（本规划列出但不执行）**：
1. `POST /api/goals` 创建目标 + 写 `goal.created` 事件（新增 kind）；让 plan 路径直接落库，移除 4.8 的 materialize 临时 API。
2. `PATCH /api/goals/:id/workflow` 更新 workflow（替代部分 `updateGoalWorkflow` 直写）。
3. `POST /api/runtime/environments` / `PATCH /api/runtime/environments/:id` / `DELETE /api/runtime/environments/:id` / `POST /api/runtime/environments/:id/activate`。
4. `POST /api/schedule/events` / `DELETE /api/schedule/events/:id`。
5. 删除 sync route + helper + Bridge 内残留 sync useEffect。

---

## 5. 执行步骤（Step-by-step）

1. **Phase A（API 切换，独立可测）**
   1. 新建 `src/lib/api/goal-commands.ts`。
   2. 修改 `taskExecution.ts` pause / catch 分支。
   3. 修改 `AwaitingUserResumePanel.tsx`。
   4. 修改 `GoalSchedulerRuntime.tsx` watchdog / catch 分支。
   5. 跑 lint + tsc，本地验证：暂停、取消、awaiting_user 回答三条链路均产生事件流。
2. **Phase B（Bridge 重构）**
   1. 备份当前 `RuntimeStateBridge.tsx`（git 自动有版本）。
   2. 删除反向 sync `useEffect`、相关 helpers；调整轮询为 30s 兜底。
   3. 重命名导出为 `RuntimeEventBridge`，更新 `app-providers.tsx`。
   4. 跑 lint + tsc，确认无遗留 `syncRuntimeStateSnapshot` 引用。
3. **Phase C（Sync 路由收窄/下线）**
   1. 收窄 sync POST 为 410（Step 1）。
   2. 全仓 `Grep "syncRuntimeStateSnapshot"`、`"/api/runtime/state/sync"` 应为 0 命中。
   3. 删除 route 与 helper（Step 2，前提：grep 复核 `upsert*Snapshot` 仅 sync 在用 / 否则保留）。
4. **Phase D（验证）**
   1. `pnpm tsc --noEmit`、`pnpm lint`。
   2. 启动 daemon + 浏览器，跑端到端：
      - 暂停 → 事件 `instance.status_changed`（producer=user）+ `instance.user_command`，UI 立刻置 paused。
      - 恢复（透过 `transition` 或重新执行）→ 事件流接续。
      - awaiting_user 回答 → 事件 `instance.user_response`，daemon 重排 runtime_job，UI 在 SSE 1–2s 内更新进度。
      - 关浏览器 30s，重开 → 通过 GET snapshot + 历史事件 + SSE 完整恢复。
   3. `pnpm run reconcile:goal-events` 输出无差异。

---

## 6. 验证清单（Verification）

- [ ] 全仓 `Grep "syncRuntimeStateSnapshot"` 命中数 = 0（Step 2 之后）。
- [ ] 全仓 `Grep "/api/runtime/state/sync"` 命中数 = 0（Step 2 之后）。
- [ ] `taskExecution.ts` 不再 import `cancelTaskRun`（仅 startTaskRun + waitForTaskRunCompletion 保留）。
- [ ] `AwaitingUserResumePanel.tsx` 不再 import `resumeTaskRun`。
- [ ] `RuntimeStateBridge` 导出已重命名为 `RuntimeEventBridge`，且 `app-providers.tsx` 同步更新。
- [ ] 暂停 / 恢复 / 取消 / 用户回答四条链路都能在 `goal_event_log` 找到对应事件（producer=user）。
- [ ] `pnpm tsc --noEmit`、`pnpm lint` 通过。
- [ ] reconcile 脚本通过。

---

## 7. 回滚方案

- Phase A：每个文件改动都可独立 revert；命令式 API 与旧路由并存期间，回滚仅需 git revert helper 调用点。
- Phase B：保留 `RuntimeStateBridge.tsx` 文件名时，revert 文件即可恢复反向 sync。
- Phase C Step 1（410）：把 route.ts 改回原实现即可。
- Phase C Step 2：从 git 历史恢复 route.ts 与 helper；事件流已写入的事件不需要清理（事件日志是 append-only，不会与旧 sync 冲突）。

---

## 8. 不在本 Sprint 范围（明确遗留）

- 默认开关切到 daemon（关闭浏览器 watchdog / 通知投递）：独立任务。
- 事件回放 UI（任务详情页"按时间回放"）：独立任务。
- 旧 `/api/goals/tasks/cancel`、`/api/goals/tasks/resume` 路由清理：等命令式 API 稳定 1 个版本后再做。
- `runtime_state_snapshots.conversations` 字段是否消费/删除：v2 §0.0 偏差 ④ 的独立工作。

---

## 9. 二次审查发现（v2 → v3 待补齐）

复审 v2 规划时发现以下 9 处问题，按重要性排序，本节同时给出修订对策。已经具体修订到正文的标 ✅，仅在此处记录待执行的标 ⏳。

### 9.1 ✅ A2 catch 分支不应直接 `transition→error`
v2 §4.2 A2 让前端在 `startTaskRun` 的 catch 分支里发 `transition({status:"error"})`。但 execute API 抛错有两种语义：(a) 4xx 入参错（lease 没建立）；(b) 5xx/网络（可能服务端已建 lease 又挂了）。情形 (b) 下，daemon 还会继续推进并写自己的事件，前端再写 `error` 会与服务端冲突，违背"服务端为权威"。**已在 §4.2 修订为按错误码分流处理**。

### 9.2 ⏳ A4 watchdog 切流后浏览器与 daemon 双写 paused 的真实幂等性
v2 §4.4 声称 Idempotency-Key `instance.status_changed:${id}:in_progress->paused:timeout` 能去重浏览器与 daemon 双写，但实际 daemon watchdog 当前的 idempotency key 实现并未约定使用同样的 ":timeout" 后缀（需复核 [GoalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/goalSchedulerEngine.ts) 中 watchdog 的 key 生成）。**修订对策**：Phase A 实施前先 grep daemon 侧 watchdog 的 key 模式，统一前端与服务端的 key 字符串；若不一致，本 Sprint 将浏览器 watchdog 改为只记 inbox reminder、不发 transition（让 daemon watchdog 独占状态写）。

### 9.3 ⏳ §4.6 收窄 sync 与 §4.5 Bridge 删除的"双重保险"自相矛盾
v2 §4.5 已经把 Bridge 的反向 sync useEffect 中 goals 字段删掉、但保留 runtimeEnv/schedule 字段；v2 §4.6 又在 sync route 加了 410 守卫（`if body.goals !== undefined`）。**两层保险本身没问题，但 §4.5 的"删除 currentGoalsKey 依赖项 / 删除 mergeRemoteSnapshotWithLocalGoals 中 goals 部分"会导致 catch 分支再也无法回灌 goals**——此时若 runtimeEnv/schedule 的 sync POST 失败回退路径里仍调用 `replaceGoals(mergedGoals)`，会把本地 goals 清空。**修订对策**：catch 分支的回退方案改为只 `replaceEnvironments` / `replaceEvents`，不动 goals。需在 §4.5 实施时直接落实。

### 9.4 ⏳ "goal 物化" useEffect 的触发条件不完备
§4.8 提出"当本地 goal 存在但服务端 snapshot 中没有时调用 materialize"。但服务端可能因为 `upsertGoalsSnapshot` 是部分更新而保存了"老版本"的 goal——此时 daemon 看到的 goal 字段陈旧（如 tasks 数组少了新加的）。**修订对策**：Bridge 的 useEffect 不只比对"是否存在"，还要比对每个 goal 的 `updatedAt`/版本字段；本地版本更新时也要 materialize。同时 materialize API 内部需要 merge（保持已有 instance/runtime 状态），不能整 goal 覆盖。

### 9.5 ⏳ Idempotency-Key 在 transition 路径的语义漏洞
[transition route](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/instances/[instanceId]/transition/route.ts#L64-L98) 当前实现：若 header 不传 Idempotency-Key，默认 key = `instance.status_changed:${id}:${prev}->${next}`，**不带 actionId**。这意味着用户连续点两次"暂停"按钮（两个独立 action）会被识别为同一事件而吞掉第二次——但用户感知上第二次点击是新动作，UI 不会有"已暂停"反馈。v2 §3 决策 5 让前端补 `:${actionId}`，但服务端的默认 key 仍可能在 helper 未正确传 header 时被使用。**修订对策**：Phase A 实施时必须保证 helper 强制传 header（不传则抛错）；或修改 transition route 让"key 缺失"也加上时间戳。

### 9.6 ⏳ `respond` 路由的 awaiting_user → in_progress 与"daemon 还没 pickup" 之间存在窗口
[respond route](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/instances/[instanceId]/respond/route.ts#L102-L109) 直接把状态写为 `in_progress`，但 runtime_job 只是被排回 queued、daemon 可能 N 秒后才真正 pickup。在这段时间里事件流没有 `instance.status_changed`，UI 看到的是 `in_progress` 但任务实际未运行。这与 v2 §3 决策 9 描述一致（乐观），但**对调度积压场景下用户体验不够好**。**修订对策**：respond route 改为写 `instance.status_changed` 到 `pending`（或新增 `awaiting_pickup` 中间态——但这要 schema 改动，超出本 Sprint）。本 Sprint 保留 `in_progress`，但在 §4.3 的 UI 文案里明确"已收到反馈，等待 KiKi 继续"。

### 9.7 ⏳ `goalStore` mutator 的副作用未被审计完整
v2 §4.7 说"保留 mutator 仍可调用因为它只改本地"。但 `markInstanceStatus` 等 mutator 可能调用其它 mutator（链式效应），间接触发 zustand subscribe，再触发 Bridge 反向 sync useEffect。**修订对策**：实施前 grep `useGoalStore.subscribe` / `subscribeWithSelector`，确认没有其它地方监听 goals 变化做远程写。本仓快速确认：仅 `RuntimeStateBridge` 通过 `useGoalStore((s)=>s.goals)` 订阅；放心。

### 9.8 ⏳ Sprint 4-A 完成后的"半身像"状态需要明确告诉用户
切流后到 Sprint 4-B 之前：用户在浏览器 A 创建 goal、在浏览器 B 打开会看不到（因为 sync 不写 goals + 没 materialize 主动调用）。**修订对策**：Phase D 验证清单增加一条端到端用例——"浏览器 A 创建 goal → 浏览器 B 在 30s 内能看到"。如果不能通过，必须先把 §4.8 方案 A 的 materialize useEffect 实施了再合入。

### 9.9 ⏳ `pnpm run reconcile:goal-events` 是否存在
§5 Phase D 提到这个命令但本仓未确认存在。**修订对策**：实施前 `cat package.json | grep reconcile`；不存在时从验证清单移除（或在本 Sprint 顺便补一个最小脚本：扫描 `goal_event_log` 中的 `instance.status_changed` 与 `runtime_state_snapshots` 中 instance.status 一致性）。

---

## 10. 修订后的执行顺序（v3 建议）

为了让 v3 的修订项落地有序：

1. **预备步**（不改代码）：
   - 复核 daemon watchdog 的 idempotency key 模式（解决 §9.2）
   - grep `useGoalStore.subscribe` 确认无其它远程写订阅（解决 §9.7）
   - 复核 `package.json` 的 reconcile 脚本是否存在（解决 §9.9）
   - 把这三项的复核结论回填到本规划 §9。
2. **Phase A**：按 v2 §5 Phase A 顺序，但 A2 按 §9.1 修订实现，helper 错误处理按 §4.1 修订实现。
3. **Phase B**：按 v2 §5 Phase B，但 catch 分支按 §9.3 修订（不动 goals）；新增 materialize useEffect（解决 §9.4 + §9.8）。
4. **Phase C**：按 v2 §5 Phase C，但保留 sync 路由的 405/410 守卫期间，监控日志中是否仍有 goals 字段写入（一周观察期）。
5. **Phase D**：按 v2 §5 Phase D，验证清单增补 §9.8 的跨浏览器用例。

