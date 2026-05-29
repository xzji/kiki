# 内置任务产出视图退役方案

## 当前进度快照（2026-05-28）

- ✅ Phase A 已完成：6 个内置视图组件 + 3 个 mock 数据文件（flashcards/emails/news）已删除；`kiki.ts` 中 `TaskResultViewKind / ExecutionPayload` 已收敛为单值。
- ✅ Phase B 已完成：`ExecutionResultBody.tsx / TaskDetailBody.tsx / TaskInlineResultView.tsx` 渲染入口已统一走 `GenericAgentResultView`。
- ⏳ Phase C / D / E / F / G 待执行。`pnpm tsc --noEmit` 当前 164 处错误，均为旧 kind 字面量遗留，需要按下方 19 个文件清单逐一收尾。

### 待修文件清单（来自 TS 报错与全文 grep）

| 阶段 | 文件 | 关键改造点 |
| --- | --- | --- |
| C | `src/lib/goalPlanning/taskCompiler.ts` | `inferExecutionKind` 直接返回 `generic_result`；移除关键词分支 |
| C | `src/lib/server/goalPlanning/taskCompiler.ts` | 同上 |
| C | `src/lib/server/goalPlanning/taskCompiler.spec.ts` | 测试参数改为 `generic_result` |
| C | `src/lib/server/goalTaskPrompt.ts` | `result_view_kind` 固定 `generic_result`，删除 5 类示例 |
| C | `src/lib/server/resultNotificationJudge.ts` | 删除按 kind 触发的关键词分支 |
| C | `src/lib/server/agentOrchestration/strategy.ts` | 同步清理 |
| C | `src/lib/server/worker/goalNotificationWorker.ts` | 移除 kind 分支 |
| C | `src/lib/server/worker/goalSchedulerEngine.ts` | 移除 kind 分支 |
| C | `src/lib/server/domain/taskPolicy.ts` | 移除 kind 比较 |
| C | `src/lib/server/goalPlanning.ts` | 移除 kind 比较 |
| D | `src/lib/goalFactory.ts` | `payloadFor` 永远返回 `generic_result` |
| D | `src/lib/server/runtime/goalStateSnapshot.ts` | payload 构造统一 |
| D | `src/components/conversation/TaskMessageCard.tsx` | 移除 kind 比较 |
| D | `src/components/providers/RuntimeEventBridge.tsx` | 移除 kind 比较 |
| D | `src/components/goal/TaskCreateDrawer.tsx` | 移除 kind 比较 / 选择器 |
| D | `src/components/goal/TaskEditDrawer.tsx` | 同上 |
| D | `src/stores/goalStore.ts` | 移除残留 kind 字面量 |
| E | `src/mocks/goals.ts` | 全部 task `executionKind=generic_result`，payload 改 markdown summary |
| E | `src/mocks/goal-breakdown.ts` | 同上 |
| E | `src/lib/devMockSessions.ts` | 同上 |

## Summary（一句话）
- 删除全部 6 个内置任务产出视图组件，把"任务渲染层"收敛成 `surface-first` 模型。
- 任何任务结果统一通过 `task_result.blocks / artifacts / webapp / external_embed` 表达，复杂交互一律由 Agent 生成 WebApp artifact 承载。
- 配套清理 `TaskResultViewKind / ExecutionKind / ExecutionPayload` 中所有具体业务 kind，只保留 `generic_result`。
- 历史数据允许清空，本地数据库（SQLite）一次性 reset，避免做迁移。

## 目标态架构

```
任务执行层：
  - 跑任务 / 收集结果 / 维护实例状态 / 与 Claude 交互
  - 不再决定"用哪个内置组件"

结果协议层（task_result）：
  - blocks: 结构化阅读类输出
  - artifactRefs: 文件 / 链接 / WebApp / External Embed
  - meta.interactiveSurfaceKind: blocks | webapp

展示层（前端只剩这些）：
  - GenericAgentResultView      # 容器
  - TaskResultBlockView         # 结构化 blocks
  - ArtifactRenderer / FileCard / LinkCard
  - SandboxedWebAppSurface      # WebApp 兜底
  - ExternalEmbedSurface        # 外部嵌入
```

不再存在 `FlashcardView / ListeningQAView / ReadingDigestView / ConfirmActionView / DraftReviewView / FreeformChatView`。

## Current State Analysis

### 1. 类型层（源头）
- [kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L14-L24)
  - `TaskResultViewKind = 'flashcard' | 'listening_qa' | 'reading_digest' | 'confirm_action' | 'draft_review' | 'freeform_chat' | 'generic_result'`
  - `ExecutionKind = TaskResultViewKind`（历史别名）
- [kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L363-L370)
  - `ExecutionPayload` 是 7 种 tagged union
  - `TaskInstance.payload: ExecutionPayload` 强制必填
- [kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L340-L361)
  - `QA / Article / EmailDraft / FlashCard` 等仅服务于内置视图的领域类型

### 2. 内置视图（要删的）
- [src/components/execution/FlashcardView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FlashcardView.tsx)
- [src/components/execution/ListeningQAView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/ListeningQAView.tsx)
- [src/components/execution/ReadingDigestView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/ReadingDigestView.tsx)
- [src/components/execution/ConfirmActionView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/ConfirmActionView.tsx)
- [src/components/execution/DraftReviewView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/DraftReviewView.tsx)
- [src/components/execution/FreeformChatView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FreeformChatView.tsx)

### 3. 渲染入口（要重写的）
- [ExecutionResultBody.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx#L212-L324)
  - `hasBuiltInDeliverable` 5 路 if/else 全部移除
  - `EXECUTION_KIND_LABEL` 仅保留 `generic_result`
  - `currentKind` 直接退化成 `'generic_result'`
- [TaskInlineResultView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/TaskInlineResultView.tsx)
  - `viewKind === 'generic_result'` 判定可去掉，统一渲染
- [TaskDetailBody.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/goal/TaskDetailBody.tsx#L860-L979)
  - `getPayloadSummaryLines` 中 5 路 case 移除
  - `EXECUTION_KIND_LABEL` 简化

### 4. 推断 / 编译层（要简化的）
- [src/lib/goalPlanning/taskCompiler.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalPlanning/taskCompiler.ts#L43-L171)
  - `inferExecutionKind` 永远返回 `'generic_result'`
  - `buildExpectedResult` 简化成单一 `generic_result` 模板
- [src/lib/server/goalPlanning/taskCompiler.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskCompiler.ts#L56-L91)
  - 同步简化

### 5. Prompt 协议层
- [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L283)
  - `result_view_kind` 字段从枚举改成固定 `'generic_result'`
  - 提示文里删掉 flashcard / listening_qa / reading_digest / confirm_action / draft_review 字眼
  - 显式声明：交互一律走 `interactiveSurface.kind = blocks | webapp`
- [src/lib/server/goalPlanning/taskDraftPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftPrompt.ts)
  - 同步清理（如果有）

### 6. Payload 构造层
- [goalFactory.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalFactory.ts#L19-L36)
  - `payloadFor` 不再 switch 多种 kind，永远返回 `{ kind: 'generic_result', summary: '' }`
- [goalCommandService.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/goalCommandService.ts)
- [goalStateSnapshot.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/goalStateSnapshot.ts#L483-L490)
- [readinessAdapter.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/readinessAdapter.ts#L42)
- [TaskAgentPromptDrawer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/goal/TaskAgentPromptDrawer.tsx#L39)
  - 所有 `payload: { kind: 'xxx' }` 统一退化为 `generic_result`

### 7. Mock / 历史样例
- [src/mocks/goals.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts)
- [src/mocks/goal-breakdown.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goal-breakdown.ts)
- [src/lib/devMockSessions.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/devMockSessions.ts)
  - 把所有 mock 任务 `executionKind` 统一改成 `generic_result`
  - mock payload 全部改成 `{ kind: 'generic_result', summary, details }`

### 8. 数据存储
- 本地 SQLite 数据库 `data/kiki.db`：
  - 保留旧字段意味着要写迁移逻辑 + 兜底渲染。
  - 用户已确认可清空 → 直接 reset 数据库 + 删除 `logs/claude-traces/` 历史 trace。

## Proposed Changes

### Phase A：物理删除内置视图与领域类型

**A1. 删除组件文件**
- 删除：
  - `src/components/execution/FlashcardView.tsx`
  - `src/components/execution/ListeningQAView.tsx`
  - `src/components/execution/ReadingDigestView.tsx`
  - `src/components/execution/ConfirmActionView.tsx`
  - `src/components/execution/DraftReviewView.tsx`
  - `src/components/execution/FreeformChatView.tsx`

**A2. 类型瘦身**
- [kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts)：
  - `TaskResultViewKind` 收敛为：`type TaskResultViewKind = 'generic_result'`
  - `ExecutionKind` 仍保留同别名（不删，否则改动面会过大；但只剩一种值）
  - `ExecutionPayload` 收敛为：`type ExecutionPayload = { kind: 'generic_result'; summary: string; details?: string; artifacts?: TaskRunArtifact[] }`
  - 删除 `FlashCard / QA / Article / EmailDraft` 这些纯服务内置视图的类型
  - `Task.executionKind: 'generic_result'`；`Task.resultViewKind?: 'generic_result'`

### Phase B：渲染入口收敛

**B1. ExecutionResultBody**
- 删掉 `FlashcardView / ListeningQAView / ReadingDigestView / ConfirmActionView / DraftReviewView` 5 个 import 与 5 段 if/else
- `hasBuiltInDeliverable` 移除
- `shouldRenderGenericDeliverable` 简化成：`!!instance.result?.taskResult || !!instance.result?.summary || !!instance.result?.finalMessage`
- `EXECUTION_KIND_LABEL` 仅保留 `generic_result: 'Agent 任务'`

**B2. TaskDetailBody**
- `EXECUTION_KIND_LABEL` 同步精简
- `getPayloadSummaryLines` 删除 5 路 case，仅保留 `generic_result`
- 不再走 `payload.kind === 'flashcard'` 等分支

**B3. TaskInlineResultView**
- `viewKind === 'generic_result' || instance.payload.kind === 'generic_result'` 判定可恒为真，删掉条件分支

### Phase C：编译 / 推断 / Prompt

**C1. taskCompiler 推断逻辑下线**
- `src/lib/goalPlanning/taskCompiler.ts` 与 `src/lib/server/goalPlanning/taskCompiler.ts`：
  - `inferExecutionKind` 直接 `return 'generic_result'`，删掉关键词分支
  - `buildExpectedResult` 单一模板：`type=deliverable`、`outputFormat=structured_blocks`、`presentationKind=document`、`interactiveSurface={ required: true, kind: 'blocks' }`（默认 blocks，由 LLM 自行决定是否升格为 webapp）
  - `userInteractionType` 推断保留，但不再依赖 kind，只看 `expectedResult.interactionMode`
  - `collaborationFor / interactionRequirementFor` 中所有按 kind 的特例分支移除

**C2. Prompt**
- [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)：
  - `result_view_kind` 字段固定为 `'generic_result'`，并在指令里说明该字段已废弃，仅保留为兼容字段
  - 删除提示中关于"flashcard/listening_qa/..."的所有列举与示例
  - 强化指令：
    - 默认输出 `task_result.blocks`
    - 需要复杂交互（答题、练习、表单、看板、模拟器）时输出 `webapp` artifact，并在 `task_result.meta.interactiveSurfaceKind = 'webapp'`
- 同步清理 `taskDraftPrompt.ts`、`agentOrchestration/strategy.ts`、`resultNotificationJudge.ts` 中关键词触发分支

### Phase D：Payload 工厂与构造点

- `goalFactory.payloadFor` → 永远 `{ kind: 'generic_result', summary: '' }`
- `goalCommandService.ts` 创建 task/instance 时 payload 永远走 `generic_result`
- `goalStateSnapshot.ts`、`readinessAdapter.ts`、`TaskAgentPromptDrawer.tsx` 同步
- `dependencyDigest.ts` 中 `payload.kind === 'generic_result' ? payload.summary : undefined` 简化为直接读 `payload.summary`

### Phase E：Mock / Dev 数据

- `src/mocks/goals.ts`、`src/mocks/goal-breakdown.ts`、`src/lib/devMockSessions.ts`：
  - 所有 task `executionKind: 'generic_result'`
  - 所有 instance `payload: { kind: 'generic_result', summary, details? }`
  - 凡是依赖 `cards / questions / articles / drafts` 的 mock 项删除或改写为 markdown blocks

### Phase F：数据库 & Trace 重置

- 删除 `data/kiki.db` 与可能存在的 `data/kiki.db-shm`、`data/kiki.db-wal`
- 清空 `logs/claude-traces/`
- 重启 dev server 让 SQLite schema 重新初始化
- 不写迁移脚本，不做 backfill

### Phase G：UI 细节兜底

- `GenericAgentResultView` 已支持空数据展示（已存在），无需改造
- `BlockRenderer / ArtifactRenderer / SandboxedWebAppSurface` 保持不变
- 当 `task_result` 为空时，沿用 GenericAgentResultView 的"暂无产出"占位

## Assumptions & Decisions

- **D1**：`TaskResultViewKind` 不彻底删除，只收窄为单值。原因：删除会引发 600+ 处类型噪音改动，仅保留单值即可达成"前端不再分支"的目标。
- **D2**：`ExecutionPayload` 不删除，但收敛为单值。原因：很多旧代码读 `payload.summary`，保留字段可让最少改动达成目标。
- **D3**：不写迁移脚本。用户明确接受历史数据清空。
- **D4**：保留 `executionKind` 字段为兼容字段，未来真要删可再单做一次大重构。
- **D5**：默认 `interactiveSurface.kind = blocks`。LLM 在执行阶段自行升级为 `webapp`，前端按 `meta.interactiveSurfaceKind` 路由。
- **D6**：删除组件后，`src/components/execution` 仅保留：`ArtifactRenderer / BlockRenderer / ExternalEmbedSurface / FileCard / LinkCard / SandboxedWebAppSurface`。

## Out of Scope

- 不重写 Agent runner / runtime job 调度
- 不修改权限模式 / 工具策略
- 不改 readiness 判定与"补充信息卡片"
- 不改 artifact 类型协议（保持现有 `webapp / external_embed / file / link` 等）

## Verification

1. `pnpm tsc --noEmit` 无错误
2. `pnpm lint --file ...` 对修改文件全通过
3. `pnpm dev` 起服务，验证：
   - 创建新 Goal → 自动生成的 task `executionKind === 'generic_result'`
   - 执行任务 → 详情页只走 `GenericAgentResultView` 路径
   - LLM 返回 webapp artifact → 渲染 `SandboxedWebAppSurface`
   - LLM 返回 blocks → 渲染 `TaskResultBlockView`
   - 停止任务后再点详情 → 不再因 `payload.kind` 分支崩溃
4. 数据库重置后 schema 正常初始化
5. 全文搜索确认以下符号已消失或只剩单一引用：
   - `FlashcardView / ListeningQAView / ReadingDigestView / ConfirmActionView / DraftReviewView / FreeformChatView`
   - `kind: "flashcard" | "listening_qa" | "reading_digest" | "confirm_action" | "draft_review" | "freeform_chat"`

## 执行顺序建议

1. 先做 Phase A（删组件、收类型）→ 一次性把 TS 报错全打开
2. 再做 Phase B / C / D / E → 顺着 TS 报错逐文件改
3. 最后 Phase F → 重置 DB + 重启 dev server
4. Phase G → 验证空态行为
