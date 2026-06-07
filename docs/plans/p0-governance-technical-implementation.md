# P0 技术实现方案：会话驱动的运行时治理（Conversation-Driven Runtime Governance）

> 关联 PRD：[conversation-runtime-governance-prd.md](./conversation-runtime-governance-prd.md)
> 范围：PRD §12 的 **P0** —— 判官识别完整 10 个枚举；落库做 **7 条写链路**；`chitchat` / `qa` / `clarify` 为纯回复类，不落库。
> 本文档落到具体文件、函数、类型签名与改动顺序，供直接进入编码。

---

## 0. 现状基线（已核验的事实）

| 事实 | 位置 | 对方案的影响 |
|---|---|---|
| 会话走 `streamClaudeCli`，纯文本流式，无 action 通道 | [chat/route.ts](../../src/app/api/claude/chat/route.ts) | 治理判官需另起一条 JSON 调用，不污染聊天流 |
| 已有判官范式：`streamClaudeCli` + `tryExtractJsonObject` + normalize + 失败降级 clarify | [taskFeedbackJudge.ts](../../src/lib/server/taskFeedbackJudge.ts) | **直接复用为治理判官的蓝本** |
| 更规范的 JSON 通道：`runPromptJson({ channelPolicy: { mode: "readonly_json" } })` | [transport.ts L184](../../src/lib/server/claude/transport.ts) | 判官优先用此通道（带 jsonRepair/parseJsonWithCandidates） |
| `GoalCommand` 联合类型含 create_task / update_task / delete_task | [goalCommandService.ts L40-L64](../../src/lib/server/services/goalCommandService.ts) | A 档落库命令现成 |
| `update_task` 落库**不含** `expectedResult` 子字段 | [goalCommandService.ts L319-L346](../../src/lib/server/services/goalCommandService.ts) | §6 缺口，P0 必须补 |
| `TaskExpectedResult.completionCriteria / requiredBlocks` 类型**已存在** | [kiki.ts L207-L227](../../src/types/kiki.ts) | 只需打通落库写入，无需新增类型 |
| patch 合并雏形 `buildMergedTaskCommandInput(task, patch)` | [dispatchTaskFromThread.ts L101](../../src/lib/server/services/dispatchTaskFromThread.ts) | 提取为通用合并器的起点 |
| rerun 链路：judge=rerun → `createGeneratedInstance` + `buildRevisionContext` + 落库 | [feedback/route.ts L230-L290](../../src/app/api/goals/tasks/feedback/route.ts) | rerun_current 复用此链路 |
| 任务定位 `findTaskRef(goals, taskRef)` + TaskRef 结构 | [feedback/route.ts L20-L48](../../src/app/api/goals/tasks/feedback/route.ts) | 会话治理同样需要 taskRef 定位 |
| 读时合成 `composeGoalsWithRuntimeJobs` | [instanceComposition.ts L111](../../src/lib/server/runtime/instanceComposition.ts) | 落库前读取须先合成，保持 SSOT 一致 |

**关键结论**：P0 不需要发明新机制，全部建立在既有范式之上。判官抄 `taskFeedbackJudge`，落库用现成 `GoalCommand`，合并器从 `buildMergedTaskCommandInput` 提取，rerun 抄 feedback route。

---

## 0.1 二次核验发现的遗漏（已并入改造清单）

对"修 §6 落库缺口"这一步做深入核验后，发现 `expectedResult` 写入链路远不止一处，原方案低估了改动面：

- **缺口1｜`TaskCommandInput` 有 4 处独立重复定义，均不含 `expectedResult`**：
  - [goalCommandService.ts L15-23](../../src/lib/server/services/goalCommandService.ts) ／ [topicCommandService.ts L31-39](../../src/lib/server/services/topicCommandService.ts) ／ [goal-commands.ts L26-34](../../src/lib/api/goal-commands.ts) ／ 以及 API 路由内联的 `parseTaskInput` 返回结构。
  - 该类型**未从 `kiki.ts` 统一导入**。P0 不强求收敛为单一类型（避免扩大改动面），但**这 4 处都必须各自补 `expectedResult` 字段**，否则任一环节会把字段截断。
- **缺口2｜落库 `createTask` 与 `update_task` 均未写 `expectedResult`**：[createTask L227-245](../../src/lib/server/services/goalCommandService.ts) 逐字段重建 Task 时根本没有 `expectedResult`；`update_task`（L319-346）同理。原方案只提了 `update_task`，**漏了 `createTask`**。
- **缺口3｜API 入口 `parseTaskInput` 会显式丢弃 `expectedResult`（最隐蔽的拦截点）**：[goals/commands/route.ts L30-50](../../src/app/api/goals/commands/route.ts) 的 `parseTaskInput` 只挑选 title/description/expectedOutcome/taskType/triggerRule/deadline/executionKind 七个字段返回，**即使底层支持，请求体里的 `expectedResult` 也会在此被过滤掉**。`topics/commands/route.ts` 同样。原方案完全没覆盖这一层。
- **发现4｜判官入参无需新增传输字段**：[ClaudeChatRequest](../../src/types/runtime.ts) **已携带** `taskRef`（含 goalId/subGoalId/taskId/instanceId）与 `quotedMessage`。第 0 级闸门与判官可直接复用，**无需在 chat 请求上加字段**，方案比原设计更简单。
- **发现5｜`Conversation.goalId` 确实存在**（[kiki.ts L559](../../src/types/kiki.ts)，可选）。闸门 `hasGoalBinding` 假设成立；但因是**可选字段**，闸门必须把 `goalId` 缺失当作"无绑定 → 走聊天"处理。

> 综合影响：原"第 1 步=改 1 个文件"实际为"改 6 处（4 类型 + 2 API 入口）+ 2 落库点（create/update）"。功能本质不变，但**改动清单与测试用例需扩展**，已反映到 §2.2 与 §5。

---

## 1. 总体架构（P0 数据流）

```
会话消息 (chat/route.ts 之前或并行)
   │
   ▼
[A] governanceGate（第 0 级结构闸门，纯函数）
   │  入参：message + conversation.goalId + taskRef + 关键词
   │  命中 → 进判官；未命中 → 原 streamClaudeCli 聊天（不变）
   ▼
[B] governanceJudge（第 1 级 JSON 判官，复用 runPromptJson/readonly_json）
   │  输出：{ intent(10枚举), targetRef, confidence, patch?, revisionHint? }
   │  低置信/失败/解析错 → 降级 chitchat → 走聊天
   ▼
[C] governanceProposalService（产出提案 + 确认卡 payload）
   │  amend/update/create/delete/rerun → 结构化 proposal（含 diff）
   │  dispatch/pause → 占位提示，不落库
   ▼
[D] 确认卡（前端）→ 用户确认
   ▼
[E] governanceCommandService（确认后落库，统一入口）
   │  amend/update → mergeTaskPatch → GoalCommand.update_task
   │  create → GoalCommand.create_task
   │  delete → GoalCommand.delete_task
   │  rerun  → 复用 feedback rerun 链路
   ▼
goalCommandService.applyGoalCommand → writeGoalsProjection → 治理事件
```

P0 落点：`[A][B][C]` 全做；`[E]` 做 5 条命令；`[D]` 做最小可用确认卡。

---

## 2. 文件级改造清单

### 2.1 新增文件

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/lib/server/governance/governanceGate.ts` | 第 0 级结构闸门（纯函数，零 LLM） | `evaluateGovernanceGate(input): GateResult` |
| `src/lib/server/governance/governanceJudge.ts` | 第 1 级 JSON 判官（复用 `runPromptJson`） | `judgeGovernanceIntent(input): GovernanceJudgeResult` |
| `src/lib/server/governance/governanceIntent.ts` | 10 枚举类型 + normalize + 降级 + schema 校验 | `GovernanceIntent`、`normalizeGovernanceResult`、`buildDegradedResult` |
| `src/lib/server/governance/governancePrompt.ts` | 判官 prompt 构造（抄 `buildFeedbackJudgePrompt` 扩 10 类） | `buildGovernanceJudgePrompt` |
| `src/lib/server/governance/taskPatchMerge.ts` | 统一合并器（从 `buildMergedTaskCommandInput` 提取并扩展） | `mergeTaskPatch(task, patch, registry)` |
| `src/lib/server/governance/taskFieldRegistry.ts` | 字段注册表（白名单 + mergeStrategy + 校验） | `TASK_FIELD_REGISTRY`、`applyFieldPatch` |
| `src/lib/server/governance/governanceCommandService.ts` | 确认后统一落库入口（分发到 5 条链路） | `applyGovernanceCommand(input): Result` |
| `src/app/api/governance/judge/route.ts` | 判官 API（闸门+判官+提案，返回确认卡 payload） | `POST` |
| `src/app/api/governance/apply/route.ts` | 落库 API（确认后执行） | `POST` |

### 2.2 修改文件

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/lib/server/services/goalCommandService.ts` | ①本地 `TaskCommandInput`（L15-23）增 `expectedResult?: TaskExpectedResult`；②`normalizeTaskInput`（L193）透传；③`createTask`（L227-245）落库写入；④`update_task`（L319-346）落库写入 | 修 §6 缺口（见 §0.1-缺口1/2） |
| `src/app/api/goals/commands/route.ts` | `parseTaskInput`（L30-50）增加读取并透传 `expectedResult` | **API 入口会丢弃 expectedResult**（§0.1-缺口3，原方案漏） |
| `src/app/api/topics/commands/route.ts` | 同上：其 `parseTaskInput` 也需透传 `expectedResult` | topic 命令同样经此入口（§0.1-缺口3） |
| `src/lib/server/services/topicCommandService.ts` | 本地 `TaskCommandInput`（L31-39）增 `expectedResult` | 类型重复定义之一（§0.1-缺口1） |
| `src/lib/api/goal-commands.ts` | 本地 `TaskCommandInput`（L26-34）增 `expectedResult` | 类型重复定义之一；前端构造命令需带该字段（§0.1-缺口1） |
| `src/lib/server/services/dispatchTaskFromThread.ts` | `buildMergedTaskCommandInput` 改为调用新 `mergeTaskPatch`（保持行为不变） | 合并逻辑收敛为单一来源 |
| `src/types/runtime.ts` | 新增 `GovernanceProposal`、`GovernanceApplyRequest` 等传输类型；判官入参**复用** `ClaudeChatRequest` 已有的 `taskRef`/`quotedMessage` | 判官/落库 API 契约（§0.1-发现4） |
| `src/lib/server/services/goalRuntimeService.ts`（或事件层 `goalCommandService` 的事件 kind 联合） | 注册治理事件 `task.definition_amended` 等 kind | 审计与回放 |
| 前端会话组件（`ConversationView` 或消息发送处） | 发消息前/后调用 `/api/governance/judge`；渲染确认卡；确认调 `/api/governance/apply` | 接入治理 sidecar |

> 注：前端确认卡组件具体落点需在编码期定位 `ConversationView` 的消息渲染管线，本方案先标注职责。

---

## 3. 核心模块设计

### 3.1 第 0 级闸门 `governanceGate.ts`（纯函数，零成本）

```ts
export type GateResult =
  | { pass: false }                                  // 走原聊天
  | { pass: true; signals: GateSignals };            // 进判官

type GateInput = {
  message: string;
  goalId?: string;                 // conversation.goalId
  taskRef?: TaskRef;               // 引用的任务卡片
  hasGoalBinding: boolean;
};
```

判定规则（命中任一强信号且满足必要条件即 pass）：
- **必要条件**：`hasGoalBinding === true`（无绑定目标 → 直接 `pass:false`）。
- **强信号**：`taskRef` 存在（引用了卡片）。
- **弱信号**：关键词预筛（`/重跑|重新|修改|删除|取消|暂停|恢复|执行|派发|下次|以后|这个任务/`）——仅弱信号命中也 pass，但在判官层用更高置信门槛。

**无 LLM 调用**，O(1)。

### 3.2 第 1 级判官 `governanceJudge.ts`（复用 runPromptJson）

完全沿用 `taskFeedbackJudge` 的形态，但：
1. 通道升级为 `runPromptJson({ channelPolicy: { mode: "readonly_json" } })`（带 jsonRepair），而非 `streamClaudeCli`。
2. 输出 10 枚举 + 可选 patch。

```ts
export type GovernanceIntent =
  | "amend_task" | "rerun_current" | "create_task" | "update_task"
  | "cancel_task" | "dispatch_task" | "pause_task"
  | "chitchat" | "qa" | "clarify";

export type GovernanceJudgeResult = {
  intent: GovernanceIntent;
  targetRef: TaskRef | null;
  confidence: number;            // 0..1
  patch?: TaskPatch;             // amend/update 时给出字段补丁建议
  revisionHint?: string;         // rerun 时给执行 Agent 的修订要求
  assistantMessage: string;      // 给用户的话术
  _degraded?: boolean;
};
```

降级规则（抄 `normalizeJudgeResult`）：
- 非法 JSON / 解析失败 / `confidence < 阈值` → `intent = "chitchat"`，走聊天。
- `intent ∈ {amend,update,create,delete}` 但 `patch` 为空 → 降级 `clarify`。
- `intent = rerun` 但无 `revisionHint` → 降级 `clarify`（对齐 feedback judge 对 revisionContext 的处理）。

### 3.3 字段注册表 `taskFieldRegistry.ts`（通用性核心）

```ts
type FieldSpec = {
  path: string;                              // "description" | "expectedResult.completionCriteria" ...
  type: "string" | "string[]" | "enum";
  mergeStrategy: "replace" | "append";
  confirmLevel: "required" | "light";
  validate?: (v: unknown) => boolean;
};

export const TASK_FIELD_REGISTRY: FieldSpec[] = [
  { path: "description",                       type: "string",   mergeStrategy: "replace", confirmLevel: "required" },
  { path: "expectedOutcome",                   type: "string",   mergeStrategy: "replace", confirmLevel: "required" },
  { path: "expectedResult.completionCriteria", type: "string",   mergeStrategy: "append",  confirmLevel: "required" },
  { path: "expectedResult.requiredBlocks",     type: "string[]", mergeStrategy: "append",  confirmLevel: "required" },
  { path: "triggerRule",                       type: "enum",     mergeStrategy: "replace", confirmLevel: "required" },
];
```

- 判官 prompt 的可改字段白名单**由此表生成** → LLM 不越界。
- 落库层用同表**服务端二次校验** → 不信任 LLM。
- `append` 需做去重（PRD §13.2 开放项：追加 completionCriteria 时按行去重）。

### 3.4 统一合并器 `taskPatchMerge.ts`

从 `buildMergedTaskCommandInput`（dispatchTaskFromThread.ts L101）提取，签名扩展为：

```ts
export function mergeTaskPatch(
  task: Task,
  patch: TaskPatch,
  registry = TASK_FIELD_REGISTRY,
): TaskCommandInput;   // 产出全量 input，喂给 update_task
```

- 仅允许 registry 白名单字段；`replace` 覆盖、`append` 追加去重。
- `dispatchTaskFromThread.updateTaskFromThread` 改为复用它（保持现有行为：ThreadRunner 的 patch 是 replace 语义，registry 对其字段用 replace）。

### 3.5 落库入口 `governanceCommandService.ts`

```ts
export async function applyGovernanceCommand(input: {
  intent: GovernanceIntent;
  taskRef: TaskRef;
  patch?: TaskPatch;
  revisionHint?: string;
  runtimeEnv: RuntimeEnvironment;
  idempotencyKey: string;
}): Promise<GovernanceApplyResult>;
```

分发（P0 五条）：
| intent | 落库 |
|---|---|
| `amend_task` / `update_task` | `mergeTaskPatch` → `applyGoalCommand({ type:"update_task" })` + 事件 `task.definition_amended` |
| `create_task` | `applyGoalCommand({ type:"create_task" })` + 事件 `task.created_via_chat` |
| `cancel_task` | `applyGoalCommand({ type:"delete_task" })` + 事件 `task.cancelled_via_chat` |
| `rerun_current` | 复用 feedback route 的 `createGeneratedInstance` + `buildRevisionContext` + 落库 |
| `dispatch_task` | 复用 `startTaskAttempt` 做会话直派执行 |
| `pause_task` / 恢复 | 暂停写 `instance.status_changed` + `instance.user_command` 并同步 runtime job；恢复复用 `startTaskAttempt` |

落库前必须 `readGoalsSnapshot` → `composeGoalsWithRuntimeJobs` 保证读时一致（SSOT，对齐 feedback route 的已知教训）。

---

## 4. 确认策略（按 §10.6 可逆性）

| intent | confirmLevel | 交互 |
|---|---|---|
| amend / update / create / cancel(delete) | required | 必弹确认卡，展示 旧→新 diff / 摘要 |
| rerun_current | light | 可执行后提示「已重跑，可撤销」 |

P0 确认卡 payload（`/api/governance/judge` 返回，前端渲染）：
```ts
type GovernanceProposal = {
  intent: GovernanceIntent;
  confirmLevel: "required" | "light";
  summary: string;
  diffs?: Array<{ field: string; before: string; after: string }>;
  applyToken: string;     // 防重放，apply 时回传
};
```

---

## 5. 改动顺序（建议的提交粒度）

按"自底向上、每步可独立验证"排列：

1. **打通 `expectedResult` 全链路写入**（无新功能，纯能力补齐；改动面见 §0.1）
   - 4 处 `TaskCommandInput` 各补 `expectedResult?: TaskExpectedResult`（goalCommandService / topicCommandService / goal-commands.ts / API 内联结构）。
   - 2 处 API 入口 `parseTaskInput`（goals + topics commands route）读取并透传 `expectedResult`。
   - 2 处落库 `createTask` 与 `update_task` 写入 `expectedResult`；`normalizeTaskInput` 透传。
   - 验证：补单测——经 API → 落库后，create_task / update_task 都能持久化 completionCriteria/requiredBlocks（端到端覆盖，防字段在任一层被截断）。
2. **提取统一合并器**
   - 新增 `taskFieldRegistry.ts` + `taskPatchMerge.ts`；`dispatchTaskFromThread` 改为复用。
   - 验证：现有 ThreadRunner update 相关单测仍绿（行为不变）。
3. **判官层**（不接 UI，先可单测）
   - `governanceIntent.ts` + `governancePrompt.ts` + `governanceJudge.ts` + `governanceGate.ts`。
   - 验证：对"信息监测加要求""今天天气""删掉这个任务"等样例，intent 分类正确；失败降级 chitchat。
4. **落库入口**
   - `governanceCommandService.ts`（5 条链路 + 2 条占位）。
   - 验证：amend 能改任务定义并落事件；rerun 能生成修订实例。
5. **API 层**
   - `/api/governance/judge` + `/api/governance/apply`。
   - 验证：端到端 curl——judge 返回 proposal，apply 落库。
6. **前端接入**
   - 会话发送链路调用 judge；渲染确认卡；确认调 apply。
   - 验证：复现本次"信息监测加要求"case，UI 确认后快照真实变更。
7. **回归**
   - `pnpm test:planning` 全绿；手测纯聊天不触发治理。

---

## 6. 测试要点

- **闸门单测**：无 goalId / 无 taskRef / 纯闲聊 → `pass:false`。
- **判官单测**（mock LLM 输出）：10 枚举映射、低置信降级、patch 缺失降级 clarify。
- **合并器单测**：replace 覆盖、append 去重、非白名单字段被拒。
- **落库单测**：amend 写入 expectedResult + 事件；create/delete 正确；dispatch/pause 抛 NotImplemented。
- **集成**：信息监测 case 全流程；纯聊天零触发；判官失败零落库。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 判官误判把闲聊当治理 | 双闸门 + 高置信门槛 + required 确认卡兜底（绝不静默写） |
| `update_task` 全量覆盖丢字段 | 合并器始终基于当前 task 全量重建，仅 registry 字段按策略改 |
| append 重复堆积 | registry 层按行去重（§13.2 开放项落实） |
| 落库读到陈旧快照 | 落库前 `composeGoalsWithRuntimeJobs`，乐观锁 baseRevision 兜底 |
| 判官增加会话延迟 | 第 0 级闸门拦截绝大多数；P0 不做缓存（§10.7），上线后观测 |

---

## 8. P0 明确不做（留 P1）

- 确认卡高级渲染与跨场景组件化（P0 已有会话内确认卡）。
- 会话 Runner 与 ThreadRunner `dispatchActions` 的后端统一（P0 用独立 `governanceCommandService`，P1 再收敛）。
