# 规划链路 Claude JSON 调用根治方案（最终版 A+B+C）

## Summary

本次失败 (conv-new-1779883996052 子目标 5/5) 表面是「任务列表为空」，但根因是 Claude CLI 在 JSON 调用里「旁路输出」——把生成的任务 JSON 用 Write 工具写到 workspace 的 `tasks/fault_tolerance_tasks.json`，stdout 只回 markdown 摘要表格。系统再用通用 JSON 修复器把 markdown 修成「不符合 schema 的 JSON」，被 [validateTaskGeneration](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1226-L1326) 全量过滤后抛错。

短期方案（重试 / 提示词加严）治不本，因为：

1. `runPromptJson` 没限制工具白名单，模型可以随时改用文件写入；
2. JSON 修复完全依赖再次调用 Claude，没有结构化兜底；
3. 单子目标失败让整次规划崩盘，没有降级隔离；
4. parse-failure 时不能定位「正确产物其实写到了文件里」。

最终实施范围为 A+B+C：

1. **Phase A：调用层硬约束**，让 JSON 通道默认禁用工具，物理上消除「旁路输出」。
2. **Phase B：解析层鲁棒性**，增加 schema-aware 错误、定向修复与工件回收，避免字段缺失或旧 CLI 行为导致规划失败。
3. **Phase C：规划层失败隔离**，让单个子目标任务生成失败不再炸掉整次规划，并支持从失败子目标继续。

暂不做前端 Trace 面板大改，只保留实现与排障必需的服务端日志、快照与验证。

## Current State Analysis

### 1) 调用层：`runPromptJson` 没有工具约束

[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L71-L174) 中 `runPromptJson` 只下发 `--output-format json` + `--permission-mode`，没有 `--allowedTools` / `--disallowedTools`，Claude CLI 默认所有工具可用，模型会「主动写文件 + 简要回答」。同文件 `streamPrompt` 早已用 [buildAllowedTools](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L231-L234) 在 readonly 模式下收敛，JSON 调用却没复用。

### 2) Prompt 层：已有「只输出 JSON」要求，但没有「禁止使用工具」

[buildTaskGenerationPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L615-L734)、[buildDecomposePrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L473-L555) 等都强调「严格 JSON、不要 Markdown / 代码块」，但没有显式禁止「调用 Write / Edit / Bash 等工具」。Claude 把「输出严格 JSON」理解成「不要带格式包裹」，仍可以用工具写文件再回个摘要。

### 3) 解析层：Claude 修复链路 + 通用正则修复，无 schema-aware 兜底

[parseClaudeJson](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L967-L1106) 失败后调用 [repairMalformedJsonWithClaude](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts#L116-L126) 让 Claude 再修一次。问题：

* 修复 prompt 不知道 schema，模型按字面意思「修」，会把 markdown 摘要修成 schema 错的 JSON；

* [validateTaskGeneration](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1226-L1326) 在每个 task 缺 `expected_output`/`title`/`description` 时静默 `continue`，最终空数组才抛错，**调用方拿不到「具体哪个字段被丢」的信息**；

* 输出文件 [fault\_tolerance\_tasks.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779883996052/tasks/fault_tolerance_tasks.json) 已经是合法 schema，但解析器看不到。

### 4) 规划层：单子目标失败=整次规划崩盘

任务生成调用在 `Promise.all` / 顺序循环里抛错后，整次规划进入 [state.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779883996052/planning/state.json) 的 failed 状态，前端只能「继续修复 / 重试生成」，没有「跳过该子目标继续」的能力，也没有把已生成的子目标产物保留。

### 5) 可观测层：parse-failure 快照缺产物维度

[writePlanningParseFailureSnapshot](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1054-L1066) 记录 raw + repaired，但不记录：是否检测到 stdout 提到 workspace 文件路径、模型是否调用了写工具（在 JSON 模式下不可见）。

## Proposed Changes

### Phase A · 调用层硬约束：JSON 调用禁止任何会产生副作用的工具

**目标**：让 Claude 在 JSON 调用中只能把答案放进 `result.result`。

**边界**：Phase A 是按「调用通道」生效，不是只针对目标规划阶段。当前项目里 `runPromptJson` 只被 [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L818-L912) 和 [runtimeEnvValidation.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtimeEnvValidation.ts#L97) 使用；任务执行阶段走 [streamPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L326-L596)，不会被禁工具影响。

#### A1. `runPromptJson` 增加白名单 / 黑名单参数

* 文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L71-L174)

* 改动：

  * 在 `runPromptJson` 输入里加 `toolPolicy?: { mode: "deny_all" | "readonly_only"; allow?: string[]; deny?: string[] }`，默认 `deny_all`。

  * 新增 `buildJsonToolArgs(policy)`，集中构造 CLI 工具参数，避免各调用方自行拼接。

  * `deny_all` 时下发 `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task`。若本机 CLI 帮助信息显示只支持 `--allowedTools`，则退化为只允许空白/无工具列表；实现时先用当前 CLI 参数实际验证一次，不在代码里假设版本。

  * `readonly_only` 复用 [buildAllowedTools](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L231-L234) 的语义：仅 Read / Glob / Grep。

  * 将最终 args 写入 Claude trace metadata，方便确认 JSON 通道确实禁用了写入类工具。

* 验收：本地通过 `claude --help` / `claude -p --output-format json` 验证一次实际可用的参数名；再用一次 JSON prompt 验证 Claude 无法调用 Write 工具，最终结果只能来自 stdout 的 `result.result`。

#### A2. 在 prompt 文本里同步加「禁止使用工具」一行

* 文件：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 中所有 `build*Prompt` 函数（任务生成、子目标拆解、信息整理、Review、计划展示、JSON 修复）。

* 改动：在「重要输出约束」段落里追加：

  * 「禁止调用任何工具（Write / Edit / Bash / WebSearch 等），所有信息必须写在最终回答里」。

* 设计要点：双层兜底——CLI 参数（最强）+ prompt 自然语言。

#### A3. 明确 JSON 通道契约

* 文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L71-L174)

* 改动：

  * 在 `runPromptJson` 函数注释中写明：JSON 通道的唯一有效业务输出是 stdout 的 `result.result`。

  * 如果未来某个 JSON 调用确实需要读取 workspace 文件，调用方必须显式传 `toolPolicy: { mode: "readonly_only" }`，且不得允许 Write/Edit/Bash。

* 决策：JSON 通道永远不允许写入类工具；需要写文件、执行命令、联网调研的任务必须走 `streamPrompt` / task runner 通道。

### Phase B · 解析层：把现状的「全有或全无」改成「错在哪 → 精确反馈 → 定向重试」

**目标**：解析失败时，调用方能准确知道哪条 task 缺什么字段；并且能利用 workspace 里 Claude 已经写出的文件作为合法降级源。

#### B1. `validateTaskGeneration` 改为「累计错误 + 抛结构化异常」

* 文件：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1226-L1326)

* 改动：

  * 把 `continue` 改成 `errors.push({ index, missing: [...] })`。

  * 全量校验完成后：

    * 若 `tasks.length === 0`，抛 `TaskGenerationSchemaError`（自定义错误类，携带 `errors` 数组）；

    * 若 `tasks.length > 0` 但仍有非法项，记 warn 并保留合法项。

  * 同步增加错误码（如 `MISSING_EXPECTED_OUTPUT`、`MISSING_TITLE`、`MISSING_DESCRIPTION`），供后续 prompt 反馈引用。

  * 保持合法 task 的归一化逻辑不变，避免改变任务展示、执行策略、导出格式等既有行为。

* 验收：单测覆盖三种典型 raw（合法、部分缺字段、全部缺字段）。

#### B2. JSON 修复链路加 schema-aware 重试

* 文件：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 中 [parseClaudeJson](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L967-L1106) 与 [generateTasksForSubGoalWithClaude](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1846-L1889)。

* 改动：

  * 当 `validator` 抛出 `TaskGenerationSchemaError` 时，进入「定向修复」分支：用 `buildTaskSchemaRepairPrompt(rawOutput, errors)` 让 Claude 在已有 JSON 上补全字段，而不是直接走通用 `buildJsonRepairPrompt`。

  * 修复 prompt 必须包含：上次产出片段 + 缺失字段清单 + schema 片段（不是全 schema，避免长度爆炸）。

  * schema-aware 修复也必须通过 Phase A 的 `deny_all` 工具策略，禁止修复过程再次写文件。

  * 定向修复只用于任务生成 schema；信息整理、拆解、Review、计划展示等 JSON 仍保留现有通用修复逻辑，避免一次性扩大影响面。

* 验收：拿本次 fault\_tolerance 的 raw 走单测，能成功补全 `expected_output` 并通过 validator。

#### B3. 增加「工件回收」候选源

* 文件：新建 [src/lib/server/claude/artifactRecovery.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/artifactRecovery.ts)，并在 [parseClaudeJson](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L967-L1106) 的解析候选构建阶段接入。

* 行为：

  1. 解析 stdout（即便是 markdown），用正则 `\b([A-Za-z0-9_\-./]+\.json)\b` 提取 Claude 提及的相对路径；
  2. 在该 conversation 的 workspace 根目录下尝试 read 这些路径（限白名单：`tasks/`、`outputs/`、`planning/`），加入 JSON 候选；
  3. 只在 Phase A 的 CLI 白名单兜底没生效时（比如旧版本 CLI、用户自定义 runtimeEnv）触发——属于第二道防线。

* 安全约束：

  * 所有路径必须通过 workspace root 解析并校验 `resolvedPath.startsWith(workspaceRoot)`。

  * 禁止绝对路径、`..`、隐藏目录、非 `.json` 后缀。

  * 单次最多读取 3 个候选文件，每个文件限制大小（建议 1MB），避免被模型输出诱导读取大量内容。

* 验收：

  * 即使关掉 Phase A，本次 conv-new-1779883996052 也能通过 `artifactRecovery` 直接从 [fault\_tolerance\_tasks.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779883996052/tasks/fault_tolerance_tasks.json) 解析成功；

  * workspace 边界严格：不允许读到 conversation 目录之外。

#### B4. parse-failure 快照补充结构化上下文

* 文件：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1054-L1066)

* 改动：

  * `writePlanningParseFailureSnapshot` 增加 `schemaErrors`、`artifactCandidates`、`recoveredArtifactPath` 字段。

  * `classifyClaudeJsonFailure` 对 `TaskGenerationSchemaError` 输出更准确的用户文案，例如「Claude 输出的任务字段不完整：第 1、2、3 条缺 expected_output.description」。

* 边界：只改服务端快照和日志，不做 DevPanel / ClaudeTracePanel 前端展示改造。

### Phase C · 规划层：失败隔离 + 子目标级重试

**目标**：单子目标任务生成失败不再炸全局，可观测、可恢复。

#### C1. `goalPlanning` 任务生成阶段引入 per-subgoal 容错

* 文件：[goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 任务生成循环（围绕 [generateTasksForSubGoalWithClaude](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1846-L1889) 的调用方）。

* 改动：

  * 把单子目标的失败包成 `SubGoalTaskGenerationFailure` 而不是直接 throw；

  * 单个子目标任务生成失败时，记录 `{ subGoalId, subGoalName, status: "task_generation_failed", errorMessage, parseSnapshotPath }`；

  * 保留已成功子目标的任务结果；再次「继续修复 / 重试生成」时，优先跳过已成功子目标，只重跑失败子目标；

  * 整次规划仅在「任务生成失败子目标占比过半」或「没有任何子目标生成成功」时整体 fail；否则进入部分成功 / 待修复状态。

* 验收：state.json 中允许 subGoals\[i].status = "task\_generation\_failed"，前端「重试生成」按钮能精确针对该子目标重跑。

#### C2. checkpoint 与 state 字段扩展

* 文件：[planning/checkpoint.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779883996052/planning/checkpoint.json) / state.json 写入逻辑。

* 改动：

  * 在 checkpoint 中加 `subGoalTaskGeneration: Array<{ subGoalId, status, taskCount, taskIds, lastError, lastRawSnapshot }>`。

  * 在 planning state 中加 `partialFailure?: { failedSubGoalIds, recoverable, message }`。

  * 对已成功子目标的任务数据使用现有任务落盘结构，不额外引入新的业务数据源。

* 决策：部分成功状态仍由服务端权威 state 驱动；前端只根据 state 展示「可继续修复」或「部分成功」文案，不在客户端自行推断。

#### C3. 继续修复逻辑只重跑失败子目标

* 文件：`goalCommandService.ts` 的继续 / 重试入口，以及 [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) 的 checkpoint 恢复逻辑。

* 改动：

  * 读取 checkpoint 时，如果某子目标 `status === "ok"` 且任务数据完整，直接复用；

  * 仅对 `task_generation_failed` / `awaiting_repair` 子目标重新调用 [generateTasksForSubGoalWithClaude](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1846-L1889)；

  * 重试成功后合并任务并刷新 checkpoint；重试仍失败则保留原失败上下文，不覆盖已成功任务。

* 约束：所有 Goal 变更继续走 `goalCommandService.ts`，不得绕过现有 `Idempotency-Key` 与 `baseRevision` 校验。

### Phase D · 验证与回归（必要范围）

* 单测：

  * `buildJsonToolArgs`：`deny_all` / `readonly_only` 参数构造正确；

  * `validateTaskGeneration`：合法 / 部分缺字段 / 全部缺字段 / 多余字段；

  * `artifactRecovery`：白名单路径、越权路径、不存在路径、文件过大；

  * `parseClaudeJson`：使用本次失败 raw + artifact fixture，验证可恢复；

  * per-subgoal checkpoint：4 个成功 + 1 个失败时，重试只重跑失败子目标。

* 集成：

  * 用 conv-new-1779883996052 的 raw 输出和 `tasks/fault_tolerance_tasks.json` 做 fixture，跑任务生成解析，预期产出 5 条任务。

  * 本地新开一个规划会话，确认 JSON 调用 trace args 中包含禁用写入工具的参数，且 stdout 直接包含合法 JSON。

* 全量：

  * `pnpm tsc --noEmit`

  * 如项目有测试脚本，运行相关单测或 `pnpm test`；如果没有可用测试脚本，至少保留 fixture + TypeScript 校验结果。

## Assumptions & Decisions

1. **CLI 工具约束作为「主防线」**：根因是模型旁路输出，唯一根治办法是物理上禁掉工具调用通道，prompt 只能算补充。
2. **artifactRecovery 是「副防线」**：保留它是为了兼容旧版本 CLI、外部 runtimeEnv 改动、以及 Claude 模型升级后 prompt 又被忽略的场景。
3. **不强制保留旧的「整次规划失败」语义**：当前体验是「失败一个=全部从头来」，这与用户「不想丢已收集信息」的多次反馈冲突，本次改成 per-subgoal 失败隔离。
4. **不引入新的二级 LLM**：JSON 修复仍走 Claude，但加 schema/diff 反馈，不堆模型链。
5. **暂不重写** **[validateTaskGeneration](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1226-L1326)** **的字段语义**：保持兼容，只把「静默 continue」改成「显式累计 + 结构化错误」。
6. **不改任务执行通道**：`goalTaskRunner.ts` 仍可按任务需要使用工具；本方案只约束结构化 JSON 生成通道。
7. **前端改动最小化**：如现有 UI 能展示 failed/partial 状态，则不新增复杂交互；必要时只补文案和「重试失败子目标」入口。

## Verification Steps

1. 复现：用 conv-new-1779883996052 的 trace 输入 + 失败 raw，作为 fixture 跑 `parseClaudeJson`，验证 Phase B 能从 artifact 或 schema-aware 修复中恢复。
2. 通道约束：本地运行一次 `runPromptJson`，确认 trace metadata 中 JSON 通道禁用了 Write/Edit/Bash，且结果来自 stdout。
3. 失败隔离：模拟 5 个子目标中第 5 个失败，确认前 4 个任务保留，checkpoint 标出失败子目标，再次继续时只重跑第 5 个。
4. 兼容回归：随机抽 3 个历史成功会话回放，确认 Phase A 不会破坏正常 JSON 调用。
5. 类型检查：运行 `pnpm tsc --noEmit`；如果测试脚本可用，运行相关单测或 `pnpm test`。
6. 文档：实现完成后将「JSON 通道默认禁用工具」写入 [project_memory](file:///Users/bytedance/.trae-cn/memory/projects/-Users-bytedance-Documents-trae-long-horizon-agent/project_memory.md) 的 Hard Constraints 一节。

## Out of Scope（明确不做）

* 不替换 Claude CLI 为 Anthropic SDK。

* 不引入 JSON Schema 校验库（如 ajv）做全量 schema：保留现有人工 validator，只让它「报错更精确」。

* 不做 DevPanel / ClaudeTracePanel 前端大改；如需要展示 partial 状态，只做最小文案与重试入口适配。

* 不改变任务执行阶段的工具权限策略；执行任务需要的 Read/Write/Bash 能力继续由 `goalTaskRunner.ts` 和 runtime permission 控制。
