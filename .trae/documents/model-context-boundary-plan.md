# 模型上下文边界（Model Context Boundary）治理方案

## Summary
当前 KiKi 在每次调用 Claude CLI 时，会把后端内部元数据（`conversationId`、`status`、`title`、`goalId`、`subGoalId`、`taskId`、`instanceId`、`planningRunState.errorMessage` 等）和"边界规则提示"一同拼进 prompt。模型在低信息输入（如首轮 `hi`）下会复述这些内部 ID 与状态字段，污染面向用户的回复气泡。

本方案要从**系统框架层面**重新定义"模型可见上下文"的边界：明确字段白/黑名单、统一的脱敏过滤层、所有 prompt 拼接点的接入方式，以及对应的回归手段。修复后第一轮 greeting 不应再复述任何内部 ID/字段，业务侧依然能依赖必要的语义上下文继续工作。

## Current State Analysis

### 1. 模型上下文进入路径（Phase 1 探索结论）
所有 Claude prompt 拼装最终汇聚在 [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L455-L487) 的 `buildWorkspaceBoundPrompt`，调用方有四类：

| 路径 | 入口 | 上下文来源 |
| --- | --- | --- |
| 会话主对话（用户聊天） | [route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L36-L48) → `streamClaudeCli` → `streamPrompt` | `buildConversationContextPack` |
| 会话 workspace context 落盘 | [route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/conversations/%5BconversationId%5D/workspace/context/route.ts#L33-L40) | `buildConversationContextPack` |
| 任务执行 Agent | [goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L2289) / [prompts.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L224-L232) | `buildGoalTaskRunnerPrompt` |
| 目标规划（goal planning） | [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L639-L719) → `runPromptJson` / `runPromptText` | 各 planning prompt |

### 2. 当前正在向模型暴露的"内部字段"清单

**`buildConversationContextPack`** [contextPack.ts L56-L113](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts#L56-L113)：
- `conversationId`（内部主键）❌
- `title`、`status`（内部状态）⚠️ 部分字段没必要进 prompt
- `planningRunState.{phase, action, errorMessage, goalText}`（恢复元数据，含错误堆栈）❌ 至少 errorMessage 不该原样回灌
- `quotedMessage.taskRef.{goalId, subGoalId, taskId, instanceId}` ❌ 内部 ID
- `recentMessages[].createdAt`（ISO 时间戳）⚠️ 时间戳精确到毫秒，模型容易复述

**`buildTaskContextPack`** [contextPack.ts L116-L156](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts#L116-L156)：
- `instanceId` ❌

**`buildGoalTaskRunnerPrompt` 链路**：[prompts.ts L224-L232](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L224-L232) 把 `identity.{conversationId, goalId, subGoalId, taskId, instanceId}` 注入 `TaskExecutionContext`，再被 prompt 拼装使用。需要在同一过滤层处理。

### 3. 根因
`contextPack.ts` 同时承担了两件事：
1. **系统约束声明**（边界规则）→ 模型必须看到。
2. **内部状态注入**（ID/status/timestamp）→ 模型不该看到。

二者混在一个文本块里，并且没有任何"对模型脱敏"的统一过滤层。一旦用户输入信息量低，模型就会把内部块当作"用户的问题语境"复述出来。

### 4. 还有什么"信息泄露"风险点
- **错误信息**：`planningRunState.errorMessage` 可能包含本地路径、CLI 报错（含真实文件名）。
- **会话标题**：用户自定义标题可能包含敏感语义；当前直接进 prompt。
- **依赖任务**：`buildGoalTaskRunnerPrompt` 的 `renderDependencySection` 会把依赖任务标题/描述全文塞入。
- **执行轨迹**：`previousAssistantOutputs` 截断 600 字，但 `step.thought` 中可能包含其它任务残留。
- **workspace 路径**：`buildWorkspaceBoundPrompt` 会向模型直接暴露绝对路径 `当前工作目录是隔离 workspace：${workspaceDir}`。这是当前工作机制必须的，但可考虑只露相对名/会话短码。

### 5. 关键反例：哪些字段必须**保留**进 prompt（不能盲目脱敏）
经过对 [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L307-L389) Output Template 的复核，**任务执行 Agent** 的 prompt 在输出 JSON 模板中要求模型回填：
```
"task_result": { "taskId": "${task.id}", "instanceId": "${instance.id}", ... }
```
也就是说**任务执行链路的 `taskId` 和 `instanceId` 是契约的一部分**，模型必须看到这些 ID 才能正确回填。如果在 task 路径里盲目脱敏，会破坏 `task_result` 的回填契约，下游 `goalTaskRunner` 无法把结果挂回正确实例。

**结论**：脱敏策略必须**按调用路径分层**，不能统一一刀切。
- ✅ 会话主对话（`/api/claude/chat`）：用户视图，严格屏蔽所有内部 ID。
- ⚠️ 任务执行链路（`buildGoalTaskRunnerPrompt` / 多 Agent prompts）：保留 `taskId` / `instanceId`（契约必需），但回复内容由 `goalTaskRunner` 解析为结构化 JSON 后再呈现，前端不会直接把 raw assistant 文本写到对话气泡中——所以这条路径**不算用户可见泄露面**。
- ⚠️ goal planning（`runPromptJson`）：返回 JSON 全部由后端解析，模型回复也不直接进对话气泡，可保留必要字段。

**一句话原则**：屏蔽边界应当是"模型回复直接落到 ConversationView 用户气泡里"的那条链路。

## Proposed Changes

### 设计原则
按"模型回复是否直接进入用户对话气泡"区分两类调用路径，分别采用不同策略：

**Class A — 用户对话路径**（`/api/claude/chat`、`workspace/context` 落盘）：模型回复直接进 `conversation_messages` 表 → ConversationView 气泡。必须采用严格白名单 + 全文净化。
**Class B — 后端结构化路径**（`buildGoalTaskRunnerPrompt`、agent orchestration、goal planning、runtimeEnv probe）：模型回复必须为可解析 JSON，由 `goalTaskRunner` / `goalPlanning` 解析后再展示。这类路径允许保留 `taskId` / `instanceId` 等契约字段，但仍需对错误信息、绝对路径做最小化处理。

把"传给模型的信息"分为四层，并以白名单（allowlist）模式管理：
1. **System Layer（系统层）** — 角色、边界规则、工具策略。明文进 prompt。
2. **Semantic Context Layer（语义上下文层）** — 目标/子目标/任务的标题、描述、摘要，最近消息正文（脱敏）。明文进 prompt。
3. **Runtime Hint Layer（运行时提示层）** — 真正需要 Claude CLI 自己决策的信息，例如 workspace 目录、resume context、planning phase 名（仅枚举值）。明文进 prompt，但要做格式化。
4. **Internal Metadata Layer（内部元数据层）** — `conversationId`/`goalId`/`subGoalId`/`taskId`/`instanceId`/`createdAt`/`errorMessage` 等。**Class A 路径默认禁止进 prompt**；Class B 路径仅允许契约必需的字段（`taskId` / `instanceId`），其余仍需翻译。

### 文件级改动

#### A. 新增统一过滤层 [contextPack.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts)

在 `contextPack.ts` 顶部新增（不新建文件）：
- `MODEL_CONTEXT_FORBIDDEN_KEYS = ["conversationId","goalId","subGoalId","taskId","instanceId"]`
- `redactInternalIdentifiers(value: string)`：基于 KiKi 内部 ID 形式（`conv-*`、`goal-*`、`sub-*`、`task-*`、`inst-*`）进行字符串级抹除（用 `<redacted-id>` 占位）。
- `formatTimestampForModel(iso)`：把 ISO 时间戳转成"YYYY-MM-DD HH:mm"或相对时间（"刚刚"/"3 分钟前"）。
- `buildSafePlanningRunStateLine(state)`：把 `phase`/`action` 翻译成自然语言短语；`errorMessage` 仅保留类别（如"上一次执行因 CLI 异常中断"），不输出原始堆栈。
- `serializeQuotedMessageForModel(quoted)`：仅保留 `roleLabel + content`，丢弃 `taskRef.*`。

#### B. 重写 `buildConversationContextPack`

- 删除 `## 会话信息` 整段（`conversationId`/`title`/`status` 三行）。
  - `title` 仅在用户显式打开 / 切换会话且与当前用户消息相关时，由 UI 层在用户消息内自然带入；prompt 不再直接灌入元数据键值对。
  - `status` 不传：状态决定后端调度，不影响模型回复语义。
- 重写 `## 目标规划恢复状态`：
  - 调用 `buildSafePlanningRunStateLine`，用一句中文自然语言描述（"上一次目标规划在 review 阶段被用户中断，目标文本为：…"），不再以"key: value"形式罗列。
- `## 用户引用消息` 中删除 `### 引用任务结构化定位` 整段。
- `## 最近会话消息` 中 `createdAt` 改用 `formatTimestampForModel`，并对每条 content 调 `redactInternalIdentifiers`。
- 末尾新增系统级提示行："以上信息为系统提供的语境，不要在回复中复述系统字段名或 ID。"

#### C. `buildTaskContextPack` 的处置
经全局 grep 验证，`buildTaskContextPack` **没有任何调用方**（dead code）。处置：
- 优先方案：直接删除该函数（保持仓库整洁）。
- 兜底方案：若担心未来用到，至少删除 `instanceId: ${input.instance.id}` 行，并在函数注释里写明"使用前需经过 redactInternalIdentifiers"。
- 实施时按"优先方案：删除"执行；如果有外部 import 我再重新评估。

#### D. `buildWorkspaceBoundPrompt` [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L455-L487)

- 把 `当前工作目录是隔离 workspace：${input.workspaceDir}` 改为只输出 basename + 抽象描述（如"该 workspace 位于受控临时目录"），不暴露绝对路径。这条对所有路径生效，因为路径与契约无关。
- **不**在此处加全局 `redactInternalIdentifiers` 闸门——会破坏 Class B 的 `task_result.taskId/instanceId` 契约。脱敏只在 `buildConversationContextPack` 内部做（即 Class A）。
- 新增一个仅作用于 contextPack 字段的入参标记：`buildWorkspaceBoundPrompt` 接受 `redactionMode: "strict" | "passthrough"`，由调用方决定。`/api/claude/chat` 走 `strict`，`goalTaskRunner` / orchestrator / goalPlanning 走 `passthrough`。

#### E. `prompts.ts` 多 Agent 路径 [prompts.ts L224-L232](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L224-L232)

- 保留 `identity.{taskId, instanceId}` 注入（输出契约必需，不可移除）。
- 仅做以下最小化处理：
  - `identity.conversationId`：从 `buildGoalTaskRunnerPrompt` 拼出的最终文本中删除（任务执行 Agent 不需要会话主键，回填 JSON 也不要求）。
  - `goalId` / `subGoalId`：保留（部分 review/synthesizer 角色 prompt 需要在 handoff 中引用）。
  - 同样把 trajectory 中的 `step.thought` 等大段文本走 `redactInternalIdentifiers`，但不影响 `taskId`/`instanceId` 字面字符串（净化函数应只匹配会话级 ID 前缀 `conv-`）。

#### F. `route.ts` 入口收敛 [api/claude/chat/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L36-L48)

- 不再相信前端传来的 `body.contextSnapshot.conversation` 全字段。仅按白名单提取：`title`、`messages`、`planningRunState`，丢弃其他属性。
- 如果未来要用 `goal`，同样按白名单（`title`、`summary`、`subGoals[].title`、`subGoals[].tasks[].{title,description,expectedOutcome,instances[last].status}`）取。

#### G. 落盘 `context.md` 不污染同源
[api/conversations/.../workspace/context/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/conversations/%5BconversationId%5D/workspace/context/route.ts) 也走新版 `buildConversationContextPack`，自动同步净化。

#### H. 客户端 `recentMessages` 切片越界（一并修正）
[route.ts L37-L39](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L37-L39) 当前只取最近 20 条。`buildConversationContextPack` 内部又再 `slice(-12)`。但 `slice(-20)` 和 `sanitizeConversationMessages` 没有任何字段白名单，整个 `ConversationMessage` 对象（含 `id`、`taskRef`、`structured` 等内部字段）都会进入函数。即便 `buildConversationContextPack` 当前不输出这些字段，前端也已经把它们打包传到了服务端 SSE。需要在 sanitize 阶段就只保留 `{role, content, createdAt}`，作为深度防御。

#### I. 系统层"不要复述 ID 与字段名"指令的位置
仅在 contextPack 末尾追加提示不够（模型会把 contextPack 视为输入数据）。应把"不要复述系统字段名、不要复述以 conv-/goal-/sub-/task-/inst- 开头的标识符、不要复述 workspace 路径"这条规则写进 **System Layer**，即 [transport.ts L463-L469](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L463-L469) 的 `buildWorkspaceBoundPrompt` 顶部 parts 数组（仅 `redactionMode: "strict"` 时附加）。

### 字段决策表（最终白/黑名单）

| 字段 | 是否进 prompt | 替代方案 |
| --- | --- | --- |
| conversationId / goalId / subGoalId / taskId / instanceId | ❌ | 完全删除；workspace 隔离已足够 |
| conversation.title | ❌（默认） | 仅当与用户当前提问语义强相关时由 UI 层用自然语言带入 |
| conversation.status | ❌ | 后端调度用，模型不需要 |
| planningRunState.phase / action | ✅ 翻译后 | 自然语言短语 |
| planningRunState.errorMessage | ❌ | 仅保留"上一次执行失败"语义 |
| planningRunState.goalText | ✅ | 用户原始目标文本，必要 |
| quotedMessage.content / roleLabel | ✅ | 必要 |
| quotedMessage.taskRef.* | ❌ | 删除整段 |
| recentMessages[].content | ✅ 净化后 | 走 `redactInternalIdentifiers` |
| recentMessages[].createdAt | ✅ 格式化 | 改成"YYYY-MM-DD HH:mm" 或相对时间 |
| goal.title / summary / subGoals[].title / tasks[].title/description/expectedOutcome | ✅ | 必要 |
| workspaceDir 绝对路径 | ⚠️ → 仅 basename | 通过 buildWorkspaceBoundPrompt 改写 |
| 工具策略（allowed / disabled） | ✅ | 已有逻辑保留 |

## Assumptions & Decisions

1. **不破坏 Claude CLI 隔离机制**：workspace 路径仍以绝对路径作为 `--cwd` 参数传给 CLI 进程；只是不在 prompt 文本里告诉模型完整路径。
2. **不引入新文件**：所有过滤函数都加在 `contextPack.ts`，因为它已经是上下文聚合层；`transport.ts` 只多调一次最终净化函数。
3. **白名单优先**：宁可删字段后回归发现某条 UX 缺失再补，也不留"全字段透传"的口子。
4. **测试策略**：在 [scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts) 已有的 spec 注册机制下，新增 `runContextPackBoundarySpecs`，断言：
   - 给定 conversation + goal + quotedMessage + recentMessages，生成的 prompt 文本不包含 `conversationId`、`goalId`、`subGoalId`、`taskId`、`instanceId` 字面字符串。
   - 不包含 `conv-`、`goal-`、`sub-`、`task-`、`inst-` 前缀的 ID。
   - 不包含 ISO 8601 毫秒时间戳模式 `T\d{2}:\d{2}:\d{2}\.\d{3}Z`。
   - planningRunState.errorMessage 中嵌入的关键词（如 `Error:`、`Traceback`、绝对路径 `/Users/`）不出现在 prompt 中。
   - quotedMessage.content 仍然存在。
   - workspace prompt 中不出现 `/Users/` 绝对路径。

## Verification

1. `pnpm tsc --noEmit` —— 类型层无回归。
2. `pnpm lint` —— 风格无回归。
3. `pnpm test:planning` —— 含新增 contextPack 边界 spec，全绿。
4. **手测（Class A）**：
   - 启动 `pnpm dev`，新建空会话，发送 `hi`。期望：Kiki 不再回复"conversationId: conv-xxx"或"status: idle"。
   - 在已有目标会话里 `@` 引用一条 task 消息发送追问。期望：Kiki 仍能理解"被引用消息"的内容，但回复气泡中不出现 `goalId` / `taskId` / `instanceId` 字面字符串及 `goal-` / `task-` / `inst-` 前缀。
   - 手动构造一次 planning 失败后 resume，发送"继续"。期望：Kiki 给出"上次执行被中断，将从 …继续"语义化回复，不复述 errorMessage 原文。
5. **手测（Class B 不能误伤）**：
   - 触发一次 goal task 执行，确认 `task_result.taskId` / `task_result.instanceId` 仍然被正确回填，`goalTaskRunner` 能把结果挂回原实例（即避免脱敏过度破坏契约）。
   - 触发一次目标规划，确认 planning JSON 解析仍正常。
6. **DB 抽查**：取 `kiki.db` 的 `conversation_messages.content where role='assistant'` 抽样 20 条**对话气泡**回复（排除 task 执行结果回填的 message），grep `conv-|goal-|sub-|task-|inst-` 应为空。
7. **回归 spec 严谨化**：spec 必须分别覆盖 Class A 和 Class B：
   - Class A（buildConversationContextPack 输出）：断言不含任何内部 ID 与 ISO 毫秒时间戳。
   - Class B（buildGoalTaskRunnerPrompt 输出）：断言**仍包含** `taskId` / `instanceId`，防止误删契约字段；同时断言不含 `conversationId` 与绝对路径 `/Users/`。

## Logic Self-Check（自我审查）

| 风险点 | 说明 | 是否已处理 |
| --- | --- | --- |
| 全局脱敏破坏 task_result 回填契约 | `goalTaskPrompt.ts` 模板要求模型输出 `task_result.taskId/instanceId` | ✅ 改为分路径策略（Class A vs B） |
| `buildTaskContextPack` 是否还在用 | grep 全仓无调用方 | ✅ 删除 dead code |
| 前端 `contextSnapshot` 包含完整 ConversationMessage 对象 | `messages[]` 含 `id`、`taskRef`、`structured` 等不该上行的字段 | ✅ 在 sanitize 时用字段白名单 |
| "不要复述字段名"提示放在 contextPack 末尾会被当输入 | 模型会把它视为数据而非系统指令 | ✅ 改为放进 System Layer parts 数组顶部 |
| workspace 绝对路径 | 所有路径均不应暴露 `/Users/...` | ✅ buildWorkspaceBoundPrompt 改 basename，对 A/B 都生效 |
| planningRunState.errorMessage | 包含 CLI 报错堆栈、本地路径 | ✅ buildSafePlanningRunStateLine 仅保留语义类别 |
| recentMessages 中 createdAt | 模型容易复述毫秒时间戳 | ✅ formatTimestampForModel |
| quotedMessage.taskRef.* | 内部 ID | ✅ serializeQuotedMessageForModel 删除 taskRef |
| Class B 路径中 `goalId` / `subGoalId` 被误删 | review/synthesizer 的 handoff 文本依赖它们 | ✅ 仅删 `conversationId`，保留 goalId/subGoalId |
| context.md 落盘文件被 Claude 后续 Read 读取 | 落盘文件也是模型可见面 | ✅ workspace/context/route.ts 同步走新版 |
| `runtimeEnvValidation.ts` 的 `runPromptJson({prompt:"请只回复 ok"})` | 极简 prompt，无内部信息 | ✅ 不需要改 |

## Out of Scope

- 不重构 `TaskExecutionContext.identity` 数据结构（后端调度仍依赖 ID）。
- 不引入加密/哈希等强脱敏（当前仅需"对模型可见性"的边界）。
- 不修改 SSE/数据库 schema。
- 不调整 multi-agent strategy 选择逻辑。

---

## Plan Review v2（基于已实施代码再次审查发现的逻辑漏洞）

下列项目是对照 [contextPack.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts)、[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts)、[chat/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts) 当前实现状态再次审查后发现的**未被原方案覆盖**或**实现与方案不一致**的问题。批准后逐项闭环。

### J. workspace basename 仍是内部 conversationId（CRITICAL）

[transport.ts L476](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L476)：
```ts
const workspaceLabel = input.workspaceDir.split("/").filter(Boolean).pop() || "workspace";
```

而 [conversationWorkspace.ts L27-29](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/conversationWorkspace.ts#L27-L29)：
```ts
return path.join(getConversationWorkspacesRootDir(), sanitizeWorkspaceSegment(conversationId));
```

`sanitizeWorkspaceSegment` 仅过滤非字母数字字符，保留 `-`，所以 `conversationId="conv-1f3a..."` 经 sanitize 后仍为 `conv-1f3a...`。最终 prompt 写入：
```
当前工作目录是受控隔离 workspace（标识：conv-1f3a...）。
```
完全暴露内部 ID。`redactInternalIdentifiers` 只作用于 contextPack 文本，**不作用于 System Layer parts**，所以这条链路绕过了所有脱敏。

**修正方案**：
- `buildWorkspaceBoundPrompt` 内部对 `workspaceLabel` 做处理：
  - 如果匹配内部 ID 模式（`/^(conv|goal|sub|task|inst)-/`），改用 `"isolated-session-<short-hash>"`，其中 short-hash 取 `workspaceLabel` 经 `crypto.createHash("sha1").update(label).digest("hex").slice(0,8)`。
  - 否则保留 basename（用户自定义路径场景）。
- 同时对所有 System Layer parts 在 strict 模式下做一次 `redactInternalIdentifiers` 兜底（防御 `workspacePolicy`、`toolSummary` 等其他字段未来意外携带 ID）。
- passthrough 模式不做兜底，因为 Class B 的 task_result 契约依赖原文 ID。

### K. quotedMessage 在 transport 层被二次原文注入（CRITICAL）

[transport.ts L449-463](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L449-L463) 的 `buildPrompt` 在 prompt 末尾再次注入 raw `quotedMessage`：
```ts
parts.push(
  `以下是当前用户引用的上下文，请优先参考：`,
  `[${quotedMessage.roleLabel}] ${quotedMessage.content}`,
);
```

而 contextPack 内部的 `serializeQuotedMessageForModel` 已经把 `quotedMessage.content` 经过 `redactInternalIdentifiers` 处理。**这意味着**：
- contextPack 段："上下文清洁版"。
- prompt 末尾段：原文（未脱敏，可能含 `task-xxx`、`goal-xxx`）。

模型同时看到两份引用，且**原文版优先级更高**（"请优先参考"），脱敏失效。

**修正方案**：
- 在 `buildWorkspaceBoundPrompt` 内拼装 prompt 末尾的 `buildPrompt` 调用前，根据 `redactionMode` 把 `quotedMessage` 透传给 `buildPrompt` 的版本：
  - strict：传 `serializeQuotedMessageForModel(quotedMessage)`（即净化版）。
  - passthrough：保持原文（Class B 的 review/synthesizer 需要 taskId）。
- 或者更简单：strict 模式下完全删除 transport 层的 quotedMessage 二次注入（contextPack 已经包含同样信息），只保留 `当前用户消息：{message}`。

### L. `pickConversationForPrompt` / `pickGoalForPrompt` 实际并未白名单（实现与方案 F 不符）

[chat/route.ts L26-56](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L26-L56) 当前用 `...conversation`、`...goal`、`...subGoal`、`...task` 展开，再重新赋同名字段——结果就是**所有字段全部透传**，`id`、`createdAt`、`updatedAt`、`taskRef`、`structured` 等都仍在对象里。这违背了原方案 F "丢弃其他属性"的承诺。

**修正方案**：改写为显式字段列表（不要 spread）：
```ts
function pickConversationForPrompt(conversation: Conversation): Conversation {
  return {
    id: conversation.id,                 // buildConversationContextPack 内部用，但不会出现在 prompt 文本
    title: conversation.title,
    status: conversation.status,
    messages: conversation.messages,
    planningRunState: conversation.planningRunState,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  } as Conversation;
}
```
同理 goal/subGoal/task 改为显式字段列表，仅保留 `title`、`summary`、`description`、`expectedOutcome`、`instances[].status`，丢弃 `metadata`、`tags`、其他业务字段。

### M. `sanitizeConversationMessages` 实际并未白名单（实现与方案 H 不符）

[contextPack.ts L24-29](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts#L24-L29)：
```ts
return messages.map((message) => ({
  ...message,
  content: sanitizeConversationMessageContent(message.content),
}));
```

`...message` 让 `id`、`kind`、`taskRef`、`structured`、`reactions` 全部透传。这些字段虽然 `buildConversationContextPack` 内部不输出，但它们已落到 `body.contextSnapshot` 内存以及 `messages.json` 落盘文件里，后续 Claude 在 workspace 内 Read 该文件时一样会看到。

**修正方案**：
```ts
return messages.map((message) => ({
  role: message.role,
  content: sanitizeConversationMessageContent(message.content),
  createdAt: message.createdAt,
  kind: message.kind,
})) as T[];
```
同时落到 `messages.json` 的 [serializeConversationMessages](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts#L36-L43) 已经是显式字段，无需修改；仅需保证落盘前用的是 sanitize 后的版本。

### N. 类型穿透：白名单产物仍标 `Conversation` / `Goal`，下游误用风险

修正 L、M 后，pick 出来的对象已经不是完整 `Conversation`/`Goal`。但目前签名仍写 `: Conversation`，会让下游误以为可以读 `id`/`structured` 等字段。

**修正方案**：
- 引入局部类型 `PromptSafeConversation = Pick<Conversation, "id" | "title" | "status" | "messages" | "planningRunState" | "createdAt" | "updatedAt">`，pick 函数返回该类型。
- `buildConversationContextPack` 入参类型也收窄为 `PromptSafeConversation`，强制契约。
- 同理 `PromptSafeGoal`。

### O. 回归 spec 缺失 Class B 与 transport 层断言（实现与方案 Verification 第 7 项不符）

当前 [contextPack.spec.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.spec.ts) 仅覆盖 6 类 Class A 断言，原方案 Verification.7 要求 Class B 路径**仍包含** `taskId`/`instanceId` 防止误删契约——这条没写。

**修正方案**：扩展 spec 增加：
1. `buildWorkspaceBoundPrompt({ redactionMode: "strict", workspaceDir: "/tmp/conv-abc-123" })`：
   - 输出不含 `conv-abc-123` 字面值（被 hash 替换）。
   - 输出不含 `/tmp/`/`/Users/` 绝对路径。
   - 输出包含"禁止复述系统字段名"提示行。
2. `buildWorkspaceBoundPrompt({ redactionMode: "passthrough", contextPack: "task_id task-xyz instance inst-zzz" })`：
   - 输出**仍包含** `task-xyz` 字面值（passthrough 不脱敏）。
   - 输出**不含**"禁止复述系统字段名"提示行（这是 strict 专属）。
3. `pickConversationForPrompt({...full conversation with id, taskRef, structured...})`：
   - 输出对象 `JSON.stringify` 后不含 `taskRef`、`structured`、`reactions` 等字段名。
4. `sanitizeConversationMessages` 输出 `JSON.stringify` 后不含 `taskRef`、`structured`、`id`。

由于 `buildWorkspaceBoundPrompt` 当前是 transport.ts 的 module-private function，需要 export 出来才能 spec 调用；这是合理的可测试性提升。

### P. context.md 落盘文件覆写时机（小修）

[chat/route.ts L84-85](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L84-L85)：
```ts
writeJsonFileAtomic(getConversationMessagesFilePath(body.conversationId), recentMessages);
writeTextFileAtomic(getConversationContextFilePath(body.conversationId), contextPack);
```
落盘的 `recentMessages` 是经 `sanitizeConversationMessages` 处理的版本（修正 M 后即为白名单版本），符合预期。落盘的 `contextPack` 是已脱敏文本，符合预期。**此处方案 G 的实现已正确**，不需要额外改动；仅需在修正 M 之后回归确认 `messages.json` 不再含 `id`/`taskRef`。

### Q. 实施顺序（优先级）

1. **CRITICAL**（直接堵漏洞）：J、K
2. **HIGH**（兑现方案承诺）：L、M、N
3. **MEDIUM**（回归保障）：O
4. **LOW**（确认）：P

### R. 更新后的 Logic Self-Check（追加项）

| 风险点 | 说明 | 是否已处理 |
| --- | --- | --- |
| workspaceDir basename 即 conversationId | `sanitizeWorkspaceSegment` 不抹 `conv-` 前缀，basename 直接进 prompt | ❌ → ✅（Section J） |
| transport 层二次注入 raw quotedMessage | contextPack 已脱敏但 buildPrompt 又拼接原文 | ❌ → ✅（Section K） |
| pick 函数 spread 透传所有字段 | 实际未达成"白名单深度防御" | ❌ → ✅（Section L） |
| sanitizeConversationMessages spread 透传 id/taskRef | 落到 messages.json 与内存 | ❌ → ✅（Section M） |
| pick 产物仍标 `Conversation` 类型 | 下游可能误用 `.id`/`.structured` | ❌ → ✅（Section N，引入 PromptSafe* 类型） |
| spec 未覆盖 Class B 与 transport | 无法防止未来误删 taskId 契约 | ❌ → ✅（Section O） |
| messages.json 落盘内容含 taskRef | 修复 M 后自动随之消失 | 间接处理（Section P） |
