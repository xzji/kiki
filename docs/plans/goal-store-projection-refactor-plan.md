# goalStore 完全投影化改造方案

## 背景

当前 `goalStore` 同时承担两类职责：

- UI 本地投影：保存页面渲染需要的 goals、tasks、instances，并接收服务端 snapshot/SSE 事件回灌。
- 本地写入源：直接创建 goal、编辑 task、生成 instance、修改 instance 状态，再由 `RuntimeEventBridge` 自动 materialize 到服务端。

“goalStore 完全投影化”指的是把 `goalStore` 收敛为只读投影层：前端不再把 Zustand 作为事实写入源，所有会改变 goal/task/instance 的操作都先调用服务端命令 API，由服务端通过 `goalRuntimeService.ts` 写入 snapshot/event log，再通过 snapshot/SSE 回灌到 `goalStore`。

这不是清理遗留代码，而是一次前后端数据权威源迁移。它会影响首屏 hydration、SSE 事件顺序、本地 pending goal、并发编辑、断网失败、幂等与冲突处理，所以应单独开一轮。

## 现状判断

已有基础：

- Goal snapshot 写入已基本收敛到 `goalRuntimeService.ts`。
- `RuntimeEventBridge` 已具备服务端 snapshot hydrate、SSE 事件同步、SSE 断线后轮询兜底。
- `/api/runtime/state/sync` 已不再接收 `goals` 字段，goal 物化改走 `/api/goals/materialize`。

仍未投影化的点：

- `goalStore` 仍暴露大量直接 mutation，例如 `createGoalFromInput`、`updateTask`、`deleteTask`、`generateInstance`、`controlTaskExecution`、`markInstanceStatus`、`completeTaskInstance`。
- `RuntimeEventBridge` 依赖 `goalMaterializeKey` 自动判断本地 confirmed goal 是否需要 materialize，这说明前端仍可能先写本地、后同步服务端。
- pending local goal 与 remote snapshot 的合并策略偏启发式，主要靠 goal id、workflow updatedAt、task shape 判断，难以表达删除、并发编辑和部分字段冲突。
- 事件可能早于 snapshot 到达，目前通过 `pendingGoalEvents` 临时排队，但如果 goal/task/instance 创建本身还依赖本地 store 先行，就会放大竞态。

## 风险评估

结论：需要单独做，但不建议一次性“大爆炸式”替换。

主要风险：

- 数据丢失：本地尚未 materialize 的 goal/task/instance 如果被远端 snapshot 覆盖，刷新或 SSE 回灌后可能消失。
- 状态回滚：服务端进度事件与前端本地 mutation 交错时，旧 snapshot 可能覆盖新事件。
- 并发冲突：多标签页、重复点击、自动调度与手动操作并发时，目前缺少统一的 CAS/expectedRevision 处理。
- UI 体验退化：如果所有操作都必须等待服务端返回，创建/编辑体验可能从即时反馈变成明显延迟。
- API 面扩张：现有本地 mutation 需要逐步替换为命令 API，否则无法真正做到单写路径。
- 测试面变大：需要覆盖 hydrate、SSE、轮询兜底、materialize 失败、事件乱序、多标签页等场景。

## 目标形态

目标原则：

- `goalStore` 只保存“当前服务端投影 + 明确标记的 optimistic overlay”，不再隐式承担事实源。
- 所有 goal/task/instance 写操作统一走服务端命令 API。
- 服务端命令 API 必须要求 `Idempotency-Key`，必要时带 `baseRevision` 或实体级 version。
- `RuntimeEventBridge` 只负责读取 snapshot、订阅事件、应用投影，不再自动把本地 goals 反向 materialize。
- 本地 optimistic 状态必须可追踪、可回滚、可重放，不能混在普通 goal 数据里。

## 分阶段方案

### Phase 0：数据流审计

目标：先冻结现状，避免盲改。

- 梳理所有调用 `useGoalStore.getState()` mutation 的组件、hook、API client。
- 将 mutation 按职责分类：草稿创建、计划确认、任务编辑、实例启动、实例状态、执行结果、通知状态。
- 标记每个 mutation 的权威源：必须服务端写入、允许本地草稿、仅用于事件投影。
- 输出迁移矩阵，明确每个 mutation 的替代 API 或保留理由。

验收：

- 有完整 mutation callsite 清单。
- 每个 mutation 都有“保留为投影应用 / 迁移到命令 API / 仅本地草稿”三类结论。

### Phase 1：引入投影边界

目标：先让代码结构表达“投影应用”和“用户命令”不同。

- 在 `goalStore` 中将 mutation 分组命名：
  - `replaceGoals`、`applyInstanceStatusProjection`、`applyInstanceProgressProjection` 作为投影入口。
  - 用户动作类 mutation 标记为 legacy command shim。
- 将 `RuntimeEventBridge` 调用的状态更新改为 projection 命名，避免与用户动作混淆。
- 增加开发期 guard：非 projection 入口在 `RuntimeEventBridge` 回灌期间不允许触发。

验收：

- SSE/snapshot 回灌路径只调用 projection 类方法。
- 用户操作路径仍可工作，但 legacy command shim 有明确 TODO 和迁移目标。

### Phase 2：补齐服务端命令 API

目标：把当前依赖本地 mutation 的写操作逐个迁到服务端。

- 新增或补齐 goal/task 命令 API：
  - 创建 goal 草稿 / 确认 goal 计划。
  - 更新 task。
  - 删除 task。
  - 新增 subGoal / task。
  - 手动启动、暂停、恢复、重跑 instance。
- 所有命令统一经过 `goalRuntimeService.ts` 写 snapshot/event log。
- 所有命令强制校验 `Idempotency-Key`。
- 对会覆盖结构的命令增加 `baseRevision` 或实体级 revision 冲突检测。

验收：

- 用户动作不再直接依赖 `goalStore` 生成最终实体。
- API route 不直接写 snapshot repository。
- 冲突返回可识别错误，前端能触发 refresh/retry。

### Phase 3：引入 optimistic overlay

目标：保留即时 UI，但不让本地 optimistic 数据伪装成服务端事实。

- 新建轻量 overlay 状态，例如 `pendingGoalCommands` 或 `goalOptimisticOverlay`。
- 用户提交命令后先记录 pending command，而不是直接改写 canonical goals。
- UI 渲染时通过 selector 合成 `serverProjection + optimisticOverlay`。
- 命令成功后等待 SSE/snapshot 确认并清理 overlay。
- 命令失败或冲突时回滚 overlay，并提示具体原因。

验收：

- 刷新页面不会把未确认 optimistic 数据误认为已持久化。
- 同一个命令重复提交可通过 idempotency 去重。
- 服务端事件到达后 overlay 能稳定消失，不产生重复 instance/task。

### Phase 4：移除自动 materialize

目标：切断“本地 goal 自动反向写服务端”的旧链路。

- 删除 `RuntimeEventBridge` 中基于 `goalMaterializeKey` 的自动 materialize 逻辑。
- 删除 `mergeRemoteSnapshotWithPendingLocalGoals` 的启发式合并，改为：
  - canonical goals 完全来自服务端 snapshot。
  - pending 状态只来自 optimistic overlay。
- `/api/goals/materialize` 进入弃用流程，保留 deprecated headers，最终移除。

验收：

- `RuntimeEventBridge` 不再调用 `materializeGoalSnapshot`。
- hydrate 与轮询只做服务端投影替换，不再合并隐式本地 goal。
- 本地 confirmed goal 不会绕过命令 API 写入服务端。

### Phase 5：收口与测试

目标：确保投影化不引入回归。

- 增加针对数据流的测试：
  - 首屏 snapshot hydrate。
  - SSE 事件早于 snapshot。
  - SSE 断线后 30s 轮询兜底。
  - 命令成功后的 optimistic overlay 清理。
  - 命令失败/冲突后的 overlay 回滚。
  - 多标签页同时编辑。
- 增加静态约束：
  - 禁止组件直接调用 legacy command mutation。
  - 禁止 route/repository 绕过 `goalRuntimeService.ts` 写 goal snapshot。

验收：

- `goalStore` 中只剩投影更新与 overlay 管理。
- 所有事实写入都可追踪到服务端命令 API 和 `goalRuntimeService.ts`。
- 清场遗留逻辑可以在此之后单独做，风险显著降低。

## 不建议混入清场的原因

- 清场通常是删除废代码、收敛命名、移除过渡层，风险主要是引用遗漏。
- 投影化会改变数据一致性模型，风险主要是状态权威源迁移和竞态。
- 两者混做会让问题定位困难：出现数据丢失时，很难判断是清理误删、事件顺序、snapshot 合并还是命令 API 设计问题。
- 投影化需要产品级验收路径，尤其是创建 goal、确认计划、启动任务、等待用户反馈、任务结束通知这些闭环。

## 建议排期

建议单独拆成一轮“goalStore 投影化”专项：

- 第一轮只做 Phase 0 到 Phase 1，不改变行为，建立边界和清单。
- 第二轮做 Phase 2 到 Phase 3，逐个迁移高价值命令并保留兼容层。
- 第三轮做 Phase 4 到 Phase 5，删除自动 materialize 和启发式合并。

在前两轮完成前，不建议删除 `/api/goals/materialize`、`mergeRemoteSnapshotWithPendingLocalGoals` 或大规模改 `goalStore` mutation。
