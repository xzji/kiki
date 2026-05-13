# 会话 Workspace 隔离实现方案

## Summary

本方案目标是把 KiKi 的每个用户会话改造成独立 workspace。Claude 在普通会话、目标规划、任务执行、任务恢复时，只能以当前会话或当前任务 workspace 作为 `cwd`，并且只读取由系统生成的当前会话上下文包，避免继续读取项目源码、其他会话数据或开发上下文。

核心改造点：

- 每个会话拥有独立目录：`data/workspaces/conversations/{conversationId}/`
- 每个任务实例拥有独立任务目录：`data/workspaces/conversations/{conversationId}/tasks/{taskId}/{instanceId}/`
- `runtimeEnv.workingDirectory` 不再作为用户会话/任务执行的最终 cwd，只作为 CLI 环境配置来源。
- 普通会话 Claude、目标规划 Claude、任务执行 Claude、repair/judge Claude 都必须通过 workspace resolver 获取 cwd。
- 删除会话时必须同步取消/清理该会话下的 runtime jobs、Claude session、workspace 文件和前端 store。

## Current State Analysis

基于当前代码只读检查，以下链路仍会直接或间接使用全局 runtime working directory：

- 普通会话 Claude：
  - `src/components/conversation/ConversationView.tsx` 调 `streamClaudeChat(...)`
  - `src/app/api/claude/chat/route.ts` 将 `body.runtimeEnv.workingDirectory` 传给 `streamClaudeCli(...)`
  - `src/lib/server/claudeCli.ts` 用 `spawn(..., { cwd })` 执行 Claude CLI
- 目标规划 Claude：
  - `src/lib/server/goalPlanning.ts` 的 `runClaudeJson()` 使用 `normalizeWorkingDirectory(input.runtimeEnv.workingDirectory)`
  - `runClaudeJson()` 被目标规划、信息收集、review、repair 等多处复用
- 任务执行 Claude：
  - `src/lib/server/goalTaskRunner.ts` 的 `runClaudePrompt()` 使用 `input.task.recommendedWorkingDirectory || input.runtimeEnv.workingDirectory`
  - 主任务执行 `streamClaudeCli(...)` 也使用同样 fallback
- 任务入队与 UI 展示：
  - `src/app/api/goals/tasks/execute/route.ts` 写入 `workingDirectory: body.task.recommendedWorkingDirectory || body.runtimeEnv.workingDirectory`
  - `src/lib/taskExecution.ts` 和 `src/components/providers/GoalSchedulerRuntime.tsx` 仍从前端传入该 fallback workingDirectory
- 会话删除：
  - `src/components/layout/Sidebar.tsx` 删除会话时只删除 Claude session、前端 goals 和 conversation
  - `src/lib/server/repositories/runtimeJobsRepository.ts` 已有 `conversation_id` 字段，但缺少按 conversationId 取消/删除 runtime jobs 的函数
- storage 基座：
  - `src/lib/server/storage/paths.ts` 目前有 `data/`、`data/storage/`、`~/.kiki/runtime`，还没有 workspace 根路径函数

当前风险：

- 普通会话使用 `Claude Code Local` 时，Claude 可能读取项目源码目录，导致把产品开发上下文误当成用户会话上下文。
- 用户表达“继续/恢复/重试”但没有明确可恢复状态时，消息可能落入普通 Claude Code 对话，出现上下文串扰。
- 删除会话不会自动终止或清理该会话下的 runtime jobs。

## Proposed Directory Structure

新增会话 workspace 根目录：

```text
data/
  workspaces/
    conversations/
      {conversationId}/
        workspace.json
        context/
          context.md
          messages.json
        planning/
          state.json
          collected-info.json
          raw/
            {requestId}-{step}.txt
            {requestId}-{step}.json
        goals/
          goal.json
        tasks/
          {taskId}/
            {instanceId}/
              context.md
              prompt.md
              progress.json
              trajectory.json
              result.json
              resume-input.json
              artifacts/
        attachments/
        exports/
        logs/
          telemetry.jsonl
```

说明：

- `context/context.md` 是普通会话 Claude 的唯一上下文包。
- `planning/state.json` 保存目标规划失败恢复状态。
- `tasks/{taskId}/{instanceId}/prompt.md` 保存实际交给 Agent 的完整任务 prompt。
- `tasks/{taskId}/{instanceId}/trajectory.json` 与现有 `runtime_jobs.trajectory_json` 双写，便于恢复与审计。
- `logs/telemetry.jsonl` 可作为会话局部镜像，第一阶段可选；全局 telemetry 暂不迁移。

## Proposed Changes

### 1. Storage Paths

修改文件：`src/lib/server/storage/paths.ts`

新增函数：

```ts
export function getWorkspaceStorageRootDir() {
  return ensureDir(path.join(getProjectRootDataDir(), "workspaces"));
}

export function getConversationWorkspacesRootDir() {
  return ensureDir(path.join(getWorkspaceStorageRootDir(), "conversations"));
}
```

目的：

- 统一 workspace 根目录。
- 避免各模块自行拼 `data/workspaces`。

### 2. Conversation Workspace Helper

新增文件：`src/lib/server/workspace/conversationWorkspace.ts`

新增类型：

```ts
export type ConversationWorkspaceInfo = {
  conversationId: string;
  workspaceDir: string;
  contextDir: string;
  planningDir: string;
  goalsDir: string;
  tasksDir: string;
  createdAt: string;
  version: 1;
};
```

新增函数：

```ts
export function sanitizeWorkspaceSegment(value: string): string;
export function getConversationWorkspaceDir(conversationId: string): string;
export function ensureConversationWorkspace(conversationId: string): ConversationWorkspaceInfo;
export function getConversationContextDir(conversationId: string): string;
export function getConversationContextFilePath(conversationId: string): string;
export function getConversationMessagesFilePath(conversationId: string): string;
export function getPlanningStateFilePath(conversationId: string): string;
export function getGoalSnapshotFilePath(conversationId: string): string;
export function getTaskWorkspaceDir(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
}): string;
export function ensureTaskWorkspace(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
}): string;
export function assertPathInsideWorkspace(input: {
  workspaceDir: string;
  targetPath: string;
}): void;
export function deleteConversationWorkspace(conversationId: string): void;
export function writeJsonFileAtomic(filePath: string, value: unknown): void;
export function writeTextFileAtomic(filePath: string, value: string): void;
export function writeTaskPromptFile(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
  content: string;
}): string;
export function writeTaskRunSnapshot(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
  trajectory?: unknown;
  progress?: unknown;
  result?: unknown;
}): void;
```

实现要求：

- `sanitizeWorkspaceSegment()` 只允许 `[a-zA-Z0-9._-]`，其他字符替换为 `_`。
- `ensureConversationWorkspace()` 创建所有固定目录，并写 `workspace.json`。
- `assertPathInsideWorkspace()` 用 `path.resolve()` 比较，防止 `../` 越界。
- 删除 workspace 必须只删除 `getConversationWorkspaceDir(conversationId)` 解析出的目录，严禁接受任意路径。

### 3. Context Pack Builder

新增文件：`src/lib/server/workspace/contextPack.ts`

新增函数：

```ts
export function serializeConversationMessages(messages: ConversationMessage[]): Array<{
  role: "user" | "kiki" | "system";
  content: string;
  createdAt: string;
  kind: string;
}>;

export function buildConversationContextPack(input: {
  conversation: Conversation;
  goal?: Goal | null;
  recentMessages: ConversationMessage[];
  quotedMessage?: { roleLabel: string; content: string } | null;
}): string;

export function buildTaskContextPack(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  trajectory?: ExecutionTrajectoryStep[];
  resumeContext?: string;
}): string;
```

上下文包内容必须包含：

- 当前会话 ID 和标题。
- 当前会话最近消息。
- 当前会话绑定的 goal 摘要。
- 当前会话下任务摘要。
- 当前待恢复状态。
- 明确限制：只能依据当前会话 workspace 和当前上下文包回答。

上下文包禁止包含：

- 其他会话内容。
- 项目源码路径。
- IDE 打开文件。
- 开发者当前对话或系统 memory。
- 全局 telemetry 原文。

### 4. Workspace APIs

新增文件：`src/app/api/conversations/[conversationId]/workspace/route.ts`

接口：

- `POST`
  - 调 `ensureConversationWorkspace(conversationId)`
  - 返回 `{ workspaceDir }`
- `DELETE`
  - 取消/删除该会话 runtime jobs
  - 删除该会话 Claude session（如果调用方提供 sessionId 或从会话状态可拿到）
  - 调 `deleteConversationWorkspace(conversationId)`
  - 返回 `{ ok: true }`

新增文件：`src/app/api/conversations/[conversationId]/workspace/context/route.ts`

接口：

- `POST`
  - 接收当前 conversation snapshot 和可选 goal snapshot
  - 写 `context/messages.json`
  - 写 `context/context.md`
  - 返回 `{ ok: true }`

说明：

- 如果不想让客户端频繁传整个 conversation，可第一阶段只在服务端调用 `ensureConversationWorkspace()`，context pack 在 `/api/claude/chat` 内构建。

### 5. Runtime Job Cleanup

修改文件：`src/lib/server/repositories/runtimeJobsRepository.ts`

新增函数：

```ts
export function cancelRuntimeJobsByConversationId(conversationId: string): number;
export function deleteRuntimeJobsByConversationId(conversationId: string): number;
export function releaseRuntimeJobLeasesByConversationId(conversationId: string): number;
```

实现要求：

- `cancelRuntimeJobsByConversationId()` 将 `queued/running/awaiting_user` 状态改为 `cancelled`，清空 `lease_owner/lease_expires_at`，写 `finished_at/updated_at`。
- `deleteRuntimeJobsByConversationId()` 仅在删除会话清理时使用。
- 删除前优先 cancel，避免 worker 继续执行。

### 6. Types

修改文件：`src/types/kiki.ts`

新增到 `Conversation`：

```ts
workspacePath?: string;
workspaceInitializedAt?: string;
```

新增到任务实例或执行态：

```ts
workspacePath?: string;
```

修改文件：`src/types/runtime.ts`

修改 `ClaudeChatRequest`：

```ts
export type ClaudeChatRequest = {
  message: string;
  conversationId: string;
  runtimeEnv: RuntimeEnvironment;
  claudeSessionId?: string;
  source: "assistant-sidebar" | "conversation";
  workspaceMode?: "conversation" | "task";
  taskRef?: {
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId: string;
  };
  quotedMessage?: {
    roleLabel: string;
    content: string;
  } | null;
};
```

约束：

- 前端不再传最终 workingDirectory。
- `runtimeEnv.workingDirectory` 只作为 CLI 安装/健康检查配置，不作为用户会话 cwd。

### 7. Claude CLI Prompt and cwd

修改文件：`src/lib/server/claudeCli.ts`

修改 `ClaudeStreamOptions`：

```ts
type ClaudeStreamOptions = {
  message: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  claudeSessionId?: string;
  quotedMessage?: { roleLabel: string; content: string } | null;
  contextPack?: string;
  workspacePolicy?: string;
  signal?: AbortSignal;
  onEvent: ...;
};
```

新增函数：

```ts
function buildWorkspaceBoundPrompt(input: {
  message: string;
  quotedMessage?: ClaudeStreamOptions["quotedMessage"];
  contextPack?: string;
  workspaceDir: string;
  workspacePolicy?: string;
}): string;
```

Prompt 规则：

- “你是 KiKi 当前会话助手，不是代码仓库开发助手。”
- “只能依据当前上下文包和当前工作目录内容回答。”
- “不得读取父目录、项目源码目录或其他会话目录。”
- “如果用户要求继续/恢复，但上下文包没有可恢复状态，说明没有找到可恢复任务。”

执行：

- `spawn(cliPath, args, { cwd })` 保持不变。
- `cwd` 必须由 workspace resolver 传入。

### 8. 普通会话 Claude 隔离

修改文件：`src/app/api/claude/chat/route.ts`

当前问题：

```ts
workingDirectory: body.runtimeEnv.workingDirectory
```

改为：

```ts
const workspace = ensureConversationWorkspace(body.conversationId);
const contextPack = buildConversationContextPack(...);
writeConversationContextPack(...);

await streamClaudeCli({
  message: body.message,
  workingDirectory: workspace.workspaceDir,
  cliPath: body.runtimeEnv.cliPath,
  permissionMode: body.runtimeEnv.permissionMode,
  claudeSessionId: body.claudeSessionId,
  quotedMessage: body.quotedMessage,
  contextPack,
  workspacePolicy: "conversation",
  signal: request.signal,
  onEvent,
});
```

关键点：

- `conversationId` 缺失时返回 400。
- 不再使用 `runtimeEnv.workingDirectory`。
- 如果后端拿不到完整 conversation snapshot，则第一阶段可以要求客户端传 `conversationContext`；更推荐在本地 store 仍在客户端时由 `/api/claude/chat` 接收 `contextSnapshot`。

### 9. ConversationView 和恢复路由

修改文件：`src/components/conversation/ConversationView.tsx`

调整：

- `streamClaudeChat()` 必须传 `conversationId`。
- 恢复意图逻辑前置：
  - 有 `planningRunState` 且用户消息语义为继续/恢复/重试/修复：走 `resumeGoalWorkflowFromRecovery()`
  - 有当前会话下可恢复 task blocker：走 task resume
  - 没有可恢复状态：本地追加 KiKi 消息“当前会话没有找到可恢复任务”，不要转给 Claude Code
- 普通聊天才进入 `/api/claude/chat`。

注意：

- 恢复意图不能写死“继续完成任务”，应复用语义判断：继续、接着、恢复、重试、修复、补齐、重新生成、retry、resume、continue 等。

### 10. 目标规划隔离

修改文件：`src/lib/server/goalPlanning.ts`

修改 `runClaudeJson()`：

```ts
async function runClaudeJson(input: {
  runtimeEnv: RuntimeEnvironment;
  prompt: string;
  conversationId?: string;
  workspaceDir?: string;
  ...
}) {
  const cwd = input.workspaceDir
    ?? (input.conversationId ? ensureConversationWorkspace(input.conversationId).workspaceDir : normalizeWorkingDirectory(input.runtimeEnv.workingDirectory));
}
```

进一步要求：

- 所有调用 `runClaudeJson()` 的函数都要把 `conversationId` 透传进去。
- `generateGoalPlanWithClaude()` 和 `advanceGoalInfoCollectionWithClaude()` 的 input 已包含 `conversationId` 或应新增。
- 每次规划阶段写：
  - `planning/state.json`
  - `planning/collected-info.json`
  - `planning/raw/{requestId}-{step}.txt`

避免：

- 不允许目标规划阶段读取项目根目录。
- 失败恢复只读当前 conversation workspace。

### 11. goalWorkflow 侧状态一致性

修改文件：`src/lib/goalWorkflow.ts`

调整：

- 创建或获取会话后，确保 workspace 初始化。
- `startGoalInfoCollection()`、`continueGoalWorkflowAfterInfo()`、`resumeGoalWorkflowFromRecovery()` 都必须带 `conversationId`。
- 失败时继续保存 `planningRunState` 到 conversation store。
- 后端同时写 `planning/state.json`。
- 成功生成 goal 后写 `goals/goal.json`，并清空 `planningRunState`。

### 12. 任务执行 workspace

修改文件：`src/app/api/goals/tasks/execute/route.ts`

当前问题：

```ts
workingDirectory: body.task.recommendedWorkingDirectory || body.runtimeEnv.workingDirectory
```

改为：

```ts
const conversationId = body.goal.conversationId;
if (!conversationId) return NextResponse.json({ reason: "任务缺少 conversationId，无法创建隔离 workspace" }, { status: 400 });

const taskWorkspaceDir = ensureTaskWorkspace({
  conversationId,
  taskId: body.task.id,
  instanceId: body.instance.id,
});

const prompt = buildGoalTaskRunnerPromptPreviewOrFull(...);
writeTaskPromptFile({ conversationId, taskId: body.task.id, instanceId: body.instance.id, content: prompt });
```

入队 payload：

```ts
{
  goal,
  subGoal,
  task,
  instance,
  runtimeEnv,
  conversationWorkspaceDir,
  taskWorkspaceDir,
}
```

`markGoalInstanceRunStarted()`：

- `workingDirectory` 写 `taskWorkspaceDir`。

### 13. Runtime Job Payload

修改文件：`src/lib/server/repositories/runtimeJobsRepository.ts`

修改：

```ts
export type RuntimeJobPayload = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
};
```

兼容历史 job：

- 如果 payload 没有 workspace，worker 根据 `conversationId/taskId/instanceId` 懒创建。

### 14. Worker 和 Goal Task Runner

修改文件：`src/lib/server/worker/taskDispatchWorker.ts`

调整：

- claim job 后解析 workspace：
  - 优先 `job.payload.taskWorkspaceDir`
  - 缺失时 `ensureTaskWorkspace(...)`
- 调 `runGoalTask()` 时传：
  - `conversationWorkspaceDir`
  - `taskWorkspaceDir`

修改文件：`src/lib/server/goalTaskRunner.ts`

修改 `RunGoalTaskInput`：

```ts
conversationWorkspaceDir?: string;
taskWorkspaceDir?: string;
```

新增函数：

```ts
function resolveGoalTaskWorkspace(input: RunGoalTaskInput): string;
```

所有 `streamClaudeCli()` 调用改为：

```ts
workingDirectory: resolveGoalTaskWorkspace(input)
```

覆盖点：

- `runClaudePrompt()`，包括 local repair、acceptance judge、repair prompt。
- 主执行的 `streamClaudeCli()`。
- 任何后续新增 judge/repair 都必须使用同一 resolver。

执行过程中写入：

- `prompt.md`
- `context.md`
- `trajectory.json`
- `progress.json`
- `result.json`

### 15. 任务恢复

修改文件：`src/app/api/goals/tasks/resume/route.ts`

调整：

- 恢复时读取原 job 的 `taskWorkspaceDir`。
- 用户反馈写入：
  - `tasks/{taskId}/{instanceId}/resume-input.json`
- 重新排队时 payload 保持原 workspace。
- 如果 workspace 缺失，按当前 job 的 `conversationId/taskId/instanceId` 懒创建。
- 不允许恢复时回退到 `runtimeEnv.workingDirectory`。

### 16. 调度器自动任务

修改文件：

- `src/components/providers/GoalSchedulerRuntime.tsx`
- `src/lib/server/worker/goalSchedulerEngine.ts`
- `src/lib/taskExecution.ts`

调整：

- 前端不再计算最终 `workingDirectory`。
- 后端 execute route 负责计算 task workspace。
- UI 如需展示目录，展示后端返回或 goal snapshot 中的 `execution.workingDirectory`。

### 17. 会话创建与删除

修改文件：`src/components/layout/Sidebar.tsx`

创建：

- `createConversation()`
- 调 `POST /api/conversations/{conversationId}/workspace`
- 失败不阻塞创建，因为后端调用时会懒初始化。

删除：

- 调 `DELETE /api/conversations/{conversationId}/workspace`
- 后端取消/删除 runtime jobs、删除 workspace、删除 Claude session
- 前端再执行：
  - `deleteGoalsByConversationId(conversationId)`
  - `deleteConversation(conversationId)`

修改文件：`src/stores/conversationStore.ts`

新增 action：

```ts
setConversationWorkspace(conversationId: string, workspacePath: string): void;
```

### 18. Dev Mock 和 Assistant Sidebar

修改文件：

- `src/lib/devMockSessions.ts`
- `src/stores/assistantStore.ts`

原因：

- 这两个入口也会创建会话/目标规划或调用 `streamClaudeChat()`。
- 必须同步使用 conversation workspace，避免只有主会话页隔离、侧边栏仍泄漏项目目录。

调整：

- mock 创建会话时初始化 workspace。
- assistant sidebar 的 goal workflow 和 Claude chat 同样传 `conversationId`。
- 侧边栏恢复语义也不能落入普通 Claude Code。

## Assumptions & Decisions

- 决策 1：第一阶段不迁移 SQLite schema，优先复用 `runtime_jobs.conversation_id` 和 `payload_json` 扩展 workspace 字段。
- 决策 2：`runtimeEnv.workingDirectory` 保留，用于 CLI 健康检查、默认环境显示、daemon 配置，但不作为用户会话/任务 cwd。
- 决策 3：workspace 初始化采用“创建时主动初始化 + 使用时懒初始化”双保险。
- 决策 4：删除会话时必须后端先取消 runtime jobs，再删前端 store。
- 决策 5：cwd 隔离不是强安全沙箱，本方案第一阶段解决上下文串扰；未来需要工具层路径校验增强。
- 决策 6：全局 telemetry 暂时保留，不作为 Claude 上下文输入；可额外双写会话局部 telemetry。

## Verification Steps

### 静态验证

1. 搜索所有 `runtimeEnv.workingDirectory`：
   - 普通会话、目标规划、任务执行、resume 不应再把它作为 Claude cwd。
   - 只允许出现在运行环境配置、健康检查、UI 设置里。
2. 搜索所有 `streamClaudeCli({`：
   - 每一处 `workingDirectory` 必须来自 conversation/task workspace resolver。
3. 搜索所有 `createQueuedRuntimeJob(`：
   - payload 必须包含或可推导 `conversationWorkspaceDir/taskWorkspaceDir`。
4. 搜索所有 `deleteConversation(`：
   - 删除前必须调用后端 workspace cleanup。

### 功能验证

1. 新建会话：
   - `data/workspaces/conversations/{conversationId}/workspace.json` 存在。
   - `context/ planning/ goals/ tasks/ attachments/ exports/` 已创建。
2. 普通聊天：
   - Claude cwd 是当前 conversation workspace。
   - Claude 回复不再提到项目源码或开发任务。
3. `/goal` 目标规划：
   - `planning/state.json` 和 `planning/raw/` 写入。
   - 失败后 `planningRunState` 和 workspace state 均可恢复。
4. 用户表达恢复：
   - 有恢复状态时走恢复链路。
   - 无恢复状态时本地提示“当前会话没有可恢复任务”，不调用 Claude Code。
5. 任务执行：
   - `tasks/{taskId}/{instanceId}/prompt.md` 写入完整 prompt。
   - `trajectory.json/progress.json/result.json` 随执行更新。
   - Claude cwd 是 task workspace。
6. 任务恢复：
   - 复用同一个 task workspace。
   - `resume-input.json` 写入用户反馈。
7. 删除会话：
   - runtime jobs 被 cancel/delete。
   - workspace 目录被删除。
   - 前端 goals/conversation 被删除。

### 回归验证

1. `pnpm dev` 无编译错误。
2. 目标规划完整走通。
3. 后台 daemon 任务执行完整走通。
4. `awaiting_user` 恢复任务完整走通。
5. 侧边栏 assistant 和会话页行为一致。

## Omission Check

- 普通会话 Claude：已覆盖 `ConversationView.tsx -> /api/claude/chat -> streamClaudeCli`。
- 目标规划：已覆盖 `/api/goals/collect`、`/api/goals/plan`、`goalPlanning.ts/runClaudeJson()`。
- 任务执行：已覆盖 `/api/goals/tasks/execute`、runtime job、worker、`goalTaskRunner.ts` 主执行/repair/judge。
- 任务恢复：已覆盖 `/api/goals/tasks/resume`，要求复用原 task workspace。
- 自动调度：已覆盖 `GoalSchedulerRuntime.tsx` 和 `goalSchedulerEngine.ts`，避免自动任务仍用 runtime cwd。
- 手动执行：已覆盖 `src/lib/taskExecution.ts`。
- 会话删除：已覆盖 `Sidebar.tsx`、workspace cleanup API、runtime job cancel/delete。
- 会话创建：已覆盖 `conversationStore.ts`、`Sidebar.tsx`、`goalWorkflow.ts`、`devMockSessions.ts`。
- 侧边栏：已覆盖 `assistantStore.ts`，避免侧边栏继续泄漏项目目录。
- 旧数据兼容：runtime job payload 缺 workspace 时由 worker 懒创建。
- telemetry：全局保留，但不注入 Claude；可选双写 workspace logs。
- 强隔离风险：已记录 cwd 不是强沙箱，后续需要工具层 `assertPathInsideWorkspace()` 和越界审计。
- Claude session 删除：删除 session 时 workingDirectory 应使用 conversation workspace，而不是 runtime env workingDirectory。

## Implementation Order

1. 新增 workspace path/helper 和 context pack。
2. 新增 workspace 初始化/清理 API。
3. 隔离普通会话 Claude。
4. 隔离目标规划 Claude。
5. 隔离任务执行与 runtime job payload。
6. 隔离任务恢复。
7. 接入会话创建/删除清理闭环。
8. 修正侧边栏 assistant 和 dev mock。
9. 执行静态搜索和端到端验证。

