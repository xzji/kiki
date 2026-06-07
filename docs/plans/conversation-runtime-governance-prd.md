# PRD：会话驱动的运行时治理机制（Conversation-Driven Runtime Governance）

> 状态：待评审
> 关联代码：`api/claude/chat/route.ts` · `claude/transport.ts` · `thread/threadRunner.ts` · `thread/dispatchActions.ts` · `services/goalCommandService.ts` · `services/conversationCommandService.ts` · `goalPlanning/taskDraftReview.ts` · `api/goals/tasks/feedback/route.ts`
> 前置讨论：本 PRD 取代并扩展了早期的「任务反馈驱动调整」窄方案（`task-feedback-driven-amendment-plan.md`），后者降级为本方案的第一个垂直切片。

---

## 1. 背景与问题

### 1.1 现象
用户在会话中针对某个任务结果提出诉求（如"每周信息监测要加 AI 产品扫描、新闻要带来源链接，下次按新要求执行"），KiKi 回复"已记录，下周按新标准执行"，但系统并未发生任何真实变更：任务定义未改、下一周期实例不会继承新要求。UI 的承诺是**假的**。

进一步追问后定位到这是一个**架构性缺口**，而非反馈机制的小 bug。

### 1.2 根因：会话有"嘴"没有"手"
项目里存在三条**互相隔离**的模型驱动链路：

| 链路 | 触发源 | 能否操作 topic/thread/task | 输出形态 |
|---|---|---|---|
| A. 前台日常会话 `/api/claude/chat` | 用户发消息 | **不能** | 流式纯文本 |
| B. 后台 ThreadRunner loop | 定时 tick | **能**（dispatch/update/cancel/archive/post） | 一次性结构化 JSON |
| C. 目标规划 `/api/goals/plan` | 前端按状态显式调用 | 能（规划期建/改任务，一次性） | 一次性 JSON |

- 有"手"的是链路 B，但它由后台定时器驱动，**用户无法直接触达**。
- 用户能触达的是链路 A，但它**只能输出纯文本**，消费端（`chat/route.ts`、`ConversationView.tsx` 的 `onEvent`）只会把模型输出写进消息气泡。

### 1.3 断点精确定位
- **断点 1（生成侧）**：会话 prompt 使用 `channelPolicy: { mode: "conversation" }`（`transport.ts` `streamPrompt`），只要求自然语言回复，不提供任何 topic/task 工具，也不要求结构化输出。
- **断点 2（消费侧）**：SSE 事件联合类型（`ClaudeStreamEvent`）只有 `delta/message/error/done/session/permission_request/tool_call`，**没有 action 通道**；消费端没有 `parseThreadTickOutput` 这类解析器，也没有 `dispatchThreadActions` 这类派发器。
- **断点 3（调用图）**：`conversationCommandService` 的命令只覆盖会话/消息自身状态，没有 task 命令；它与 `goalCommandService` / `topicCommandService` / `dispatchTaskFromThread` 之间**无任何调用路径**。

### 1.4 本质问题陈述
> 用户在会话里无法对 topic / thread / task 做基础操作（修改、删除、执行/派发、暂停等）。"任务反馈调整"只是这个总问题的一个子集。

---

## 2. 目标 / 非目标

### 2.1 目标
- 让用户能**通过自然语言会话**触发对 topic/thread/task 的治理操作，并真实落库。
- 所有写操作遵循 **SSOT 单写 + 高影响动作需用户确认**，杜绝"假承诺"与静默改写。
- **最大化复用** ThreadRunner 已验证的 action schema 与确定性派发层，不另起炉灶。
- 机制**通用、可扩展**：新增一类可治理操作或一个可改字段时，改动面最小。

### 2.2 非目标
- 不重写整条会话链路的工具协议（不一期就给会话 CLI 注册 topic/task 原生工具）。
- 不做跨目标的全局策略学习。
- 不改变 ThreadRunner 后台 loop 本身的行为。
- 不追求"自由文本直接静默生效"——写操作一律经确认闸门。

---

## 3. 核心设计：两级分诊 + JSON 判官 + 会话 Runner + 确认卡

整体管线（在链路 A 的基础上挂一个"治理 sidecar"，纯聊天仍走原流式回复）：

```
用户消息
   │
┌──┴───────────────── 第 0 级：结构信号闸门（非 LLM，零成本）─────────────┐
│ · 是否引用 task/thread/topic 卡片(taskRef)                              │
│ · 会话是否已绑定 goal (conversation.goalId)                             │
│ · 关键词预筛（重跑/修改/删除/暂停/执行/下次/这个任务…）                  │
└──┬────────────────────────────────────────────┬───────────────────────┘
   │ 命中治理嫌疑                                  │ 未命中
   ▼                                              ▼
第 1 级：意图判官（JSON 模式 CLI，复用 runClaudeJson 范式）         原流式 streamPrompt
   │ 输出极简枚举 { intent, targetRef, confidence }                 （纯文本聊天回复）
   │                                                                    │
   ├─ intent=chitchat/qa / 低置信度 / 解析失败  ──► 降级走原流式回复 ────┘
   │
   ▼ intent ∈ 治理类
会话 Runner（复用 ThreadRunner action schema + dispatcher）
   │ 产出结构化 action 提案（create_task/update_task/amend_task/cancel/dispatch…）
   ▼
确认卡（展示 旧→新 diff / 操作摘要）
   │ 用户「确认」/「修改」/「取消」
   ▼ 确认
确定性命令落库（goalCommandService / topicCommandService / dispatchTaskFromThread）
   │ 单写 · 幂等 · 乐观锁 · 事件溯源
   ▼
UI 真实回执（"已更新任务标准，下次起生效" —— 与落库状态严格一致）
```

### 3.1 第 0 级：结构信号闸门（非 LLM）
纯代码判断，命中才进第 1 级，绝大多数消息在此零成本分流：
- **强信号**：消息携带 `taskRef`（引用了某卡片）。
- **必要条件**：`conversation.goalId` 存在（无绑定目标的会话没有可治理实体，直接走聊天）。
- **弱信号**：治理类关键词预筛，仅用于降低进入第 1 级的频率，不单独作为触发依据。

### 3.2 第 1 级：意图判官（LLM，但用 JSON 模式而非流式）
- **复用 `runClaudeJson` 范式**（规划链路、`taskDraftReview` 已用的一次性结构化调用），**不是**当前流式 `streamPrompt`。
- 只输出极简枚举，不产文案、不落库：

```json
{
  "intent": "amend_task | rerun_current | create_task | update_task | cancel_task | dispatch_task | pause_task | chitchat | qa | clarify",
  "targetRef": "task-xxx | thread-xxx | topic-xxx | null",
  "confidence": 0.0
}
```

- **安全降级**：低置信度 / 解析失败 / schema 不合法 → 一律降级为 `chitchat`，走原流式回复。宁可漏判（用户再说一次），不可误触发写操作。沿用 `taskDraftReview` 的 decision-only + 降级范式。

### 3.3 会话 Runner（复用 ThreadRunner 资产）
- **复用** `threadTickOutputSchema.ts` 的 action 校验（`parseThreadTickOutput`）与 `dispatchActions.ts` 的派发逻辑。
- 与 ThreadRunner 的唯一区别是**触发源**：从"loop tick"换成"用户消息 + 判官意图"。
- Runner 只产出**提案**（机器可读 action + 人读摘要/diff），**无直接落库权限**。

### 3.4 确认卡 + 落库
- 高影响动作（改周期任务标准、删除、批量操作）**必须经用户确认**后才落库。
- 确认后走既有确定性命令服务，遵循单写 / 幂等 / 乐观锁 / 事件溯源。
- UI 回执文案必须发生在落库成功**之后**，与真实变更一一对应。

---

## 4. 支持的治理操作集（按优先级）

| 操作 | intent | 落库命令 | 确认级别 |
|---|---|---|---|
| 修改任务定义/标准（加要求、改频率） | `amend_task` | 统一 `mergeTaskPatch` + 既有 `update_task` | 必须确认 |
| 重跑当前结果 | `rerun_current` | 现有 rerun 链路 | 轻确认 |
| 新建任务 | `create_task` | `create_task` | 必须确认 |
| 取消/删除任务 | `cancel_task` | `delete_task`/cancel | 必须确认 |
| 立即派发执行 | `dispatch_task` | `startTaskAttempt` | 轻确认 |
| 暂停/恢复任务 | `pause_task` | `instance.status_changed` / `startTaskAttempt` | 轻确认 |

> 注：`amend_task` 与现有两个 `update_task` 的关系见 §6。

---

## 5. 字段注册表（通用性与灵活度的核心杠杆）

把"可被会话治理修改的字段"做成**声明式注册表**，而非散落判断。这是"后续灵活度高"的关键：以后想让更多字段可被会话调整，只需注册一项，判官白名单、Runner 提案、落库校验三处自动支持。

每项声明：
```
{
  path: "expectedResult.completionCriteria",
  type: "string" | "string[]" | "enum",
  mergeStrategy: "replace" | "append",   // “加来源链接”属 append
  validate: fn,
  confirmLevel: "required" | "light"
}
```

典型映射：

| 反馈诉求 | 落点字段 | mergeStrategy |
|---|---|---|
| "增加 AI 产品扫描和检测" | `task.description` / `executionObjective` | replace |
| "每条新闻加来源链接" | `expectedResult.completionCriteria` | append |
| "产出要含 XX 板块" | `expectedResult.requiredBlocks` | append |
| "目标说清楚交付什么" | `task.expectedOutcome` | replace |
| "改成每周二执行" | `task.triggerRule` | replace |
| 子目标成功标准 | `subGoal.successCriteria` | append |

- **提案层**白名单从注册表生成 → LLM 天然不越界。
- **落库层**用同一张表做服务端二次校验 → 不信任 LLM 输出。

---

## 6. 任务修改的统一框架（amend_task 与现有两套 update_task 收敛为一套）

### 6.1 现状：表面三套，底层已是一套
代码审计结论：所谓"两套 `update_task`"在**落库层其实是同一个引擎**，外面只是包了不同的入口适配器。真实分层如下：

```
入口适配器（产出 patch / input）              合并 & 落库
──────────────────────────────              ─────────────────────────────────
规划前端手动编辑  → 全量 input ───────────────┐
                                              │
ThreadRunner update_task → updateTaskFromThread│
  （patch 语义）  → buildMergedTaskCommandInput ┼─► goalCommandService.update_task
                  把 patch 合并成全量 input     │   （全量覆盖落库引擎，单写/幂等/乐观锁/事件溯源）
                                              │
（topicCommandService.update_task 仅改名转发到 goalCommandService）
```

证据：
- `topicCommandService.update_task` 只是把命令**转发**给 `goalCommandService`（`topicCommandService.ts` 的命令映射），并非独立引擎。
- ThreadRunner 的 patch 语义不独立落库，而是在 `dispatchTaskFromThread.ts` 的 `buildMergedTaskCommandInput` 里**先把 patch 合并成全量 input，再喂给同一个 `update_task`**。

所以现状的本质是：**一套全量覆盖的落库引擎 + 两个入口适配器**。patch 只是入口处的一个 merge 步骤，不是另一个引擎。

### 6.2 目标形态：统一合并器 + 统一字段注册表 + 多入口适配

`amend_task` 的本质需求 = patch 语义 + 支持 `append`（追加而非覆盖）。它与 ThreadRunner 几乎同构，只多一个 `append` 合并策略。因此**不新增独立命令**，而是把三者收敛为同一套：

```
入口适配器（3 个，各自产出 TaskPatch）            统一合并器                  统一落库引擎（1 个）
──────────────────────────────────            ─────────────────────       ──────────────────
规划手动编辑  → 全量 patch (全 replace)  ┐
ThreadRunner  → 增量 patch (部分 replace) ┼─► mergeTaskPatch(task,patch,    ─► applyGoalCommand
会话 amend    → 增量 patch (replace/append)┘     strategy, 字段注册表校验)        .update_task（全量写）
```

统一点：**三者都退化成"产出一个 TaskPatch → 经统一合并器 → 调同一个全量 update 命令"**。

### 6.3 改造清单
1. **提取统一合并器**：把 `dispatchTaskFromThread.ts` 的 `buildMergedTaskCommandInput` 上移为公共 `mergeTaskPatch(task, patch, { strategy })`，三入口共用。
2. **扩展字段范围**：补 `expectedResult.completionCriteria` / `requiredBlocks` 等当前三套都不支持的子字段——这是现有两套的**共同缺口**，统一后一并修掉。
3. **新增 `append` 合并策略**：对字符串/数组字段支持追加（如"每条新闻加来源链接"），由 §5 字段注册表的 `mergeStrategy` 驱动。
4. **会话入口适配器**：`amend_task` 仅作为第三个轻量入口适配器，把 LLM 提案的 patch 喂进统一合并器，**不引入新落库命令**。

### 6.4 必须保留的差异：确认策略不能抹平
三个入口的信任级别不同，**确认要求属于入口策略，不属于落库引擎**，不可强行统一：

| 入口 | 信任来源 | 确认要求 |
|---|---|---|
| 规划手动编辑 | 用户亲手改 | 无需确认 |
| ThreadRunner | 后台自治（低风险约束兜底） | 无人确认 |
| 会话 amend | LLM 解析用户意图 | **必须确认（展示 diff）** |

### 6.5 收敛边界小结
| 层 | 是否统一 | 做法 |
|---|---|---|
| 落库引擎 | **已统一** | 都是 `applyGoalCommand.update_task`，无需动 |
| 合并器 | **统一** | 提取 `mergeTaskPatch(strategy)`，三入口共用 |
| 字段范围/校验 | **统一** | 共享 §5 字段注册表（单一来源） |
| 入口适配 & 确认策略 | **保持各异** | 3 个适配器各自产 patch，确认级别独立 |

一句话：**值得统一，但统一的是"合并器 + 字段注册表"，而非把三个入口揉成一个函数。** `amend_task` 因此只是第三个轻量入口，且统一过程顺带修复现有两套"改不了 `expectedResult` 子字段"的共同缺口。

---

## 7. SSOT 与数据 / 事件模型
- 任务定义变更**只写**权威 goals snapshot（`writeGoalsProjection`），不在实例里物化第二份标准。
- 新增事件类型 `task.definition_amended`（及其它治理事件）写入 `goal_event_log`，payload 含 `patches + sourceMessageId + intent + confidence`，用于审计与回放"任务为什么变了"。
- 会话实例侧保留原始诉求留痕（`userFeedbackHistory`），但它不再是承诺兑现依据。

---

## 8. 交互与体验
- 判官识别为治理意图后，会话流中插入**操作确认卡**（展示操作类型、目标实体、旧→新 diff / 摘要），而非直接回一段"已执行"的文本。
- 用户可「确认」「修改提案」「取消」。取消则不改任何状态，文案如实说明"未调整"。
- 纯聊天/问答体验完全不变（不经判官，直接流式回复）。

---

## 9. 边界场景
- **诉求模糊**（"这个不太行"）→ 判官输出 `clarify`，追问改哪一项，不直接 amend。
- **诉求越界**（要求与目标无关）→ 提案为空，回退 `clarify` 并说明超出范围。
- **会话未绑定 goal** → 第 0 级即分流为纯聊天。
- **一次性任务（taskType≠repeat）** → `amend_task`（改未来）无意义，提示是否改为 `rerun`。
- **判官失败/超时** → 降级为纯聊天回复，绝不静默写库。
- **用户拒绝确认卡** → 不改任何字段，仅留痕。

---

## 10. 关键设计决策（已与干系人确认）
1. **方向**：通用治理层 + 确认闸门（覆盖会话操作 topic/thread/task 全集），而非只补反馈窄缝。
2. **确认闸门**：修改周期任务标准等高影响动作**必须二次确认（展示 diff）后才回写**。
3. **当前结果处理（P0）**：识别到"改未来"诉求时**只改标准、不自动重跑**当前已完成结果。
4. **判官形态**：意图分类用**一次性 JSON 模式 CLI**（复用 `runClaudeJson`），与流式聊天回复解耦；**不**一期给会话 CLI 注册原生 topic/task 工具。
5. **意图枚举范围**：判官按 §3.2 的**完整 10 个枚举**识别（amend_task / rerun_current / create_task / update_task / cancel_task / dispatch_task / pause_task / chitchat / qa / clarify），不裁剪。
6. **确认分级标准**：按**可逆性**判定——不可逆操作（改未来标准、删除任务）必须确认；可逆操作（重跑、派发、暂停/恢复）轻确认。
7. **判官性能**：P0 **不做缓存/防抖**，靠第 0 级结构闸门控制判官调用频率，上线后按真实调用量再评估优化。

---

## 11. 验收标准
1. 用户在会话中表达"下次按新要求执行/优化这个任务"，**不再**被判为单纯 acknowledge，而是产出 `amend_task` 提案。
2. 用户确认后，`runtime_state_snapshots.goals` 中对应 task 字段确实变更，`goal_event_log` 有 `task.definition_amended` 记录。
3. 下一周期实例执行时，prompt 中任务描述/完成标准已包含新增要求。
4. 用户在会话中可触发新建/删除/派发任务等操作（按分期逐步开放），且均经确认卡。
5. 纯聊天/问答消息不触发任何治理流程，体验与现状一致。
6. 判官失败、低置信度、用户取消时，系统状态零变更，UI 无假承诺。

---

## 12. 分期路线

> 核心拆分原则：**判官能力一步到位（P0 即识别全 10 个枚举），写链路优先复用现有能力**。当前实现已将 7 类写操作全部接入，纯回复类仍不落库。

- **P0｜会话治理垂直切片（判官全识别 + 写操作落库）**
  - 第 0 级结构闸门 + 第 1 级 JSON 判官：**判官识别完整 10 个枚举（§10.5）**，能力一步到位、未来不回炉。
  - **P0 落库范围 = 7 条写链路**：
    - `amend_task`：经 §6 统一框架（`mergeTaskPatch` 合并器 + `expectedResult` 子字段扩展 + `append` 策略），复用既有 `update_task` 引擎（`goalCommandService.ts` L319）。
    - `update_task`：与 amend 同引擎，直接复用。
    - `create_task`：复用 `goalCommandService.ts` L297。
    - `cancel_task`/删除：复用 `goalCommandService.ts` L348（`delete_task`）。
    - `rerun_current`：从 feedback route 抽出独立动作复用。
    - `dispatch_task`：复用 `startTaskAttempt` 做会话直派执行。
    - `pause_task`/恢复：暂停写 `instance.status_changed` + `instance.user_command` 并同步 runtime job；恢复复用 `startTaskAttempt`。
  - **纯回复类**：`chitchat` / `qa` / `clarify` 不落库，直接走回复/追问。
  - 字段注册表先覆盖 description / completionCriteria / requiredBlocks / triggerRule。
  - 确认卡按 §10.6 可逆性分级；落库写 `task.definition_amended` 等治理事件。
  - 目标：完整跑通本次"信息监测加要求"case，并使"改/建/删/重跑/执行/暂停恢复"治理一期可用。

- **P1｜体验与架构收敛**
  - 复用 ThreadRunner 的 `parseThreadTickOutput` + `dispatchActions` 作为会话 Runner 统一后端。
  - 确认卡通用化（diff/摘要组件）。

- **P2｜体验与智能增强**
  - `both` 路径（改标准后可选立即重跑）。
  - 判官与会话回复的合并优化（评估是否值得给会话 CLI 注册原生工具）。
  - 治理操作审计视图。

---

## 13. 评审记录与剩余开放项

### 13.1 已确认（归档至 §10）
- 意图枚举范围：按完整 10 个枚举识别 → §10.5。
- 确认分级标准：按可逆性判定 → §10.6。
- 判官性能：P0 不做缓存/防抖 → §10.7。

### 13.2 剩余开放项（实现期再定）
- "轻确认"的具体交互形态（执行后可撤销 vs 执行前一键确认）。
- `clarify` 追问的话术与轮次上限（避免反复追问骚扰）。
- 字段注册表中 `append` 的去重策略（追加来源链接时如何避免重复项）。
