# Claude Session ID 持久化根因修复方案

## Summary

修复"刚清理完数据后新建会话，发出第二轮消息时 Kiki 气泡空白"的根因：Claude CLI 的 stream-json 输出会从多个事件来源里携带 `session_id`（`system.subtype=init`、`hook_started`、`hook_response`、`result.error_during_execution` 等），目前 [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L650-L651) 对每一个 `session_id` 都向上层广播 `session` 事件，[ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx#L999-L1001) 又会无条件把它写回 store 与服务端，从而把 hook/错误结果里的非规范 session id 覆盖掉了 init 阶段的真实 session id。下一轮 `--resume <bad-id>` 必然失败，CLI 返回的错误又被静默丢弃（assistant 气泡只翻 `status`，`content` 仍为空字符串），表现为"什么都没回"。

修复目标：

1. **transport 层只广播一次"权威 session id"**（来自 `system.subtype=init` 且会话期间不变）。
2. **结果错误显式上抛**：`result.subtype !== "success"` 时如果错误文本包含 `No conversation found with session ID`，转换为可识别的恢复事件 `session_invalid`，让前端清掉坏 id 并提示。
3. **前端错误事件落到气泡内容**：避免气泡空白；同时把 `session_invalid` 与 `error` 区分处理。
4. **store 端加幂等护栏**：单次会话生命周期内，已锁定的 `claudeSessionId` 在没有显式 `clear`/`session_invalid` 的情况下不被覆盖。

## Current State Analysis

### 问题路径

1. [src/lib/server/claude/transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L637-L651) `consumeLine` 解析每一行 stream-json：
   ```ts
   const nextSessionId = payload.session_id;
   if (nextSessionId && !emitEvent({ type: "session", sessionId: nextSessionId })) return;
   ```
   这里 **无差别** 对 `payload.session_id` 触发 `session` 事件。Claude CLI 的 stream-json 会在 `system.subtype="init"`、`hook_started`、`hook_response`、`result.error_during_execution` 等多个 envelope 上各自携带 `session_id`，并不全部等于会话主 session。

2. [src/components/conversation/ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx#L999-L1001):
   ```ts
   if (event.type === "session") {
     setClaudeSessionId(conversation.id, event.sessionId);
     return;
   }
   ```
   每来一次 `session` 都会写一次 store + 经命令 API 写回服务端，最后一次 emit 到的 hook session id（或 error session id）成为 `conversations.claudeSessionId` 的最终值。

3. [src/stores/conversationStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/conversationStore.ts#L414-L421) `setClaudeSessionId` 没有任何幂等/竞态保护，最后写入即生效。

4. 下一轮 `streamClaudeCli` 拿到的 `claudeSessionId` 不是真实 session，CLI 返回 `result.subtype="error_during_execution"` + `result="No conversation found with session ID: ..."`。当前代码在 [transport.ts result 分支](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L737-L747) 里只是 `emitEvent({ type:"error", message })`。

5. 前端 [error 分支](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx#L1022-L1030) 只把消息状态改为 `"error"`，不写 `content`，所以气泡保持空白且没有任何提示。

### 影响

- 任何一次包含 hook session_id 的事件都会污染 conversation 的真实 session。
- 一旦污染，所有后续轮次都会失败，且失败信息对用户不可见。
- 因为坏 session id 已经持久化到 SQLite（`conversations.claudeSessionId` + `conversation_event_log` 中的 `claude_session_set`），刷新/换标签页/换浏览器都救不回来。

## Proposed Changes

### 1. `src/lib/server/claude/transport.ts`：只在 init 阶段广播 session

**目标**：让 `session` 事件成为"权威 session id"的唯一来源，过滤掉 hook 与错误结果里的副作用 session_id。

**改动点**（在 `consumeLine` 内）：

- 移除当前位于解析最前面、对所有 payload 都触发的 `emit "session"` 代码块（[transport.ts L650-L651](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L650-L651)）。
- 在闭包顶部新增 `let canonicalSessionId: string | undefined;`。
- 仅在 `payload.type === "system" && payload.subtype === "init"` 分支里记录并广播：
  ```ts
  if (payload.type === "system" && payload.subtype === "init") {
    if (payload.session_id && !canonicalSessionId) {
      canonicalSessionId = payload.session_id;
      if (!emitEvent({ type: "session", sessionId: canonicalSessionId })) return;
    }
    // 现有 status 分支保持不变（status 子类型在另一个 if 中处理）
  }
  ```
- 其他分支（`stream_event`、`assistant`、`result`、未知 hook 事件）**禁止** 再触发 `session`。
- 即使同一次 CLI 调用里 init 出现多次（理论不会），也只取第一个；后续如果出现不同的 session id，写一行 `trace?.appendStdout` 警告以便排查，但不向上广播。

**为什么**：根据 Claude Code stream-json 协议，`system.subtype="init"` 是会话开始的权威信号，其 `session_id` 与 `--resume` 参数一致；hook 事件携带的 session_id 与会话级 session 无关，error_during_execution 的 session_id 经常是 CLI 内部错误上下文。只锁定 init 即可彻底消除歧义。

### 2. `src/lib/server/claude/transport.ts`：错误结果显式区分 `session_invalid`

**目标**：让前端能识别"上一次 resume 用了坏 id"，自动恢复而不是停在错误状态。

**改动点**（`payload.type === "result"` 且 `subtype !== "success"` 分支，[transport.ts L737-L747](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L737-L747)）：

```ts
const errorMessage =
  payload.result ||
  payload.errors?.join("\n") ||
  payload.api_error_status ||
  "Claude 返回了错误结果";

emittedFatalError = true;

if (
  options.claudeSessionId &&
  /No conversation found with session ID/i.test(errorMessage)
) {
  emitEvent({
    type: "session_invalid",
    sessionId: options.claudeSessionId,
    message: errorMessage,
  });
  return;
}

emitEvent({ type: "error", message: errorMessage });
return;
```

**对应类型扩展**（[transport.ts L71-L79](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L71-L79)）：

```ts
export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "session_invalid"; sessionId: string; message: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "delta"; text: string }
  | { type: "message"; content: string; fallbackContent?: string }
  | { type: "tool_call"; toolName: string; summary: string; input?: unknown; index?: number }
  | { type: "permission_request"; reason: string }
  | { type: "error"; message: string }
  | { type: "done" };
```

### 3. `src/lib/api/claude.ts`：放行 `session_invalid` 事件

[claude.ts L7-L20](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/claude.ts#L7-L20) 的 `parseEventType` 加上 `case "session_invalid":` 分支。

### 4. `src/app/api/claude/chat/route.ts`：透传无需改动

route 层用 `writeSseEvent(controller, event.type, event)` 直接转发，会自动透传新事件。**仅需确认** `ClaudeStreamEvent` 类型在 `@/types/runtime` 中也加了对应分支（如果该文件单独维护类型，需要同步更新）。

### 5. `src/components/conversation/ConversationView.tsx`：错误落到气泡内容 + 自动恢复

**改动点 A**：`error` 分支必须把错误文本写进 `content`，避免空白气泡。

```ts
if (event.type === "error") {
  setStreamError(event.message);
  updateMessage(conversation.id, assistantId, (message) => ({
    ...message,
    content: message.content || `（任务失败：${event.message}）`,
    status: "error",
  }));
  setConversationStatus(conversation.id, "error");
  return;
}
```

**改动点 B**：新增 `session_invalid` 处理：清掉 store 与服务端的 `claudeSessionId`，并在气泡内提示用户"会话已重置，请重发"。**不自动重发**（避免与用户输入竞态、避免双倍 token 消耗），交由用户重新点 Send。

```ts
if (event.type === "session_invalid") {
  setClaudeSessionId(conversation.id, undefined);
  const hint = "上一轮 Claude 会话已失效，已自动重置。请重新发送消息。";
  setStreamError(hint);
  updateMessage(conversation.id, assistantId, (message) => ({
    ...message,
    content: message.content || `（${hint}）`,
    status: "error",
  }));
  setConversationStatus(conversation.id, "error");
  return;
}
```

**改动点 C**：保留原有 `session` 处理逻辑（由于 transport 层已限制为 init 期一次性广播，前端无须再做额外判重）。

### 6. `src/stores/conversationStore.ts`：`setClaudeSessionId` 支持显式清除

当前签名 `setClaudeSessionId(conversationId, claudeSessionId: string)`，需支持 `undefined` 表示"清除"。

```ts
setClaudeSessionId: (conversationId, claudeSessionId) => {
  set({
    conversations: get().conversations.map((item) =>
      item.id === conversationId ? { ...item, claudeSessionId } : item,
    ),
  });
  sendConversationCommand(setConversationClaudeSessionCommand(conversationId, claudeSessionId));
},
```

- 类型签名更新为 `(conversationId: string, claudeSessionId: string | undefined) => void`。
- 命令构造器 `setConversationClaudeSessionCommand` 也需要支持 `undefined`，对应服务端 reducer 设为清空。需要同步检查 [src/lib/api/conversation-commands.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/conversation-commands.ts)、`conversationsService` 命令处理与 SQLite 列约束（应为 nullable）。
- 不引入"幂等护栏"——既然 transport 已经过滤，store 层无需再判重；保持简单。

### 7. 类型同步 `src/types/runtime.ts`

如果 `ClaudeStreamEvent` 同时声明在 `src/types/runtime.ts`，必须同步加上 `| { type: "session_invalid"; sessionId: string; message: string }`，避免两侧类型漂移。Phase 1 未直接打开此文件，**实施时需先 grep 确认**：
```
grep -rn "ClaudeStreamEvent" src/
```
若有重复定义，统一从 `transport.ts` 导出，或两处保持一致。

## Assumptions & Decisions

- **不自动重发**：`session_invalid` 只清 id 并提示。理由：自动重发会和用户输入竞争、可能重复扣费、且 ASTS 等场景里需要用户确认上下文丢失。
- **init 优先**：选择 `system.subtype === "init"` 作为权威 session 来源，是依据 Claude Code stream-json 公开协议；如果未来 CLI 更新了协议，需要回到此点重新确认。
- **保留 trace 写日志**：non-init 但携带新的 `session_id` 的事件不会广播，但需要写到 trace（便于排查异常 hook）。
- **服务端 SQLite 列**：`conversations.claudeSessionId` 必须允许 `NULL`（命令清除）。若现有 schema 是 `NOT NULL`，需要 migration v? 改为可空——实施时先用 `sqlite3 .schema conversations` 验证。
- **不改聚合 SSE 路由**：本次问题与 SSE 链接无关，不动 `/api/runtime/events/stream`。
- **不动 `setConversationClaudeSessionCommand` 事件类型**：保持现有 `conversation.claude_session_set` 事件类型，仅扩展其 payload 允许 `claudeSessionId === null`。

## Verification

1. **类型 / 静态检查**：
   - `pnpm tsc --noEmit`
   - `pnpm lint`

2. **回归 Spec**：
   - `pnpm test:planning`
   - 新增 1 个 spec：在 `src/lib/server/claude/transport.spec.ts`（若不存在则创建）注入伪造 stdin 流，覆盖：
     - 仅 init 触发 `session` 事件
     - hook_started/hook_response 携带 session_id 不会触发 `session`
     - `result.error_during_execution` 且 message 含 "No conversation found with session ID" 时触发 `session_invalid`
     - 普通 error 仍触发 `error`
   - 在 `scripts/run-planning-specs.ts` 注册新 spec。

3. **端到端手测**：
   - `pnpm dev`，新建一个 ASTS 会话，发送 3 轮消息，确认每轮都能正常返回，`select claudeSessionId from conversations` 一次锁定后不变。
   - 强制污染场景：在 SQLite 里手工把 `claudeSessionId` 改为一个不存在的 id，再发一条消息，确认：
     - 气泡显示"会话已失效"提示而非空白；
     - `claudeSessionId` 被清空；
     - 用户再次点 Send 后可以正常开始新一轮（init 会发一个新的真实 session id）。
   - 观察 `data/.trae/claude-traces/` 下 trace，确认非 init 的 session_id 不再触发 store 写回。

4. **Telemetry**：检查 `conversation_event_log` 不再出现频繁的 `claude_session_set` 振荡（同一会话内多次切换 id）。

## Out of Scope

- 不修改 SSE 聚合通道、命令乐观锁等已稳定模块。
- 不引入"sessions 表"或专门的 `claude_session` 抽象——本次以最小代价解决根因即可。
- 不处理 Claude CLI 自身的 `--resume` 失败重试策略（交由 CLI 上游处理）。
