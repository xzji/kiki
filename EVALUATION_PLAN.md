# KiKi 评测方案

## 0. 一句话目标

KiKi 是「长程目标编排 + 本地 Claude 执行」的 Agent 系统，链路长、环节多、单点错会被放大。评测的核心不是「模型答得好不好」，而是**每个可被替换的环节（Prompt / 判定逻辑 / 调度规则）是否稳定产出正确结果，且能把失败结构化喂回去做改进**。

---

## 1. 评测对象：谁被评测

KiKi 的链路可拆成 9 个**可独立评测的节点**。每个节点输入输出明确，可单独打分，避免「端到端一锅煮、出错无法定位」。

| # | 节点 | 关键代码 | 本质 | 输入 | 输出 |
|---|------|---------|------|------|------|
| E1 | 信息收集 / 澄清 | `interviewerPrompt.ts`、`goalWorkflow.ts` | 该不该追问、问得对不对、几轮收敛 | 用户目标原文 | 澄清问题列表 / 充分判定 |
| E2 | 目标拆解（规划） | `plannerPrompt.ts`、`goalPlanning.ts` | 子目标是否 MECE、是否逆向推演 | 澄清后的完整背景 | 子目标 + 任务草案 |
| E3 | 字段发现 | `taskDraftPrompt.ts`、`taskDraftSchema.ts`、`compileFields.ts` | 是否识别出任务真正需要用户提供的字段 | 任务标题 + 描述 | `requiredUserInputs` |
| E4 | 任务草案 Review | `taskDraftReview.ts`、`criticPrompt.ts` | 任务与目标是否对齐、有无遗漏 | 任务草案 | Review 结论 / 修正 |
| E5 | 就绪判定 | `taskReadinessPolicy.ts`、`blockProtocol.ts` | 缺字段判定是否准确（不重复追问、不漏问） | 任务 + resumeContext | ready / blocked + 缺失项 |
| E6 | 调度 | `scheduling/taskScheduler.ts`、`taskDispatcher.ts` | 依赖检查、到期判定、并发、优先级 | 目标快照 + 时钟 | 可派发实例集 |
| E7 | 任务执行 | `goalTaskRunner.ts` | 本地 Claude 真实产出 | 任务 prompt + runtime | 原始结果 JSON |
| E8 | 结果验收 | `localValidation.ts`、`goalTaskAcceptancePrompt.ts` | 本地硬校验 + LLM 验收是否判得准 | 执行结果 | verdict + 修复指令 |
| E9 | 记忆治理 | `memory/*`、`userMemoryCandidates.ts` | 不污染、不泄露、patch 不产生虚假差异 | 会话 / 任务事件 | 记忆写入 / 拒绝 |

另加 2 个**横切评测维度**（不绑定单节点）：

- **X1 端到端闭环**：一个目标从 `/goal` 到任务完成的整体成功率与人工干预次数。
- **X2 性能 / 稳定性**：各环节耗时、JSON 解析失败率、超时率（已有 `benchmark-hi-flow.ts` 雏形）。

---

## 2. 评测标准：每个节点判什么

评测标准分两类：**确定性标准**（可写死断言，0/1 判定）和**质量标准**（需 LLM-judge 或人工打分，0-1 连续分）。

### E1 信息收集
- 确定性：轮数 ≤ 配置上限；信息充分时必须停止追问（不能无限问）。
- 质量：问题是否覆盖任务执行所必需的未知项；是否避免问「描述里已给」的信息（关键痛点，对应历史「重复追问预算」事故）。
- 指标：`收敛轮数`、`无效追问率`（问了已知信息）、`漏问率`（该问没问，导致执行期才发现缺字段）。

### E2 目标拆解
- 质量：MECE（无重叠、无遗漏）、子目标是否可导向最终目标、任务粒度是否可执行。
- 指标：`覆盖度`（关键交付物是否都有对应任务，可对 `deliveryClosureAudit` 复用）、`冗余度`。

### E3 字段发现 / E5 就绪判定（一对，最关键）
- 确定性：给定「任务 + 已提供字段」，期望的 `缺失字段集` 必须精确匹配（不能子串误命中，历史已修过 `/date/` 误匹配 `target_candidates`）。
- 指标：字段级 **Precision / Recall**。
  - Recall 低 = 漏问 → 执行期才暴露 → 体验差。
  - Precision 低 = 多问 / 重复问 → 用户烦躁（历史「反复追问预算」）。

### E4 草案 Review
- 质量：是否抓住任务与目标的错配；是否误杀正确任务。
- 指标：`错配检出率`、`误杀率`。

### E6 调度
- 确定性（全部可写死，用例已在 `taskScheduler.spec.ts`）：依赖未就绪不派发；到期才派发；并发不超上限；优先级正确；`composed` 快照口径一致（历史事故：调度读原始快照导致 1-2 卡住）。

### E7 任务执行
- 质量：产出是否满足 `completionCriteria` 与 `expectedSurfaces`；是否真做了工作而非空摘要。
- 指标：`一次通过率`（E8 直接 pass）、`需修复率`、`需用户介入率`、`假完成率`（声称完成但验收 fail）。

### E8 结果验收（评「评委」本身）
- 确定性（本地校验）：artifact-only 必须判不通过；缺 `task_result.blocks` 必须报 `missing_task_result`（用例已在 `test-task-acceptance.ts`）。
- 质量（LLM 验收）：与人工标注的 verdict 一致率；修复指令是否可执行、是否定向（不要求无关重写）。
- 指标：`验收准确率`（vs 人工）、`漏放率`（fail 误判 pass）、`误杀率`（pass 误判 fail）。

### E9 记忆
- 确定性：敏感信息（密钥 / 临时 token）不得写入长期记忆；patch 更新只产生真实 diff（历史 lesson：updateMessage 幂等）。
- 指标：`污染率`、`泄露率`、`虚假差异率`。

### X1 端到端
- `目标完成率`、`平均人工干预次数`、`平均推进时长`、`卡死率`（任务长时间无进展）。

### X2 性能
- 各环节 P50/P95 耗时、`JSON 解析失败率`（规划链路容错触发次数）、`超时率`。

---

## 3. 如何高效评测：四层金字塔

按「成本从低到高、频率从高到低」分层，绝不所有东西都跑真实 Claude。

```
        ┌─────────────────────────┐
  L4    │ 人工抽检 (周/版本级)      │  最贵，只抽 LLM-judge 拿不准的样本
        ├─────────────────────────┤
  L3    │ 端到端真实执行 (夜间/发版) │  跑真 Claude，小黄金集，看 X1
        ├─────────────────────────┤
  L2    │ LLM-as-judge 离线评分     │  固定输入样本，judge 打分，无需端到端
        ├─────────────────────────┤
  L1    │ 确定性 spec (每次提交)     │  最快，纯函数断言，秒级，已有脚手架
        └─────────────────────────┘
```

### L1 确定性 spec —— 复用现有 `pnpm test:planning`
- 覆盖 E5/E6/E8 的确定性标准（已有大量 `.spec.ts`，见 `run-planning-specs.ts`）。
- **新增**：E3 字段发现的「黄金任务 → 期望字段集」断言；E9 记忆污染断言。
- 特点：不调模型、纯逻辑、每次 commit 跑、CI 阻断。

### L2 LLM-as-judge 离线评分（核心新增能力）
针对 E1/E2/E4/E7/E8 这类「没有唯一正确答案」的节点：
1. 准备**固定输入样本集**（见第 4 节数据集）。
2. 跑被测节点 → 拿到输出（E1/E2/E4 可只跑该节点的 Prompt，不端到端）。
3. 用一个**独立的 judge Prompt**（与被测 Prompt 解耦）按 rubric 打分，输出结构化 JSON：
   ```json
   { "score": 0.0-1.0, "dimensions": {...}, "failures": ["..."], "evidence": "..." }
   ```
4. 关键：**judge 与被测用不同上下文 / 角色**，且 judge 输出必须带 evidence，便于回溯（符合「可追溯根因」偏好）。
- KiKi 已有现成的 judge 范式（`goalTaskAcceptancePrompt.ts` 就是验收 judge），扩展到规划 / 字段层即可。

### L3 端到端真实执行
- 只在夜间 / 发版前跑，用**小而精的黄金目标集**（10-30 个真实目标）。
- 走完整 `/goal` → 调度 → 执行 → 验收，采集 X1 指标。
- 复用 `dogfood-daemon.ts`、`benchmark-hi-flow.ts` 的链路驱动方式。

### L4 人工抽检
- 只抽 L2 中 judge `confidence=low` 或分数处于阈值边界的样本。
- 人工标注结果回灌成新的黄金样本（数据集滚雪球）。

---

## 4. 数据集与采集：评测的燃料

高效评测的前提是有**稳定、可回放、带标注**的样本。三个来源：

### 4.1 黄金集（Golden Set）—— 手工精标，少而稳
- 每个节点 10-30 条「输入 + 期望输出 / 期望分数」。
- 例：E3 黄金条 = `{任务标题, 任务描述, 已提供字段}` → `期望缺失字段集`。
- 存为版本化 fixture（建议 `eval/golden/<节点>/*.json`），改 Prompt 后必须回归。

### 4.2 回放集（Replay Set）—— 从线上失败捞，自动滚动
- 已有基建：`replay-planning-failures.ts` 从 `data/workspaces/conversations` 捞真实样本回放解析。
- 已有信号源：`goalTelemetry.ts` 落盘的 progress/log（含 failed 状态、attemptCount、error）。
- 机制：**任何线上失败 / 需修复 / 重复追问的 case，自动归档为回放样本**，下次评测必跑 → 防回归。

### 4.3 合成集（Synthetic Set）—— 用 LLM 批量造边界
- 让 Claude 生成「易触发字段漏问 / MECE 失败 / 假完成」的刁钻目标，扩充覆盖面。
- 仅作压力测试，不作为正确性基线（基线只信黄金集 + 人工标注）。

---

## 5. 反馈闭环：评测结果如何喂回 AI 做优化

这是用户最关心的一环。评测产出**结构化、可机器消费的失败报告**，而不是一句「分数 72」。

### 5.1 失败报告的结构
每条失败样本统一格式（KiKi 已在验收链路用类似结构）：
```json
{
  "node": "E3",
  "input": { ... },
  "expected": { ... },
  "actual": { ... },
  "failureType": "missing_field | over_ask | misalignment | hallucinated_completion | ...",
  "severity": "critical | major | minor",
  "evidence": "judge 给出的判据",
  "repairHint": "定向修复建议（不要求无关重写）"
}
```

### 5.2 三级反馈路径（从轻到重）

**① Prompt 自动迭代（轻量、可自动化，符合「低维护成本」偏好）**
- 把同一节点的 N 条失败报告聚合 → 喂给一个「Prompt 改进 Agent」→ 输出对被测 Prompt 的**定向 patch 建议**。
- 关键约束：patch 必须只针对失败模式，禁止重写整段（复用项目已固化的「定向修复、不无关重写」原则）。
- 改完立刻在黄金集 + 回放集回归，分数不退化才采纳。

**② 判定逻辑 / 阈值调整（半自动）**
- 若失败集中在确定性节点（E5 误匹配、E6 口径），说明是代码逻辑问题，转成 spec 用例 + 修代码（历史已这样修过 `/date/` 误匹配）。

**③ 数据集回灌（持续，让评测越用越准）**
- 人工抽检（L4）结论 → 新黄金样本。
- 线上失败（4.2）→ 新回放样本。
- judge 与人工不一致的样本 → 校准 judge Prompt 本身。

### 5.3 闭环图

```
线上 telemetry / 失败 ──► 回放集
黄金集 + 回放集 ──► L1/L2 评测 ──► 结构化失败报告
        │                              │
        │                              ├─► ① Prompt patch 建议 ──► 回归 ──► 采纳/丢弃
        │                              ├─► ② 转 spec + 修逻辑
        ▼                              └─► ③ 回灌数据集
   分数看板（趋势、按节点、按失败类型）
```

---

## 6. 落地路线图（基于现有脚手架，最小增量）

KiKi 已有的可复用资产：`run-planning-specs.ts`（L1 框架）、`test-task-acceptance.ts`（judge 范式）、`replay-planning-failures.ts`（回放）、`goalTelemetry.ts`（信号源）、`benchmark-hi-flow.ts`（性能）。

| 阶段 | 动作 | 复用 / 新增 |
|------|------|------------|
| P0 | 建 `eval/` 目录：`golden/`、`replay/`、`reports/`；定义统一失败报告 schema | 新增目录 + 1 个 type |
| P0 | E3/E5 字段发现黄金集 + 断言接入 `test:planning` | 复用 L1 框架 |
| P0 | E6 调度口径回归（防 composed/原始 快照不一致重演） | 扩 `taskScheduler.spec.ts` |
| P1 | L2 judge runner：读黄金集 → 跑节点 → judge 打分 → 出报告 | 复用验收 judge 范式 |
| P1 | telemetry 失败自动归档为回放样本 | 复用 `goalTelemetry.ts` |
| P2 | L3 端到端黄金目标集 + X1 指标采集脚本 | 复用 `dogfood-daemon.ts` |
| P2 | Prompt 自动迭代 Agent（失败聚合 → patch 建议 → 回归） | 新增 |
| P3 | 分数看板（按节点 / 失败类型 / 趋势） | 新增 |

建议新增 npm scripts：
```
"eval:specs"   → L1 确定性（合入 test:planning 或独立）
"eval:judge"   → L2 LLM 离线评分
"eval:e2e"     → L3 端到端黄金集
"eval:report"  → 汇总出报告 + 趋势
```

---

## 7. 优先级建议

- **P0（先做，性价比最高）**：E3/E5 字段发现的黄金集 + Precision/Recall。这是项目历史事故最密集的环节（重复追问、漏问、子串误命中），且确定性可断言、成本最低。
- **P1**：L2 judge runner + 失败自动归档闭环。让评测能覆盖「无标准答案」节点并自我滚动。
- **P2**：端到端 X1 + Prompt 自动迭代，形成「评测 → 改 Prompt → 回归」的自动优化飞轮。

---

## 8. 关键原则（贯穿全方案）

1. **分层定位**：能用确定性 spec 判的，绝不上 LLM-judge；能离线判的，绝不端到端。成本与频率匹配。
2. **失败必结构化**：每个 fail 带 node / type / severity / evidence / repairHint，否则无法喂回 AI。
3. **judge 与被测解耦**：避免「自己判自己」，judge 必须带判据可回溯。
4. **数据集滚雪球**：线上失败和人工标注持续回灌，评测越用越准。
5. **改 Prompt 必回归**：任何 Prompt patch 必须在黄金集 + 回放集上不退化才采纳，防「修一个坏一个」。
