# 会话页假运行状态修复计划

## Summary

目标是在进入会话页时，确保页面展示的运行状态与真实执行状态一致：

- 如果后端/Claude 实际没有运行，前端不应继续显示“正在...”消息。
- 输入框不应继续 disabled，也不应显示停止按钮。
- 过期的 `conversation.status === "streaming"` 和消息 `status === "streaming"` 应被自动收敛为可理解的结束态。
- 如果会话不存在，不应在 client component 中触发整页 client-side exception。

本次修复重点是会话页的“进入时状态对账”和“离开时中断收尾”，不改目标规划的业务生成逻辑。

## Current State Analysis

### 运行中 UI 的来源

- `src/components/conversation/ConversationView.tsx` 使用 `conversation.status === "streaming"` 控制输入框禁用与停止按钮：
  - `AssistantComposer.disabled={conversation.status === "streaming"}`
  - `AssistantComposer.onStop={conversation.status === "streaming" ? stopGeneration : undefined}`
- `AssistantComposer` 在 `disabled && onStop` 时展示停止按钮。
- 会话消息里的“正在理解目标和关键约束...”来自目标模式初始消息，状态为 `status: "streaming"`。

### 当前问题

- 目标规划/信息收集被中断后，后端日志与 telemetry 已经是 failed/aborted，但前端持久化 store 仍可能保留：
  - `conversation.status: "streaming"`
  - 最后一条 KiKi 消息 `status: "streaming"`
- 进入会话页时没有状态对账逻辑，页面直接相信本地持久化状态。
- 结果是：
  - 消息区仍显示“正在...”。
  - 输入框仍 disabled。
  - 发送按钮仍显示停止按钮。

### 相关文件

- `src/components/conversation/ConversationView.tsx`
  - 启动目标模式、继续目标模式、普通聊天 stream。
  - 保存 `streamAbortRef` 与 `activeAssistantMessageIdRef`。
  - 负责 `stopGeneration()`。
  - 当前缺少“进入页面时发现 stale streaming 并修正”的逻辑。
- `src/stores/conversationStore.ts`
  - 提供 `setConversationStatus()`、`updateMessage()`。
  - 当前没有批量清理 stale streaming 消息的 action。
- `src/components/layout/AssistantComposer.tsx`
  - 停止按钮展示逻辑依赖 `disabled && onStop`，无需直接改 UI。
- `src/components/conversation/ConversationView.tsx`
  - 当前 `if (!conversation) return notFound();` 位于 client component，找不到会话时可能触发 client-side exception。

## Proposed Changes

### 1. 增加会话页进入时的 stale streaming 对账

文件：`src/components/conversation/ConversationView.tsx`

做法：

- 新增一个 `useEffect`，在 `conversation.id` 或 `conversation.status` 变化时执行。
- 如果 `conversation.status !== "streaming"`，不处理。
- 如果当前组件内存在真实活动控制器：
  - `streamAbortRef.current` 存在，并且 `activeAssistantMessageIdRef.current` 指向当前会话中的 streaming 消息，则认为当前页面正在真实运行，不修正。
- 如果没有活动控制器，但持久化状态显示 streaming，则认为这是 stale running state。
- 找到当前会话内最后一条 `status === "streaming"` 且 `role === "kiki"` 的消息。
- 将该消息更新为：
  - `status: "done"`
  - 内容追加 `（已停止，未检测到正在运行的任务）`
  - 如果原内容为空，则写入 `已停止，未检测到正在运行的任务。`
- 将 `conversation.status` 设置为 `idle`。
- 清空本地 `streamError`。

原因：

- 进入会话页时，本组件的 `streamAbortRef` 初始为空；如果本地 store 仍是 streaming，基本可以判断是上一次执行的残留状态。
- 当前系统的真实请求由页面内 `AbortController` 驱动，组件不存在时无法继续由当前页面控制。
- 该方案能直接修正截图中的“消息还在运行、输入框还是停止按钮”的错误样式。

### 2. 组件卸载时主动中断并收尾

文件：`src/components/conversation/ConversationView.tsx`

做法：

- 新增 unmount cleanup effect。
- 如果组件卸载时 `streamAbortRef.current` 仍存在：
  - 调用 `abort()`。
  - 将对应 assistant 消息从 `streaming` 改为 `done`。
  - 追加 `（已中断）`。
  - 将会话状态设为 `idle`。
  - 清理 `streamAbortRef` 和 `activeAssistantMessageIdRef`。

原因：

- 避免用户切换页面、刷新、路由跳转时，前端状态继续停留在 streaming。
- 与现有 `stopGeneration()` 的语义保持一致。

### 3. 将停止逻辑抽成统一 helper

文件：`src/components/conversation/ConversationView.tsx`

做法：

- 抽出一个内部函数，例如 `finalizeInterruptedStream(reasonText)`。
- `stopGeneration()`、unmount cleanup、stale streaming 对账都复用它。
- helper 负责：
  - abort 当前 controller。
  - 更新 active assistant message。
  - 设置会话 `idle`。
  - 清理 refs。

原因：

- 避免三处逻辑分叉导致以后再次出现“后端停了但 UI 没停”的问题。

### 4. 找不到会话时避免 client-side exception

文件：`src/components/conversation/ConversationView.tsx`

做法：

- 替换 `if (!conversation) return notFound();`。
- 改为客户端安全空态：
  - 展示“会话不存在或已被删除”。
  - 提供返回 `/conversations` 的按钮。
- 或在 effect 中执行 `router.replace("/conversations")`，同时 render 一个轻量空态。

推荐方案：

- 显示空态并提供返回按钮，不自动跳转。

原因：

- 当前 `notFound()` 在 client component 中会导致截图中的 `Application error: a client-side exception has occurred`。
- 空态能避免整页崩溃，也方便用户理解发生了什么。

### 5. 可选：给 conversationStore 增加批量修正 action

文件：`src/stores/conversationStore.ts`

做法：

- 增加 action：`reconcileStaleStreaming(conversationId, messageSuffix)`。
- 该 action 一次性完成：
  - 将 conversation status 设为 `idle`。
  - 将该会话中所有 `status === "streaming"` 的消息设为 `done`。
  - 只给最后一条 streaming KiKi 消息追加说明。

推荐实施：

- 如果只改 `ConversationView.tsx` 就能完成，优先不加 store action，保持改动小。
- 如果实现中出现多处重复更新，再加 store action。

## Assumptions & Decisions

- 进入会话页时，如果本组件没有活动 `AbortController`，但本地 store 显示 `streaming`，视为 stale 状态。
- stale 状态修正为 `idle + done`，而不是 `error`，因为用户看到的是“任务已经不在运行”，不是新的执行错误。
- 保留原“正在...”文本，并追加停止说明，避免丢失历史上下文。
- 不在本次改动中新增服务端 API。
- 不在本次改动中修改目标规划 JSON 协议或任务执行逻辑。
- 停止按钮仍由 `conversation.status === "streaming"` 控制；修复后只要状态对账正确，按钮自然恢复为发送按钮。

## Verification Steps

1. 构造一个会话，使其本地状态为：
   - `conversation.status = "streaming"`
   - 最后一条 KiKi 消息 `status = "streaming"`
   - 但没有真实 Claude 进程运行。
2. 进入该会话页。
3. 验证消息区：
   - 不再持续显示纯“正在...”状态。
   - 最后一条 streaming 消息被标记为 done，并追加“已停止/未检测到运行中任务”说明。
4. 验证输入框：
   - textarea 可输入。
   - 右下角显示发送按钮，不显示停止按钮。
5. 切换到另一个会话再切回，状态保持正确。
6. 启动一次正常 `/goal`，确认真实运行期间：
   - 输入框 disabled。
   - 停止按钮显示。
   - 点击停止后消息变成已中断，输入框恢复。
7. 访问不存在的 `/conversations/{id}`。
8. 验证不再出现 client-side exception，而是展示“会话不存在或已被删除”的空态。
9. 运行：
   - `pnpm lint`
   - `GetDiagnostics` 检查改动文件。

