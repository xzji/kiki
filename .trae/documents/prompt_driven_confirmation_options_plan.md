# 提示词驱动候选项生成方案

## Summary

将“待确认/待补充信息”的候选项生成从规则兜底改为提示词驱动：

* 候选项必须由 Claude 根据问题、目标、子目标、任务描述、执行目标、预期结果、完成标准、协作要求、缺失字段说明、恢复上下文生成。

* 本地代码不再根据关键词生成业务候选项，例如不再用“签证/酒店/正确率/词汇清单”等规则拼出候选项。

* 如果第一次生成结果不可用，服务端使用“修复/重试提示词”再生成一次。

* 第二次仍失败时，不展示伪候选项，只保留自定义输入，让用户自己描述，避免错误选项误导。

* 前端只负责展示服务端给出的候选项，不再自行补业务候选项。

## Current State Analysis

### 服务端现状

* `src/lib/server/userConfirmationOptionsPrompt.ts`

  * 已有 `buildUserConfirmationOptionsPrompt()`，但输入只有 `question` 和扁平 `context`。

  * 当前 prompt 偏“单问题候选项生成”，没有结构化输入缺失字段、任务协作要求、预期结果等。

  * `normalizeConfirmationOptionLabels()` 会用本地规则过滤泛泛选项。

* `src/lib/server/goalTaskRunner.ts`

  * `taskContextForOptionGeneration()` 会拼接目标、子目标、任务标题、描述、执行目标、预期结果、完成标准、恢复上下文。

  * `generateUserConfirmationOptions()` 先调用 Claude 生成候选项，不足 3 个时会走 `semanticFallbackOptions()`。

  * `semanticFallbackOptions()` 是规则化业务兜底，包含旅游、词汇训练等关键词分支，和目标方案冲突。

  * `defaultContextOptions()` 会从文本里抽示例，抽不到再走 `semanticFallbackOptions()`。

  * `buildReadinessFromUserBlockers()` 会给每个 blocker 塞入 `options: semanticFallbackOptions(...)`，导致前端可能直接展示规则生成的候选项。

  * `coerceMissingUserContextBlocker()` 在没有模型选项时会调用 `defaultContextOptions()`，继续落到规则兜底。

### 前端现状

* `src/components/task/AwaitingUserResumePanel.tsx`

  * `defaultOptionsFor()` 会根据交互类型生成通用候选项，如“主流稳妥方案/高性价比方案/体验优先方案”。

  * `defaultOptionsForMissingItem()` 会用本地关键词规则生成业务候选项。

  * `optionsForMissingItem()` 在 item 没有 options 时，会使用前端本地候选项或全局 suggestedOptions。

  * 这会导致服务端没生成具体候选项时，前端仍展示看似可选、实际不贴合任务的问题选项。

### 已确认产品决策

* 失败降级：第一次提示词生成失败或质量不足时，服务端重试一次；重试仍失败后只显示输入框。

* 质量校验：不使用本地规则过滤或生成候选项，全部靠模型生成与模型自我修复。

* 范围限制：本方案只改候选项生成链路，不改变任务执行主流程、任务验收流程、等待用户状态机制。

## Proposed Changes

### 1. 重构候选项提示词输入

文件：`src/lib/server/userConfirmationOptionsPrompt.ts`

做法：

* 将 `buildUserConfirmationOptionsPrompt()` 的输入从 `{ question, context, optionCount }` 扩展为结构化上下文：

  * `question`

  * `goalTitle`

  * `goalSummary`

  * `subGoalTitle`

  * `taskTitle`

  * `taskDescription`

  * `executionObjective`

  * `expectedOutcome`

  * `expectedResultDescription`

  * `completionCriteria`

  * `collaborationSummary`

  * `missingItems`

  * `resumeContext`

  * `seedOptions`

* Prompt 明确要求：

  * 候选项必须是用户对当前问题的“可直接提交答案”。

  * 每个缺失字段都要生成自己的 3 个候选项。

  * 如果一个问题包含多个缺失字段，输出 `items` 数组，逐项对应。

  * 不允许“主流方案/高性价比方案/体验优先方案/补充信息/选项A”等空壳表达。

  * 不允许凭空生成需要精确事实的数据；遇到无法合理枚举的字段，应返回 `options: []` 并给出 `inputPlaceholder`。

  * 必须严格输出 JSON。

建议输出结构：

```json
{
  "question": "对用户的一句话问题",
  "items": [
    {
      "id": "missing item id",
      "label": "缺失字段名",
      "question": "这一项要问用户什么",
      "options": [
        { "label": "候选答案1", "hint": "为什么适合" },
        { "label": "候选答案2", "hint": "为什么适合" },
        { "label": "候选答案3", "hint": "为什么适合" }
      ],
      "inputPlaceholder": "如果都不合适，用户可如何填写"
    }
  ]
}
```

首轮生成提示词定稿：

```text
# 角色
你是 KiKi 的“用户待确认信息候选项生成器”。你的职责不是继续执行任务，而是把当前等待用户回答的问题，转化成用户可以一键点击提交的具体答案。

# 输入
你会收到一个 JSON 上下文，包含：
- goal：长期目标信息
- subGoal：当前子目标
- task：当前任务、任务描述、执行目标、预期结果、完成标准
- collaboration：Agent/用户职责、用户介入类型、用户介入时机
- awaitingUser：当前需要用户补充或确认的问题
- missingItems：本轮缺失字段列表
- resumeContext：用户此前已经补充过的信息，如果有
- seedOptions：上游模型可能已经给出的候选项，如果有

# 生成目标
为 missingItems 中的每一项生成 0-3 个候选答案。

候选答案必须满足：
1. 是用户可以直接提交的“答案”，不是动作或说明。
2. 必须紧扣该 missingItem 的 label、description、reason，以及当前任务的 expectedOutcome / completionCriteria。
3. 候选项之间要互斥，覆盖常见分支。
4. 每个候选项要包含区分信息，例如范围、程度、数量、时间、场景、取舍或条件。
5. 每个候选项建议 8-28 个中文字符。
6. 如果当前字段本质上需要用户提供精确事实，不能合理枚举候选项，则 options 返回空数组，并给 inputPlaceholder。

# 禁止
禁止输出这些空壳候选项或同义表达：
- 主流方案
- 稳妥方案
- 高性价比方案
- 体验优先方案
- 补充信息
- 提供偏好
- 填写其他信息
- 暂时无法提供
- 选项A / 方案一

禁止为了凑满 3 个而编造精确事实。
禁止把同一组选项复制给多个 missingItems。
禁止输出 Markdown 代码块。
禁止输出 JSON 之外的任何解释。

# 输出 JSON Schema
{
  "question": "面向用户的一句话总问题",
  "items": [
    {
      "id": "必须等于输入 missingItems[i].id",
      "label": "必须等于输入 missingItems[i].label",
      "question": "这一项具体要问用户什么",
      "options": [
        {
          "label": "用户可直接提交的候选答案",
          "hint": "一句话解释该选项适用场景，可为空"
        }
      ],
      "inputPlaceholder": "没有合适候选项时，提示用户如何手动填写"
    }
  ]
}

# 输出要求
- items 必须覆盖输入中的所有 missingItems，顺序保持一致。
- 每个 item 最多 3 个 options。
- 如果没有合适候选项，options 输出 []，不要硬凑。
- question / inputPlaceholder 要使用用户能看懂的自然语言。

# 上下文 JSON
{{CONTEXT_JSON}}
```

### 2. 增加模型修复提示词

文件：`src/lib/server/userConfirmationOptionsPrompt.ts`

新增：

* `buildUserConfirmationOptionsRepairPrompt(input)`

  * 输入包含原始 prompt 上下文、第一次 raw output、解析/质量问题说明。

  * 要求模型只修复 JSON 和候选项，不改变问题语义。

  * 不允许输出解释文本。

修复提示词定稿：

```text
# 角色
你是 KiKi 的“候选项 JSON 修复器”。上一次候选项生成结果不可用，你需要基于同一份上下文重新输出可解析、可展示的 JSON。

# 失败原因
{{ERROR_SUMMARY}}

# 上一次原始输出
{{RAW_OUTPUT}}

# 修复规则
1. 只输出 JSON，不要输出 Markdown 代码块或解释。
2. 输出必须符合指定 Schema。
3. items 必须覆盖上下文 JSON 中的所有 missingItems，并保持顺序。
4. 每个 item 最多生成 3 个候选答案。
5. 候选答案必须是用户可以直接提交的具体答案。
6. 如果某个字段需要用户提供精确事实，不能合理枚举，则 options 返回 []，并提供 inputPlaceholder。
7. 不要使用“主流方案 / 稳妥方案 / 高性价比方案 / 体验优先方案 / 补充信息 / 选项A”等空壳候选项。
8. 不要把同一组选项复制给多个 missingItems。

# 输出 JSON Schema
{
  "question": "面向用户的一句话总问题",
  "items": [
    {
      "id": "必须等于输入 missingItems[i].id",
      "label": "必须等于输入 missingItems[i].label",
      "question": "这一项具体要问用户什么",
      "options": [
        {
          "label": "用户可直接提交的候选答案",
          "hint": "一句话解释该选项适用场景，可为空"
        }
      ],
      "inputPlaceholder": "没有合适候选项时，提示用户如何手动填写"
    }
  ]
}

# 上下文 JSON
{{CONTEXT_JSON}}
```

新增解析能力：

* `parseUserConfirmationOptions()` 支持新结构 `items`。

* 对解析结果只做结构合法性检查：

  * JSON 可解析。

  * `items` 为数组。

  * 每个 item 的 `options` 是数组。

  * label 是字符串。

* 不做本地业务规则过滤，不用关键词判断“是否泛泛”。

### 3. 服务端候选项生成改为 prompt-only

文件：`src/lib/server/goalTaskRunner.ts`

修改：

* 删除或停止使用 `semanticFallbackOptions()`。

* 删除或停止使用 `defaultContextOptions()` 和 `extractExampleOptions()` 的兜底生成职责。

* `generateUserConfirmationOptions()` 改为：

  * 调用 `buildUserConfirmationOptionsPrompt()`。

  * 解析为结构化结果。

  * 如果缺失项只有一个，返回该 item 的 options。

  * 如果是多缺失项，交给新函数按 item id/label 写回 readiness items。

  * 第一次失败时记录 raw output 和失败原因。

  * 调用 `buildUserConfirmationOptionsRepairPrompt()` 重试一次。

  * 第二次仍失败时返回空数组，不返回规则候选项。

新增建议函数：

* `buildOptionGenerationContext(input: RunGoalTaskInput)`

  * 生成结构化上下文对象，而不是纯文本。

* `generateOptionsForReadinessItems(input, readiness, question)`

  * 一次性为所有 `readiness.missingUserInfo` 生成候选项。

  * 将模型输出按 `id` 或 `label` 写回对应 item。

  * 失败后 item.options 保持为空。

需要调整调用点：

* `buildReadinessBlockedResult()`

  * 当前只生成一个全局 `options`。

  * 改为先为每个 missing item 生成 item.options。

  * 顶层 `interactionRequirement.options` 只在单一缺失项时填入该项 options；多缺失项时可为空，避免一组选项套所有问题。

* `buildReadinessFromUserBlockers()`

  * 不再给每个 blocker 立即写 `semanticFallbackOptions()`。

  * 只创建缺失项结构，`options` 留空，后续由提示词生成器填充。

* `buildNeedsUserFromAcceptance()`

  * 改为使用新 `generateOptionsForReadinessItems()`。

  * 如果重试后仍为空，允许进入 awaiting\_user，但前端只显示输入框。

* `coerceMissingUserContextBlocker()`

  * 不再调用 `defaultContextOptions()`。

  * 保留已有模型返回的 `interactionRequirement.options`。

  * 若没有模型选项，不补规则候选项。

### 4. 前端移除业务候选项规则

文件：`src/components/task/AwaitingUserResumePanel.tsx`

修改：

* 删除 `defaultOptionsFor()` 的候选项生成职责。

* 删除 `defaultOptionsForMissingItem()`。

* 删除 `GENERIC_CONTEXT_OPTIONS` 和 `GENERIC_CONTEXT_OPTION_PATTERNS` 的过滤逻辑。

* `pickThreeOptions()` 只做去重、截断、去空，不判断语义。

* `optionsForMissingItem(item)` 只读取：

  * `item.options`

  * 不再使用 `suggestedOptions` 作为多字段兜底，防止一组选项重复套到多个问题。

* 当某个 missing item 没有 options：

  * 直接展示“都不是，我自己描述”输入行。

  * placeholder 使用 `item.label` 或服务端的 `inputPlaceholder`（如果后续类型扩展）。

* 当全局问题没有 options：

  * 只展示自定义输入框。

### 5. 调整类型以支持逐项候选项

文件：`src/components/task/AwaitingUserResumePanel.tsx`

短期做法：

* 在组件本地 `ReadinessItem` 类型增加可选字段：

  * `optionQuestion?: string`

  * `inputPlaceholder?: string`

* 渲染时优先显示 `optionQuestion`，否则显示 `请选择${item.label}`。

如果服务端类型已有对应共享定义，实施时应迁移到共享类型；本计划不强制新增全局类型文件。

### 6. 日志与可观测性

文件：`src/lib/server/goalTaskRunner.ts`

新增日志点：

* 第一次候选项生成失败：

  * phase: `executing`

  * message: `用户候选项提示词生成失败，准备重试`

  * details 包含 parse error、raw output 截断内容。

* 修复提示词仍失败：

  * message: `用户候选项生成重试失败，将仅展示自定义输入`

  * details 包含 repair raw output 截断内容。

* 生成成功：

  * 记录缺失项数量、每项候选项数量，不记录过长正文。

目的：

* 后续如果又出现空候选项，可以判断是模型未生成、JSON 不合法、还是前端没渲染。

## Assumptions & Decisions

* 候选项生成不再依赖本地业务规则。

* 本地可以做 JSON 结构合法性判断，但不做语义过滤。

* 模型失败后重试一次；重试失败只显示自定义输入。

* “都不是，我自己描述”仍由前端固定提供，但它不是候选项生成结果的一部分。

* 多缺失项必须逐项生成候选项，不能用一组全局候选项套所有字段。

* 本方案保留前一轮关于“产出前待补充时不展示具体产物”的修复，因为它解决的是展示时机冲突，不属于候选项生成规则。

## Verification Steps

### 静态检查

* 运行 `GetDiagnostics` 检查：

  * `src/lib/server/userConfirmationOptionsPrompt.ts`

  * `src/lib/server/goalTaskRunner.ts`

  * `src/components/task/AwaitingUserResumePanel.tsx`

* 运行：

```bash
pnpm lint
```

### 行为验证

* 构造一个多缺失项任务，例如：

  * `用户测试作答结果`

  * `正确率统计数据`

  * `需重点复习词汇清单`

* 预期：

  * 每个问题的选项由模型根据上下文生成，且三组不再完全相同。

  * 若模型无法合理生成某项候选项，该项只显示自定义输入框。

  * 不再出现硬编码的“主流稳妥方案/高性价比方案/体验优先方案”。

### 失败路径验证

* 模拟候选项生成 raw output 非 JSON：

  * 第一次失败后应触发 repair prompt。

  * repair 仍失败后，任务仍进入 awaiting\_user。

  * 前端不展示伪候选项，只展示输入框。

  * 日志包含 raw output 截断内容，便于排查。

### 回归验证

* 单缺失项任务：

  * 仍能显示 3 个模型候选项。

* 多缺失项任务：

  * 每项显示自己的候选项。

* 无候选项任务：

  * 可以通过自定义输入提交并恢复执行。
