# 任务验收与补齐闭环方案

## 1. 背景

当前任务执行链路已经要求 Agent 输出 `task_result.blocks`，前端只把它作为主产出展示。但“任务是否真的完成”仍需要更清晰的闭环：

- 本地代码能判断结构问题，例如缺少 `task_result.blocks`、block 字段不合法、只返回 artifact。
- 模型更适合判断语义问题，例如结果是否覆盖完成标准、推荐结论是否有依据、对比维度是否足够。
- 当前补齐方式偏浅，只把失败原因拼成几行 `resumeContext`，不够指导 Agent 定向修复。

本方案目标是建立一套稳定、可观测、可复验的任务验收与补齐机制。

## 2. 目标

- 任务没有达到完成标准时，不能标记为完成。
- 没有组件化主产出时，不能展示空“产出物”卡片。
- 本地校验失败时，先用定向修复 Prompt 解决结构问题。
- 结构通过后，再用独立验收员判断内容是否真的达标。
- 补齐过程必须清楚记录失败原因、补齐策略、补齐次数和最终结论。
- 最终完成判断由“本地硬校验 + 验收员报告”共同决定，而不是执行 Agent 自己说了算。

## 3. 不做什么

- 不让执行 Agent 自己直接决定任务完成。
- 不让验收员直接自由生成一大段临时 Prompt。
- 不把 artifact、summary、final_message 当成主产出。
- 不因为补齐失败就推送空结果给用户。
- 不无限重试。
- 不让 Agent 猜测用户才能提供的信息。

## 4. 核心角色

### 4.1 执行 Agent

职责：

- 根据任务目标、完成标准、交付要求执行任务。
- 生成完整 JSON。
- 主产出必须放在 `task_result.blocks`。
- 如果需要用户信息，必须进入待补充状态。

特点：

- 可以调工具。
- 可以读取文件、搜索、运行命令。
- 负责真实完成任务。

### 4.2 本地硬校验

职责：

- 用代码判断确定性问题。
- 不调用 Claude。
- 不判断复杂语义质量。

能判断的问题：

- JSON 是否可解析。
- 是否返回 `task_result`。
- `task_result.blocks` 是否存在且非空。
- block 类型和字段是否合法。
- 是否只返回 artifact。
- 是否缺少任务要求的 block 类型。
- `awaiting_user` 与 `interaction_requirement` 是否一致。
- `deliverable_check` 是否存在并结构合法。

### 4.3 验收员

职责：

- 独立检查结果是否满足任务完成标准。
- 不执行任务。
- 不调工具。
- 不补写最终产出。
- 只输出结构化验收报告。

实现方式：

- 一次轻量 Claude 调用。
- 使用只读 Prompt。
- 输出 JSON。

### 4.4 修复器

职责：

- 根据本地校验报告修复结构问题。
- 优先复用上一轮结果。
- 把 artifact、summary、final_message 中的有效内容转成 `task_result.blocks`。

实现方式：

- 仍由 Claude 完成，但使用专门的本地校验修复 Prompt。
- 可根据问题类型限制是否允许重新调工具。

### 4.5 补齐器

职责：

- 根据验收员报告补齐内容问题。
- 保留已通过内容。
- 只修未通过项。

实现方式：

- 仍由执行 Agent 完成。
- 使用系统生成的内容补齐 Prompt。

## 5. 总体流程

```text
执行 Agent
  -> 解析结果
  -> 本地硬校验
    -> 失败：本地修复 Prompt
      -> 再次本地硬校验
      -> 仍失败：继续本地修复或失败
    -> 通过：进入验收员
  -> 验收员
    -> pass：标记完成
    -> needs_user：等待用户补充
    -> needs_repair：内容补齐 Prompt
      -> 再次本地硬校验
      -> 再次验收员
    -> fail：标记未完成
```

## 6. 状态机

```text
running
  -> local_validation_failed
  -> local_repairing
  -> local_validation_passed
  -> judging
  -> semantic_repairing
  -> completed
  -> awaiting_user
  -> failed
```

状态说明：

| 状态 | 含义 |
|---|---|
| `running` | 执行 Agent 正在执行任务 |
| `local_validation_failed` | 本地硬校验失败 |
| `local_repairing` | 正在修复 JSON / blocks / 结构问题 |
| `local_validation_passed` | 本地硬校验通过 |
| `judging` | 验收员正在检查内容是否达标 |
| `semantic_repairing` | 正在根据验收报告补齐内容 |
| `completed` | 本地硬校验和验收员都通过 |
| `awaiting_user` | 缺少用户信息，等待用户补充 |
| `failed` | 多轮修复后仍不合格 |

## 7. 本地硬校验

### 7.1 校验结果结构

```ts
export type LocalValidationIssueCode =
  | "json_parse_failed"
  | "missing_task_result"
  | "empty_blocks"
  | "artifact_only"
  | "invalid_block_schema"
  | "missing_required_blocks"
  | "blocked_state_invalid"
  | "deliverable_check_invalid";

export type LocalValidationIssue = {
  code: LocalValidationIssueCode;
  severity: "critical" | "major" | "minor";
  message: string;
  evidence?: string;
  repairHint: string;
};

export type LocalValidationReport = {
  passed: boolean;
  repairMode:
    | "format_repair"
    | "structure_repair"
    | "presentation_repair"
    | "state_repair"
    | "content_completion";
  allowToolCalls: boolean;
  issues: LocalValidationIssue[];
  reusableContent: {
    summary?: string;
    finalMessage?: string;
    artifacts?: unknown[];
    taskResult?: unknown;
  };
};
```

### 7.2 失败类型与处理方式

| 问题类型 | 处理方式 | 是否需要验收员 |
|---|---|---|
| `json_parse_failed` | 只修 JSON，不新增事实 | 否 |
| `missing_task_result` | 从已有内容生成 `task_result` | 否 |
| `empty_blocks` | 从已有内容补齐 blocks | 否 |
| `artifact_only` | 把 artifact 转成 blocks | 否 |
| `invalid_block_schema` | 保留内容，修 block 字段 | 否 |
| `missing_required_blocks` | 补齐缺失 block | 否 |
| `blocked_state_invalid` | 修正等待用户状态 | 否 |
| `deliverable_check_invalid` | 重建验收结果字段 | 否 |

本地校验失败时，先不调用验收员。原因是这些问题都是结构性问题，模型验收内容质量前，结果必须先能被系统接收和展示。

## 8. 本地校验修复 Prompt

### 8.1 基础 Prompt

```text
你是 KiKi 的任务结果修复 Agent。

本轮不是重新开始做任务，而是根据系统本地校验报告，修复上一轮输出，使其成为可被系统接收、可展示、可判断完成的完整结果。

你必须优先复用上一轮已经产生的有效内容，不要无关重写。

任务信息：
- 目标：{{goal_title}}
- 子目标：{{sub_goal_title}}
- 任务标题：{{task_title}}
- 任务描述：{{task_description}}
- 任务执行目标：{{execution_objective}}
- 预期产出：{{expected_outcome}}
- 完成标准：{{completion_criteria}}
- 主展示形式：{{presentation}}
- 主格式：structured_blocks
- 必须包含的 blocks：{{required_blocks}}

系统本地校验报告：
{{local_validation_report_json}}

上一轮 Claude 原始输出：
{{raw_agent_output}}

上一轮已解析结果：
{{parsed_result_json}}

修复目标：
1. 修复所有 critical 和 major 问题。
2. 返回一个完整 JSON 对象，不要只返回修改片段。
3. 主产出必须放在 task_result.blocks。
4. summary 和 final_message 只能做简短说明，不能替代主产出。
5. artifacts 只能作为导出或兼容镜像，不能作为唯一产出。
6. 如果已有 artifacts / final_message / summary 中包含有效内容，必须把它们转换或整理进 task_result.blocks。
7. 如果 repairMode 是 format_repair、structure_repair 或 presentation_repair，不要重新调研，不要新增未经验证的事实。
8. 只有 allowToolCalls=true 时，才可以重新获取资料或重新分析。
9. 如果缺少用户才能提供的信息，不要猜测；必须返回 awaiting_user=true，并设置 interaction_requirement.type 为 provide_context 或 answer。
10. 如果无法修复，不要假装完成；返回 deliverable_check.matched=false，并说明仍缺什么。

block 要求：
- heading：标题，字段 { kind, text, level }
- paragraph：普通段落，字段 { kind, text }
- markdown：富文本正文，字段 { kind, content }
- list：清单，字段 { kind, ordered, items }
- key_value：属性对，字段 { kind, entries: [{ label, value, emphasis }] }
- comparison_table：对比表，字段 { kind, columns, rows, highlight }
- decision：决策点，字段 { kind, question, options, selectedOptionId }
- callout：提示/风险/结论，字段 { kind, tone, text }

输出 JSON 格式：
{
  "summary": "一句话说明修复后的结果",
  "final_message": "面向用户的简短说明，不能替代 task_result.blocks",
  "result_view_kind": "generic_result",
  "awaiting_user": false,
  "awaiting_reason": "",
  "interaction_requirement": {
    "type": "none|answer|provide_context|perform_offline_action|deliverable_gap|agent_revision_required",
    "timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
    "reason": "",
    "question": "",
    "options": [],
    "suggested_actions": [],
    "should_notify_user": false
  },
  "suggested_actions": [],
  "artifacts": [],
  "task_result": {
    "schemaVersion": 1,
    "taskId": "{{task_id}}",
    "instanceId": "{{instance_id}}",
    "title": "产出物标题",
    "status": "done|pending_user|blocked|failed",
    "blocks": [
      { "kind": "heading", "text": "核心产出", "level": 2 }
    ],
    "meta": {
      "producedAt": "ISO 时间",
      "presentation": "{{presentation}}",
      "primaryFormat": "structured_blocks",
      "exportableFormats": ["markdown"]
    }
  },
  "deliverable_check": {
    "matched": true,
    "confidence": "high|medium|low",
    "delivered_artifacts": ["task_result.blocks"],
    "missing_deliverables": [],
    "criteria_results": [
      {
        "criterion": "完成标准",
        "status": "passed|failed|unknown",
        "evidence": "对应 task_result.blocks 中的证据"
      }
    ],
    "gap_reason": ""
  },
  "structured_output": {
    "repair_source": "local_validation",
    "repaired_issues": []
  }
}

只输出 JSON，不要加代码块，不要输出额外解释。
```

### 8.2 按问题类型追加指令

`json_parse_failed`：

```text
本轮只修复 JSON 格式。
不要改变原始含义。
不要新增事实。
不要省略已有内容。
如果原始输出中有可用产出内容，必须整理进 task_result.blocks。
```

`artifact_only`：

```text
上一轮结果只存在 artifacts / final_message / summary 中。
这不算完成。
请把其中的有效内容转换为 task_result.blocks。
如果内容是对比、表格、清单或方案，不要只放 markdown，优先使用 comparison_table、list、key_value、callout。
```

`empty_blocks`：

```text
task_result.blocks 为空，因此无法展示给用户。
请根据上一轮已有内容补齐完整 blocks。
如果上一轮没有足够内容，则 deliverable_check.matched 必须为 false，并说明缺失项。
```

`missing_required_blocks`：

```text
任务要求包含以下 blocks：{{required_blocks}}。
当前结果缺少：{{missing_blocks}}。
请补齐缺失 blocks，并确保它们承载真实产出内容，而不是占位说明。
```

`invalid_block_schema`：

```text
当前 blocks 结构不符合系统支持的字段。
请保留原内容，只修正 block kind 和字段结构。
不要发明新的 block 类型。
```

`blocked_state_invalid`：

```text
当前结果的用户等待状态不一致。
如果缺少用户才能提供的信息，必须设置 awaiting_user=true，并说明需要用户补充什么。
如果不缺用户信息，则 awaiting_user=false，并直接返回完整 task_result.blocks。
```

## 9. 验收员

### 9.1 什么时候调用

调用验收员的前提：

- 本地硬校验通过。
- 结果已经有合法 `task_result.blocks`。
- 任务不是明确等待用户输入。
- 需要判断内容是否满足完成标准。

不需要调用验收员的情况：

- JSON 不合法。
- 缺少 `task_result.blocks`。
- block schema 不合法。
- required blocks 明确缺失。
- artifact-only。
- 缺用户信息。

### 9.2 验收员输出结构

```ts
export type AcceptanceReport = {
  verdict: "pass" | "needs_repair" | "needs_user" | "fail";
  confidence: "high" | "medium" | "low";
  summary: string;
  hardFailures: string[];
  passedCriteria: Array<{
    criterion: string;
    evidence: string;
  }>;
  failedCriteria: Array<{
    criterion: string;
    evidence: string;
    severity: "critical" | "major" | "minor";
    repairableByAgent: boolean;
    requiresUserInput: boolean;
  }>;
  blockAssessment: {
    keepBlocks: string[];
    rewriteBlocks: string[];
    missingBlocks: string[];
  };
  repairStrategy: {
    mode: "presentation_only" | "content_gap" | "restructure" | "rerun_with_tools";
    reuseExistingContent: boolean;
    allowNewToolCalls: boolean;
  };
  repairInstructions: string[];
  userBlockers: string[];
};
```

### 9.3 验收员 Prompt

```text
你是 KiKi 的任务验收员。你不负责执行任务，不负责补做任务，不允许为了“看起来差不多”而判定通过。

你的唯一职责是：根据任务完成标准，检查当前执行结果是否已经满足要求，并输出结构化验收报告。

验收原则：
1. 以任务完成标准和预期产出为最高优先级，而不是以 summary / final_message 为准。
2. 必须检查 task_result.blocks 是否已经承载主产出。
3. 如果主产出缺失、内容不完整、只给摘要、只给 artifact、缺少 requiredBlocks，都不能判定为完成。
4. 如果问题只涉及呈现方式、结构化不足、某些 blocks 缺失，但核心内容大体已存在，可判定为 needs_repair。
5. 如果缺的是用户才能提供的关键信息，判定为 needs_user，不要要求 Agent 猜测补齐。
6. 你必须明确指出：哪些标准已通过，哪些未通过，证据是什么，下一轮应该保留什么、补什么、不要改什么。
7. 不要输出自然语言长文，只输出 JSON。

任务信息：
{{task_info_json}}

完成标准和交付要求：
{{task_completion_requirements_json}}

本地硬校验结果：
{{local_validation_report_json}}

当前执行结果 JSON：
{{current_result_json}}

请输出 JSON：
{
  "verdict": "pass | needs_repair | needs_user | fail",
  "confidence": "high | medium | low",
  "summary": "一句话结论",
  "hardFailures": [],
  "passedCriteria": [
    { "criterion": "xxx", "evidence": "xxx" }
  ],
  "failedCriteria": [
    {
      "criterion": "xxx",
      "evidence": "xxx",
      "severity": "critical | major | minor",
      "repairableByAgent": true,
      "requiresUserInput": false
    }
  ],
  "blockAssessment": {
    "keepBlocks": [],
    "rewriteBlocks": [],
    "missingBlocks": []
  },
  "repairStrategy": {
    "mode": "presentation_only | content_gap | restructure | rerun_with_tools",
    "reuseExistingContent": true,
    "allowNewToolCalls": false
  },
  "repairInstructions": [],
  "userBlockers": []
}
```

## 10. 内容补齐 Prompt

内容补齐只在验收员返回 `needs_repair` 时触发。

```text
你是 KiKi 的后台任务执行 Agent。本轮不是从头执行，而是根据验收报告，定向补齐当前结果。

目标：
在不破坏已通过内容的前提下，修复未通过项，返回完整、可验收的最终 JSON。

必须遵守：
1. 保留 acceptance_report.passedCriteria 已经通过的内容，不要无关重写。
2. 优先复用已有 task_result / artifacts / final_message 中已经正确的内容。
3. 只有在 acceptance_report.repairStrategy.allowNewToolCalls=true 时，才允许重新搜索、读取、执行工具。
4. 如果本轮只是 presentation_only，不允许重新调研，只允许把已有内容重组为合格的 task_result.blocks。
5. 如果缺的是用户信息，不要猜测；直接返回 awaiting_user / provide_context 或 answer。
6. 最终必须返回完整 JSON，不要只返回 patch，不要只返回解释。
7. task_result.blocks 必须是主产出。
8. 不要丢失已经通过的内容。
9. 不要只返回 summary / final_message / artifacts。

任务信息：
{{task_info_json}}

完成标准和交付要求：
{{task_completion_requirements_json}}

上一轮执行结果：
{{current_result_json}}

验收报告：
{{acceptance_report_json}}

请修复以下问题：
{{repair_instruction_list}}

输出要求：
- 返回完整结果 JSON。
- task_result.blocks 必须是主产出。
- deliverable_check 必须重新根据修复后的结果填写。
- 如果仍不能满足完成标准，deliverable_check.matched 必须为 false。
- 只输出 JSON，不要加代码块，不要输出额外解释。
```

## 11. 完成判断规则

任务只有同时满足以下条件，才能写成 `completed`：

- 本地硬校验通过。
- 存在合法且非空的 `task_result.blocks`。
- 没有 artifact-only 问题。
- 没有 required block 缺失。
- 验收员返回 `pass`。
- `deliverable_check.matched === true`。
- 没有等待用户补充的信息。

否则：

- 本地校验失败：进入本地修复。
- 验收员返回 `needs_repair`：进入内容补齐。
- 验收员返回 `needs_user`：进入 `awaiting_user`。
- 多轮补齐仍失败：进入 `failed`。

## 12. 调用次数控制

建议上限：

| 类型 | 上限 |
|---|---:|
| 初始执行 | 1 |
| 本地修复 | 2 |
| 验收员检查 | 3 |
| 内容补齐 | 2 |
| 总 Claude 调用 | 6 |

失败规则：

- 连续两次相同本地校验错误：直接失败。
- 内容补齐两次后仍 `needs_repair`：直接失败。
- 验收员返回 `fail`：直接失败。
- 缺用户信息：不再自动补齐，等待用户。

## 13. UI 展示规则

### 13.1 用户可见

- 完成后的 `task_result.blocks`。
- 等待用户补充的信息卡。
- 任务失败后的重试入口。
- 简洁的执行链路。

### 13.2 默认不展示

- 本地校验报告原始 JSON。
- 验收员原始 JSON。
- 修复 Prompt 全文。
- Claude 原始输出。

### 13.3 可在调试视图展示

- 本地校验失败项。
- 验收员结论。
- 补齐轮次。
- 每轮耗时。
- 每轮是否允许工具调用。

## 14. 数据落库建议

建议在 `runtime_jobs.result` 或 `structuredOutput` 中增加：

```ts
type TaskAcceptanceRuntimeState = {
  localValidationReports: LocalValidationReport[];
  acceptanceReports: AcceptanceReport[];
  repairAttempts: Array<{
    type: "local_validation" | "semantic_repair";
    attempt: number;
    promptKind: string;
    startedAt: string;
    finishedAt?: string;
    status: "running" | "passed" | "failed";
    issueCodes?: string[];
    verdict?: AcceptanceReport["verdict"];
  }>;
};
```

这样刷新页面后，仍能看到为什么没有完成、补齐过几次、最终为什么失败。

## 15. 服务端改造点

### 15.1 新增类型

建议新增：

- `src/types/taskAcceptance.ts`
  - `LocalValidationIssue`
  - `LocalValidationReport`
  - `AcceptanceReport`
  - `TaskAcceptanceRuntimeState`

### 15.2 新增本地校验模块

建议新增：

- `src/lib/taskResult/localValidation.ts`

职责：

- 接收 raw output、parsed result、task。
- 输出 `LocalValidationReport`。
- 不调用 Claude。

### 15.3 新增 Prompt Builder

建议新增：

- `src/lib/server/goalTaskAcceptancePrompt.ts`

包含：

- `buildLocalValidationRepairPrompt`
- `buildAcceptanceJudgePrompt`
- `buildSemanticRepairPrompt`

### 15.4 改造 Runner

改造 `goalTaskRunner.ts`：

- 初始执行后不直接完成。
- 先跑本地校验。
- 本地校验失败进入本地修复循环。
- 本地校验通过后调用验收员。
- 验收员返回 `needs_repair` 后进入内容补齐循环。
- 只有最终 `pass` 才调用 `finishGoalTelemetry()`。
- 未通过上限时调用 `failGoalTelemetry()`。

## 16. 伪代码

```ts
async function runTaskWithAcceptance(input) {
  let result = await executeAgent(input);
  let rawOutput = result.rawOutput;

  for (let localAttempt = 1; localAttempt <= 2; localAttempt += 1) {
    const localReport = validateLocally({ task: input.task, rawOutput, result });
    persistLocalReport(localReport);

    if (localReport.passed) break;

    const repairPrompt = buildLocalValidationRepairPrompt({
      task: input.task,
      rawOutput,
      parsedResult: result,
      localReport,
    });

    result = await runClaudeRepair(repairPrompt);
    rawOutput = result.rawOutput;
  }

  const finalLocalReport = validateLocally({ task: input.task, rawOutput, result });
  if (!finalLocalReport.passed) {
    return failTask("本地校验失败，任务未完成", finalLocalReport);
  }

  for (let semanticAttempt = 1; semanticAttempt <= 2; semanticAttempt += 1) {
    const acceptanceReport = await runAcceptanceJudge({
      task: input.task,
      localReport: finalLocalReport,
      result,
    });
    persistAcceptanceReport(acceptanceReport);

    if (acceptanceReport.verdict === "pass") {
      return completeTask(result, acceptanceReport);
    }

    if (acceptanceReport.verdict === "needs_user") {
      return awaitUser(acceptanceReport);
    }

    if (acceptanceReport.verdict === "fail") {
      return failTask("验收未通过", acceptanceReport);
    }

    const repairPrompt = buildSemanticRepairPrompt({
      task: input.task,
      currentResult: result,
      acceptanceReport,
    });

    result = await runClaudeRepair(repairPrompt);

    const localReportAfterRepair = validateLocally({
      task: input.task,
      rawOutput: result.rawOutput,
      result,
    });

    if (!localReportAfterRepair.passed) {
      result = await repairLocalStructureAgain(result, localReportAfterRepair);
    }
  }

  return failTask("多轮补齐后仍未达到完成标准", result);
}
```

## 17. 分阶段落地

### 阶段一：本地校验报告

- 新增 `LocalValidationReport`。
- 把现有 `enforceDeliverableRequirements` 拆成可复用本地校验。
- 先覆盖：
  - `missing_task_result`
  - `empty_blocks`
  - `artifact_only`
  - `invalid_block_schema`
  - `deliverable_check_invalid`

验收标准：

- artifact-only 不会完成。
- empty blocks 不会完成。
- 本地校验失败项可在 `structuredOutput` 中查看。

### 阶段二：本地校验修复 Prompt

- 新增 `buildLocalValidationRepairPrompt`。
- 替换当前浅层 `buildReflectionContext` 的结构修复场景。
- 支持最多 2 次本地修复。

验收标准：

- artifact-only 可以被转换为 `task_result.blocks`。
- block schema 错误可以自动修正。
- 修复失败不会进入 completed。

### 阶段三：验收员

- 新增 `buildAcceptanceJudgePrompt`。
- 新增 `AcceptanceReport`。
- 本地校验通过后调用验收员。

验收标准：

- 内容明显缺失时，验收员返回 `needs_repair`。
- 缺用户信息时，验收员返回 `needs_user`。
- 只有 `pass` 才能完成。

### 阶段四：内容补齐

- 新增 `buildSemanticRepairPrompt`。
- 根据验收报告做定向补齐。
- 支持保留已通过内容。

验收标准：

- 缺表格时只补表格。
- 缺结论时只补结论。
- presentation-only 不重新调研。
- content_gap 才允许重新调工具。

### 阶段五：UI 与可观测

- 执行链路展示：
  - 本地校验失败
  - 本地修复中
  - 验收员检查
  - 内容补齐中
  - 最终完成 / 失败
- 普通用户不展示原始 JSON。
- 调试模式可查看详细报告。

## 18. 风险与处理

| 风险 | 处理 |
|---|---|
| 调用次数增加导致慢 | 本地明确失败不调用验收员；简单任务可配置跳过验收员 |
| 验收员过严 | 记录 failedCriteria，支持后续调参 |
| 验收员过松 | 本地硬校验兜底，关键任务强制 required blocks |
| 修复器反复同一错误 | 连续两次同一 issue code 直接失败 |
| Agent 编造缺失信息 | needs_user 分支强制停，不允许猜测 |
| presentation-only 误触发重新调研 | repairStrategy.allowNewToolCalls=false 时禁止工具调用 |

## 19. 推荐默认策略

- 信息密集型任务：必须调用验收员。
- 决策型任务：必须调用验收员。
- 对比分析任务：必须调用验收员。
- 简单通知类任务：本地校验通过即可完成。
- 内置练习类任务：沿用内置组件校验，不强制验收员。

默认次数：

- 本地修复：最多 2 次。
- 内容补齐：最多 2 次。
- 验收员：最多 3 次。

## 20. 最终判断

最合理的方案不是让执行 Agent 自评，也不是让验收员自由写 Prompt。

推荐方案是：

1. 本地硬校验先保证结果能被系统接收和展示。
2. 本地校验失败时，用专门修复 Prompt 解决结构问题。
3. 结构通过后，由独立验收员判断内容是否达到完成标准。
4. 验收员只输出结构化报告。
5. 系统根据报告生成稳定补齐 Prompt。
6. 执行 Agent 定向补齐。
7. 最终只有本地校验和验收员都通过，任务才算完成。
