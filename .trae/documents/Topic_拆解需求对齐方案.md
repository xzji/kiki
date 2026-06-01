# Topic 拆解需求对齐方案

> 目的：在改代码之前，先把"用户输入一个 Topic 后，Agent 应该怎么拆、怎么持续推进、怎么和用户共同完成"这件事的产品/交互需求对齐清楚。本文不涉及代码实现，只描述行为契约和决策规则。
>
> 本次对齐范围：
>
> * **覆盖到完整 Topic 生命周期**（识别 → 拆解 → 持续运转 → 用户协作 → 归档）
>
> * **Topic 不分类**：所有 Topic 是同一种实体，`deadline` 是 Topic 的**可选属性**，存在则影响 Task 排程，不存在则不作为规划参考因素

***

## 一、问题背景与核心改造意图

### 1.1 现状缺口（基于现有代码）

| 现状问题               | 体现                                                      |
| ------------------ | ------------------------------------------------------- |
| 强制 deadline        | 任何输入都按"有 deadline"处理；非量化输入会被强行追问 deadline               |
| 硬塞默认 deadline      | 无法从信息中判断时，统一兜底为 `2026-06-30`，造成"持续关注"型目标拿到一个虚假终点        |
| `Goal.deadline` 必填 | 类型层即不允许空 deadline，下游 schedule / progress / inbox 全部依赖必填 |
| 信息收集靠固定轮数          | 仅看 `answeredRounds / minRounds / maxRounds`，不评估"信息完整度"  |
| 拆解一次完成             | 子目标 + 全部 Task 一次性产出，没有"先给种子任务、运行中再产出"的能力                |
| Task 调度靠自由文本       | `triggerRule` 是字符串，正则解析；`condition` 类规则永远不会自动到期         |
| 单 LLM 拆解           | 没有 Critic / Refiner，错误规划没有挑刺机会，用户只能靠"继续调整"按钮反复让模型重来     |

### 1.2 本次想达成的产品意图

> "用户输入一段他最近想关注的事情，KiKi 不再硬塞 deadline，而是把它拆成几条独立的关注线索（Thread），每条线索按自己的节奏自循环；如果用户输入了明确的 deadline，则让 deadline 影响 Task 的排程；过程中遇到需要用户决定的事情主动询问；一段时间后用户问起，KiKi 能整合产出。"

转译为系统行为：

1. **接收**：把用户输入统一作为一个 Topic 接收，不做类型分支判定。
2. **识别 deadline**：仅识别用户输入中是否包含明确的时间约束；不强行追问、不做兜底默认。
3. **拆解**：拆成 1\~N 条 Thread（独立运转的关注线索）+ 每条 Thread 的初始种子 Task（不一次拆完）。
4. **持续运转**：每条 Thread 按自己的 `loopInterval`（实时/小时/日/周/cron/单次）独立 tick，动态产出新 Task。
5. **协作粒度沿用 Task 级**：是否打扰用户继续由 Task 自带的 `collaborationMode` / `interaction` 控制（沿用现有机制），本期不在 Topic 顶层引入新参与度档位。
6. **归档**：用户主动归档为主；系统不自动归档，仅在长期无产出时给出提示。

***

## 二、Topic 数据模型（统一不分类）

### 2.1 Topic 字段定义

| 字段                   | 是否必填     | 语义                                           |
| -------------------- | -------- | -------------------------------------------- |
| `title`              | 必填       | Topic 名称                                     |
| `summary`            | 必填       | 一段话描述用户想关注/达成的事情                             |
| `deadline`           | **可选**   | ISO 字符串。**仅当用户明确给出**时填写；不存在时表示该 Topic 没有时间约束 |
| `completionCriteria` | **可选**   | 自然语言描述的完成判定条件。仅当用户主动表达了明确终点时填写               |
| `threads[]`          | 必填，1-5 条（**上限 5，推荐 2-4**） | 关注线索数组                                       |

> 不引入 `topicKind` / `quantifiable` / `participationLevel` 等字段。所有 Topic 是同一种实体；行为差异仅由"是否填写了 deadline / completionCriteria"驱动。协作粒度（是否打扰用户）由 Task 级 `collaborationMode` 自治，沿用现有机制。

### 2.2 deadline 的作用范围

| 场景                  | deadline 存在                                   | deadline 缺失                      |
| ------------------- | --------------------------------------------- | -------------------------------- |
| Planner 拆解          | Thread/Task 的排程参考 deadline 倒推                 | 不作为排程参考，按自然节奏（loopInterval）推进    |
| Task `triggerRule`  | 单次型 Task 优先安排在 deadline 之前                    | 单次型 Task 不带强约束截止时间               |
| Topic 详情页头部         | 显示截止日期 + 剩余天数                                 | 不显示截止行（已在 GoalPlanContent 改动中落地） |
| 状态机                 | deadline 到达时给出"是否归档"提示，不自动归档                  | 永远不会出现"超期"语义                     |
| Thread loopInterval | 不强制限制；如果用户给出短期 deadline，Critic 会建议偏向 daily 节奏 | 不限制；以业务自然节奏为主                    |

### 2.3 completionCriteria 的作用范围

| 场景        | completionCriteria 存在                    | 缺失                         |
| --------- | ---------------------------------------- | -------------------------- |
| 进度可视化     | 可显示"已完成 / 未完成"判定状态                       | 仅显示运行轨迹（运行 X 天 / 本周 N 条产出） |
| 自动归档      | 达成 criteria 时给出"是否归档"提示，由用户确认（**不自动归档**） | 不会触发任何归档相关逻辑               |
| Critic 校验 | 检查种子 Task 是否朝向 criteria                  | 仅校验 Thread 是否覆盖用户关注维度      |

***

## 三、Interviewer 阶段（信息收集）需求

### 三大原则：

1. **不强行追问 deadline / 完成标准**：只在用户输入中已经出现明显信号（关键词 / 句式）时才追问澄清；用户没提就不问。
2. **必问只保留关注维度 + 反馈节奏**。
3. **deadline / completionCriteria 留空是合法状态**，不再用 `2026-06-30` 兜底。

### 3.1 必问问题集（统一，不分类型）

按优先级排列：

1. **关注维度 / 推进角度**：希望以什么方式关注或推进？（推送新闻 / 监控异动 / 解读财报 / 跟踪进展 / 完成具体产出 …）
2. **当前上下文**：是否已经持有相关资产 / 资源 / 背景知识？
3. **反馈节奏**：希望多频繁收到反馈？（每日 / 每周 / 仅重大事件）

> 不再询问"全自动 / 重要节点 / 每步确认"等顶层参与度问题。每个 Task 是否需要打扰用户由 Planner 在拆解时按 Task 性质给 `collaborationMode` 打标，沿用现有机制。

### 3.2 条件追问问题集（仅在用户输入中出现相应信号时追问）

| 触发信号                                         | 追问问题                      |
| -------------------------------------------- | ------------------------- |
| 用户输入含具体日期 / 期限关键词（"X 月之前"、"在 X 日期前"、"X 天内"等） | 追问确认 deadline 与紧迫程度       |
| 用户输入含明确量化目标（数字、达到/通过/完成 + 量化对象）              | 追问 completionCriteria 的细节 |
| 用户输入含推送渠道倾向（提到 Inbox / 飞书 / Email）           | 追问推送渠道偏好                  |

> 关键：**这些追问只在用户主动暴露了相应信号时才触发**，不会强行套问。

### 3.3 轮数与结束条件

| 维度        | 现状                                          | 改造后                              |
| --------- | ------------------------------------------- | -------------------------------- |
| 结束判定      | 仅看 `answeredRounds / minRounds / maxRounds` | 同时看"必问字段覆盖率"（必问 3 项至少覆盖 2 项即可结束） |
| minRounds | 由 EasterEgg 配置（默认 2-3）                      | 推荐 1-2（用户输入信息丰富时尽快进入拆解）          |
| maxRounds | 同上                                          | 通用上限保留作为兜底                       |
| **跳过收集**  | 不支持                                         | 支持：用户首条消息已包含必问字段 80% 以上时直接跳过     |

### 3.4 断点续问

* Interviewer 阶段的中间状态（已问问题 + 已收集 slot）必须可持久化（沿用现有 checkpoint 机制）。

* 用户中途切走 / 关闭页面后，回来继续收集时不重复已问的问题。

***

## 四、Planner 阶段（Topic 拆解）需求

### 4.1 拆解输出契约

| 字段                         | 说明                                      |
| -------------------------- | --------------------------------------- |
| `topic.title`              | 必填                                      |
| `topic.summary`            | 必填                                      |
| `topic.deadline`           | **可选**。仅当 Interviewer 收集到明确时间约束时填写；否则留空 |
| `topic.completionCriteria` | **可选**。仅当 Interviewer 收集到明确完成判定时填写；否则留空 |
| `threads[]`                | 1-5 条                                   |

### 4.2 Thread 必填属性

| 字段             | 说明                                                                          |
| -------------- | --------------------------------------------------------------------------- |
| `id`           | 由后端生成                                                                       |
| `title`        | 线索名称，简洁可读                                                                   |
| `intent`       | 该 Thread 的目标说明（一段话）                                                         |
| `loopInterval` | `realtime` / `hourly` / `daily` / `weekly` / `cron:...` / `one_shot` 之一（取值集见 5.2）。**本期不实现 `event-driven`** |
| `seedTasks[]`  | 1-3 条种子 Task。每条 Task 由 Planner 按性质打 `collaborationMode`（沿用现有机制）             |

### 4.3 拆解原则（统一）

| 维度              | 规则                                                                             |
| --------------- | ------------------------------------------------------------------------------ |
| 拆解视角            | 优先按"信号源 / 关注维度"切分（如"持仓监控 / 行业动态 / 财报跟踪"）；如果用户输入显式包含可分解的步骤，则按 MECE 子目标切分        |
| Thread 数量推荐     | 2-4 条（避免过多导致推送过载）                                                              |
| Thread 间依赖      | 默认不允许依赖，全部并行；仅在 Critic 检测到明确前置条件（如"先建白名单 → 再监控"）时允许弱依赖                         |
| loopInterval 选择 | 优先按 Thread 自然节奏选择；deadline 存在时偏向 daily 以保证频次足够；one\_shot 仅用于明确一次性产出（如"产出一份报告"） |

### 4.4 deadline 对拆解的影响

| 场景                       | 行为                                           |
| ------------------------ | -------------------------------------------- |
| Topic 含明确 deadline 且时间充裕 | Thread loopInterval 按业务自然节奏选择；种子 Task 排程不强约束 |
| Topic 含明确 deadline 且时间紧迫 | Critic 建议提高节奏（daily），种子 Task 倒排到 deadline 之前 |
| Topic 不含 deadline        | 完全按业务自然节奏拆解，所有 Task `triggerRule` 不带强截止      |

### 4.5 静态 Task vs 动态 Task

> 这是本次改造的核心差异点之一：**Planner 不再一次性把所有 Task 拆完**。

| Task 来源                               | 说明                                                                                     | `taskType` 默认值                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **种子 Task**（Planner 一次性产出）            | 1-3 条/Thread。用于建立基线、配置数据源、白名单、首轮分析等                                                    | 默认 `one_shot`；**仅当种子 Task 自身的执行频率与所属 Thread.loopInterval 不同**（例如 daily Thread 内挂一条"每周一总结"），才允许打 `repeat`，避免与 Thread tick 同频造成双重重复触发 |
| **动态 Task**（ThreadRunner.tick 在运行中产出） | 由 tick 在 `dispatchActions` 中产出。本期受限于"无外部信号源"，动态 Task 占比有限，主要触发场景是 tick 检测到 Thread 内部状态变化（如某条种子 Task 完成后需补充分析） | **永远 `one_shot`**，跑完即归档（避免 Thread tick 与 Task repeat 双重重复触发） |

> deadline 存在与否不改变这条规则；deadline 影响的是 Task 排程时间，而不是产出时机。

> **关于本期"动态 Task 占比"的诚实表达**：在外部信息源 / knowledge pool 接入前，tick 内部能拿到的"新信号"非常有限，因此本期实际形态更接近"种子 Task 占主体 + 偶发动态 Task 补充"。当 5.2.1 列出的未来扩展能力上线后，动态 Task 占比才会上升到"占主体"。

### 4.6 Critic / Refiner 介入

#### Critic 视角矩阵

| 维度           | 检查内容                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| 节奏合理性        | Thread 的 loopInterval 是否过于密集（如 3 条 hourly Thread 会推送过载）                           |
| deadline 一致性 | 若 Topic 含 deadline，种子 Task 排程是否在 deadline 之前；若不含 deadline，是否仍出现了未授权的截止时间硬塞        |
| 覆盖度          | 用户提到的关注维度是否都有 Thread 覆盖？                                                          |
| 冗余           | 多条 Thread 是否覆盖范围重叠？                                                               |
| 可执行度         | 种子 Task 描述是否含糊？是否依赖未配置的数据源？                                                       |
| 协作模式合理性      | 涉及交易决策 / 财务操作的 Task 是否被默认打成 `agent_autonomous`？应至少 `agent_with_user_confirmation` |

#### Refiner 行为

* 接受 Critic 反馈后输出修订版规划。

* 最大循环次数：3（超过即采用最近一版并标注 issue 给用户）。

* 单轮 Refiner 失败：保留上一版规划，记录到 `agent_events`。

#### Critic 重要约束

* **不应把"无 deadline"判为缺陷**：deadline 是可选字段，缺失是合法状态。

* **不应在用户没提供量化信号时要求"量化的成功标准"**。

### 4.7 Presenter 阶段

* 决策层（紧凑 JSON）：Topic + Thread 结构 + 种子 Task。

* 展示层（异步 fire-and-forget Markdown）：用户看到的"规划草案卡片"自然语言文案。

* 沿用现有"决策/展示层拆分"硬约束（避免 token 截断）。

* 展示层文案要根据 deadline 是否存在差异化措辞（有 deadline 时强调"在 X 之前"；无 deadline 时强调"持续帮你跟踪"）。

***

## 五、Thread 持续运转（运行期）需求

### 5.1 ThreadRunner.tick 抽象流水线

每次 tick 内部按以下步骤推进（不显式建模为 Step，但行为契约必须满足）：

```
collect → filterRelevance → reasonNextActions → dispatchActions
```

| 步骤                  | 输入                      | 输出                       |
| ------------------- | ----------------------- | ------------------------ |
| `collect`           | **本期数据源**：Thread memory + 上次 tick 产出 + 该 Thread 下最近 7 天 Task instances 结果。**本期不接外部源**（外部源接入见 5.2.1） | 内部信号集（已完成的 Task 产出 + memory 中的累积线索）          |
| `filterRelevance`   | 内部信号集                   | 与本 Thread 当前关注点相关的子集     |
| `reasonNextActions` | 相关信号 + 历史               | 决定本次该不该发消息 / 该不该派生新 Task |
| `dispatchActions`   | 决策                      | 发消息（同时落会话+Inbox）/ 派发新 Task / 静默 |

#### 5.1.1 dispatchActions 仅 3 类输出

> **本期简化**：不再区分"会话消息"与"Inbox 卡片"两条独立路径，所有要告知用户的内容统一走 `post_message`，**默认同时落地到当前 Topic 的会话窗口和 Inbox 列表**，由前端各自渲染。

| 动作              | 适用场景                                       | 行为                                                |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| `dispatch_task` | 需要进一步处理：调外部能力 / 多轮分析 / 长耗时 / 等用户决策     | 写一条 Task 入库（**默认 `taskType:one_shot`**，含完整 prompt + triggerRule + collaborationMode），由现有 `goalSchedulerEngine` 派发执行 |
| `post_message`  | tick 内部已能直接给出结论，一句话/一段话能讲完               | 同步写入会话消息流 + Inbox 列表（同一条内容、同一来源，仅渲染位置不同）         |
| `silent`        | 无值得告知用户的事                                  | 仅记一条 `agent_events`，前端无感                          |

**判断规则一句话**：

> **能在本次 tick 一段话讲完的 → `post_message`；要再起一次完整执行流程的 → `dispatch_task`。**

> **同一次 tick 可以同时输出多条动作**（例如先 `post_message` 一句结论，同时 `dispatch_task` 派一个深入分析任务）；3 类动作不是互斥的 3 选 1，而是允许任意组合。`silent` 仅在没有任何 `post_message` / `dispatch_task` 时使用。

> 关于"通知/打扰用户"的最终决策仍由 Task 完成阶段的 `resultNotificationJudge` 把守 —— `post_message` 只覆盖"tick 直接出结论"这条短路径，不替换 Task 完成后的通知判定链路。

### 5.2 loopInterval 与现有 triggerRule 的关系

* 本期不替换现有 `triggerRule` 字段，新增 `Thread.loopInterval`。

* ThreadRunner 在每次 tick 时，根据当前 Thread memory + 本次拉取到的相关信号，决定本次输出（`dispatch_task` / `post_message` / `silent`）；若产 Task，新 Task 默认走 `triggerRule="immediate"`，由现有 `goalSchedulerEngine` 派发。

* **deadline 存在时**：dispatch 的 Task 若是单次型（`one_shot`），可以带具体 datetime triggerRule，从 deadline 倒推。

* **本期 loopInterval 取值**：

  | 取值                                         | 含义                                | 何时叫起 tick                                       |
  | ------------------------------------------ | --------------------------------- | ----------------------------------------------- |
  | `realtime` / `hourly` / `daily` / `weekly` | scheduler 按周期到点                  | **拆解 Saga 完成后立即首跑一次**（确保用户确认拆解后能很快看到第一条产出），后续由 scheduler 检查 `lastTickAt + interval ≤ now` 触发 |
  | `cron:...`                                 | 按 cron 表达式                        | **拆解 Saga 完成后立即首跑一次**，后续按 cron 命中               |
  | `one_shot`                                 | 仅 tick 一次                         | 拆解后立即一次，跑完 Thread 自动归档                          |

* **事件驱动相关能力本期不实现**（不引入 EventDispatcher / `eventTriggers[]` 字段）：

  * 用户在 Topic 会话内的消息：本期 Topic 详情页的会话窗口等价于普通对话，**不实现 Topic 会话 Agent**（不感知 Topic 上下文 / 不调起 Thread tick）；该能力延后到下一版
  * 跨 Task 的**持续/订阅式**依赖：本期不做；沿用现有 `task.dependencies`（仅一次性触发依赖）
  * 外部 webhook / RSS / 行情流：留作未来扩展（见 5.2.1）

#### 5.2.1 未来扩展（不在本期范围内，仅作设计预留）

> 当 Thread 接入"外部信息源 + 自有 knowledge pool"两类能力后，会需要更细粒度的 tick 模型，以下设计预留命名以避免后续重构：

| 未来能力                  | 增量价值                                                                | 对 tick 的影响                                                |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 接入外部信息源（webhook/RSS/行情流） | Thread 不再只靠"上次 tick 后被动累积"，可以由外部数据流主动喂入                              | 引入 `externalSourceSubscription` 字段，Thread 既可周期 tick 也可被外部源 push 唤醒 |
| Thread 自有 knowledge pool | Thread 持有沉淀的长期知识库（不只是短期 memory），tick 时可以基于知识库做更深的"该不该做点什么"判断          | 在 `reasonNextActions` 步骤之前，先做 `knowledge.retrieve` 取相关历史 |
| 跨 Thread 主动协同         | 上游 Thread 的关键产出可以被下游 Thread 订阅                                       | 引入 `threadOutputSubscription` 字段（即原方案的事件订阅），但前置依赖外部源能力打通 |

> 本期实现仅保留 loopInterval 周期性 tick 一种触发路径。上述能力作为 P3+ 的 capability resolver 工作，命名约定先冻结，避免后续不兼容重构。

### 5.3 Thread 终止条件

| 条件                                 | 行为                                             |
| ---------------------------------- | ---------------------------------------------- |
| 用户归档所属 Topic                       | Thread 自动归档                                    |
| 用户单独暂停 Thread                      | tick 停止，状态变 `paused`                           |
| Thread 长期无产出（按 loopInterval 自适应阈值，次数与天数取**先触发**者） | 不自动归档、Thread 状态保持 `active`，仅在 Topic 详情页给出"是否调整 / 归档"提示。阈值（次数维度 / 天数维度，谁先到谁触发）：`hourly` 24 次 或 7 天 / `daily` 7 次 或 30 天 / `weekly` 3 次 或 90 天 / `realtime` 24 次 或 7 天 / `cron` 按对应触发频次折算 |
| 含 completionCriteria 的 Topic 达成判定 | 给出"是否归档"提示，由用户确认（**不自动归档**）。**本期不做自动达成判定**：仅在用户主动打开 Topic 详情页时由前端基于已落地的 Task 产出做提示性比对，不引入后端巡检；**不做跨 Thread 状态聚合** —— 单条 Thread 完成不冒泡 Topic 整体完成判定 |
| Topic deadline 到达                  | 仅在状态条提示"已超期，是否归档？"由用户决定（**不自动归档**）             |

> **关于"无产出 vs 失败"的边界**：tick 输出 `silent` 算作"无产出"但不算"失败"，Thread 状态保持 `active`，仅累计无产出计数；只有 tick 抛错（异常 / 超时）才计入 6.2 的 `paused` 失败计数。两个计数器互不影响。

### 5.4 推送过载控制

> **本期完全不引入 Topic 级过载控制 / 跨 Thread 协调 / 状态聚合**。所有"通知 / 打扰用户"的判定继续沿用现有 Task 级机制（[resultNotificationJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/resultNotificationJudge.ts) + [goalNotificationWorker.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalNotificationWorker.ts)），不在 Topic 顶层叠加任何新机制。

* **Task 级是否打扰用户**：完全沿用现有机制 —— Task 的 `collaborationMode` + `interaction.shouldNotifyUser` + 完成后 `resultNotificationJudge` 三层共同决定。

* **`post_message` 是否打扰用户**：tick 决定写 `post_message` 时直接写入会话流 + Inbox，不再额外做 Topic 级查重 / 限流 / 合并。

* **跨 Thread 去重 / Topic 当日上限 / completionCriteria 跨 Thread 聚合**：本期**全部不做**。出现过载 / 误触发等问题时，再决定加什么协调机制（届时再评估是否需要 Topic Coordinator 这一抽象）。

***

## 六、归档与状态流转

### 6.1 Topic 状态机（统一不分类）

```
collecting_info → active ⇄ paused → archived
```

| 状态                | 触发                       |
| ----------------- | ------------------------ |
| `collecting_info` | Interviewer 阶段中          |
| `active`          | Saga 完成，Thread 开始运转      |
| `paused`          | 用户主动暂停（影响所有 Thread tick） |
| `archived`        | 用户主动归档                   |

> Topic 永远不会被系统自动归档；deadline / completionCriteria 达成时仅产生提示，归档需用户确认。

### 6.2 Thread 状态机

```
active ⇄ paused → archived
```

| 状态         | 触发                                 |
| ---------- | ---------------------------------- |
| `active`   | Topic 进入 active 后，Thread 默认 active |
| `paused`   | 用户主动暂停 / 连续 5 次 tick **抛错（异常/超时）**自动 paused（不含 `silent` 无产出） |
| `archived` | 用户主动归档 / Topic 归档时级联归档             |

### 6.3 系统不自动归档原则

* Topic 没有 deadline → 永远不会因时间到期触发归档相关逻辑

* Topic 有 deadline 但到期 → 提示"已超期，是否归档？"由用户决定

* Topic 有 completionCriteria 且达成 → 提示"是否归档？"由用户决定

* Thread 长期无产出 → 触发条件与提示行为见 [5.3](#53-thread-终止条件)，本节不重复定义阈值（统一以 5.3 表为准）

### 6.4 deadline / completionCriteria 的运行期编辑

* 用户可在 Topic 详情页随时新增、修改、清空 deadline / completionCriteria。

* 编辑这两个字段不会重新触发 Saga，仅更新 Topic 字段。

* 新增 deadline 后，下一次 ThreadRunner.tick 时会重新评估排程；清空 deadline 后，已派发的 Task triggerRule 不回退（保持原排程）。

> **为什么清空 deadline 不回退已派发 Task**：① 已派 Task 可能已开始执行 / 已被用户提前介入，回退会造成用户体感混乱；② 现有 [goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts) 不支持 triggerRule 撤回语义，强行回退需要新增链路；③ 用户清空 deadline 通常意味着"以后不再设期限"，对已经按旧 deadline 排好的 Task 不应反悔。如果用户确实想撤销，可以单独删除 / 暂停对应 Task。

***

## 七、用户协作（"共同完成"）的关键路径

### 7.1 用户能在哪些环节介入

| 环节                       | 可介入动作                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 信息收集                     | 回答问题 / 跳过收集（"信息已经够了直接拆"）                                                                                                |
| 拆解草案展示                   | 确认启动 / 调整规划（自由文本反馈） / 取消                                                                                                |
| 运行中（任意时刻）                | 暂停整个 Topic / 单条 Thread / 手动添加 Task（**必须显式选择归属 Thread，不允许产生无 Thread 归属的孤儿 Task**） / 手动删除 Thread / 手动调整某条 Task 的 `collaborationMode` / 编辑 deadline 与 completionCriteria。**本期不开放运行期编辑 Thread.loopInterval / Thread.intent**（如需调节奏只能暂停该 Thread 后由用户重新拆解，下一版补 UI 入口） |
| 待确认 Task                 | 在 Task 卡片上确认 / 修正 / 跳过（沿用现有 awaiting\_user 流程）                                                                          |
| 询问类 Task（awaiting\_user） | 答复 / 标记线下完成                                                                                                             |
| 长期对话                     | 在会话中追问"这周关注的 X 怎么样了"，**本期会话窗口等价于普通对话**（不感知 Topic 上下文 / 不调起 tick）；Topic 上下文检索能力延后到下一版                                                                                                       |

### 7.2 用户被动态产出的 Task 影响时如何感知

完全沿用现有机制，不引入 Topic 顶层覆盖：

* Task 由 Planner 打 `collaborationMode`：

  * `agent_autonomous`：派发后自动跑，完成后视 `resultNotificationJudge` 决定是否推送

  * `agent_with_user_confirmation`：派发前进入 `awaiting_user`，用户确认后再执行

  * `agent_user_collaborative` / `user_primary_agent_assistive`：每步交互，沿用现有 awaiting flow

* Task 完成后，`resultNotificationJudge` 单独判定 `shouldNotify` + `notificationType`（action\_required / answer\_required / context\_required / result\_ready / silent\_archive）

* Topic 详情页负责把这些事件按 Thread 聚合可视化

### 7.3 用户对 Topic 长期价值的查询

> 这部分是"和用户共同完成"的关键体感：用户一段时间后回来问"我们关注的 X 怎么样了？"

本期最小可用方案：

* **Topic 详情页**：展示 Threads 状态 + 最近 N 条 Task / 推送（**这是本期主要的查询入口**）

* **会话内问答**：**本期不实现** —— 会话窗口不感知 Topic 上下文。如果用户想了解 Topic 进展，请通过 Topic 详情页查看

* **跨 Topic Knowledge Pool**：本期完全不做，留待后续迭代

***

## 八、可观测性与失败处理

### 8.1 拆解 Saga 的可见性

* 用户侧：拆解过程显示"正在分析 → 正在生成规划 → 正在校验 → 正在准备草案"4 个阶段（对应 Interviewer 收尾 → Planner → Critic+Refiner → Presenter）。

* 开发者侧：DevPanel（已规划在改造方案中）展示完整 Saga 时间线 + 各 Agent 决策 / 展示层 payload。

### 8.2 失败兜底

| 失败场景            | 行为                                                           |
| --------------- | ------------------------------------------------------------ |
| Interviewer 失败  | 回退到上一轮，给用户"信息收集出错，是否重试？"提示                                   |
| Planner 失败      | 写入 parse-failure snapshot；提示用户"规划生成出错，是否重试或手动新建？"            |
| Critic 死循环      | 3 次未收敛则采用 Refiner 最近一版 + 在用户卡片上标注 "AI 内部对此规划仍有 N 条疑虑，已附在详情中" |
| Presenter 展示层失败 | 决策层正常落库，展示层失败时使用模板化兜底文案                                      |
| Thread tick 失败  | 单次 tick 失败不归档；连续 5 次失败自动 `paused` 并提示                        |

### 8.3 数据落地

沿用改造方案中的 `agent_events` / `agent_runs` / `saga_instances` 三张表（不在本文档范围内）。

***

## 九、范围边界（明确不做）

为了控制本期范围，以下能力**明确不在本次拆解需求中**，留待后续迭代：

| 项                                                  | 不做的原因                                                  |
| -------------------------------------------------- | ------------------------------------------------------ |
| **Topic 类型分类（kind / quantifiable）**                | 已确认不分类，统一为 Topic + 可选属性                                |
| **Topic 顶层参与度（L0-L4）**                             | 已确认沿用 Task 级 `collaborationMode`，不在 Topic 顶层引入新档位      |
| **Pre/Post Value Gate（价值闸门）**                      | 改造方案 v2.1 已明确后置到 P6                                    |
| **完整 Knowledge Pool（跨 Topic 知识池）**                 | 本期完全不做，跨 Topic 共享上下文留待后续迭代                                    |
| **Topic 会话 Agent / 会话内问答**                          | 本期不做，Topic 详情页会话窗口等价于普通对话；Topic 上下文检索 / 会话感知能力留待下一版           |
| **外部 webhook / RSS 实时事件接入**                        | 受限于 capability resolver 未上线，本期 tick 数据源仅来自 Thread 内部状态（memory + 上次产出 + 最近 Task instances） |
| **跨 Thread 事件订阅 / EventDispatcher**                  | 本期完全不实现，本期 tick 触发路径仅保留 loopInterval 周期性触发；跨 Task 依赖沿用 `task.dependencies`（详见 5.2 / 5.2.1） |
| **Topic 嵌套 Topic**                                 | 已确定顶层平铺，不引入复杂度                                         |
| **多 Conversation 共享 Topic**                        | 本期保持 Topic 与 Conversation 多对一                          |
| **deadline 软提示 vs 硬约束的区分**                         | 本期不分软硬，deadline 存在即作为排程参考；硬约束下沉到 Task triggerRule      |
| **Critic-Refiner 用户中途介入**                          | 拆解 Saga 期间用户不可介入，仅在 Presenter 后调整                      |
| **deadline / completionCriteria 运行期变更引发的 Task 重排** | 本期编辑只改 Topic 字段，已派发 Task 不回退                           |

***

## 十、需求评审清单（下次评审建议聚焦的决策点）

下面这些点在本文档已给出建议，但属于"可以推翻的产品决策"，建议评审时重点对齐：

1. **Interviewer 条件追问触发门槛**：仅在用户输入含明确信号时才追问 deadline / completionCriteria，是否过松？是否需要在某些领域（如考试 / 项目）默认追问一次？
2. **种子 Task 数量（每 Thread 1-3 条）是否合适？** 太少可能让用户感觉"什么都没做"；太多回到一次性拆解。
3. **Critic 最大循环次数 3** 是否会拖慢拆解？是否需要给用户一个"跳过 Critic"的快速路径？
4. **deadline 缺失时的 Thread loopInterval 默认值**：当前建议偏 daily；是否需要让 Planner 自由判断？
5. **Thread 间依赖默认禁用**：仅在 Critic 检测到明确前置时才允许，是否过严？
6. **用户主动跳过信息收集**（首条消息够详细时）的判定门槛是否需要更保守？避免误跳。
7. **deadline 运行期被清空后，已派发 Task 的 triggerRule 是否需要回退？** 当前建议不回退，仅影响后续新派 Task。
8. **Topic 是否需要给用户提供"暂停所有打扰"的开关**（即便不做完整 L0-L4，是否需要保留一个最小的"安静模式"按钮）？

***

## 十一、Prompt 层适配清单（P1.5 阶段实施依据）

> 本节列出本期需求落地时**必须改动的 prompt 模板**，每条均给出"现状 → 改造目标"。如果某条 prompt 在本期改动范围之外，请标注"延后"。

### 11.1 Interviewer 层 Prompt（信息收集）

| 文件 / 函数 | 现状问题 | 改造目标 |
| --- | --- | --- |
| [goalPlanning.ts#buildGoalClarificationPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L361) | 第 3 条优先询问列表里硬塞 "**截止时间/频率**"，与 Topic 不再强制 deadline 的需求冲突 | 改为"关注维度 / 当前上下文 / 反馈节奏"三项必问；deadline 仅在用户输入含明确时间信号时才追问（条件追问）。删除"至少问 1 个确认关键约束的问题"的兜底 |
| [goalPlanning.ts#buildGoalFollowUpQuestionsPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L383) | 仅靠 minRounds/maxRounds 决定是否继续问 | 引入"必问字段覆盖率"判定（必问 3 项至少覆盖 2 项即可结束）；首条消息已包含 80% 必问字段时直接跳过收集 |
| 收集结束总结 prompt | 输出强制要求 deadline 和成功标准 | 输出契约改为：deadline / completionCriteria 是**可选字段**，缺失时显式输出 `null`，禁止使用 `2026-06-30` 兜底 |

### 11.2 Planner 层 Prompt（拆解）

| 文件 / 函数 | 现状问题 | 改造目标 |
| --- | --- | --- |
| [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L620) 第 4 条 + DEFAULT_DEADLINE | "deadline 必须是 ISO 字符串；如果无法可靠判断使用 `2026-06-30T23:59:59+08:00`" + [`DEFAULT_DEADLINE`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L163) 常量 | **删除整条 deadline 兜底语义** + 删除 DEFAULT_DEADLINE 常量；prompt 改为"deadline 仅当用户明确给出时填写，否则输出 `null`"；下游 schema 同步允许 deadline 为可选 |
| Goal 拆解（旧 SubGoal 切分）prompt | 输出结构是 SubGoal[]，每个 SubGoal 含 successCriteria | 改为输出 `topic.threads[]`，每条 Thread 含 `id/title/intent/loopInterval/seedTasks[]`；不再要求 successCriteria 必填（completionCriteria 可选） |
| [taskDraftPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftPrompt.ts) | cadence 字段语义直接落到 Task triggerRule | 在 Thread loopInterval 上下文下重写：种子 Task 默认 `taskType:one_shot`；仅当 Task 频率 ≠ Thread.loopInterval 时才允许 `repeat`；prompt 中明确"避免与 Thread tick 同频造成双重重复触发" |
| Planner 输出契约（决策层 JSON） | 一次性输出全部 Subgoal + 全部 Task | 改为"种子 Task 占主体 + 动态 Task 由 tick 在运行中产出"；契约里明确 seedTasks 数量 1-3 条/Thread；动态 Task 不在 Planner 阶段产出 |

### 11.3 Critic / Refiner Prompt（新增）

> 当前代码中 Critic / Refiner 尚未独立成 prompt，本期需新增。

| 角色 | 关键约束（必须写进 prompt） |
| --- | --- |
| Critic | ① **不应把"无 deadline"判为缺陷**（deadline 是可选字段，缺失合法）；② 不应在用户没提供量化信号时要求"量化的成功标准"；③ 校验 6 个视角：节奏合理性 / deadline 一致性 / 覆盖度 / 冗余 / 可执行度 / 协作模式合理性；④ 涉及交易决策 / 财务操作的 Task 默认 `agent_autonomous` 必须打回为至少 `agent_with_user_confirmation` |
| Refiner | 接受 Critic 反馈后输出修订版规划；最大循环 3 轮；超过 3 轮采用最近一版并标注 issue 给用户；单轮 Refiner 失败保留上一版规划，记录 `agent_events` |

### 11.4 ThreadRunner.tick Prompt（新增，本期核心）

> tick 内部按 `collect → filterRelevance → reasonNextActions → dispatchActions` 流水线推进。本期作为**单 prompt 实现**（不拆 4 个 LLM 调用），但 prompt 必须显式列出 4 步思考过程并要求按步骤输出。

prompt 必备约束：

1. **决策/展示层拆分**（沿用现有硬约束）：tick 输出**仅**返回结构化 JSON 决策（`actions[]`），不允许夹带 markdown 解释。展示层（post_message 的具体文案）由独立异步通道生成。
2. **collect 数据源声明**：明确告诉模型本期 collect 数据源仅来自 ① Thread memory ② 上次 tick 产出 ③ 该 Thread 下最近 7 天 Task instances 结果；**不接外部源**。
3. **dispatchActions 输出 3 类动作**：`dispatch_task` / `post_message` / `silent`；同一次 tick **可叠加输出多条**，仅当无任何 `post_message` / `dispatch_task` 时才使用 `silent`。
4. **判断规则一句话**写进 prompt："能在本次 tick 一段话讲完的 → `post_message`；要再起一次完整执行流程的 → `dispatch_task`"。
5. **dispatch_task 默认 `taskType:one_shot`**：避免 Thread tick 与 Task repeat 双重重复触发。
6. **post_message 同时写会话流 + Inbox**：prompt 不需要让模型决定渠道，固定双写。
7. **不允许产出"无 Thread 归属"的 Task**：所有 dispatch_task 必须挂在当前 Thread。
8. **agent_events.payload ≤ 8KB 硬约束**（沿用项目硬约束，超长内容写外部文件保留引用）。

### 11.5 Presenter Prompt（展示层文案）

| 文件 / 函数 | 现状问题 | 改造目标 |
| --- | --- | --- |
| Presenter（计划草案展示） | 措辞默认假定"在 X 截止前完成" | 根据 deadline 是否存在差异化措辞：① 有 deadline → "在 X 之前 …"；② 无 deadline → "持续帮你跟踪 …"。**禁止在无 deadline 时硬塞虚假终点** |
| [agentOrchestration/prompts.ts#Presenter](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L224) | 现有 Presenter 用于 Task 执行结果展示，不影响本期；保持不动 | 不在本期 Topic 改造范围内（标注为延后） |

### 11.6 Topic 会话 Agent Prompt（本期不实现）

* 7.3 已明确："本期会话窗口等价于普通对话，不感知 Topic 上下文，不调起 Thread tick"。
* prompt 层面：**不新增任何 Topic 会话 Agent 模板**；现有 Conversation Agent prompt 保持不变。
* 延后到下一版。

### 11.7 通用约束（所有新增 / 修改 prompt 都要遵守）

1. **决策/展示层拆分**：长输出一律拆为精简 JSON（决策层）+ 异步生成的 markdown（展示层），避免 token 截断（[jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts) 的 `autoCloseTruncatedJson` 是兜底而非托底，prompt 自身就要短）。
2. **deadline / completionCriteria 缺失合法**：所有 prompt 默认输出契约里 `deadline` 和 `completionCriteria` 必须支持 `null`，禁止任何 `DEFAULT_DEADLINE` 兜底常量。
3. **沿用 collaborationMode 4 档**：所有 Task 生成 prompt 都打 `collaborationMode`（`agent_autonomous` / `agent_with_user_confirmation` / `agent_user_collaborative` / `user_primary_agent_assistive`），不引入新档位。
4. **不引入 Topic 顶层参与度**：prompt 中禁止出现 `participationLevel` / `topicKind` / `quantifiable` 字段。
5. **保留并更新 [promptDuplicationGuardSpec.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/planning/specs/promptDuplicationGuardSpec.ts) 的护栏**：新增 prompt 时同步加入查重断言。

***

## 十二、与现有改造方案 v2.1 的关系

本文档是改造方案 v2.1 中"P1 数据迁移 / P1.5 Prompt 适配 / P2 多 Agent Saga"三个阶段的**需求侧补充说明**：

* v2.1 描述了"做什么 + 用什么架构做"

* 本文档描述了"产品行为契约"（用户和系统在每个状态下的可见行为）

* 二者不冲突；实施时优先以 v2.1 的架构骨架为准，本文档作为 prompt 设计 / UI 状态 / 用户参与点的依据

***

## 十三、本次评审反馈记录

| 轮次 | 反馈                                                                                                                                                                         | 状态   |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| v1 | 把 Topic 分为"持续关注型 / 可量化型"两类                                                                                                                                                 | 已废弃  |
| v2 | 不分类。Topic 统一概念；deadline 是可选属性，存在则影响 Task 执行时间，不存在则不作为规划参考因素                                                                                                                | 已采纳  |
| v3 | Topic 顶层不引入参与度 L0-L4，沿用 Task 级 `collaborationMode`（现有机制：`agent_autonomous` / `agent_with_user_confirmation` / `agent_user_collaborative` / `user_primary_agent_assistive`） | 已采纳 |
| v4 | post_message / write_inbox 不再区分，统一发送到会话+Inbox；简单的 tick 内部直接发消息，需多轮处理才走 task                                                                                                | 已采纳 |
| v5 | event-driven Thread / EventDispatcher / 跨 Thread 事件订阅本期不做；tick 触发只保留 loopInterval 周期性；外部信息源 + Knowledge Pool 作为未来扩展预留命名                                                      | 已采纳 |
| v6 | 删除 Topic Coordinator 概念及其 3 项职责（跨 Thread 去重 / Topic 推送上限 / completionCriteria 跨 Thread 聚合）—— 本期全部不做；Topic 会话 Agent 本期不做；Thread 数量上限 5、推荐 2-4；连续无产出阈值按 loopInterval 自适应；Thread 长期无产出阈值按 loopInterval 自适应 | 已采纳 |
| v7 | 二次 review 修复：① 十章评审清单残留 event-driven 字样清理；② 5.3 / 6.3 两套"无产出"阈值合并为单条（次数 ∨ 天数取先触发）；③ 显式区分 `silent` 无产出（active）与 tick 抛错（5 次后 paused）；④ completionCriteria 主语统一为 Topic，并明确"本期不做自动达成判定"；⑤ "持续依赖" 措辞修正为"持续/订阅式依赖本期不做"；⑥ 种子 Task 打 `repeat` 的边界写死为"频率 ≠ Thread.loopInterval"；⑦ tick 单次输出明确支持多动作叠加；⑧ 拆解 Saga 完成后所有 loopInterval 模式立即首跑一次；⑨ 手动添加 Task 必须显式选 Thread；⑩ 本期不开放运行期编辑 loopInterval / intent | 已采纳 |
| v8 | 新增第十一章 **Prompt 层适配清单**（P1.5 实施依据），覆盖 Interviewer / Planner / Critic / Refiner / ThreadRunner.tick / Presenter 6 类 prompt 的现状对照与改造目标，并写明 7 条通用约束（决策展示拆分 / deadline 可选 / collaborationMode 4 档复用 / 不引入新 Topic 顶层字段 / promptDuplicationGuard 同步等）。同步删除 `goalPlanning.ts` 中 `DEFAULT_DEADLINE` 兜底常量的硬性要求 | 当前版本 |

***

**评审结论由用户填写：**

* [ ] 接受当前需求范围

* [ ] 需要调整：\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

* [ ] 需要补充：\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

* [ ] 暂不通过，原因：\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

