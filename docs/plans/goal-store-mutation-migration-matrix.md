# goalStore mutation 迁移矩阵

本文是 [`architecture-refactor-remaining-roadmap.md`](./architecture-refactor-remaining-roadmap.md) Phase 0 的审计产物，用于约束后续 `goalStore` 投影化改造。

## 迁移原则

- 服务端 `goalRuntimeService` 是 goal/task/instance 写入的单一编排入口。
- `goalStore` 只保留服务端 snapshot/SSE 的投影应用能力，以及过渡期 legacy command shim。
- 用户操作已迁移到命令 API；即时 UI 反馈后续迁移到 optimistic overlay。
- 运行态更新优先迁移，其次是规划确认，最后是结构编辑和 demo-only 清场。

## 矩阵

| mutation | 当前调用位置 | 调用方角色 | 是否依赖本地事实源 | 迁移目标 | Phase | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| `replaceGoals` | `RuntimeEventBridge.tsx`、goal 详情页、task 详情页 | snapshot/hydrate 回灌 | 否 | 重命名为 `applyGoalsProjection`，只允许服务端投影调用 | Phase 1 | 中 |
| `markInstanceStatus` | `RuntimeEventBridge.tsx` | SSE 事件回灌 | 否 | 重命名为 `applyInstanceStatusProjection` | Phase 1 | 中 |
| `syncTaskInstanceRun` | `RuntimeEventBridge.tsx`、`taskExecution.ts`、多个组件 selector | SSE 回灌 + 前端轮询运行态写入 | 是 | SSE 路径改 `applyInstanceProgressProjection`；前端轮询路径迁服务端事件/overlay | Phase 1-3 | 高 |
| `markTaskNotificationDelivered` | 当前主要由事件投影预留 | 通知投影 | 否 | 重命名为 `applyNotificationProjection` | Phase 1 | 中 |
| `startTaskInstanceRun` | `taskExecution.ts` | 用户启动运行态写入 | 是 | 服务端 start/rerun command，前端只发命令 | Phase 2 | 高 |
| `failTaskInstanceRun` | `taskExecution.ts` | 前端失败兜底写入 | 是 | 服务端失败事件；前端只展示临时错误 | Phase 2 | 高 |
| `stopTaskInstanceRun` | `taskExecution.ts` | 用户取消后的本地写入 | 是 | `cancelGoalInstance` 后等待事件或 overlay | Phase 2-3 | 高 |
| `generateInstance` | `taskExecution.ts`、`useTriggerEngine.ts` | 前端生成实例 | 是 | 服务端 command 生成 canonical instance；浏览器调度降级/删除 | Phase 2 | 高 |
| `generateRerunInstance` | `taskExecution.ts` | 前端生成重跑实例 | 是 | 服务端 rerun command 生成 canonical instance | Phase 2 | 高 |
| `removeTaskInstance` | `taskExecution.ts` | 清理临时 instance | 是 | optimistic overlay 清理，不进 canonical store | Phase 3 | 中 |
| `resolveTaskInstanceAwaitingUser` | `AwaitingUserResumePanel.tsx` | 用户响应后的本地恢复 | 是 | `respondGoalInstance` 后等待事件或 overlay | Phase 2-3 | 高 |
| `completeTaskInstance` | `ExecutionResultBody.tsx` | 结果页本地完成 | 是 | 完成/反馈命令 API，服务端决定完成态 | Phase 2 | 高 |
| `createGoalFromDraft` | `devMockSessions.ts` | dev mock 本地注入 | 否 | 生产链路已改 `createGoalCommand`；mock 保留 dev-only | Phase 2 已完成 / Phase 6 清场 | 中 |
| `confirmGoalPlan` | 无生产调用 | legacy shim | 是 | 已迁 `confirmGoalPlanCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 中 |
| `requestGoalPlanRevision` | 无生产调用 | legacy shim | 是 | 已迁 `requestGoalPlanRevisionCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `updateTask` | 无生产调用 | legacy shim | 是 | 已迁 `updateGoalTaskCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `addTask` | 无生产调用 | legacy shim | 是 | 已迁 `createGoalTaskCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `deleteTask` | 无生产调用 | legacy shim | 是 | 已迁 `deleteGoalTaskCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `addSubGoal` | 无生产调用 | legacy shim | 是 | 已迁 `createSubGoalCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `deleteGoalsByConversationId` | 无生产调用 | legacy shim | 是 | 已迁 `deleteGoalsByConversationCommand` + `baseRevision` | Phase 2 已完成 / Phase 6 清场 | 低 |
| `updateGoalWorkflow` | 多个 workflow 内部路径 | 本地 workflow 变更 | 是 | workflow command 或服务端规划链路事件 | Phase 2 | 高 |
| `activateGoal` | workflow 相关路径 | 本地 workflow 变更 | 是 | 服务端 workflow command | Phase 2 | 中 |
| `failGoalWorkflow` | workflow 相关路径 | 本地 workflow 变更 | 是 | 服务端 workflow failure event | Phase 2 | 中 |
| `retryTaskInstanceRun` | 当前未发现生产调用 | legacy 运行态写入 | 是 | 删除或迁移到 rerun command | Phase 3/6 | 低 |
| `controlTaskExecution` | 当前未发现生产调用 | legacy 运行态写入 | 是 | 删除或迁移到 start/cancel/resume command | Phase 3/6 | 低 |
| `createGoalFromInput` | 当前未发现生产调用 | legacy 本地草稿 | 是 | goal draft command 或删除 | Phase 3/6 | 低 |

## Phase 1 准入修改

Phase 1 只允许做以下低风险改动：

- 新增 projection 命名入口，不删除旧 mutation。
- `RuntimeEventBridge` 与 snapshot fallback 改用 projection 命名入口。
- 保留 legacy command shim，避免行为变化。
- 删除页面中未使用的 legacy selector 或改为 projection selector。

## Phase 2 前置条件

进入 Phase 2 前，需要确认：

- `applyGoalsProjection` 是 snapshot/hydrate 唯一入口。
- `applyInstanceStatusProjection`、`applyInstanceProgressProjection` 是 SSE 写入入口。
- 前端组件中的 `syncTaskInstanceRun`、`completeTaskInstance` 等 selector 已不再作为直接写入口暴露。
- materialize 桥接已删除；goal/task command API 是结构变更唯一生产入口。
