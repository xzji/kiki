# 方案 A：调度下沉 + 执行轨迹事件流（v2 修正版）

> 对应原文《Scaling Managed Agents》中的两个关键论点：
> 1. **harness 必须 cattle 化**：调度大脑可被任意拉起、任意杀掉，状态不丢
> 2. **session 不是 context window**：执行历史是 append-only event log，可按位置切片回放
>
> 本文是「问题 1：浏览器关掉就停」+「问题 2：状态对不上、无法回放」的合并实施方案。
> 两个问题强耦合，分开做会两次重写同一片代码，因此合并为一个版本。
>
> **v2 修正记录**（2026-04-08）：对照真实代码核查后修订了 6 处偏差、补充了 4 处遗漏，详见 §0.0。

---

## 0. 修订前的现实校准

### 0.0 v2 相对 v1 的修正

| 类别 | 内容 |
|---|---|
| 偏差 ① | 浏览器调度器 **现网默认就是关闭**（`NEXT_PUBLIC_KIKI_ENABLE_BROWSER_SCHEDULER` 默认 `"0"`），daemon 已经是事实主调度，工作量下调 |
| 偏差 ② | 新表必须进 schema migration v7（现 v6） |
| 偏差 ③ | 必须把"事件日志 vs runtime_jobs vs goalTelemetry vs trajectory.json"的角色划清，避免"四本账" |
| 偏差 ④ | `runtime_state_snapshots.conversations` 当前是孤儿写入，要么消费、要么删除 |
| 偏差 ⑤ | 现有 sync 已有乐观并发（baseRevision + conflict），迁移期并发模型必须配套 |
| 偏差 ⑥ | `deliverPendingTaskNotifications` 在浏览器中**无条件运行**，与调度器开关解耦，需单独处理 |
| 遗漏 ⑦ | `awaiting_user` 用户回答事件 kind 必须在第一版覆盖 |
| 遗漏 ⑧ | 事件日志清理策略 |
| 遗漏 ⑨ | 回滚后已写入事件日志的处置 |
| 遗漏 ⑩ | 前端命令式 API 的幂等键 |

### 0.1 现状速览（产品经理读这一段就够）

KiKi 的"自动派发任务"逻辑现在**有两个版本同时存在**：

| 位置 | 文件 | 真实状态 |
|---|---|---|
| 浏览器侧调度 | [GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx) | **现网默认关闭**（环境变量未启用），仅做 watchdog 与通知投递 |
| 浏览器侧通知投递 | 同上 `deliverPendingTaskNotifications` | **现网始终启用**，与调度器开关解耦 |
| 服务端调度 | [goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts) | **现网默认承担派发**，但功能不完整（缺 watchdog、通知投递） |

结论比 v1 乐观：调度大脑**部分已经在 daemon 里**，但有 3 个洞：
- daemon 没做超时 watchdog
- daemon 没做通知投递（inbox / 会话卡片 / 日程 event）
- 用户关浏览器后，"通知"无法继续投递（即使任务跑完了，inbox 也不会更新）

### 0.2 现在的"记忆"长什么样？

任务发生过的事情，分散存在四处：

| 存储 | 角色 | 是否权威 |
|---|---|---|
| 前端 Zustand store | 当前 UI 视图 | ❌ |
| `runtime_state_snapshots`（SQLite，现 schema v6） | 跨浏览器/重启视图 | 🟡 半权威 |
| `runtime_jobs`（SQLite） | 正在执行的任务队列 + lease | ✅ 对"正在跑"权威 |
| `goalTelemetry` + `trajectory.json` / `progress.json` / `result.json` | 执行步骤明细 | 🟡 单任务内权威 |

**问题**：四份存储没有"全局唯一的真理来源"，且：
- snapshot 是覆盖式的，丢历史
- runtime_jobs 是任务粒度，跨任务的"通知投递""目标 workflow 跃迁"无处归档
- telemetry 是单任务内部，目标层抓不到全局视图

---

## 1. 目标态（做完后是什么样子）

### 1.1 用一句话讲给 PM

> 浏览器只看，daemon 自己跑；所有发生过的事写进同一本流水账，前端任何时候都基于流水账重算视图。

### 1.2 三句话讲给工程师

1. **唯一调度器**：daemon `goalSchedulerEngine` 成为唯一派发源；浏览器 `GoalSchedulerRuntime` 退化为"事件订阅 + 视图层 watchdog"，**不再创建 instance、不再 enqueue runtime_jobs、不再投递通知**
2. **唯一事件日志**：新增 `goal_event_log` 表（schema v7），所有"目标级跃迁/任务实例创建/状态变化/通知投递/审核结论/工件产出/用户回答"统一以事件形式追加
3. **派生视图**：`runtime_state_snapshots`、前端 store 都从事件日志派生；遇到不一致以事件日志为准

### 1.3 用户能讲出来的变化

- 关掉浏览器 8 小时，回来打开看到 8 小时间产生的进度**和通知**
- 任务详情页可以点"回放"，按时间看做了什么
- 状态再也不会"莫名其妙变回去"

---

## 2. 四本账的角色划分（v2 新增）

迁移完成后，四类存储各司其职，避免重叠：

| 存储 | 新角色 | 写入方 | 读取方 |
|---|---|---|---|
| `goal_event_log`（**新表**） | **唯一权威**：发生过的事的流水账 | daemon scheduler / worker / API（用户命令） | 视图派生器、前端事件订阅、回放 |
| `runtime_jobs` | 仅"任务正在执行"队列与 lease 状态 | worker | worker（claim）、daemon（健康检查） |
| `goalTelemetry` + `trajectory.json` | 单任务**子步骤**明细（tool call 级） | runner | 任务详情页"步骤展开" |
| `runtime_state_snapshots` | "事件日志的最新状态视图"缓存（性能） | 事件 reducer | 前端首屏、外部只读访问 |

**判断原则**
- 任何**跨任务/跨目标**的状态变化 → 必须先写 `goal_event_log`
- `runtime_jobs` 任务结束后保留 N 天用于审计，不再作为状态来源
- `runtime_state_snapshots` 不再被前端**直接写入**（它是派生缓存，不是输入口）

---

## 3. 当前代码的关键耦合点

### 3.1 浏览器侧大脑现在做了什么（必须搬走的）

| 行为 | 当前实现 | 现状 | 搬到哪 |
|---|---|---|---|
| 找到 ready 任务 | `getReadyTasks(goals)` | 默认关闭 | 已在 daemon `goalSchedulerEngine` |
| 创建 TaskInstance | `goalStore.generateInstance` | 默认关闭 | daemon append `instance.created` |
| 创建 InboxItem | `inboxStore.upsertItem` | **始终开启**（通过 `deliverPendingTaskNotifications`） | daemon 投递事件，前端订阅 |
| 创建日程 AgentEvent | `scheduleStore.addEvent` | 默认关闭 | daemon append `instance.created`，前端派生 |
| 注入会话卡片 | `conversationStore.appendMessage` | **始终开启** | daemon 投递，前端订阅 |
| 发起 task run | `startTaskRun()` 直接打 API | 默认关闭 | daemon 派发 |
| 超时 / heartbeat watchdog | `runExecutionWatchdogs` | **始终开启** | daemon 后台循环 |
| 通知投递 | `deliverPendingTaskNotifications` | **始终开启** | daemon → `notification.delivered` 事件 |

**v2 关键修正**：3 个"始终开启"的浏览器逻辑（通知投递、会话注入、watchdog）是真正影响"关浏览器就停"的元凶，比"调度"更紧迫。

### 3.2 浏览器侧可以保留的（不搬）

- 用户**显式**操作：点"立即执行 / 暂停 / 重试 / 取消 / 回答 awaiting_user"
- **视图层 watchdog**：抽屉里 loading 太久的提示等纯 UI 责任

### 3.3 状态分布的目标态

```
   命令式 API ──→ ┌────────────────────────────────┐
   (用户操作)     │                                │
   daemon ─────→  │   goal_event_log（事件流）      │   ← 唯一权威
   worker ─────→  │                                │
                  └────────────────────────────────┘
                              │
                  事件 reducer │（增量物化）
                              ↓
                  ┌────────────────────────────────┐
                  │ runtime_state_snapshots（缓存） │
                  └────────────────────────────────┘
                              │
                  前端首屏读   │  + SSE 实时事件订阅
                              ↓
                  前端 Zustand store（只读派生）
```

---

## 4. 数据模型变化

### 4.1 新增表：`goal_event_log`（schema migration v7）

```sql
CREATE TABLE IF NOT EXISTS goal_event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  goal_id         TEXT NOT NULL,
  task_id         TEXT,
  instance_id     TEXT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  produced_by     TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_event_log_goal     ON goal_event_log (goal_id, id);
CREATE INDEX IF NOT EXISTS idx_goal_event_log_instance ON goal_event_log (instance_id, id);
CREATE INDEX IF NOT EXISTS idx_goal_event_log_idem     ON goal_event_log (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

**字段说明**
- `id`：单调位置切片用（`getEvents(fromId, limit)`）
- `event_id`：ULID，去重幂等用（同一事件被多次 append 只生效一次）
- `idempotency_key`（v2 新增）：**给前端命令式 API 用**，例如"用户连点两下'暂停'"通过相同 idem-key 幂等
- `produced_by`：`scheduler` / `worker` / `user` / `judge` / `daemon`

**migration v7**
```ts
{
  version: 7,
  sql: `<上述建表 SQL>`,
}
```
不动既有表，纯增量。

### 4.2 事件 kind 收口表（v2 补充用户响应类）

第一版覆盖 11 类：

| kind | 触发方 | 含义 |
|---|---|---|
| `goal.workflow_changed` | api / scheduler | 目标 workflow phase 跃迁（含 confirmed → executing → monitoring） |
| `instance.created` | scheduler | 新 TaskInstance 被创建 |
| `instance.status_changed` | worker | pending→in_progress→completed/failed/awaiting_user/paused |
| `instance.progress` | worker | 执行中的进度更新（节流采样） |
| `instance.artifact_produced` | worker | 产出工件 |
| `instance.notification_pending` | worker | 任务有通知要投递 |
| `notification.delivered` | daemon | 通知已落到 inbox/会话/日程 |
| **`instance.user_response`** ⚡ v2 新增 | user (api) | 用户对 awaiting_user 的回答；触发 resume |
| `instance.timeout_paused` | watchdog | 超时被自动暂停 |
| **`instance.user_command`** ⚡ v2 新增 | user (api) | 用户显式：暂停/恢复/重试/取消 |
| **`schedule.event_synthesized`** ⚡ v2 新增 | daemon | 由 instance.created 派生出的日程 AgentEvent，独立成事件以便前端订阅 |

**为什么把"用户操作"也建模为事件**
原文里 brain 是 cattle、可任意 wake，前提是用户操作必须可重放。如果用户暂停只更新 store，daemon 重启后无法知道"用户曾经按过暂停"。

### 4.3 派生视图的关系（v2 修正）

- `runtime_state_snapshots` 从此变成"事件流的物化视图"，由**事件 reducer 增量重算**
- snapshot 中的 `conversations` key（当前的孤儿写入）一并并入事件流派生体系；如果迁移期发现没人读它，明确删除
- 前端 `goalStore` 不再从前端发起写入；前端写操作 = 调命令 API → API append 事件 → 事件订阅回流 → store 更新

---

## 5. 接口变化

### 5.1 新增（前端只读）

```
GET  /api/goals/events?goalId=...&fromId=0&limit=200
     → { events: [...], nextCursor: 12345 }

GET  /api/goals/events/stream?goalId=...   （SSE）
     → 实时推送新事件
```

`fromId` 直接对应原文 `getEvents(positionalSlice)`。

### 5.2 调整（前端写改为命令式，v2 增加幂等键）

| 原行为 | 改后 |
|---|---|
| 前端 `goalStore.markInstanceStatus` 后 sync | `POST /api/goals/instances/{id}/transition`（带 `Idempotency-Key`），daemon 校验后 append `instance.status_changed` 或 `instance.user_command` |
| 前端 `inboxStore.upsertItem` | 由 `notification.delivered` 事件派生 |
| 前端 `scheduleStore.addEvent` | 由 `schedule.event_synthesized` 派生 |
| 用户回答 awaiting_user | `POST /api/goals/instances/{id}/respond`（带 `Idempotency-Key`），append `instance.user_response` |

**幂等键约定**
- 前端生成 ULID 作为 `Idempotency-Key`
- API 把它写到 `idempotency_key` 列；二次提交直接返回首次结果，不再重复 append

### 5.3 RuntimeStateBridge 改造

**保留壳子，更名为 `RuntimeEventBridge`**：
- 启动时读最新 snapshot（性能起步，复用现有 `fetchRuntimeStateSnapshot`）
- 立刻订阅 `events/stream`
- 收到事件以"事件 → reducer → store"方式更新前端
- 完全移除"前端 store → 后端"反向同步链路

### 5.4 旧 `syncRuntimeStateSnapshot` 的处置

- Sprint 1-3 期间保留可用，但**前端不再调用写**；服务端的 `baseRevision` 并发逻辑保留作为读路径降级
- Sprint 4 删除写入接口，仅保留只读

---

## 6. 实施切片（v2 重新评估工作量）

> 总体策略：**新表/新接口可以先并行存在，逐步切流量**，全程不破坏现网。

### Sprint 1 · 事件流地基（约 4-5 个工作日）

- [ ] schema migration v7：建 `goal_event_log` 表
- [ ] `goalEventLogRepository`：`appendEvent`、`getEvents(goalId, fromId, limit)`、幂等键去重
- [ ] 在 [goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts) 关键节点**双写**：现有逻辑保留，并 append 事件
- [ ] 在 [goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts) 入口加 append
- [ ] 双写一致性对账脚本（CI 运行）
- **此时无用户可感知变化**

### Sprint 2 · daemon 补齐 watchdog + 通知投递（约 5-6 个工作日，**v2 重点**）

> v2 关键洞察：daemon 调度本身已经默认开启，真正缺失的是 **watchdog + 通知投递**，这是关浏览器不响应的根因。

- [ ] daemon 主循环加 watchdog tick：超时暂停 → append `instance.timeout_paused`
- [ ] daemon 通知投递器：发现 `instance.notification_pending` → 实际写 inbox/会话/日程 → append `notification.delivered`
- [ ] daemon 派生 `schedule.event_synthesized`（替代浏览器侧 `buildScheduleEvent`）
- [ ] 把 [GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx) 中 `runExecutionWatchdogs` 与 `deliverPendingTaskNotifications` 用新 flag `notifications.runtime = "browser" | "daemon"` 包住，默认 browser
- [ ] 内部环境切换到 `daemon`，全功能回归
- **用户能感受到**：关浏览器后通知/超时逻辑也照常（仅内部环境）

### Sprint 3 · 事件流接管视图（约 5 个工作日）

- [ ] 实现 `/api/goals/events` 与 SSE
- [ ] 事件 reducer：从事件流增量物化 `runtime_state_snapshots.goals` / `scheduleEvents`
- [ ] `RuntimeStateBridge` 改为 `RuntimeEventBridge`：首屏读 snapshot + 订阅事件
- [ ] 命令式 API 第一批：`/instances/{id}/transition`、`/instances/{id}/respond`、`/instances/{id}/cancel`
- [ ] 前端把 1-2 个动作（暂停 / 回答 awaiting_user）切到命令式（开关控制）
- [ ] 任务详情页加"事件回放"视图（直接渲染事件流）
- **用户能感受到**：详情页可回放、刷新后状态稳定

### Sprint 4 · 默认开关 + 旧路径下线（约 3 个工作日）

- [ ] 两个 flag（`scheduler.runtime`、`notifications.runtime`）默认值改为 `daemon`
- [ ] 浏览器侧调度器只剩"视图 watchdog"
- [ ] `runtime_state_snapshots` 写入收口为"事件 reducer 产出"
- [ ] 旧 `syncRuntimeStateSnapshot` 写接口 410 Gone，仅保留读
- [ ] 文档与回滚预案落档

### 灰度策略

- 内部 dogfood → 邀请用户 → 全量
- 三个核心指标：①事件追加成功率 ②前端状态一致率 ③TTFT
- 任意指标回退超过阈值 → flag 一键切回

---

## 7. 验收指标

| 指标 | 含义 | 目标 |
|---|---|---|
| 关浏览器 12h 后的应推进任务完成率 | 是否真的"daemon 自己跑" | ≥ 95% |
| 关浏览器 12h 后通知投递率 | v2 新增（验证通知投递下沉） | ≥ 99% |
| 刷新前后状态一致率 | 解决"状态倒退" | ≥ 99% |
| 前端首屏状态可见时间（TTFT） | 对应原文改进目标 | p50 ≤ 400ms |
| 双写一致率（Sprint 1） | 事件流是否值得信任 | ≥ 99.9% |
| 命令式 API 重复提交幂等率 | v2 新增（同一 idem-key 重复请求不重复生效） | 100% |
| 回滚演练通过 | flag 切回后 5 分钟内恢复 | 必过 |

---

## 8. 风险与对策（v2 增补 4 条）

| 风险 | 影响 | 对策 |
|---|---|---|
| daemon 没启动就完全没大脑 | 体验比当前更差 | 健康检测：daemon 离线时 fallback 到浏览器调度器（保留旧路径） |
| 双写阶段两路出现差异 | 数据不一致 | Sprint 1 对账脚本必须先跑稳（≥ 99.9%）才进 Sprint 2 |
| 事件爆量（log 写入压力） | SQLite I/O 瓶颈 | 单 task progress 事件节流（≥ 5%/≥ 1s 才记一次）+ WAL + 批量 append |
| 历史数据怎么办 | 老 task 没事件 | 不回填，老 task 走旧路径直到完结；新 task 走事件流 |
| **v2-A：事件日志膨胀** | SQLite 文件增长无上限 | **保留策略**：`completed/cancelled` 任务的事件 30 天后归档为单条 `instance.archived`；目标层事件永不删除 |
| **v2-B：回滚后已写入事件如何处理** | 回滚到旧路径，事件继续追加但不被消费 | 回滚时**不停止 append**（保持双写），只切读路径回 snapshot；新事件作为审计存底 |
| **v2-C：多浏览器并发同一用户操作** | 重复提交 transition | 命令式 API 的 `idempotency_key` + `event_id` 双重去重 |
| **v2-D：snapshot.conversations 孤儿写入** | 不一致风险 | Sprint 1 决策：(1) 接入派生 (2) 直接停写并清理；推荐 (2) |

---

## 9. 与原文对照表

| 原文主张 | 本方案对应 |
|---|---|
| brain 不应活在 sandbox 容器里 | 调度器、watchdog、通知投递从浏览器搬到 daemon |
| brain 是 cattle，可被 `wake(sessionId)` | daemon 重启后从事件日志最后位置继续 |
| session 是 append-only log，brain 通过 `getEvents` 切片读 | `goal_event_log` + `/api/goals/events?fromId=` |
| harness 失败 = tool-call error，不影响 session | 浏览器关闭、daemon 重启都不影响事件日志 |
| 容器只在需要时按 `execute(name, input)` 拉起 | 任务实例只在 ready 时被 daemon 创建并入队 |
| 用户操作可重放 | 用户命令也作为事件（`instance.user_command` / `user_response`）追加 |

---

## 10. 不在本方案范围内（明确划出去）

- ❌ Runner 接口去业务化（独立方案）
- ❌ JSON 多级修复 / 5 阶段 workflow（方案 B）
- ❌ 凭据沙箱化（仅文档警示）
- ❌ 替换 Claude CLI 原生 session（等本方案稳定后讨论）

---

## 11. 一句话给老板

> 我们要把 KiKi 的"自动推进 + 通知投递 + 超时兜底"全部从浏览器搬到后台进程，并把"状态记忆"统一成一本流水账。做完之后，关浏览器目标也能推、通知也能继续投、刷新不丢状态、问题排查可以回放。改造分 4 个 sprint 渐进切流（约 17-19 个工作日），每一步都有 feature flag 兜底；v2 修订版重点修正了"调度部分实际已下沉到 daemon、真正卡点在 watchdog 和通知投递"这一现状误判。
