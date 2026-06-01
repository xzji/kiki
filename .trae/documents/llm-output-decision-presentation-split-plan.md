# 决策层 / 展示层拆分方案

> 把"模型同时输出结构化决策 + 长文解释"的单口气 prompt，拆成两层：
> - **Decision Layer**：极小 JSON，承载机器消费的字段；
> - **Presentation Layer**：自由文本，承载人读的解释，可异步、可降级。
>
> 目标：从根本上消除"JSON 末尾被 token limit 截断 → 整批失败"这一类故障。

---

## 1. Summary

| 维度 | 现状 | 目标 |
|---|---|---|
| 单 prompt 输出 | 决策枚举 + 长 reasoning + suggestions 一锅煮 | 决策极简 JSON；解释独立 plain text |
| 截断半径 | 任一字段截断 → 整次 review 失败 → 主链路终止 | 决策几乎不会截断；解释截断仅影响 UX |
| 失败兜底 | repair → 同长度再生成 → 同位置再断 | 决策有 schema 校验+重试；解释失败可"无解释"降级 |
| 工程改造面 | 集中在 `taskDraftReview` + `goalPlanning.ts` | 同模式可外推 decomposition / planPresentation / collectedInfo |

---

## 2. Current State Analysis

### 2.1 故障复现链（已确认）

- 失败来自 [goalPlanning.ts#L1443-L1483](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1443-L1483) → `reviewTaskDraftsWithClaude` → `runClaudeJson` → `parseClaudeJson`。
- output.txt 末尾以 `]` 结尾，缺最外层 `}`：模型在写完最后一条 `suggestions` 数组后被 max_tokens 切断。
- 修复路径 [jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts) 对"未闭合括号"无能为力（`extractBalancedJsonSnippet` 在 [jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts) depth 不归零时退化为返回原文），repair-via-claude 又用同样的 prompt 让 Claude 重生成同样长度，仍在同位置截断。

### 2.2 review schema 与消费方对照（关键证据）

[taskDraftReview.ts#L12-L21](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts#L12-L21) 定义：

| 字段 | 类型 | 是否被 `applyDraftReview` 消费？ |
|---|---|---|
| `taskId` | string | ✅ 用于映射 |
| `aligned` | boolean | ✅ 过滤条件 |
| `goalContribution` | enum | ✅ 过滤条件 |
| `subGoalContribution` | enum | ✅ 过滤条件 |
| **`reasoning`** | **长字符串** | ❌ **完全未读** |
| **`suggestions`** | **string[]** | ❌ **完全未读** |

`applyDraftReview` 仅当 `aligned===false && goalContribution==="low" && subGoalContribution==="low"` 时丢弃 → **reasoning/suggestions 是"机器无人消费、却把模型逼到 token 悬崖"的纯负担**。

### 2.3 同类风险点（按 token 体积排序）

| 函数 | 输出 schema | 长字段 | 风险 |
|---|---|---|---|
| `reviewTaskDraftsWithClaude` | reviewResults[] | reasoning + suggestions | **高（已发生）** |
| `decomposeGoalWithClaude` ([L1241](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1241)) | goalAnalysis + subGoals + reasoning + risks | reasoning + subGoals[].why/description | 中 |
| `summarizeCollectedInfoWithClaude` ([L1190](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1190)) | 7 个长 string 字段 | 全部 | 中（已有 fallback） |
| `buildPlanPresentationWithClaude` ([L1485](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1485)) | goalTitle + summary + deadline + notificationStrategy | summary | 低-中 |

### 2.4 运行时基础设施可用性

- `runPromptJson` / `runPromptText` 来自 [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts) — 当前不暴露 `maxTokens`，全部走默认。
- workspace trace 已记录 prompt/output/metadata（`logs/claude-traces/...`），可作为 schema 演化的回放数据。
- `parseJsonWithCandidates` 已支持多策略，新增"末尾自动闭合"候选成本低。

---

## 3. Proposed Changes

### 3.1 总体策略：两层分离

```
┌─────────────── Decision Pass (必须成功) ───────────────┐
│ 极小 JSON: { results: [{taskId, aligned, gContrib, sgContrib}, ...] }
│ - 只有枚举/布尔/短 ID，输出长度可估算上限（每 task ~30 token）
│ - schema 校验失败 → 限定次数重试（不靠 LLM 修 JSON）
│ - 拒识时使用保守降级：默认全部 aligned=true 通过
└────────────────────────────────────────────────────────┘
                           ↓
              主链路继续推进（task 进入下一阶段）
                           ↓
┌─────────── Presentation Pass (尽力而为, 异步) ───────────┐
│ Plain text / Markdown: 给用户看的解释 + 建议
│ - 不嵌套 JSON，无括号闭合风险
│ - 失败/超时 → 不展示解释 → 不影响主链路
│ - 可在后台异步生成、SSE 推送、失败重试
└──────────────────────────────────────────────────────┘
```

### 3.2 阶段 1：Task Review 拆分（核心目标，MVP）

#### 3.2.1 新增决策层 prompt：`buildTaskDraftReviewDecisionPrompt`

- **位置**：[taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts)
- **输出 schema**（仅这些）：
  ```
  { "results": [
      { "taskId": "1", "aligned": true, "goalContribution": "high", "subGoalContribution": "high" }
  ] }
  ```
- **prompt 关键约束**：
  - 显式声明"不要 reasoning/suggestions/explanation 字段"。
  - 字段值只能是 enum；taskId 必须使用入参 index 字符串。
  - 一段不超过 200 字的 system 段位于 prompt 顶部（与 contextPack 强格式约束保持一致）。
- **输出体积上限**（理论）：N 个 task × ~80 chars = N×80 字符。10 个 task ≈ 800 字符，远低于任何 token limit。

#### 3.2.2 新增展示层 prompt：`buildTaskDraftReviewPresentationPrompt`

- 入参：`(drafts, decisionResults)`（决策结果作为上下文，让展示层只补"为什么"）。
- 输出格式：纯 markdown 文本，**不要 JSON**。
- 例如：
  ```
  ## Task 1：构建政策关键词库
  - 与子目标对齐度：高
  - 评估理由：...
  - 改进建议：...
  ```
- 调用方式：`runPromptText`（已存在）。

#### 3.2.3 新增 schema 与解析

- 在 `taskDraftReview.ts` 增加：
  - `TaskDraftReviewDecision = { taskId, aligned, goalContribution, subGoalContribution }`
  - `validateTaskReviewDecision(value)`：纯 schema 校验，不写日志副作用。
- `validateTaskReview`（旧）保留，标记 `@deprecated`，不再被新链路使用。

#### 3.2.4 改造 `reviewTaskDraftsWithClaude`

- 位置：[goalPlanning.ts#L1443](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1443)
- **改动**：
  1. 用 `buildTaskDraftReviewDecisionPrompt` 替换原 prompt。
  2. validator 替换为 `validateTaskReviewDecision`。
  3. 决策失败重试 1 次（同 prompt 同 input，重试已有 jsonRepair 候选机制）；仍失败 → **保守降级**：返回 `{ results: drafts.map(d => { taskId, aligned: true, goalContribution: "medium", subGoalContribution: "medium" }) }`，并 `appendGoalLog level=warn`。
  4. **不再调用 `repairMalformedJsonWithClaude`**（决策层输出极短，截断概率 ~0；真正失败靠保守降级，避免再吃一次 LLM 调用的延迟与失败传播）。
- 函数返回类型从 `TaskDraftReviewPayload` 改为 `TaskDraftReviewDecisionPayload`。

#### 3.2.5 适配 `applyDraftReview`

- 当前 [taskDraftReview.ts#L58-L65](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts#L58-L65) 的实现已经只读取 `aligned/goalContribution/subGoalContribution` 三个字段。
- **改动**：把入参 `TaskDraftReviewPayload.reviewResults` 替换为 `TaskDraftReviewDecisionPayload.results` 即可；过滤逻辑不变。

#### 3.2.6 异步展示层：`generateTaskReviewExplanation`（可选、不阻塞）

- 位置：新增到 [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts)。
- 入参：`{ drafts, decision, runtimeEnv, signal, requestId, conversationId, subGoalIndex, totalSubGoals }`。
- 内部调用 `runClaudeText`（[goalPlanning.ts#L721](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L721)）。
- 失败处理：catch 后返回 `null`，写 warn 日志；**不抛**。
- 调用点：在 [goalPlanning.ts#L1818](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1818) `applyDraftReview` 之后 fire-and-forget 启动；产物用于后续 plan presentation 摘要的引用，或仅写入 trace 用于 dogfooding 复盘（见 §3.4）。
- **本期作用域**：仅"启动 + 写 trace"，**不接前端 UI**（避免 SSE 协议改动膨胀，留给后续阶段）。

### 3.3 阶段 2：决策层重试与降级机制（基础设施）

#### 3.3.1 `runPromptJson` 增加 `maxTokens` 可选项

- 位置：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts) 的 `ClaudeStreamOptions` / `runPromptJson`。
- **目的**：决策层可显式声明上限，让 Claude CLI 在调用模型时传 `--max-output-tokens`（若 CLI 暴露），否则在 prompt 顶部加"输出严格限制 ≤ N tokens"软约束。
- **决策层默认值**：`maxTokens: 2000`（足够覆盖 50 个 task 的极简 schema）。
- 不强制要求所有调用方都传；仅决策层、修复路径建议传。

#### 3.3.2 `parseJsonWithCandidates` 新增"自动闭合"候选

- 位置：[jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts)。
- 算法：扫描 raw 文本，跟踪 `{` `[` 栈深度（已 string-aware），若未闭合则按栈反向追加 `}` `]`，得到候选 `auto_closed`，加入候选列表。
- 防御：仅当末尾在结构内（`,` 或 `]` 或 `}` 或 `"`）才尝试；遇到截断在字符串中（无结尾引号）则跳过该候选。
- 单元测试覆盖：3 类用例（缺 `}`、缺 `}]`、字符串中截断不补）。

### 3.4 阶段 3：同模式外推（不在本期实施，仅声明路径）

| 函数 | 拆分方案 | 是否本期改 |
|---|---|---|
| `reviewTaskDraftsWithClaude` | §3.2 | ✅ 本期 |
| `buildPlanPresentationWithClaude` | summary 字段已是给人看的，可拆为：决策层只输出 `goalTitle + deadline`，展示层输出 `summary + notificationStrategy` | ⏸ 留给阶段 3 |
| `decomposeGoalWithClaude` | reasoning/why/risks/assumptions 拆为展示层 plain text | ⏸ 留给阶段 3 |
| `summarizeCollectedInfoWithClaude` | 已有 fallback；优先级低 | ⏸ 留给阶段 3 |

阶段 3 不在本计划交付物中，但本期改动需保证接口形态可向后扩展（即 decision/presentation 工具函数提取到 `taskDraftReview.ts` 后，再外推时能复用结构）。

### 3.5 影响面汇总

| 文件 | 改动 |
|---|---|
| [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) | 新增 decision schema + prompt + presentation prompt + `generateTaskReviewExplanation`；旧 `TaskDraftReviewPayload`/`buildTaskDraftReviewPrompt`/`validateTaskReview` 标 `@deprecated` |
| [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) | `reviewTaskDraftsWithClaude` 改造为决策层流程 + 保守降级；`applyDraftReview` 调用点适配新返回类型；`validateTaskReview`（旧版本，仅在 [L1088](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1088)）保留供 fallback 但不再被链路调用 |
| [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts) | `runPromptJson` 新增可选 `maxTokens` 字段并透传 |
| [jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts) | 新增 `auto_closed` 候选 + 单测 |
| `taskDraftReview.spec.ts`（已存在）/ 新增 `decisionPrompt.spec.ts` | 增加：决策 schema 边界、保守降级、auto_closed 算法的回归 |
| `scripts/run-planning-specs.ts` | 注册新 spec |

---

## 4. Assumptions & Decisions

| # | 决定 | 理由 |
|---|---|---|
| A1 | 决策层失败时**不再调用 LLM 修复**，直接保守降级 | 原修复路径在 token 上限场景下重复失败；保守降级（全 medium/aligned=true）属于"宁错不阻"，与 review 本身的弱过滤性质一致 |
| A2 | 展示层本期仅启动 + 写 trace，**不接 UI** | 避免 SSE/前端 conversationStore 协议改动；阶段 3 再统一接入 |
| A3 | 旧 `validateTaskReview` 保留 `@deprecated` 不删 | 防止 [goalPlanning.ts#L1088](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1088) 直接删除引发其它隐式依赖（trace 回放/checkpoint 兼容） |
| A4 | `auto_closed` 候选只在末尾结构层补，遇字符串截断不补 | 在字符串内部补 `"` 容易制造合法但语义错误的 JSON，宁可让原管线失败 |
| A5 | `maxTokens` 字段仅暴露不强制 | 兼容现有 CLI 行为；若 Claude CLI 不支持透传，则只在 prompt 顶部加软约束（无 breaking） |
| A6 | 阶段 3 不动 | 本期目标是堵住已发故障源；外推先观察一周 dogfooding |

---

## 5. Verification Steps

1. **单测层**
   - `taskDraftReview.spec.ts`：决策 schema 校验通过 / 缺字段被丢弃 / 保守降级输出形态。
   - `jsonRepair.spec.ts`：`auto_closed` 三类用例（缺 `}` / 缺 `}]` / 字符串中截断不补）。
   - 现有 `applyDraftReview` 测试覆盖未变（仍读 3 字段）。
2. **集成层**
   - `pnpm test:planning` 全绿。
   - 在 `taskDraftReview.spec.ts` 加一条"模拟截断"测试：构造一段以 `]` 结尾、缺 `}` 的 raw output，断言决策层走保守降级、不抛。
3. **类型与 lint**
   - `pnpm tsc --noEmit` 无错误。
   - `pnpm lint` 维持原有 warning 数量不增。
4. **dogfooding 验证**
   - 重启 dev server，跑一遍触发 review 的目标规划（"持仓个股监控 + 政策追踪 + 每日推送"任意复杂目标）。
   - 检查 `logs/claude-traces/*reviewing_tasks*/output.txt`：长度应大幅下降（<1KB）。
   - 故意把模型输出 mock 为截断文本（dev-only 旗标，跳过 LLM 直接喂截断 raw），确认保守降级生效、主链路推进至 plan presentation。

---

## 6. Rollback Plan

- 每个改动点都是新增函数 / 新增字段，旧函数保留 `@deprecated`。
- 若决策层 prompt 出现 schema 漂移（模型不肯只输出 4 字段），可通过环境变量 `KIKI_REVIEW_USE_LEGACY_PROMPT=1` 一键回退到旧 `buildTaskDraftReviewPrompt`，回退路径走原 `validateTaskReview` 与原 `repairMalformedJsonWithClaude` 链路。

---

## 7. Out of Scope（明确不做）

- 决策层不引入 schema validation library（zod 等），保持手写 validator 与现有项目风格一致。
- 不修改 `--output-format json` 信封解析（[jsonRepair.ts#L34-L48](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts#L34-L48)）。
- 不重构 `parseClaudeJson` 的日志副作用（已在 architecture-refactor 计划中规划）。
- 不接前端展示层 UI；阶段 3 才做。

---

## 8. Plan Review v2（自检与补强）

> 在第一版基础上做了第二轮 self-review，按严重度发现 8 处遗漏。下面为补强后的统一约束，若与上文冲突以本节为准。

### 8.1 CRITICAL：第二处 review 消费点遗漏

**问题**：除了 [taskDraftReview.ts#L58-L65](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts#L58-L65) 的 `applyDraftReview`，[goalPlanning.ts#L1877](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1877) 还有 `lowAlignmentCount = review.reviewResults.filter(item => !item.aligned).length`，用于触发覆盖度警告。第一版方案没提到这个调用点。

**补强**：
- §3.2.4 改造时，必须同步把 [L1877](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1877) 的 `review.reviewResults` 改为 `review.results`，类型注解换成 `TaskDraftReviewDecisionPayload["results"][number]`。
- 写一个适配 helper `getReviewLowAlignmentCount(review)` 隐藏字段名变化，便于阶段 3 外推时统一处理。

### 8.2 CRITICAL：checkpoint 持久化向后兼容

**问题**：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 多个 checkpoint 写入点会序列化 `review` 对象到磁盘（`logs/checkpoint.json`）。一旦 schema 从 `reviewResults` 变 `results`，**老的 checkpoint 无法被新代码恢复**，会触发 `applyDraftReview` 读不到字段后的隐式空过滤（保留全部 drafts）—— 行为偏移但不报错，最难排查。

**补强**：
- 在 `applyDraftReview` 与 `getReviewLowAlignmentCount` 中加入 **dual-key 读取**：优先读 `review.results`，回退读 `review.reviewResults`。新写入只写 `results`。
- checkpoint resume 路径在 [goalPlanning.ts#L1788](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1788) 附近若读到旧字段，迁移到新字段并写一行 `appendGoalLog level=info` 标记 "schema migration: review legacy → decision"。
- 预计 1 周后（dogfooding 稳定）删除 dual-key 兜底，改为只读 `results`。

### 8.3 HIGH：保守降级的"静默风险"

**问题**：§3.2.4 步骤 3 的保守降级（全部 aligned=true / medium）在生产环境会"看起来正常"，但其实 review 没起作用。如果模型输出长期不稳定，该降级会持续静默生效，等于把 review 这个质量门彻底关掉。

**补强**：
- 保守降级必须：
  1. `appendGoalLog level=warn`，`message: "review 决策层失败，已使用保守降级（默认全部对齐）"`，`details` 含原始解析错误的截断片段（前 500 字）。
  2. 调用 `writePlanningParseFailureSnapshot` 把 raw + prompt 写入 trace（这是项目已有的失败样本采集机制）。
  3. 在产物中添加 `_degraded: true` 标记字段（不参与业务逻辑，仅供 telemetry / dogfooding 复盘 grep）。
- dogfooding 看板需要新增一个"review 降级率"监控（可借用 `appendGoalLog` 的 telemetry 出口，本期只埋点不做面板）。

### 8.4 HIGH：决策层重试策略未明确

**问题**：§3.2.4 步骤 3 写"重试 1 次"，但没说重试什么——是再次跑 LLM？还是只跑一次本地 jsonRepair candidates？两者成本和成功率差异大。

**补强（明确化）**：
- **第一遍**：跑 LLM 获取 raw → `parseJsonWithCandidates`（含新增 `auto_closed`） → 若任一候选解析成功 + schema 校验通过，直接返回。
- **第二遍**：**不重新调 LLM**，仅在原 raw 上跑增强候选集（`auto_closed` + `repair_common_issues` + `balanced` 组合），仍失败 → 保守降级。
- 理由：决策层 prompt 输出 < 1KB，截断概率极低；若第一遍连枚举都吐错，再调一次也大概率同样错，纯浪费延迟。
- 把"重试"二字从 plan 中改为"扩大候选集"，避免歧义。

### 8.5 MEDIUM：异步展示层会被 conversation 关闭/abort 泄漏

**问题**：§3.2.6 fire-and-forget 启动 `generateTaskReviewExplanation`，如果用户在它跑完前关闭会话或触发 abort，这个 promise 会成为孤儿任务，仍然会调 Claude CLI 占用预算，且失败时只会进 unhandled rejection。

**补强**：
- 必须接入与主流程同一个 `signal: AbortSignal`：用户 abort → 展示层一起取消。
- 在 fire-and-forget 启动点用 `void promise.catch(error => appendGoalLog level=warn ...)`，避免 unhandled rejection。
- 加超时上限（30s）：超时则 abort 自身、写 warn 日志、返回 null。

### 8.6 MEDIUM：`maxTokens` 在 Claude CLI 不支持时的兜底

**问题**：§3.3.1 写"若 CLI 暴露则传 `--max-output-tokens`，否则在 prompt 顶部加软约束"，但没说**怎么探测 CLI 是否支持**。直接传未识别 flag 会让 CLI 启动失败。

**补强（决策化）**：
- **本期不传 CLI flag**，仅在决策层 prompt 顶部追加一条软约束：`"输出限制：本次回复必须 ≤ 50 行、≤ 2000 字符；只能输出 results 数组的极简 JSON"`。
- 由于决策 schema 输出体积本身极小（10 task 约 800 字符），软约束 + schema 简化已经足够。
- `runPromptJson` 暂**不**新增 `maxTokens` 字段，避免引入死参数。该项从 §3.3.1 撤销。
- 若未来需要硬约束，再走独立 spike 探测 CLI 能力。

### 8.7 MEDIUM：`auto_closed` 候选的字符串感知边界

**问题**：§3.3.2 的算法说"已 string-aware"，但实际 [jsonExtraction.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/jsonExtraction.ts) 现有实现的 string 状态在末尾被截断时会保持 `inString=true`，需要明确这种情况下的行为。

**补强（细化算法）**：
- 扫描结束时若 `inString===true`，**返回空候选**（不补 `"`、不闭合）。理由是：在字符串内部截断的内容补 `"` 后能解析，但语义内容已经截断不全，可能产生看起来合法但缺字段的 task review，比直接失败更危险。
- 扫描结束时若 `inString===false` 且栈非空：按栈顺序 LIFO 追加 `}`/`]`，得到 `auto_closed` 候选。
- 在追加前再做一次"trailing 清理"：若末尾是 `,`、空白、未闭合的 `"key":`，先剥离这些悬空 token 再补。例如 `... "tasks": [{"id":1},` → 先剥离 `,` 再补 `]}`。
- 单测必须覆盖：
  1. 缺 `}` （末尾是 `]`）→ 期望补 `}`。
  2. 缺 `}]` （末尾是 `}`）→ 期望补 `]}`。
  3. 字符串中截断（末尾未闭合的 `"reasoning": "xxx`）→ 期望返回空候选。
  4. 末尾悬空逗号（`}, ` 或 `, ]`）→ 期望剥离后正确闭合。

### 8.8 LOW：spec 注册位置与 trace_summary 影响

**问题**：§3.5 提到"`taskDraftReview.spec.ts`（已存在）"，但实际 [LS goalPlanning](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning) 没有这个 spec 文件（已存在的是 `blockProtocol.spec.ts` 与 `taskCompiler.spec.ts`）。

**补强**：
- 新建 `/Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.spec.ts`，导出 `runTaskDraftReviewSpecs()`。
- 新建 `/Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.spec.ts` 或扩展已有文件，覆盖 §8.7 的 4 类用例。
- 在 [scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts) 末尾注册（`runTaskDraftReviewSpecs()` + `runJsonRepairAutoCloseSpecs()`）。

---

## 9. 修订后的执行顺序（替代原 §3 隐含顺序）

按依赖关系串行：

1. **基础设施先行**：在 [jsonRepair.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts) 增加 `auto_closed` 候选 + 单测（§3.3.2 + §8.7）。该改动独立、零风险，先验证。
2. **schema + prompt 落地**：在 [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) 增加 decision schema、prompt、validator、`getReviewLowAlignmentCount`、保守降级辅助（§3.2.1 + §3.2.3 + §8.3）。
3. **链路接入**：改造 `reviewTaskDraftsWithClaude`（§3.2.4 + §8.4）；改造 `applyDraftReview`（§3.2.5 + §8.2 dual-key）；改造 [L1877](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1877) 调用点（§8.1）。
4. **异步展示层**：实现 `generateTaskReviewExplanation` + 调用点 fire-and-forget + abort/超时（§3.2.6 + §8.5）。
5. **测试**：写新 spec 文件、注册到 run-planning-specs（§8.8），跑 `pnpm test:planning` / `pnpm tsc --noEmit` / `pnpm lint`。
6. **dogfooding**：重启 dev、跑一遍长目标，验证 trace output.txt 体积变化与降级率。

---

## 10. 修订决策表（v2 新增/变更）

| # | 决定 | v1 → v2 变更 |
|---|---|---|
| A1 | 决策层失败靠保守降级，不再调 LLM 修复 | 不变 |
| A2 | 展示层本期仅启动 + 写 trace | 加 abort/超时约束（§8.5） |
| A3 | 旧 validator 标 `@deprecated` 保留 | 加 dual-key 读取兼容旧 checkpoint（§8.2） |
| A4 | `auto_closed` 候选只在末尾结构层补 | 加 4 类细化用例 + 字符串中截断返回空（§8.7） |
| A5 | `maxTokens` 字段仅暴露不强制 | **撤销**：本期不新增 `maxTokens`，仅在 prompt 加软约束（§8.6） |
| A6 | 阶段 3 不动 | 不变 |
| **A7** | **保守降级必须 warn 日志 + failure snapshot + `_degraded` 标记** | **v2 新增**（§8.3） |
| **A8** | **第二遍重试 = 扩大候选集，不重调 LLM** | **v2 新增（明确化）**（§8.4） |
| **A9** | **新建独立 spec 文件并注册到 run-planning-specs** | **v2 新增**（§8.8） |

