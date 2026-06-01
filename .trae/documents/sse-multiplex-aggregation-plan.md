# SSE 长连接耗尽浏览器连接池根因方案：聚合多路复用通道

## Summary
- 当前 `RuntimeEventBridge` 为每个 goal 单独建立一条 `/api/goals/events/stream` SSE 连接，再额外建立一条 `/api/conversations/events/stream` 长连接。
- HTTP/1.1 同源并发连接上限通常为 6，而真实环境中 `N(goals) + 1` 普遍 ≥ 7。
- 当前 Tab 刷新时旧连接尚未被浏览器立刻释放，新页面的 HTML / RSC / API / 新 SSE 全部排队，表现为“刷新加载不出来”，关闭 Tab 后再打开则恢复。
- 根因方案：把所有运行时事件流合并为一条聚合 SSE 通道 `/api/runtime/events/stream`，前端只持有一个 `EventSource`，按事件名分发，并在服务端正确响应客户端断开。

## Current State Analysis

### 服务端
- [src/app/api/goals/events/stream/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/events/stream/route.ts)
  - 一个 SSE 路由对应一个 `goalId`，每 2s `setInterval` 轮询 `getGoalEvents`。
  - `cancel()` 仅清理 `setInterval`，没有显式响应 `request.signal`，但 `ReadableStream.cancel` 会在客户端断连时被触发。
- [src/app/api/conversations/events/stream/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/conversations/events/stream/route.ts)
  - 全局会话事件流，不区分 conversationId。
  - 同样 2s 轮询。
- [src/lib/server/repositories/goalEventLogRepository.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/goalEventLogRepository.ts)
  - `getGoalEvents` 当前对单个 goal 过滤事件，全表扫描后 in-memory filter（已知非最优，但本方案不重写它）。
- [src/lib/server/repositories/conversationEventLogRepository.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/conversationEventLogRepository.ts)
  - `getConversationEvents` 已支持 SQL 层 cursor 过滤。
- [src/lib/server/sse.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/sse.ts)
  - 提供统一 `writeSseEvent` / `createSseHeaders`。

### 客户端
- [src/components/providers/RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx#L382-L441)
  - `useEffect` 为 conversation 单独建立一条 EventSource。
- [src/components/providers/RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx#L568-L624)
  - 另一个 `useEffect` 遍历当前 goals，对每个 `goalId` 通过 `createGoalEventsSource` 各建一条 SSE。
- [src/lib/api/goal-events.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/goal-events.ts)
  - `createGoalEventsSource(goalId, fromId)` 单 goal 单连接的客户端工厂。

### 实测影响
- `pnpm dev` 日志显示同时存在 6 条 `/api/goals/events/stream` + 1 条 `/api/conversations/events/stream`，共 7 条长连接。
- 刷新当前 Tab 时浏览器需要为新页面新建 7 条同源连接，与未释放的旧连接合计远超 HTTP/1.1 上限，新页面关键请求被阻塞。

## Root Cause
浏览器对同源 HTTP/1.1 的并发连接上限是常量级（Chrome 默认 6）。当我们用“每个 goal 一条 SSE”把全部连接耗尽后，刷新场景下旧连接释放与新连接建立存在竞态，导致新页面所有请求排队等待。多个 Tab、HMR、设置面板等场景同样会触发。**根本治理路径：把多条 SSE 合并为一条多路复用通道，使每个 Tab 在任意时刻只占用一条 SSE 连接。**

## Proposed Changes

### 1. 新增聚合 SSE 路由 `/api/runtime/events/stream`
新文件：`src/app/api/runtime/events/stream/route.ts`

- 入参（query）：
  - `goalCursor`：单个数字，表示"goal_event_log 全表起点"。bootstrap 已经把全部 goal backlog 拉完，这里只需要一个全局游标，不再按 goalId 上报。
  - `conversationCursor`：number，由 bootstrap 阶段从 `fetchConversationState().latestEventId` 得到。**禁止默认 0**，否则刷新瞬间会推全量历史。
  - 不再以 goalIds 限定订阅范围；服务端推所有 goal 事件，前端按本地 store 过滤。这样 goalIds 集合变化不需要重连。
- 输出 SSE 事件名：
  - `ready`：`{ goalCursor, conversationCursor }`。
  - `goal-events`：`{ events: GoalEventRecord[], nextCursor: number }`（按事件 id 升序）。
  - `conversation-events`：`{ events: ConversationEventRecord[], nextCursor: number }`。
  - `heartbeat`：`{ ts: number }`。
  - `error`：`{ message: string }`。
- 行为：
  - 每 2s `tick`：
    - 一次 SQL：`getGoalEventsSince(goalCursor, limit=200)` —— 新增 repo 函数，单次扫描，避免对 N 个 goal 各扫一次。
    - 一次 SQL：`getConversationEvents({ fromId: conversationCursor, limit=200 })`（已支持 SQL 游标）。
    - 仅在有新增事件时推送对应事件名；都没有则推 `heartbeat`。
  - 连接生命周期：
    - 维护本地 `disposed=false`。
    - `request.signal.addEventListener("abort", cleanup, { once: true })`。
    - `ReadableStream.cancel()` 也调用 `cleanup`。
    - `cleanup` 幂等：若 `disposed` 直接 return；否则 `disposed=true`、`clearInterval(timer)`、`try { controller.close(); } catch {}`。

### 2. 新增聚合客户端工厂 `src/lib/api/runtime-events.ts`
新文件 + 导出：
- `type RuntimeEventsCursors = { goalCursor: number; conversationCursor: number }`
- `createRuntimeEventsSource(cursors: RuntimeEventsCursors): EventSource`
  - 内部拼接 `?goalCursor=&conversationCursor=` 后 `new EventSource(...)`。
- 该模块不再导出 per-goal `EventSource` 工厂，逐步替换 `createGoalEventsSource` 的使用。

### 2.1 新增 repo 函数 `getGoalEventsSince`
修改：[src/lib/server/repositories/goalEventLogRepository.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/goalEventLogRepository.ts)
- 新增 `getGoalEventsSince(fromId: number, limit: number): GoalEventRecord[]`
  - SQL: `SELECT * FROM goal_event_log WHERE id > ? ORDER BY id ASC LIMIT ?`。
  - 不做 `goalId` 过滤；前端按 store 进行 goal 维度筛选/分发。
- 现有 `getGoalEvents(goalId, ...)` 不动，bootstrap 路径继续按 goal 拉历史。

### 3. 重构 `RuntimeEventBridge` 的 SSE 接入
修改：`src/components/providers/RuntimeEventBridge.tsx`

- 删除现有“conversation 单独 SSE”与“per-goal SSE 列表”两个 `useEffect` 的连接逻辑。
- 新增一个 `useEffect`，**依赖 `bootstrapped` 一项；不依赖 goalIds 集合**，避免每次新增/删除 goal 都触发重连：
  1. bootstrap 阶段保留：
     - `fetchConversationState()` → 取 `latestEventId` 设到 `conversationCursorRef`，并 `hydrateConversations`。
     - 对当前 goals 顺序 `fetchGoalEvents` 拉 backlog。⚠️ 改为**串行 await**而非并行，避免刷新瞬间 N 个并发 HTTP 再次占满连接池。
     - 取本地 `eventCursorRef` 中所有 goal 中的最大 id 作为 `aggregateGoalCursor`（保证 SSE 不重放已应用事件）。
  2. 用 `createRuntimeEventsSource({ goalCursor: aggregateGoalCursor, conversationCursor: conversationCursorRef.current })` 建立单条 SSE。
  3. `goal-events`：对每条 event 调用 `applyGoalEventAndAdvance`；同时把 `nextCursor` 写到本地一个 `aggregateGoalCursorRef`，供后续重连使用（不再写入按 goal 维度的 `eventCursorRef`，因为某些 goal 不在订阅范围时也会出现，简化为"全局已读到 X"语义）。
     - 兼容：`eventCursorRef`/`writeGoalEventCursors` 跨 Tab 同步逻辑保留，仅作为"已应用过的最大 id 提示"，便于其他 Tab 启动时不从 0 开始。
  4. `conversation-events`：复用现有 `applyConversationEvent`，并维护 `conversationCursorRef`。
  5. `error` / `open` 事件继续控制 `sseDisconnectedRef`，30s 轮询保底逻辑保留。
  6. 清理函数：`source.close()`，确保单连接随组件卸载释放。
- HMR/StrictMode 防抖：在 effect 顶部用一个 `mountedRef`/`abortController`-style 标记保证清理函数可幂等；EventSource 显式置 null。

### 4. 老路由的处理
- 保留 `/api/goals/events/stream` 与 `/api/conversations/events/stream`，但不再被前端默认使用，作为回退/外部消费者通道。
- `src/lib/api/goal-events.ts` 中的 `createGoalEventsSource` 标记为已废弃（保留导出，避免破坏其他潜在引用），并在文件顶部 JSDoc 注明“已被 `createRuntimeEventsSource` 取代，禁止在新代码中使用”。

### 5. 服务端断连释放强化
修改：聚合路由实现中
- 在 `start(controller)` 内 `request.signal.addEventListener("abort", cleanup, { once: true })`，确保浏览器刷新关闭连接时立即停止 timer。
- `cleanup` 内使用 `try { controller.close(); } catch {}` 防止重复关闭抛错。
- 同步在旧的两个 stream 路由内补上同样的 `request.signal` 监听，保证哪怕未来仍有人使用，也不会泄漏 `setInterval`。

### 6. Planning Spec 注册
新增文件：`src/app/api/runtime/events/stream/route.spec.ts`（仅纯函数级断言，不启动真实流式）。
- 通过抽出辅助函数 `composeAggregatedTick({ goalIds, goalCursors, conversationCursor })` 进行单测：
  - 多 goal 合并产物。
  - 仅在有事件时推送对应频道。
- 注册到 [scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts) 的 `run` 列表。

## Assumptions & Decisions
- **决策 A**：聚合路径选择“一条多事件名 SSE”而非“一条多事件流 + WebSocket”。理由：现有架构是 SSE，重写成 WebSocket 影响面过大；一条 SSE 对“浏览器连接池被耗尽”问题已经足够。
- **决策 B**：聚合路由仍走 2s 轮询 SQLite。理由：现状 `goal_event_log` 与 `conversation_event_log` 没有 LISTEN/NOTIFY 通道；改为推模型属于另一个根因（性能优化），不在本方案范围内。
- **决策 C**：保留旧路由不删除。理由：避免破坏外部脚本/调试工具与运行中的旧 Tab；只确保前端默认不再使用。
- **决策 D**：聚合通道按"事件名"区分，而非"data.type 字段"，使前端 `addEventListener("goal-events", ...)` 与 `addEventListener("conversation-events", ...)` 直接复用 EventSource 原生分发，不需要再做 JSON 类型路由。
- **决策 E**：bootstrap 仍用 HTTP `fetchGoalEvents` 而不是聚合 HTTP，避免新增聚合 HTTP 路由扩面；只把“长连接”聚合掉就足以解决根因。

## Risks
- 单连接故障会同时丢失所有事件流；通过现有 `sseDisconnectedRef` + 30s 快照轮询保底已经覆盖。
- 一条 SSE 流中若 goal 数量极多，`getGoalEvents` 的 in-memory filter 仍是 O(N) 扫表；本方案不解决该性能问题，已在“决策 B”中显式排除。
- 旧 Tab 仍会按旧逻辑建立 N 条 SSE；用户刷新后即转为新逻辑。

## 复审补遗（自我批评）
本节记录方案在自审中发现并修订的问题，避免漏改：

1. **bootstrap 并发再次打满连接池**
   - 旧实现中 6 个 `fetchGoalEvents` 在 `for` 循环里 `await`，已经是串行；本方案保持串行。
   - 但 `hydrateConversationsFromServer` 与 `bootstrap` 并行启动；改为先 `await` conversation hydrate 再开始 goal backlog，避免与 bootstrap 同时打开多个并发 HTTP。
2. **conversation 起点游标必须来自 server**
   - SSE `fromId` 必须是 `latestEventId`，禁止默认 0（否则刷新瞬间重放全量历史，等同于刚才说的“看起来卡”）。
3. **goalIds 集合变化不再触发 SSE 重连**
   - 通过把订阅范围改为“全表 since 全局 cursor”，前端按 store 分发；新增 goal 时不需要重连。
4. **服务端 N 倍扫表问题**
   - 新增 `getGoalEventsSince` 单次查询，避免聚合后变成同 tick 内的 N 次 SQL。
5. **`cancel()` 与 `request.signal.abort` 双触发**
   - 加 `disposed` 幂等标记，`cleanup` 只跑一次。
6. **HMR/StrictMode 双挂载**
   - 在 effect 内用 `let cancelled=false; let source: EventSource|null=null` 模式；卸载函数 `source?.close(); source=null`，防止 dev 模式下双挂载残留。
7. **跨 Tab 兼容**
   - 旧 Tab 仍跑老逻辑，老路由保留；新 Tab 单连接；在最少 1 次刷新后系统全量收敛。
8. **回归覆盖**
   - 增补 spec：聚合 tick 函数 + `getGoalEventsSince` 行为 + 客户端 `createRuntimeEventsSource` 拼参；都注册到 `run-planning-specs.ts`。
9. **不与现有 BroadcastChannel 冲突**
   - `RUNTIME_STATE_CHANNEL` / `GOAL_EVENT_CURSOR_CHANNEL` 仍跑；它们是“跨 Tab 收敛”而非“服务器到浏览器”，与本次连接聚合无重叠。

## Verification

1. **本地复现验证**
   - `pnpm dev` 启动后打开页面（≥6 个 goal），DevTools Network 中筛 `EventSource`，应仅看到 1 条 `/api/runtime/events/stream`。
   - 刷新当前 Tab 多次，页面应在合理时间内完成加载，不再出现长时间“无法加载”。
2. **多 Tab 验证**
   - 同时打开 3 个 Tab，每个 Tab 仅占 1 条 SSE，总长连接 = Tab 数。
3. **事件落地验证**
   - 触发一次任务执行，观察 goal 状态/进度更新仍能流式反映。
   - 在另一 Tab 发送会话消息，确认会话事件通过聚合通道下发。
4. **断连释放验证**
   - 关闭 Tab / 刷新后，`pnpm dev` 日志应不再积累“几十分钟级”的存量 SSE 请求。
5. **回归**
   - `pnpm tsc --noEmit`
   - `pnpm lint`
   - `pnpm test:planning`

## Out of Scope
- 把事件订阅由轮询改为 push（SQLite 触发器或队列）。
- `getGoalEvents` 的 SQL 层游标过滤优化。
- WebSocket 全面替换 SSE。
- 服务端事件压缩 / 增量分片。
