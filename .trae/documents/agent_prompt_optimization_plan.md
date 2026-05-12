# Agent Prompt 优化方案（以"越南 6 日双人游·任务1 确认出发城市与航班"为样本）

## 0. 改动作用域（必读）

**这次改动是对全局 Agent prompt 模板的修改，不是针对单个任务的修改。**

* 修改的文件是 [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts) 中的 `buildGoalTaskRunnerPrompt()` 和 [schemaForPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts) 中的 `TASK_RESULT_PROMPT_FRAGMENT`。

* 这两处是 KiKi 系统中**所有目标任务**生成 Agent prompt 的统一入口（见 [goalTaskRunner.ts:3](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L3) 与 [goalTaskRunner.ts:1345-1350](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1345-L1350)）。

* 因此本计划落地后：

  * 所有由 `executeOnce` 拉起的目标任务（以及修复轮 / 验收路径间接依赖的同一段约束）都会用上新模板。

  * 越南行程 6 个任务、其他历史/未来 goal 下的所有任务、以及前端 Prompt 预览面板看到的 prompt 全部生效。

* 选这个具体任务作为评估样本，是因为它最暴露当前 prompt 在 `userInteractionTiming = before_execution` 场景下的缺陷；但**优化目标是普适的**，方案需要覆盖以下任务族而不能"过拟合"到这一个：

  1. **before\_execution + answer/provide\_context** 类（典型：本样本——必须先识别用户必填字段再决定是否动手）。
  2. **agent\_autonomous + 信息类（information）**（典型：搜集对比、分析报告——直接产出 visual\_report 主交付物）。
  3. **agent\_autonomous + 实物类（deliverable）**（典型：写代码、写文档、生成行程 Markdown——产出 document 主交付物）。
  4. **during\_execution / after\_agent\_output 介入**（典型：方案选择、人工审核——产出方案集 + decision block）。
  5. **resume 续跑**（任意类型回到 awaiting\_user 后被恢复）。

* 因此 §3 的每条优化都需通过条件分支（基于 `task.collaboration` / `task.expectedResult` 字段）来收敛，不会让"信息缺失就停"这条规则误伤本来就该 Agent 自主完成的任务。

***

## 1. 摘要

* 当前 prompt 体量约 **200+ 行**，大量规则互相重复（交付物契约 × 执行约束 × 结构化产物契约 × 返回 JSON 示例），且没有按「执行判断流」组织。

* 对这类 `userInteractionTiming = before_execution`、`userInteractionType = answer`、`mode = agent_user_collaborative` 的任务，prompt 没有**前置判断分支**：Agent 进来第一眼看到的是"你必须真实推进任务"和"必须产出 task\_result.blocks"，然后在第 8 条才出现"缺用户输入要立刻停"。结果就是 Agent 容易先编一份"三个航班方案"占位，再被本地校验判为 `artifact_only / blocked_state_invalid`，触发修复轮，浪费一次 Claude 调用。

* 本次 `task_result` 示例里 `meta.presentation` 直接写成了 `comparison_table`（来自 [goalTaskPrompt.ts:194](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L194)），这是一个 **bug**——`presentation` 合法取值是 `visual_report | document | ...`，`comparison_table` 是 `blocks[].kind`，Agent 会照抄到 meta 里。

* 优化的核心：**加一个"执行前提门" → 精简重复 → 给两套模板（done / awaiting\_user）而不是一套混合模板 → 修掉 presentation 枚举错配**。

***

## 2. 当前 Prompt 的问题清单

基于 [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts) 和 [schemaForPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts) 的实际内容：

### 2.1 指令顺序让"该停"被"必须交付"淹没

* [goalTaskPrompt.ts:105-107](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L105-L107) 开场就是"请以交付物契约为核心真实推进任务"、"不是证明自己做过事情，而是交付可验收产物"——这会把模型推向"赶紧产出 blocks"。

* [goalTaskPrompt.ts:129](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L129) 执行约束第 1 条 `优先直接执行、检索、分析、生成结果` 再次强化。

* [goalTaskPrompt.ts:136-146](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L136-L146) 第 8 条才说"缺用户输入要停"。

* 结果：对 `before_execution + answer` 场景，模型第一直觉是先跑起来再说，而不是先识别"出发城市"这种用户提供字段。

### 2.2 `before_execution / answer / provide_context` 缺少专用分支

* 任务明确告诉 Agent：

  * `userInteractionType = answer`

  * `userInteractionTiming = before_execution`

  * 用户要提供："出发城市""航班偏好（直飞/转机）""最终方案选择"

* 但 prompt **没有**一条"执行前提识别"指令：Agent 没被要求先列出"用户必须给的字段清单"，然后对照 Goal/Task 上下文判断哪些已经有、哪些没有。

* 样本里 Goal 没有出发城市、没有偏好，但 Agent 仍可能把"常见出发城市如上海/北京/广州"作为候选硬塞——这正是执行约束第 9 条禁止的，但没有机制帮 Agent**在动手之前**做这一步 gate。

### 2.3 重复、冗余、同义反复

* **主产出要放进 task\_result.blocks** 被写了 **4 次**：

  * 顶部"你的任务不是证明自己做过事情"一次 [L107](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L107)

  * 执行约束 2 [L130](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L130)

  * 执行约束 5 [L133](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L133)

  * `TASK_RESULT_PROMPT_FRAGMENT` 第 6、7 条 [schemaForPrompt.ts:16-17](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts#L16-L17)

  * 验收规则 4 [L155](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L155)

* **"allowed block kinds"** 写了 2 次（执行约束 3 + TASK\_RESULT\_PROMPT\_FRAGMENT 第 2 条）。

* **"awaiting\_user 时如何填 interaction\_requirement"** 散落在执行约束 8 的 9 个子项里，信息密度过高，关键点（`artifacts 必须为空数组`、`blocks 只能写"需要补充的信息"`）容易被一句话带过。

* **返回 JSON 大模板**同时演示了"done"和"pending\_user"，但没分开；Agent 容易直接抄"done"。

### 2.4 meta.presentation 枚举错配（实现 bug）

* [L194](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L194) 写成：

  ```
  "presentation": "${task.expectedResult?.presentation || (...)}"
  ```

* 当前任务 `presentation = comparison_table`（在 prompt 上面交付物契约里展示为"呈现形态：comparison\_table"），但 `TASK_RESULT_PROMPT_FRAGMENT` 里说"信息类报告优先用 `presentation=visual_report`"。两套命名混用，Agent 极可能原样抄成 `meta.presentation = "comparison_table"`——这和前端可视化渲染器期望的枚举对不上。

* 根因：数据源里 `expectedResult.presentation` 把 block 级呈现（`comparison_table`）和结果级呈现（`visual_report`）塞进了同一个字段。

### 2.5 交付物契约表达形式不利于机器对齐

* 交付物契约用中文散文式 bullet：`- 结果类型：information`、`- 主格式：structured_blocks`、`- 必须包含的 blocks：heading、key_value、comparison_table、callout`。

* 这些字段是**检查清单**（验收会逐项 match），但在 prompt 里是纯文本，没有结构化 JSON 形态。Agent 难以把它们直接映射到 `meta` 和 `deliverable_check.criteria_results`。

### 2.6 协作契约第 6-10 条的"options 必须 2-5 个"与新 UI 不一致

* UI 最近要求"3 个候选 + 1 个自填"（参见最近会话记忆：UI Preference）。

* prompt 说的是 `options 必须给出 2-5 个可直接点击的候选项` [L140](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L140)——与 `AwaitingUserResumePanel` 的结构化渲染（3 候选 + 自填）不对齐。

### 2.7 `suggested_actions` 字段在 awaiting\_user 场景定位不清

* 返回 JSON 模板里既有顶层 `suggested_actions` 又有 `interaction_requirement.suggested_actions`，两者含义没给出明确区分；实际样本里出现了"建议操作：海滩区/珍珠岛/市中心/混合方案/需要更多价格/设施细节再决定"这种**长串文本**，正是这个字段职责混淆造成的副作用。

***

## 3. 优化方案（逐条可执行）

> 目标：让 Agent 在看到这个"确认出发城市与航班"任务时，**第一动作是返回 awaiting\_user=true 并一次性列出 3 个问题（出发城市 / 偏好 / 预算上限）**，而不是先胡编航班表。

### 3.1 Prompt 顶部增加「执行前提门（Step 0）」

**位置**：`buildGoalTaskRunnerPrompt` 返回字符串，在当前 L105 的开场语之后、"目标/子目标/任务标题"之前，插入一个 Step 0 块。

**关键：Step 0 内部必须显式分支，避免误伤 agent\_autonomous 任务**
Step 0 的触发条件绑定协作契约字段，而不是一刀切要求所有任务都走"先问用户"：

* `collaboration.mode = agent_user_collaborative` **且** `userInteractionType ∈ {answer, provide_context}` **且** `userInteractionTiming = before_execution` → 走模板 B 检查。

* `collaboration.mode = agent_autonomous` → Step 0 降级为"快速检查是否有关键事实缺失（如用户从未指定目标）"，默认直接进入模板 A。

* `userInteractionTiming ∈ {during_execution, after_agent_output}` → Step 0 不强制停，Agent 先产出候选方案，再在 `interaction_requirement` 里标记用户介入点。

内容样式（按此模板写入，带分支）：

```
【第一步：执行前提自检（必须先做）】
先看你当前任务的"协作契约 / 用户介入时机 / 用户介入类型"，按以下规则判断：

A. 如果 协作模式=agent_user_collaborative 且 用户介入时机=before_execution 且
   用户介入类型 ∈ {answer, provide_context}：
   1) 列出任务"用户负责"清单中所有需要用户提供的字段；
   2) 对照"目标 / 目标摘要 / 任务描述 / 依赖任务 / 恢复上下文"判断是否已具备；
   3) 任一关键字段缺失 → 不做检索、不给方案、不输出占位对比表；
      直接按 "输出模板 B (awaiting_user)" 返回，一次性列出所有缺失字段。
   4) 全部前提已满足 → 进入正常执行，按 "输出模板 A" 返回。

B. 如果 协作模式=agent_autonomous：
   1) 只检查是否存在无法靠检索/推理补齐的硬缺口（例如：用户从未设定目标方向、凭证缺失）。
   2) 没有硬缺口 → 直接按 "输出模板 A" 正常推进与产出。
   3) 有硬缺口 → 才走 "输出模板 B"，且 interaction_requirement.type 设为 deliverable_gap。

C. 如果 用户介入时机 ∈ {during_execution, after_agent_output}：
   1) Agent 应先产出可选方案 / 对比 / 候选集，填入 task_result.blocks；
   2) 在 interaction_requirement 里注明"需要用户在该节点选择/审核"，
      awaiting_user=true，interaction_requirement.type 按协作契约决定（confirm / answer 等）。

D. 如果本轮是"恢复执行模式" (resumeBlock 存在)：
   1) 仅针对上一轮新暴露的缺口执行 Step 0；
   2) 已由上一轮用户回答的字段严禁重复提问。
```

**效果**：在模型做 chain-of-thought 时，前提自检被显式写成第一步，不再被"必须交付"的情绪淹没。

### 3.2 把"执行约束 8"从一段 9 小条，重构为两个输出模板

当前 L136-L146 的 9 个子项，改成直接给 Agent 两个"输出模板"，模板本身就是正确示例，Agent 只需照抄结构：

**输出模板 A — 正常完成**（保留现有 task\_result 示例，只保留 done / draft 分支）
**输出模板 B — awaiting\_user（执行前提不足）**：

```json
{
  "summary": "需要用户补充关键信息后才能继续",
  "final_message": "面向用户的一段话：说明要补哪些信息、为什么",
  "result_view_kind": "generic_result",
  "awaiting_user": true,
  "awaiting_reason": "简要写缺口",
  "interaction_requirement": {
    "type": "provide_context",
    "timing": "before_execution",
    "reason": "缺少用户才能给的关键输入",
    "question": "请一次性列出本轮所有缺失字段，用自然语言提问",
    "options": ["候选1", "候选2", "候选3"],  // 恰好 3 个；UI 会自动补 1 个"自己填写"
    "suggested_actions": [],                 // awaiting_user 下留空
    "should_notify_user": true
  },
  "suggested_actions": [],
  "artifacts": [],
  "task_result": {
    "schemaVersion": 1,
    "taskId": "${task.id}",
    "instanceId": "${instance.id}",
    "title": "等待用户补充：...",
    "status": "pending_user",
    "blocks": [
      { "kind": "heading", "text": "需要你补充的信息", "level": 2 },
      { "kind": "list", "ordered": true, "items": ["出发城市", "航班偏好（直飞/转机）", "预算上限"] },
      { "kind": "callout", "tone": "info", "text": "补充完这些信息后，Agent 会继续产出航班方案对比表。" }
    ],
    "meta": {
      "producedAt": "ISO 时间",
      "presentation": "visual_report",
      "primaryFormat": "structured_blocks",
      "exportableFormats": ["markdown"]
    }
  },
  "deliverable_check": {
    "matched": false,
    "confidence": "high",
    "delivered_artifacts": [],
    "missing_deliverables": ["出发城市", "航班偏好", "预算上限"],
    "criteria_results": [],
    "gap_reason": "用户必需输入缺失，尚无法产出主交付物"
  },
  "structured_output": {}
}
```

把 9 小条约束浓缩为模板的注释，Agent 抄写正确率会显著提升。

### 3.3 `options` 硬限制为 **3 个**，对齐 UI

* prompt 里 `options 必须给出 2-5 个` 改为 `options 必须给出恰好 3 个`（UI 会自动补 1 个"自己填写"兜底）。

* 在模板 B 的 `options` 下方补一行注释："如果候选项暂时想不出 3 个动作型选项，用『补充具体信息』『补充约束/偏好』『说明暂时无法提供』兜底。"

### 3.4 修复 `meta.presentation` 枚举错配

* 在 [goalTaskPrompt.ts:194](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L194) 不再直接 `task.expectedResult?.presentation`，改为做一次「block 级 → result 级」映射：

  * 已是 `visual_report` / `document` / `dashboard`：直接用。

  * 是 `comparison_table` / `key_value` / `list` 等 block kind：统一转成 `visual_report`（信息类）或 `document`（deliverable 类）。

* 交付物契约列表里把 `- 呈现形态：comparison_table` 这一行改为两行：

  * `- 结果级呈现：visual_report`

  * `- 主视图 block：comparison_table`

* 同步更新 `TASK_RESULT_PROMPT_FRAGMENT` 的第 5 条，对"合法 presentation 枚举"明确列举。

### 3.5 消除重复，统一入口

* 把"主产出必须放进 task\_result.blocks"只在两处保留：

  * Step 0 之后的**总原则**一句话。

  * `TASK_RESULT_PROMPT_FRAGMENT` 内的"第 6 条"。

* 删除：执行约束 2、5 和验收规则 4 中的重复；这些位置替换为引用："详见 结构化产物契约 第 6 条"。

* 把"allowed block kinds"从执行约束 3 移除，只保留在 `TASK_RESULT_PROMPT_FRAGMENT`。

### 3.6 交付物契约 → 结构化 JSON 形态

* 在当前 bullet 形式之外（保留 bullet 以便人读），**追加**一段：

  ```
  【交付物契约机器可读视图】(Agent 必须把它原样映射到最终 deliverable_check.criteria_results)
  {
    "resultType": "information",
    "primaryFormat": "structured_blocks",
    "presentation": "visual_report",
    "requiredBlocks": ["heading","key_value","comparison_table","callout"],
    "completionCriteria": "用户已确认出发城市，且已提供至少3个航班方案供选择",
    "exportableFormats": ["html","markdown"]
  }
  ```

* 对应让 `deliverable_check.criteria_results` 有明确 1:1 目标：`completionCriteria` 拆出两条子标准——`用户已确认出发城市`、`至少 3 个航班方案`。

### 3.7 `suggested_actions` 职责切分

* 明确两个字段：

  * 顶层 `suggested_actions`：**任务已完成后**给用户"下一步可做什么"的建议（如"进入子目标2：交通住宿"）。

  * `interaction_requirement.suggested_actions`：**awaiting\_user 时**给用户在回答问题之外的行动建议。

* prompt 里给一句规则："如果 awaiting\_user=true，顶层 suggested\_actions 必须为空数组。"

### 3.8 `resumeBlock` 场景下对执行前提自检的降级

* 如果 `isResume=true`，Step 0 前提自检改写为"只针对上一轮新暴露的缺口"，避免恢复执行时被要求再做一次全量自检、重复追问用户。

* 在 [L92-L103](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L92-L103) 的 resumeBlock 最后追加一条："只有恢复执行后新发现的缺口才允许再次 awaiting\_user；已由上一轮用户回答的字段不得重复提问。"（实际上已在 L141 有接近表述，但放在 resumeBlock 里更显眼。）

***

## 4. 改动落点（Phase 3 完成后实现时对照）

| 文件                                                                                                                                                               | 改动概要                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/server/goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)                                   | ① 开场之后插入 Step 0 段落；② 执行约束 8 换成「模板 A / 模板 B」两段示例 JSON；③ L194 修复 presentation 取值映射；④ 交付物契约追加机器可读 JSON；⑤ 清理与 TASK\_RESULT\_PROMPT\_FRAGMENT 重复的条目；⑥ resumeBlock 末尾追加"只补新缺口"。 |
| [src/lib/taskResult/schemaForPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts)                         | 第 5 条显式列举 presentation 合法枚举 `visual_report / document / dashboard / kanban`；删除与主 prompt 重复的第 6 条"只返回 artifact 不算完成"（保留在主 prompt 更贴合执行上下文）。                                |
| 验收端对齐（仅核对，不改） [src/lib/server/goalTaskAcceptancePrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts) | 确保 `presentation` 取值改动后，本地校验不再把 `visual_report` 判为 `invalid_block_schema`。                                                                                                |

***

## 5. 预期效果（以本样本任务为验证用例）

* **模型第一次回答**：按模板 B 返回 `awaiting_user=true`，`interaction_requirement.question` 一次性列出 3 个待补字段，`options` 为 3 个动作型候选，`task_result.status=pending_user`，`artifacts=[]`。

* **不再发生**：

  * 凭空给出三家航空公司价格对比表（本地校验 `artifact_only` / `blocked_state_invalid` 会拦，但需要多一轮修复）。

  * `meta.presentation = "comparison_table"` 这种非法取值。

  * 多轮逐一追问"出发城市→偏好→预算"。

* **本地校验 + Acceptance Judge 路径**：第一轮就能被 Acceptance Judge 标为 `needs_user`，直接升成 awaiting\_user，跳过修复轮。

***

## 6. 假设与决策

* **假设 A**：前端 `AwaitingUserResumePanel` 已按"3 候选 + 1 自填"重构（最近会话记忆已证实）。

* **假设 B**：`meta.presentation` 的合法枚举由前端 block renderer + 验收器共同决定；实现阶段需对 `src/components/execution/BlockRenderer.tsx` 里是否消费 `presentation` 字段做一次确认，若只消费 blocks，则 `presentation` 规范化为 `visual_report / document` 两值足够。

* **决策 1**：Step 0 选择以**硬规则**写入 prompt（而非代码端前置 LLM 判断），保证"修改 prompt 即生效"，不增加调用链。

* **决策 2**：不新增字段到 `Task` schema；只在 prompt 输出层做 `presentation` 取值规范化。

* **决策 3**：本次只动 prompt 文案，不改 `TaskResult` 类型或 `BlockRenderer`；风险小、回滚成本低。

***

## 7. 验证步骤（实现后）

> 因 §0 已说明改动作用域是**全局 prompt**，验证必须在多任务族上做回归，不能只看样本。

**A. 静态验证（看 prompt 文本）**

1. 通过 `TaskAgentPromptDrawer` 抽屉，分别打开下列任务的 prompt 文本，逐项核对：

   * 越南行程 任务1（agent\_user\_collaborative + before\_execution + answer）→ Step 0 触发分支 A。

   * 越南行程 任务4 / 5 / 6（多为 agent\_autonomous information）→ Step 0 触发分支 B，应直接走模板 A。

   * 任意一个 deliverable 类任务（agent\_autonomous + 写文档/写代码）→ Step 0 仍是分支 B。

   * 任意一个 during\_execution / after\_agent\_output 介入任务 → Step 0 走分支 C。

   * 任意一个处于 resume 状态的任务 → Step 0 走分支 D，且 resumeBlock 末尾出现"只补新缺口"。
2. 每条 prompt 都需出现：Step 0 段、模板 A、模板 B、机器可读交付物契约 JSON、合法 presentation 枚举说明。

**B. 行为验证（实际执行，跨任务族回归）**

1. **样本任务（分支 A）**：执行越南任务1，首轮 Claude 输出应满足：

   * `awaiting_user === true`、`interaction_requirement.type === "provide_context"`、`options.length === 3`、`artifacts.length === 0`、`task_result.status === "pending_user"`、`deliverable_check.matched === false` 且 `missing_deliverables` ≥ 3 条、`meta.presentation === "visual_report"`。
2. **agent\_autonomous information（分支 B）**：执行一个无用户依赖的"信息汇总"任务：

   * 不会被 Step 0 误触发为 awaiting\_user；

   * 直接产出 `task_result.blocks`，含 comparison\_table / key\_value 等；

   * `meta.presentation === "visual_report"`，不再出现 `comparison_table` / `key_value` 这种 block kind 误填。
3. **agent\_autonomous deliverable**：执行一个写文档/写代码型任务，验证 `meta.presentation === "document"`，blocks 主体是 markdown / list 等。
4. **during\_execution（分支 C）**：执行一个"产生候选方案后等用户选"的任务：

   * blocks 中出现 `decision` block；

   * `awaiting_user === true` 但 `task_result.status` 不是 `blocked`，是 `draft` 或 `pending_user`；

   * `interaction_requirement.type` 不是 `provide_context`。
5. **resume（分支 D）**：把任务1 在 awaiting\_user 状态下补充 1/3 字段后恢复：

   * Agent 不会重新追问已补字段；

   * 只对剩余 2 个字段再次 awaiting\_user，或在已经够用时直接进入正常产出。

**C. 验收链路回归**
6\. 跑一遍本地校验 + Acceptance Judge：确认 `presentation=visual_report` 不再被判为 `invalid_block_schema`；并确认分支 A 的样本任务首轮就被 Acceptance Judge 标为 `needs_user`，跳过修复轮。

***

## 8. 风险与回滚

* **风险 1**：Step 0 过强，让一些"其实能自主完成"的任务过度触发 awaiting\_user。

  * 缓解：Step 0 约束写明"只有明确属于 `用户负责` 或 `userInteractionType ∈ {answer, provide_context}` 时才走模板 B"。

* **风险 2**：Acceptance Judge 对 `presentation=visual_report` 仍按旧规则判为不达标。

  * 缓解：实现后搜索 `presentation` 在验收侧的判定逻辑，一并对齐（本计划只改 prompt，不改验收代码；若验收硬判需要同步改动，再开一份补充计划）。

* **回滚**：单文件 prompt 回滚即可（git revert [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts) / [schemaForPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts)），无 schema/数据迁移。

