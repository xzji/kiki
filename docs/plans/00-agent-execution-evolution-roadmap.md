# KiKi Agent 执行体系演进总规划

> 目标：把 KiKi 的长程任务执行体系，从当前的“单轮契约化 Prompt + 结果回写”，演进为“结构化产物 + 可观测执行 + 可审批动作 + 可恢复任务 + 能力扩展”的完整 Agent 平台。

本文是以下三份方案的上位路线图：

- [方案 1：呈现层 — Block JSON + Artifact 沙箱](./01-presentation-block-renderer.md)
- [方案 2：执行层 — Capability + Plan-Act-Reflect](./02-execution-agent-runner.md)
- [方案 3：进化层 — Capability Forge（能力锻造）](./03-evolution-capability-forge.md)

---

## 1. 总体判断

三份方案的方向是正确的，但不能按“方案 1 完整做完 → 方案 2 完整做完 → 方案 3 完整做完”的方式推进。

更稳妥的路线是按能力成熟度拆阶段：

```text
结构化产物
  → 可观测执行
  → 可审批动作
  → 可恢复任务
  → 外部能力接入
  → 能力缺口发现
  → 半自动能力锻造
```

核心原因：

- 当前项目已经有 `goalTaskRunner`、`goalTaskPrompt`、`runtime_jobs`、telemetry、通知门禁和任务详情 UI，不应推倒重写。
- 当前 Claude CLI 封装可以观察 `tool_use`，但不能在 Claude Code 内置工具真正执行前拦截，因此短期不应宣称能对内置 `Read/Edit/Bash` 做副作用闸门。
- 当前 SQLite 只有 bootstrap schema，没有 migration runner；任何新增表或列都必须先补迁移基础设施。
- Capability Forge 涉及未知代码生成、依赖安装、凭证隔离和动态加载，必须远期分阶段推进，不能近期自动化。

---

## 2. 当前项目基线

### 2.1 已具备能力

- 目标规划：`/goal` 已能生成目标、子目标、任务与协作契约。
- 协作契约：任务已包含 `TaskCollaborationContract`，区分 Agent / 用户职责。
- 执行 Prompt：`goalTaskPrompt.ts` 已硬绑定 `expectedOutcome` 和交付物验收。
- 执行 Runner：`goalTaskRunner.ts` 已能调用 Claude CLI、解析 JSON、执行 deliverable check。
- 后台任务：`runtime_jobs` 已支持本地 SQLite 持久化、worker 领取、状态同步。
- 执行过程：telemetry 已能记录日志，并同步到任务详情页 timeline。
- 通知门禁：`resultNotificationJudge.ts` 已根据 interaction type 决定是否推送。
- UI 呈现：任务详情页、收件箱、会话卡片已支持结果回流与用户介入提示。

### 2.2 主要短板

- 结果表达仍偏旧：当前以 `summary/finalMessage/artifacts` 为主，缺少统一可组合的结构化产物模型。
- 执行链路不够强：当前 timeline 更像日志流，不是真正可恢复、可审计的 trajectory。
- 用户介入不可恢复：`awaiting_user` 能表达暂停，但缺少恢复点、恢复 token 和 step 级上下文。
- 副作用闸门边界不清：Claude 内置工具只能观察，不应假设可以由 KiKi 拦截。
- DB 迁移缺失：新增表/列不会自动对已有 `data/kiki.db` 生效。
- Capability Forge 风险过高：未知代码不应直接进入 KiKi 主进程或 `~/.claude/skills/`。

---

## 3. 核心原则

### 3.1 不推倒重写

所有阶段都应在当前链路上增量演进：

```text
goalPlanning
  → goalTaskPrompt
  → goalTaskRunner
  → runtime_jobs
  → goalStateSnapshot
  → goalStore
  → TaskDetailBody / ExecutionResultBody / Inbox
```

### 3.2 结果契约优先

先把“Agent 到底交付了什么”标准化，再升级执行循环。

如果没有稳定的产物 schema，Plan-Act-Reflect 只会产出更复杂但仍不可验收的过程日志。

### 3.3 内置工具可观测，外部能力可拦截

短期边界必须清楚：

| 工具类型 | 当前策略 |
|---|---|
| Claude Code 内置工具：Read/Edit/Bash/Grep/WebFetch 等 | 记录 trajectory，不承诺执行前拦截 |
| KiKi 自建 Capability：email/calendar/browser/payment 等 | 通过 Capability Registry + sideEffectGuard 审批后执行 |

### 3.4 `awaiting_user` 必须语义化

用户介入不是一个泛化状态，必须由 `InteractionRequirement` 说明：

- `confirm`：需要确认或给修改建议
- `answer`：需要用户作答
- `provide_context`：需要补充上下文
- `perform_offline_action`：需要用户完成线下动作
- `deliverable_gap`：交付物缺口，默认 Agent 继续补齐
- `agent_revision_required`：需要 Agent 自我修订，默认不打扰用户

### 3.5 未知代码不能进入主进程

Capability Forge 生成的任何代码，都不能直接 `import()` 到 KiKi 主进程。

远期如果允许 experimental capability，也必须运行在独立进程、MCP server 或受限 worker 中，通过 JSON-RPC 调用，并具备：

- 进程级隔离
- 网络白名单
- 凭证 scope 隔离
- 超时和资源限制
- 审计日志
- 用户首次审批

---

## 4. 阶段路线

## 阶段 0：基础设施补齐

### 目标

为后续所有方案补地基，避免新增 schema 后本地 SQLite 数据库无法升级。

### 范围

| 项目 | 内容 |
|---|---|
| DB Migration | 增加 migration runner，不再只依赖 bootstrap schema |
| Schema Version | 基于 `meta.schema_version` 顺序执行迁移 |
| 轨迹字段预留 | 新增 `runtime_jobs.trajectory_json` 或短期写入 `result_json.trajectory` |
| 类型预留 | 定义 server-only `TaskResult` / `ResultBlock` 类型 |
| 兼容策略 | 明确新 `TaskResult` 与旧 `summary/finalMessage/artifacts` 的映射 |

### 不做

- 不改 Claude 执行模式
- 不做 Capability Registry
- 不做 Artifact 沙箱
- 不做 Forge

### 验收标准

- 已有 `data/kiki.db` 能自动升级。
- 新装项目和已有本地数据库都能启动。
- 旧任务、旧 mock、旧通知不丢。
- `pnpm lint` 和 `pnpm build` 通过。

---

## 阶段 1：结构化产物呈现

### 目标

把任务结果从“文本 + 少量 artifacts”升级为“可枚举、可组合、可验收的 blocks”。

这是第一阶段真正的产品能力交付。

### 核心改造

新增 `TaskResult`：

```ts
type TaskResult = {
  schemaVersion: 1;
  taskId: string;
  instanceId: string;
  title: string;
  status: "draft" | "pending_user" | "done" | "blocked" | "failed";
  blocks: ResultBlock[];
  meta: {
    producedAt: string;
    durationMs?: number;
    tokensUsed?: number;
  };
};
```

首批只支持 8 类 block：

| block | 用途 |
|---|---|
| `heading` | 标题 |
| `paragraph` | 普通段落 |
| `markdown` | 富文本正文 |
| `list` | 清单 |
| `key_value` | 属性对 |
| `comparison_table` | 多方案对比 |
| `decision` | 决策点 |
| `callout` | 风险、提示、结论 |

### 接入策略

短期不替换旧字段，而是双轨：

```text
Claude 输出 TaskResult
  → parseTaskResult()
  → deriveLegacyTaskResult()
  → 旧 UI 继续消费 summary/finalMessage/artifacts
  → 新 UI 逐步消费 blocks
```

### 需要改造的模块

| 模块 | 改造 |
|---|---|
| `goalTaskPrompt.ts` | 注入 TaskResult 输出契约 |
| `goalTaskRunner.ts` | 解析 TaskResult，并派生 legacy 字段 |
| `types/kiki.ts` | 在 `TaskInstanceResult` 中增加 `taskResult?: TaskResult` |
| `GenericAgentResultView.tsx` | 优先渲染 `taskResult.blocks` |
| `TaskDetailBody.tsx` | 任务详情页结果区接入 BlockRenderer |
| `resultNotificationJudge.ts` | 通知摘要继续使用 legacy 派生字段，避免大改 |

### 暂缓内容

- `artifact html`
- `artifact react-jsx`
- iframe 沙箱
- Vega 图表
- 第三方 embed
- block 级用户交互事件回灌

### 验收标准

- 一个调研任务可产出 `comparison_table + decision`。
- 一个总结任务可产出 `heading + markdown + callout`。
- 未知 block 不白屏，降级为 JSON 折叠展示。
- 老的任务卡片、收件箱摘要、会话推送仍正常。
- `summary/finalMessage/artifacts` 兼容字段仍能被旧 UI 使用。

---

## 阶段 2：执行过程可观测

### 目标

把当前 telemetry 日志升级为可持久化、可回放、可排障的 trajectory。

### 核心模型

```ts
type ExecutionStep = {
  id: string;
  index: number;
  type: "system" | "assistant" | "tool_call" | "tool_result" | "approval" | "result" | "error";
  thought?: string;
  toolCall?: {
    name: string;
    input: unknown;
    sideEffect?: "none" | "reversible" | "irreversible";
  };
  toolResult?: {
    ok: boolean;
    output?: unknown;
    error?: string;
  };
  status: "running" | "completed" | "failed" | "awaiting_user";
  startedAt: string;
  endedAt?: string;
};
```

### 接入策略

当前 `streamClaudeCli` 已经能解析 `tool_use`：

- 保留 tool name。
- 增加 raw input。
- 增加 event index。
- 增加 event timestamp。
- 尽量识别 tool result 或 result message。

### 关键边界

这一阶段只做“可观测”，不做“强拦截”。

原因：Claude Code 内置工具执行权在 Claude CLI 内部，KiKi 当前无法保证在 `Edit/Bash/Write` 真正执行前拦截。

### 需要改造的模块

| 模块 | 改造 |
|---|---|
| `claudeCli.ts` | 输出 raw tool event，而不是只有 summary |
| `goalTaskRunner.ts` | 将 raw tool event 写入 trajectory |
| `runtimeJobsRepository.ts` | 持久化 `trajectory_json` |
| `goalStateSnapshot.ts` | 从 trajectory 派生 timeline |
| `goalStore.ts` | 合并 trajectory / timeline，避免覆盖早期日志 |
| `TaskDetailBody.tsx` | 执行过程优先展示 trajectory 派生信息流 |

### 验收标准

- 页面刷新后执行链路不丢。
- 关闭浏览器再打开仍能看到完整执行过程。
- 能看到 Claude 启动、工具调用、重试、最终结果、错误。
- telemetry 缓冲被清理时，仍可从 SQLite 恢复 trajectory。

---

## 阶段 3：用户介入与恢复闭环

### 目标

让“等待用户”从静态 UI 状态变成可恢复的执行断点。

### 核心模型

```ts
type ExecutionBlocker = {
  executionId: string;
  blockedStepIndex: number;
  resumeToken: string;
  interactionRequirement: InteractionRequirement;
  resumePayload?: unknown;
  createdAt: string;
};
```

### 典型流程

```text
Agent 执行
  → 命中需要用户确认 / 作答 / 补充
  → 写 blocker
  → 任务状态 awaiting_user
  → 通知门禁判断是否推送
  → 用户提交输入
  → 验证 resumeToken
  → 从 blockedStepIndex 恢复
```

### 和现有协作契约的关系

`TaskCollaborationContract` 决定任务预期协作模式，`InteractionRequirement` 决定本轮执行实际需要什么介入。

两者需要保持一致：

| 协作契约 | 运行时介入 |
|---|---|
| `agent_autonomous` | 默认不需要用户；`deliverable_gap` 由 Agent 自修 |
| `agent_with_user_confirmation` | 结果完成后进入 `confirm` |
| `agent_user_collaborative` | 可进入 `answer` / `provide_context` |
| `user_primary_agent_assistive` | 可进入 `perform_offline_action` |

### 通知原则

- 任务启动不推送。
- 普通执行中不推送。
- `deliverable_gap` / `agent_revision_required` 默认不推送，由 Agent 补齐。
- `confirm` / `answer` / `provide_context` / `perform_offline_action` 根据 `shouldNotifyUser` 推送。
- 任务完成且有值得查看的结果时推送。

### 验收标准

- 确认类任务能暂停、推送、确认、恢复。
- 作答类任务能暂停、作答、继续。
- 补充上下文任务能把用户输入注入下一轮执行。
- 交付物不合格不会误报为“待确认”。
- 用户刷新页面后，阻塞状态和恢复入口不丢。

---

## 阶段 4：Capability Registry 最小版

### 目标

接入 Claude Code 内置工具没有的产品化外部能力，并提供统一审批和可观测性。

### 能力边界

不要把 Claude Code 内置工具全部重包一遍。

| 类型 | 策略 |
|---|---|
| 文件、代码、Shell、搜索等 Claude 内置能力 | 继续交给 Claude CLI，KiKi 做观察和记录 |
| 邮件、日历、浏览器自动化、支付、第三方 SaaS | 进入 KiKi Capability Registry |

### Capability 契约

```ts
type Capability = {
  id: string;
  source: "builtin" | "imported" | "forged";
  sideEffect: "none" | "reversible" | "irreversible";
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  invoke(input: unknown, ctx: CapabilityContext): Promise<unknown>;
  dryRun?(input: unknown, ctx: CapabilityContext): Promise<unknown>;
  describeForUser(input: unknown): {
    title: string;
    detail: string;
  };
};
```

### 首批能力建议

| 能力 | 风险 | 说明 |
|---|---|---|
| `email.draft` | reversible | 只生成草稿，不发送 |
| `calendar.create_draft` | reversible | 只创建待确认日程 |
| `browser.research` | none/reversible | 用受控浏览器做调研 |
| `file.export_artifact` | reversible | 导出报告、表格、代码片段 |

### 副作用策略

| 副作用级别 | 处理 |
|---|---|
| `none` | 可直接执行，记录 trajectory |
| `reversible` | 可执行，但必须记录可回滚信息 |
| `irreversible` | 必须进入审批卡，用户批准后执行 |

### 验收标准

- 一个任务可以调用至少一个 KiKi Capability。
- Capability 调用被写入 trajectory。
- 不可逆动作必须先进入审批。
- 用户拒绝后任务不会继续执行该动作。
- Capability 失败后能返回结构化错误并进入重试或阻塞。

---

## 阶段 5：Capability Forge Phase A（人工锻造）

### 目标

先做“能力缺口发现和人工锻造建议”，不要自动安装和运行未知代码。

### 流程

```text
Agent 执行
  → 发现缺少能力
  → 输出 capability_gap
  → 本地 registry search
  → 未命中
  → 收件箱提示用户/开发者
  → 生成能力包草稿
  → 开发者人工 review
  → 手动实现为 builtin capability
```

### capability_gap 模型

```ts
type CapabilityGap = {
  id: string;
  intent: string;
  expectedInputs: string[];
  expectedOutputs: string[];
  blockingExecutionId: string;
  detectedAt: string;
  status: "detected" | "searching" | "proposed" | "accepted" | "rejected" | "resolved";
};
```

### 不做

- 不自动写入 `~/.claude/skills/`。
- 不自动安装 npm/pip 依赖。
- 不动态 import `.ts` handler。
- 不让 forged 代码进入主进程。
- 不跨用户共享能力。

### 验收标准

- Agent 能记录一次 capability gap。
- 同类 gap 能聚合，避免重复造。
- 收件箱能展示“为什么需要这个能力”。
- 开发者可以基于草稿实现一个 builtin capability。
- 被拒绝的 gap 不会反复打扰用户。

---

## 阶段 6：Capability Forge Phase B/C（远期）

### Phase B：半自动锻造

允许生成 experimental capability，但必须满足：

- user-private 范围
- 独立进程或 MCP server 运行
- 测试通过
- 静态扫描通过
- 网络白名单
- 凭证 scope 隔离
- 首次人工审批
- 完整审计日志

### Phase C：自治与收编

只有在成功率、安全事件率和使用反馈达到阈值后，才允许：

- experimental → verified
- user-private → team-shared
- 高价值能力由开发团队重写为 builtin

### 永久禁止项

- 未知代码直接 import 到主进程。
- 未经审批执行不可逆动作。
- forged capability 直接读取任意环境变量。
- forged capability 默认访问全网。
- forged capability 默认跨用户共享。

---

## 5. 推荐排期

| 阶段 | 周期 | 交付物 |
|---|---:|---|
| 阶段 0：基础设施 | 2-3 天 | migration runner、schema 版本升级、trajectory 字段预留 |
| 阶段 1：结构化产物 | 4-6 天 | TaskResult schema、legacy adapter、BlockRenderer 最小版、Prompt 改造 |
| 阶段 2：执行可观测 | 5-7 天 | trajectory 持久化、执行链路 UI、Claude tool_use raw event 记录 |
| 阶段 3：恢复闭环 | 5-7 天 | blocked_on_user 恢复、用户确认/作答/补充链路 |
| 阶段 4：Capability | 1-2 周 | Capability Registry、sideEffectGuard、首个外部能力 |
| 阶段 5：Forge A | 1-2 周 | capability_gap 检测、人工锻造建议 |
| 阶段 6：Forge B/C | 远期 | experimental capability、隔离运行、能力治理 |

---

## 6. 第一阶段执行方案

第一阶段建议合并执行“阶段 0 + 阶段 1”。

### 为什么先做这部分

当前最大痛点是：任务执行产物与预期交付物不稳定，结果表达依赖自由文本，UI 只能被动展示。

如果先做 Plan-Act-Reflect，会让执行过程更复杂，但最终仍可能产出不可验收结果。

因此第一阶段要先建立“结果契约”：

```text
expectedOutcome
  → TaskResult schema
  → blocks
  → legacy adapter
  → UI 渲染
  → deliverable_check
```

### 第一阶段具体任务

| 序号 | 任务 | 涉及文件 |
|---|---|---|
| 1 | 实现 DB migration runner | `src/lib/server/db/client.ts`、`schema.ts` |
| 2 | 新增 `TaskResult` 类型 | `src/types/taskResult.ts` |
| 3 | 新增 TaskResult prompt fragment | `src/lib/server/goalTaskPrompt.ts` 或独立 `schemaForPrompt.ts` |
| 4 | 新增 parse + repair | `src/lib/server/goalTaskRunner.ts` 或 `src/lib/taskResult/parseAndRepair.ts` |
| 5 | 新增 legacy adapter | `src/lib/taskResult/legacyAdapter.ts` |
| 6 | 扩展 `TaskInstanceResult` | `src/types/kiki.ts` |
| 7 | 实现最小 BlockRenderer | `src/components/execution/BlockRenderer.tsx` |
| 8 | 接入 generic result UI | `GenericAgentResultView.tsx`、`TaskDetailBody.tsx` |
| 9 | 更新 mock 数据或归一化逻辑 | `src/mocks/goals.ts`、`goalStore.ts` |

### 第一阶段不做

- 不做 Artifact 沙箱。
- 不做 Capability Registry。
- 不做副作用审批。
- 不做任务恢复。
- 不改 Claude CLI 的主执行模式。

### 第一阶段验收

- 任意 generic 任务能输出 blocks 并被 UI 渲染。
- 调研类任务能输出表格和决策点。
- 旧任务结果仍可展示。
- 通知摘要仍能正常生成。
- 交付物验收继续可用。
- `pnpm lint` / `pnpm build` 通过。
- 清理 `.next` 后 3000 端口可正常运行。

---

## 7. 与三份原方案的关系

### 方案 1 的调整

保留：

- Block JSON 方向
- 通用渲染原语
- TaskResult schema
- FallbackBlock

调整：

- 第一阶段只做最小 8 类 block。
- Artifact 沙箱降到后续阶段。
- 不直接替换旧 UI，先用 legacy adapter。

### 方案 2 的调整

保留：

- trajectory
- Plan-Act-Reflect 方向
- blocked_on_user
- 审批恢复
- Capability Registry

调整：

- 不新建一套 `spawnClaudeStream`，优先扩展当前 `streamClaudeCli`。
- 不宣称可拦截 Claude 内置工具。
- Plan-Act-Reflect 在 trajectory 稳定后再做。
- Capability 只覆盖外部能力，不重包内置工具。

### 方案 3 的调整

保留：

- capability_gap
- search before forge
- trustLevel
- 人工审批
- 能力治理

调整：

- 近期只做 Phase A：能力缺口发现 + 人工锻造建议。
- 不自动安装到 `~/.claude/skills/`。
- 不动态 import unknown `.ts`。
- experimental capability 必须远期运行在隔离进程或 MCP server。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| TaskResult schema 太复杂，Agent 输出不稳定 | 第一阶段只做 8 个 block；few-shot；解析失败走 repair；旧字段兜底 |
| BlockRenderer 增加 UI 复杂度 | 先只接 generic result；专属组件不删除 |
| DB 迁移损坏本地数据 | migration 全部幂等；迁移前可备份 `data/kiki.db` |
| trajectory 数据过大 | step 做摘要，raw input/output 限长，必要时归档 |
| awaiting_user 再次语义过载 | 强制所有阻塞点带 `InteractionRequirement` |
| Claude 内置工具不可拦截 | 明确只做可观测；高风险执行继续依赖 Claude permission mode |
| Capability 误执行副作用 | 只对 KiKi 自建 Capability 开放执行；irreversible 必须审批 |
| Forge 生成恶意代码 | Phase A 不运行未知代码；Phase B 起必须进程隔离 |

---

## 9. 最终路线摘要

```text
第一阶段：
DB migration + TaskResult blocks + legacy adapter + BlockRenderer

第二阶段：
trajectory 持久化 + 执行过程稳定回放

第三阶段：
blocked_on_user 恢复闭环 + 用户介入语义精确化

第四阶段：
KiKi 自建 Capability + sideEffect 审批

第五阶段：
capability_gap 发现 + 人工锻造建议

第六阶段：
隔离进程中的 experimental Forge，逐步演进到 verified/builtin
```

这条路线的关键判断是：**先让任务结果可验收，再让执行过程可回放，再让用户介入可恢复，最后再让 Agent 拓展能力。**
