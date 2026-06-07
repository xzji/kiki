# PRD：任务结果反馈驱动的「任务自适应调整」机制

> 状态：待评审（PRD 阶段，暂不含技术实现方案）
> 关联代码：`taskFeedbackJudge.ts` / `api/goals/tasks/feedback/route.ts` / `goalTaskPrompt.ts`

## 1. 背景与问题

当前任务结果反馈链路（`taskFeedbackJudge.ts`）只有三种判定：

| 决策 | 含义 | 实际动作 |
|---|---|---|
| `acknowledge` | 满意 / 表达偏好但不要求改 | 仅写实例 `userFeedbackHistory` |
| `clarify` | 不满意但方向不清 | 追问用户 |
| `rerun` | 要求重做**当前结果** | 新建修订实例，重跑这一次 |

**核心缺口**：这三类都无法处理"改未来"的诉求。用户说"下次按新要求执行 / 优化这个任务"属于**对任务定义本身的持久修改**，但系统：

1. 把它误判成 `acknowledge`（实测：反馈被写进 `structuredOutput.userFeedbackHistory`，decision=acknowledge）；
2. 即使判成 `rerun`，也只重跑当前实例，**不回写** `task.description / expectedOutcome / expectedResult` 等权威字段（执行 prompt 读的就是这些字段，见 `goalTaskPrompt.ts` 的 `# Dynamic Context`）；
3. UI 却回复"已记录，下周按新标准执行"——**承诺与系统真实状态不一致**。

### 实测证据（goal: 每周AI产品分析输出机制）

用户反馈："1. 每周信息监测要有具体的 AI 产品扫描和检测；2. 相关新闻增加来源链接；优化这个任务，下次按新要求执行。"

系统真实状态：

- 任务「每周信息监测与素材整理」定义**未变**：
  - 描述仍为 `每日/每两日浏览AI产品相关动态，每周整理可用素材和潜在选题`
  - 预期结果仍为 `本周AI产品领域值得关注的事件、产品更新、趋势信号清单`
  - 完成标准仍为泛化的"输出完整、可展示、可复用的结果"
  - **未加入**"具体 AI 产品扫描和检测"
  - **未加入**"新闻来源链接 / 来源 URL"
- 反馈被判为 `acknowledge`，仅记录在实例历史里。
- UI 文案"已记录，下周按新标准执行"为**假承诺**。

## 2. 目标 / 非目标

**目标**

- 能识别反馈意图是"修当前这一次"还是"改未来这个任务"，或两者都要。
- 当意图是改未来时，把诉求落到**任务定义的权威字段**（SSOT），让后续周期实例真正继承。
- UI 反馈与系统真实变更严格对齐，杜绝"假承诺"。

**非目标**

- 不做跨目标 / 跨子目标的全局策略学习；本期只针对"被引用的那个任务"。
- 不改变现有 `rerun` 重跑机制本身。

## 3. 核心机制：双维度意图识别

把现有"单一 decision"升级为**两个正交维度**，由反馈判断器一次性输出：

**维度 A — 时间范围（Scope）**

- `this_result`：只针对当前这次产出
- `future_task`：针对任务标准本身（影响后续所有实例）
- `both`：当前要重做 + 未来也要改

**维度 B — 动作（Action）**

- `acknowledge` / `clarify`（不变）
- `rerun`（重跑当前实例，不变）
- `amend_task`（**新增**：修改任务定义）

组合出的处理路径：

| Scope × Action | 处理 |
|---|---|
| this_result × rerun | 现状：重跑当前实例 |
| future_task × amend_task | **新增**：生成任务修改提案 → 确认 → 回写任务定义 |
| both | 改任务定义；当前实例**不自动重跑**（见 §5 决策） |
| any × acknowledge/clarify | 现状：记录 / 追问 |

> 判断仍由语义模型完成（复用 `judgeTaskFeedback` 的 prompt 框架），但 schema 增加 `scope` 字段与 `amend_task` 决策，并要求模型在 `future_task` 场景下**禁止**返回 `acknowledge`。这正是本次 case 被误判的根因修复点。

## 4. 任务修改的「字段映射 + 提案模型」

`amend_task` 不是自由改写，而是产出一份**结构化补丁**，只允许命中以下白名单字段（均为执行 prompt 实际消费的字段）：

| 反馈诉求 | 落点字段 |
|---|---|
| "增加 AI 产品扫描和检测" | `task.description` / `task.executionObjective` |
| "每条新闻加来源链接" | `task.expectedResult.completionCriteria` + `requiredBlocks` |
| "产出要包含 XX 板块" | `task.expectedResult.requiredBlocks` / `presentation` |
| "目标说清楚要交付什么" | `task.expectedOutcome` |
| "改成每周二执行" | `task.triggerRule` |
| 子目标层面的成功标准 | `subGoal.successCriteria` |

补丁数据结构（提案，待确认后才落库）：

```json
{
  "taskId": "task-opq-...",
  "summary": "为每周信息监测增加产品扫描与来源链接要求",
  "patches": [
    { "field": "description", "before": "...", "after": "..." },
    { "field": "expectedResult.completionCriteria", "before": "...", "after": "...每条资讯须附可追溯来源URL..." },
    { "field": "expectedResult.requiredBlocks", "before": ["heading","list","paragraph","callout"], "after": ["heading","list","paragraph","callout"] }
  ],
  "sourceFeedbackId": "feedback-msg-user-...",
  "createdAt": "..."
}
```

## 5. 交互流程（高影响动作必须确认）

> 决策已确认：修改周期任务标准属于高影响动作，**必须经用户二次确认（展示旧→新 diff）后才回写**；P0 阶段对当前已完成结果**只改标准、不重跑**。

```
用户引用结果 + 提反馈
        ↓
意图识别（scope + action）
        ↓
 ┌──────────────┴───────────────┐
future_task / both           this_result
        ↓                         ↓
生成「任务调整提案」卡片        现有 rerun / clarify / ack
（展示 旧→新 diff）
        ↓
用户「确认调整」/「修改」/「取消」
        ↓ 确认
回写任务定义(writeGoalsProjection) + 落 goal_event_log
        ↓
UI 明确回复："已更新任务标准，下次起生效"（真实对齐）
```

关键点：

- UI 的"已生效"必须发生在 `writeGoalsProjection` 成功**之后**，文案与实际变更一一对应。
- P0 不做"立即重跑当前实例"；如用户想重做这一次，仍走独立的 `rerun`。

## 6. SSOT 与数据 / 事件模型

遵循项目 SSOT 约定，不双写：

- 任务定义变更**只写**权威 goals snapshot（`writeGoalsProjection`），不在实例里物化第二份标准。
- 新增事件类型 `task.definition_amended` 写入 `goal_event_log`，payload 含 `patches + sourceFeedbackId`，用于审计与回放"任务为什么变了"。
- 实例侧仍保留 `userFeedbackHistory` 作为"原始诉求留痕"，但它不再是承诺兑现的依据。

预计涉及的改动面（供后续技术方案展开，本期不实现）：

- `TaskFeedbackDecision` 扩展 + judge prompt/schema 升级：`taskFeedbackJudge.ts`
- feedback route 增加 `amend_task` 分支与提案返回：`api/goals/tasks/feedback/route.ts`
- 新增"任务调整提案"确认接口（确认后回写）
- 新增任务调整卡片组件（展示 diff）

## 7. 边界场景

- **诉求模糊**（"这个不太行，优化下"）→ 不直接 amend，走 `clarify` 追问改哪一项标准。
- **诉求越界**（要求改成与目标无关的事）→ amend 提案为空，回退 `clarify` 并说明超出该任务范围。
- **一次性任务（taskType≠repeat）** → `future_task` 无意义，提示用户是否改为 `rerun`。
- **用户拒绝提案** → 不改任何字段，仅记录 feedback，文案如实说"未调整"。

## 8. 验收标准

1. 输入"下次按新要求执行 / 优化这个任务"类反馈，**不再**被判为 `acknowledge`。
2. 确认后，`runtime_state_snapshots.goals` 中对应 task 的目标字段确实变更，且 `goal_event_log` 有 `task.definition_amended` 记录。
3. 下一周期实例执行时，prompt 中 `任务描述 / 完成标准` 已包含新增要求。
4. UI 文案与实际落库状态一致（无"假已生效"）。

## 9. 分期建议

- **P0**：意图识别加 `scope` + `amend_task`，修掉误判；任务字段补丁 + 二次确认 + 回写（覆盖本次 case），当前实例不重跑。
- **P1**：diff 卡片可视化 + 事件审计完善。
- **P2**：`both` 路径（改标准后可选立即重跑当前实例）。
