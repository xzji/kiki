# 会话数据服务端持久化改造方案

## 0. 背景与目标

当前 `Conversation` / `ConversationMessage` 仅持久化在浏览器 `localStorage`（key=`kiki.conversations`，由 `zustand/middleware` 的 `persist` 维护），导致：

- 清浏览器缓存或换浏览器 → 会话历史全部丢失。
- 与项目硬约束「Browser store is a read-only projection updated via snapshots, SSE, or BroadcastChannel」不一致——会话仍是浏览器写权威。
- 多 Tab / 多端无法共享会话状态，未来上 Cloudflare/Railway 后无法跨设备恢复。

而 inbox 由服务端 `goal_event_log` 重放，所以即便浏览器 storage 被清，inbox 仍能恢复，进一步暴露出「inbox 有数据 / 会话却空」的不一致体验。

**改造目标**：让 conversation 走与 goals/inbox 相同的「服务端权威 + 命令 API + 事件流 + 浏览器只读投影」架构。

## 1. 强约束

沿用项目硬约束（写在 `project_memory.md` 中）：

1. **State Authority**：浏览器禁止 bulk sync 上行；所有写都走显式命令 API + `expectedRevision` 乐观锁。
2. **UI Projection**：浏览器 store 是只读投影，由 SSE / snapshot / `BroadcastChannel` 喂数据。
3. **App Architecture**：使用 `useSearchParams()` 的组件必须包 `Suspense`。
4. **Daemon Runtime**：daemon 共用模块禁止 import `server-only` 模块。
5. **Cloud Migration**：本地实现需通过 `src/lib/server/adapters/` 抽象。
6. **API**：重复 ID 创建必须返回 409；命令 API 必须带 `Idempotency-Key`。
7. **CI**：新增 service / spec 必须注册到 `scripts/run-planning-specs.ts`。

## 2. 架构对照（参考 Goal）

| 层 | Goal 现状 | Conversation 目标 |
|---|---|---|
| 写命令 API | `POST /api/goals/commands` | `POST /api/conversations/commands` |
| 命令服务 | `src/lib/server/services/goalCommandService.ts` | `src/lib/server/services/conversationCommandService.ts` |
| 事件日志 | `goal_event_log` + `goalEventLogRepository.ts` | 新增 `conversation_event_log` + `conversationEventLogRepository.ts` |
| 投影存储 | `runtime_state_snapshots` (key=`goals`) | 新增 `conversations` / `conversation_messages` 表（消息体量大，不塞 snapshot JSON） |
| SSE | `/api/goals/events/stream` | `/api/conversations/events/stream` |
| 浏览器 store | `conversationStore.ts`（持久化） | 改为投影：移除 `persist`，由命令 + SSE 驱动 |
| 多 Tab | 现有 `BroadcastChannel('kiki-runtime')` | 复用同一通道，避免重复 SSE 连接 |

## 3. 数据模型与 Schema (v10)

```sql
-- KIKI_DB_SCHEMA_VERSION = 10

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal_id TEXT,
  workspace_path TEXT,
  workspace_initialized_at TEXT,
  runtime_env_id TEXT,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',          -- 'idle' | 'streaming' | 'error'
  pinned INTEGER NOT NULL DEFAULT 0,
  goal_info_collection_json TEXT,               -- 大字段单独存
  planning_run_state_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,          -- 乐观锁
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local-user'    -- 预留多用户
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_goal ON conversations(goal_id);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,                          -- ConversationMessage.id（worker 透传的稳定 id）
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                         -- 单调递增，分页/游标
  kind TEXT NOT NULL,                           -- 'text' | 'goal_plan_card' | 'task_card'
  role TEXT NOT NULL,                           -- 'kiki' | 'user'
  source TEXT,                                  -- 'user' | 'kiki' | 'system'
  status TEXT,                                  -- 'streaming' | 'done' | 'error'
  content TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  ref_json TEXT,                                -- goalRef / taskRef
  snapshot_json TEXT,                           -- taskSnapshot 等
  version INTEGER NOT NULL DEFAULT 1,           -- 流式消息按 version 覆盖
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_messages_conv_seq ON conversation_messages(conversation_id, seq);

CREATE TABLE conversation_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- conversation.created | message.appended | message.updated | … 见下
  payload_json TEXT NOT NULL,
  produced_by TEXT NOT NULL,                    -- 'user' | 'system' | 'worker'
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_conv_event_log_conv ON conversation_event_log(conversation_id, id);
CREATE UNIQUE INDEX idx_conv_event_log_idem
  ON conversation_event_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

事件 kind 枚举：

- `conversation.created`
- `conversation.renamed`
- `conversation.deleted`
- `conversation.pinned_toggled`
- `conversation.goal_set`
- `conversation.workspace_set`
- `conversation.runtime_env_set`
- `conversation.claude_session_set`
- `conversation.status_changed`
- `conversation.goal_info_collection_updated`
- `conversation.planning_run_state_updated`
- `conversation.read` / `conversation.unread`
- `message.appended`
- `message.updated`
- `message.deleted`
- `message.read`

## 4. 命令 API

### 4.1 路由

`POST /api/conversations/commands`，header 必带 `Idempotency-Key`。

### 4.2 Command 类型

```ts
export type ConversationCommand =
  | { type: "create_conversation"; conversation: { id: string; title: string } }
  | { type: "rename_conversation"; conversationId: string; title: string }
  | { type: "delete_conversation"; conversationId: string }
  | { type: "toggle_pinned"; conversationId: string }
  | { type: "set_goal"; conversationId: string; goalId: string }
  | { type: "set_workspace"; conversationId: string; workspacePath: string }
  | { type: "set_runtime_env"; conversationId: string; runtimeEnvId: string }
  | { type: "set_claude_session"; conversationId: string; claudeSessionId: string }
  | { type: "set_status"; conversationId: string; status: "idle" | "streaming" | "error" }
  | { type: "set_goal_info_collection"; conversationId: string; collection: GoalInfoCollection | null }
  | { type: "set_planning_run_state"; conversationId: string; state: GoalPlanningRunState | null }
  | { type: "append_message"; conversationId: string; message: ConversationMessage }
  | { type: "update_message"; conversationId: string; messageId: string; patch: Partial<ConversationMessage>; expectedVersion?: number }
  | { type: "delete_message"; conversationId: string; messageId: string }
  | { type: "mark_conversation_read"; conversationId: string }
  | { type: "mark_conversation_unread"; conversationId: string }
  | { type: "mark_message_read"; conversationId: string; messageId: string };
```

### 4.3 响应与错误码

- 成功：`{ ok: true, conversation, revision }`
- 重复 idempotency：409 + `ConversationCommandIdempotencyConflictError`
- revision 冲突（元数据类）：409 + `{ currentRevision, expectedRevision }`
- 重复 message.id（append 类）：直接 200 返回已存在记录（与现 SSE 防重一致）
- 校验失败：400

### 4.4 幂等策略

- 元数据写：`Idempotency-Key` 唯一；冲突 409。
- `append_message`：按 `(conversation_id, message.id)` 唯一；重复返回 200。
- `update_message`：可选 `expectedVersion` 防止落后写覆盖最新流式片段。

## 5. 投影下行

| 接口 | 用途 |
|---|---|
| `GET /api/conversations/state` | 首屏：返回 `{ conversations: ConversationMeta[], revision }`，仅元数据 + 最近预览，不含全量 messages |
| `GET /api/conversations/[id]/messages?after=<seq>&limit=50` | 详情/分页 |
| `GET /api/conversations/events/stream?fromId=<cursor>` | SSE：消费 `conversation_event_log` |

事件 payload 设计：

- 小消息直接带 body（推荐 ≤32KB）。
- 大消息只带 `messageId + seq`，浏览器按需 fetch。
- 多 Tab 复用 `BroadcastChannel('kiki-runtime')`：第一个 Tab 持有 SSE，其它 Tab 收 broadcast。

## 6. 浏览器侧改造

### 6.1 `conversationStore.ts`

- 移除 `persist` 中间件（保留一次性迁移读旧 localStorage）。
- 所有 `set/append/update/rename/delete` 方法重构为：
  1. 生成乐观更新（基于本地 `revision`）。
  2. 调命令 API。
  3. 失败回滚 / 409 触发 `resync(conversationId)`（重新拉 state）。
- 暴露纯投影 reducer：`applyConversationEvent(state, event)`，供 SSE / Broadcast / fetch 后统一调用。
- 启动时执行一次性迁移：
  1. 读 `localStorage["kiki.conversations"]`。
  2. 调 `POST /api/conversations/import`（仅当服务端 conversations 表为空时允许）。
  3. 写 `localStorage["kiki.conversations.migrated"] = "1"` 并清原数据。

### 6.2 命令封装

新建 `src/lib/api/conversation-commands.ts`，参考 `goal-commands.ts`：

- 自动生成 `Idempotency-Key`。
- 解析 409 与 `currentRevision` 触发 resync。
- 提供 `appendMessageCommand` / `updateMessageCommand` 等强类型 wrapper。

### 6.3 写入点替换

按调研梳理出的 17 处直接调 `useConversationStore.getState().xxx` 写方法的位置（[goalWorkflow.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalWorkflow.ts)、[assistantStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/assistantStore.ts)、[devMockSessions.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/devMockSessions.ts)、[RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx) 等）全部改为命令调用。

为防回退，加 ESLint 规则禁止 client 端直接调 `useConversationStore.getState().<writeMethod>`。

## 7. 服务端写入点改造（关键）

[RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx#L268-L300) 当前在浏览器把 worker 通知拼装成 `task_card` 消息直接写 store。这一路径不符合「服务端权威」：

- 把消息拼装下沉到 [goalNotificationWorker.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalNotificationWorker.ts)：当 `target === "conversation"` 时，worker 在产生 `notification.delivered` 的同事务里写 `conversation_messages` + 追加 `conversation_event_log` 的 `message.appended`。
- 浏览器端只消费 SSE，不再做拼装。
- 好处：dogfood / 无前端 / 多设备场景都能保留完整会话历史。

## 8. Repositories / Services 拆分

| 模块 | 职责 |
|---|---|
| `src/lib/server/repositories/conversationsRepository.ts` | conversations 表 CRUD + revision 比较 |
| `src/lib/server/repositories/conversationMessagesRepository.ts` | messages 表分页/追加/版本更新 |
| `src/lib/server/repositories/conversationEventLogRepository.ts` | 事件日志 append/读取游标 |
| `src/lib/server/services/conversationCommandService.ts` | applyConversationCommand：事务 + 校验 + 事件 + revision++ |
| `src/lib/server/services/conversationProjectionService.ts`（可选） | 给前端投影 API 用，组装 ConversationMeta |

## 9. 数据迁移与一次性导入

服务端：

- `POST /api/conversations/import`，body 为旧 localStorage 的 `conversations: Conversation[]`。
- 仅在 `conversations` 表为空（或 `force=false` 检查）时允许；幂等键 = `migration:<deviceId>`。
- 内部按命令 service 逐条 `create_conversation` + `append_message` 写入，避免绕过事件日志。

客户端：

- 启动时 `RuntimeEventBridge` 检查 localStorage 是否还有旧数据 + 未标记 migrated → 调 import → 清旧数据。
- 失败可重试，标记 `kiki.conversations.migrated.failed_at` 用于排障。

## 10. CI / 回归

新增 spec：

- `src/lib/server/services/conversationCommandService.spec.ts`：覆盖创建 / 重命名 / 置顶 / append 幂等 / update version 落后 / 409。
- `src/lib/server/repositories/conversationMessagesRepository.spec.ts`：seq 单调、分页游标、unique 冲突。
- `src/components/providers/RuntimeEventBridge.spec.tsx`（如已有 setup）：SSE 投影合并幂等。

注册到 [run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts)。

新增脚本：

- `scripts/verify-conversation-command-service.ts`，参照 [verify-goal-command-service.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/verify-goal-command-service.ts)。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 高频流式 `update_message` 触发 409 风暴 | 用 `version` 乐观比较（落后即丢弃），不参与 conversation.revision |
| 消息体过大撑爆事件 payload | 阈值切换：>32KB 只发 `messageId + seq`，浏览器拉详情 |
| `goalInfoCollection` / `planningRunState` 体积膨胀 | 字段 JSON；若 >100KB 再拆 `conversation_state_blobs` 表 |
| SSE 重连/重放重复事件 | event_log id 单调；浏览器维护 `appliedConvEventIds` Set，与现 goal 事件相同模式 |
| 多 Tab 重复 SSE | `BroadcastChannel` 选主 + 心跳；非主 Tab 仅收 broadcast |
| 一次性迁移覆盖服务端数据 | 仅当服务端为空时允许 import；前置 `state` 探测 |
| 前端遗留直写 store | ESLint 自定义规则 + spec 守护 |

## 12. 落地阶段（PR 顺序）

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 | schema v10 + repositories + commandService + spec + 注册 CI | 低（纯加表） |
| P2 | 命令 API + state API + messages 分页 API + SSE | 中 |
| P3 | 浏览器 store 改投影（保留 persist 作 fallback）+ 一次性导入 | 中 |
| P4 | 移除 persist + RuntimeEventBridge 写消息逻辑下沉到 worker | 中 |
| P5 | ESLint 规则禁止 client 直写 + 文档同步 | 低 |

## 13. 验收标准

- [ ] 清空浏览器 localStorage 后刷新，会话列表 + 历史消息完整恢复。
- [ ] 同账号多 Tab 同时操作，消息状态一致，无重复。
- [ ] dogfood daemon 在无前端运行时也能产生完整 task_card 历史（DB 中可查）。
- [ ] 重复 `Idempotency-Key` 命令返回 409，append_message 重复 ID 返回 200。
- [ ] CI 中 `conversationCommandService.spec.ts` 全绿，`run-planning-specs.ts` 通过。
- [ ] 新增表与索引 EXPLAIN QUERY PLAN 走索引，列表查询 P95 < 50ms（5k 会话/100k 消息样本）。
