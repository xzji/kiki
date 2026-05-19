# 方案 B：模型拐杖的退役评估（先不改）

> 对应原文《Scaling Managed Agents》最锋利的一句话：
> > Harnesses encode assumptions about what Claude can't do on its own. Those assumptions go stale as models improve.
>
> 翻译成产品语言：**今天为模型短板写的兜底代码，明天会变成项目的死重量。**
>
> 本方案目标：先不删任何代码，但把 KiKi 里所有"为模型当下缺陷而存在的拐杖"梳理成一张可观测、可灰度、可数据化退役的清单。

---

## 0. 一句话目的

> 不删拐杖，但把每根拐杖装上"使用计数器"和"可拆卸开关"，等模型升级后用数据决定哪根可以扔。

---

## 1. KiKi 当前都有哪些"拐杖"？

按"假设了模型做不到什么"分类盘点。

### 拐杖 1：JSON 多级修复链路 🦯

**位置**
- [jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts)
- [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 多处 fallback
- [parseAndRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/parseAndRepair.ts)

**当前逻辑**
1. 直接 `JSON.parse`
2. 失败 → `extractBalancedJsonSnippet` 截括号
3. 失败 → 字符级替换修复（去掉非法转义、修复尾逗号等）
4. 失败 → 让 Claude 再修一次（buildSemanticRepairPrompt）

**它假设了模型做不到什么**
> "Claude 不能稳定输出合法 JSON。"

**这条假设何时会过期**
当目标模型支持稳定的 JSON / structured output 模式（Anthropic tool use、JSON mode），第 2-4 层基本可以下线，只保留第 1 层。

---

### 拐杖 2：`/goal` 5 阶段 workflow 🦯

**位置**
- [goalWorkflow.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/goalWorkflow.ts)
- [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts)
- [goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts)

**当前逻辑**
固定流转：`collecting_info → decomposing → generating_tasks → reviewing_tasks → presenting_plan`，每一步独立调用 LLM。

**它假设了模型做不到什么**
> "Claude 一次输出无法兼顾'澄清+拆解+任务化+自检+UI 友好'，必须由 harness 强制分步。"
> "Claude 不会自己判断需不需要继续追问。"

**这条假设何时会过期**
当模型具备稳定的"端到端规划 + 自检"能力时（更强的 reasoning、自带 reflection），可以从"5 步硬编码"演进为"模型自己决定走几步、harness 只提供工具"。

---

### 拐杖 3：信息收集轮数硬上限 🦯

**位置**
- [easterEggSettingsStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/easterEggSettingsStore.ts) 中的 `infoCollectionMaxRounds`（默认 3）

**当前逻辑**
最多追问 3 轮，到上限强制进入规划。

**它假设了模型做不到什么**
> "Claude 不知道'信息已经够了'，必须由外部 cap 兜底。"

**何时会过期**
模型自己能稳定输出"信息充分度评分"，且评分校准可信。

---

### 拐杖 4：任务结果本地校验 + 二次修复 🦯

**位置**
- [localValidation.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/localValidation.ts)
- [parseAndRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/parseAndRepair.ts)
- [goalTaskAcceptancePrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts) 的 `buildLocalValidationRepairPrompt`

**当前逻辑**
任务输出 → 本地 schema 校验 → 不合格 → 让 Claude 按错误清单修复。

**它假设了模型做不到什么**
> "Claude 输出的结构化结果不一定符合 schema。"

**何时会过期**
模型原生 tool use / structured output 稳定后，schema 违例率显著下降时。

---

### 拐杖 5：Acceptance Judge / Notification Judge 🦯

**位置**
- [resultNotificationJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/resultNotificationJudge.ts)
- [goalTaskAcceptancePrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts)
- [taskFeedbackJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskFeedbackJudge.ts)

**当前逻辑**
执行后再调一轮 Claude 做"我自己刚才做得对不对、要不要通知用户"判定。

**它假设了模型做不到什么**
> "执行 agent 不会同时输出可信的自检结论，必须由独立 judge 调一轮。"

**何时会过期**
执行 agent 可以稳定附带"verdict + confidence"输出，且其与独立 judge 的一致率 > 阈值时。

---

### 拐杖 6：`buildSemanticRepairPrompt` / `buildUserConfirmationOptionsRepairPrompt` 🦯

**位置**
[goalTaskAcceptancePrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskAcceptancePrompt.ts)、[userConfirmationOptionsPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/userConfirmationOptionsPrompt.ts)

**当前逻辑**
解析失败时再起一轮 LLM 让模型自己修。

**它假设了模型做不到什么**
> "首轮输出经常不达标，但模型自己有能力在错误清单引导下修复。"

**何时会过期**
首轮达标率提升到一定水位（比如 ≥ 99%）后，第二轮的 ROI 接近零。

---

## 2. 为什么"先不改"

简单一句话：**这些拐杖现在是真有用的**。

| 理由 | 说明 |
|---|---|
| 当前模型版本下确实有效 | 删除会立刻掉成功率，用户感受立竿见影 |
| 删除收益小 | 主要是"代码更干净"，对 KPI 几乎无贡献 |
| 一旦判错就难还原 | 拐杖删除是单向操作，恢复需要重新调 prompt |
| 模型升级节奏不可控 | 我们不知道下一个能让某根拐杖失效的版本何时来 |
| 与方案 A 没有直接冲突 | 不阻塞核心架构演进 |

---

## 3. 但要做什么（只做"观测改造"，不动业务逻辑）

### 3.1 给每根拐杖装计数器

**目标**：每次拐杖被触发，必须留下一条结构化日志。

字段建议（写到 `data/storage/` 下新增一个 `crutch-telemetry.jsonl`，或者直接进 `goal_event_log` 一类的事件流）：

```json
{
  "ts": "2026-04-08T12:34:56Z",
  "crutch_id": "json_repair.balanced_extract",
  "model_id": "claude-sonnet-4-5",
  "attempt": 2,
  "outcome": "fixed" | "passthrough" | "still_failed",
  "input_size": 1234,
  "context": { "scope": "goal_planning.task_generation", "goal_id": "..." }
}
```

**关键点**
- `crutch_id` 是稳定字符串，方便长期分析
- `model_id` 必须记，否则将来无法做"换模型后是否仍然需要"的对比
- `outcome` 必须区分"是这根拐杖救回了 / 这根拐杖没用上 / 这根拐杖也救不回"

### 3.2 给每根拐杖加"可拆卸开关"

**目标**：能从设置面板（[easterEggSettingsStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/easterEggSettingsStore.ts)）一键关闭某根拐杖，用于灰度对比。

**建议字段**
```ts
type CrutchToggles = {
  jsonRepairBalanced: boolean;          // 默认 true
  jsonRepairCharLevel: boolean;         // 默认 true
  jsonRepairLlmFallback: boolean;       // 默认 true
  goalWorkflowEnforced5Phase: boolean;  // 默认 true
  infoCollectionHardCap: boolean;       // 默认 true
  taskResultLlmRepair: boolean;         // 默认 true
  notificationJudgeIndependent: boolean;// 默认 true
};
```

放进设置 → 隐藏调参 → 新分组「模型能力假设」。

### 3.3 拐杖清单仪表盘（最小版本）

不需要做花哨 UI，做一个 dev-only 页面就够：
- 每根拐杖：触发次数、修复成功率、拐杖关闭时的失败率（A/B 对比）
- 按模型分组：当出现新模型，对比同一根拐杖在新旧模型下的触发频率

放在 `/dev/crutches` 路径，仅内部可见即可。

---

## 4. 退役决策表（未来用数据决定的标准）

每根拐杖到达以下条件之一时，进入"考虑退役"流程：

| 条件 | 判定 |
|---|---|
| 在新模型下连续 4 周触发率 < 1% | 拐杖几乎没用，可以默认关闭，再观察 4 周 |
| 拐杖关闭时（A/B 实验）任务成功率下降 < 0.5pp | 实质上没救回什么，可以下线 |
| 拐杖输出 vs 不带拐杖输出 一致率 > 99% | 拐杖是空跑，可以下线 |
| 出现新的官方能力（structured output / tool use）且覆盖了同一痛点 | 优先迁移到官方能力，把拐杖代码作为 fallback 保留一个版本周期后下线 |

**正式退役流程**
1. 默认关闭一个版本周期（≥ 2 周）
2. 监控核心指标无下降
3. 删除代码 + 加入 changelog
4. 在 [PROJECT_OVERVIEW.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/PROJECT_OVERVIEW.md) §12 工程约束里更新"已下线拐杖"列表

---

## 5. 实施切片（很轻，可以单 Sprint）

仅做"观测层改造"，不动任何业务逻辑：

### Step 1 · 定义拐杖清单（0.5 天）
- [ ] 把 §1 的 6 根拐杖在代码中打上标记常量 `CRUTCH_ID = "..."`
- [ ] 在每根拐杖入口处加 `recordCrutchUsage(crutchId, ctx)` 一行

### Step 2 · 落日志（0.5 天）
- [ ] 实现 `recordCrutchUsage`，写入 `data/storage/crutch-telemetry.jsonl`
- [ ] 自动包含 `model_id`（从当前 runtimeEnv 读）

### Step 3 · 加开关（0.5 天）
- [ ] 在 [easterEggSettingsStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/easterEggSettingsStore.ts) 加 `CrutchToggles`
- [ ] 在每根拐杖入口包一层 `if (!toggles[id]) return passthrough();`
- [ ] 默认值全部为 true（保持现状）

### Step 4 · Dev 仪表盘（0.5-1 天）
- [ ] 新增 `/dev/crutches` 页面
- [ ] 读取 `crutch-telemetry.jsonl`，按 `crutch_id × model_id` 聚合
- [ ] 展示触发次数、修复成功率、近 7 天趋势

合计约 2-3 天工作量。

---

## 6. 与方案 A 的关系

| 维度 | 方案 A | 方案 B |
|---|---|---|
| 本质 | 改架构 | 改观测 |
| 用户能感受到 | 是（关浏览器也跑、能回放） | 否 |
| 紧迫性 | 高 | 低 |
| 是否阻塞 | 不阻塞 B | 不阻塞 A |
| 推荐时序 | 先做 | 等 A 完成或并行做 Step 1-2 |

**实操建议**：方案 B 的 Step 1-2（标记 + 日志）可以**和方案 A 并行进行**，因为只是埋点。Step 3-4（开关 + 仪表盘）等方案 A 落地稳定再启动。

---

## 7. 一句话给老板

> 这些代码现在不能删，但我们可以让它们"会汇报"。装上计数器和开关之后，未来某次模型升级后，可以用 2 周数据决定哪根拐杖该退役，而不是凭感觉删，也不是把它们永远留在代码里。
