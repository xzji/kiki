# 「补充信息卡片」根因级修复计划

> 目标：从信息架构层面统一「等待用户补充」交互的契约，使所有问题（静态 readiness / LLM 产出 / 未来新增字段）都能稳定获得清晰的问题描述、互斥候选项与一致的兜底体验，不再依赖个案补丁。

## 一、Summary（结论先行）

当前 UI 退化到「每个问题只剩一个『都不是，我自己描述』」并非渲染 bug，而是数据契约层的系统性缺陷：

1. **数据契约一维化**：`InteractionRequirement.options` 是 `string[]`，无法表达「按字段分组」。当一次性缺失 N 个用户输入时，无处放 N 组 options。
2. **生产者各自为政**：`taskReadinessPolicy`（静态规则）只填 `label/description/reason`，从不填 `options/optionQuestion`；`goalTaskPrompt`（LLM 协议）只产出顶层一维 options；二者无法对齐合并。
3. **UI 渲染分支盲点**：多缺失项时既不能复用 LLM 的全局 options，也没有任何兜底，最终只剩 UI 自带的「都不是」。
4. **问题描述弱**：UI 标题 fallback 链是 `optionQuestion → 请选择${label}`，跳过了 readiness 中已有的 `description`、跳过了任务上下文驱动的提问改写。

### 通用解法

引入**「按字段分组的需求模型」`InformationRequest`** 作为唯一真实来源，所有生产者输出都映射成它，UI 只读取它：

```
InformationRequest = {
  intent: "provide_context" | "answer" | "confirm" | ...
  rationale: string                    // 解释为什么需要这些信息
  fields: MissingFieldQuestion[]       // 每个缺失字段一个对象
  globalOptions?: string[]             // 仅当 fields.length<=1 才有意义
}

MissingFieldQuestion = {
  id: string                           // 与 readiness item id 对齐
  label: string                        // 字段名
  question: string                     // 完整问句（必须）
  description: string                  // 解释为什么需要（必须）
  options: string[]                    // ≥3 个具体候选项（兜底由 UI 自动追加）
  inputPlaceholder?: string
  source: "user" | "agent" | "system"
}
```

此模型是 readiness、LLM、UI 三方的契约；任何一方都必须满足"每个 field 至少 3 个具体候选项 + 完整 question"。

---

## 二、Current State Analysis（基于 Phase 1 代码探查）

### 2.1 数据流

```
[启动期 静态] taskReadinessPolicy.buildTaskReadinessCheck()
    └─ items: { id, label, description, source, status, reason }   ← 只到这一层
        ↓ readinessAdapter.contextBlockersFromReadiness()
        ↓ preExecutionBlocker.createPreExecutionInteractionRequirement(readiness)
            └─ buildOptions(): missingUserInfo.length === 1 才有 options，否则 []
            └─ buildQuestion(): 多缺失项只生成 "请一次性补充以下信息：1. X；2. Y"
        ↓ instance.awaitingUser.interactionRequirement: { question, options:string[] }
        ↓ instance.result.structuredOutput.taskReadiness: { items[] }

[运行期 LLM] goalTaskPrompt.ts L250-258
    └─ 协议: interaction_requirement.options: string[3]    ← 一维，与字段无关
        └─ "UI 会自动补 1 个'都不是'，你不要把这个兜底项放进 options"

[渲染] AwaitingUserResumePanel.tsx L208-221
    └─ if (missingItems.length > 0) options = []           ← 多字段就清空全局 options
    └─ optionsForMissingItem(item):
         missingItems.length === 1 → 用 LLM options
         else → 用 item.options（永远空，因为 readiness 不填）
    └─ 标题: item.optionQuestion?.trim() || `请选择${item.label}`   ← 退化
```

**根因落点**：

| 位置 | 缺陷 | 直接现象 |
|---|---|---|
| [taskReadinessPolicy.ts L107-147](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts#L107-L147) | 静态规则永不填 `options/optionQuestion/inputPlaceholder` | 多字段渲染必然 0 选项 |
| [preExecutionBlocker.ts L31-34](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/preExecutionBlocker.ts#L31-L34) | `buildOptions` 仅 1 字段时取 options | 数据契约层把多字段场景丢弃 |
| [goalTaskPrompt.ts L250-258](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L250-L258) | LLM 协议只产出一维 options | LLM 产物无法投射到多字段 UI |
| [AwaitingUserResumePanel.tsx L218-221, L336](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx#L218-L221) | UI 兜底链不完整、标题不用 description | 视觉降级到「都不是」单选 + 弱标题 |
| [kiki.ts L54-69](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L54-L69) | `InteractionRequirement.options: string[]` | 类型层无法表达字段维度 |

### 2.2 已审阅的关键文件（Phase 1）

- [src/types/kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts#L54-L69)：`InteractionRequirement` 类型
- [src/lib/server/taskReadinessPolicy.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts)：静态 readiness 规则
- [src/lib/server/taskExecution/preExecutionBlocker.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/preExecutionBlocker.ts)：启动期 blocker 构造
- [src/lib/server/taskExecution/readinessAdapter.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/readinessAdapter.ts)：上下文 blocker ↔ readiness item
- [src/lib/server/taskExecution/startTaskAttempt.ts L230-326](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/startTaskAttempt.ts#L230-L326)：启动期等待用户路径
- [src/lib/server/goalTaskPrompt.ts L250-365](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L250-L365)：LLM 输出协议
- [src/components/task/AwaitingUserResumePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx)：渲染层
- [src/lib/taskResult/optionalFeedback.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/optionalFeedback.ts)：完成后可选反馈复用同一 options

---

## 三、Proposed Changes（按层级）

### 3.1 类型层：扩展 `InteractionRequirement`

**文件**：[src/types/kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts)

向后兼容地新增字段，不删除现有 `options`（保留作为单字段/全局回退）：

```ts
export type MissingFieldQuestion = {
  id: string;                          // 与 TaskReadinessInfoItem.id 对齐
  label: string;
  question: string;                    // 完整问句
  description: string;                 // "为什么需要"
  options: string[];                   // 至少 3 个具体候选项；UI 不再硬编码兜底
  inputPlaceholder?: string;
  source: "user" | "agent" | "system";
};

export type InteractionRequirement = {
  type: ...;                           // 不变
  timing: UserInteractionTiming;
  reason: string;
  question?: string;                   // 仍保留：在没有 fields 时使用
  options?: string[];                  // 仍保留：单字段或确认场景
  fields?: MissingFieldQuestion[];     // 新增：多字段权威结构
  suggestedActions?: string[];
  shouldNotifyUser: boolean;
};
```

**原则**：UI 渲染优先级 `fields > options`。`fields` 存在时 UI 不再读取 readiness `structuredOutput`，单点读取 `interactionRequirement.fields`。

### 3.2 静态规则层：补齐 readiness 字段

**文件**：[src/lib/server/taskReadinessPolicy.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts)

为现有三类（出发城市 / 出行日期 / 预算约束）补充 `options/optionQuestion/inputPlaceholder`，并提取通用注册器：

```ts
type ReadinessTemplate = {
  match: RegExp;
  build: (input: TaskReadinessInput, text: string) => TaskReadinessInfoItem;
};

const TEMPLATES: ReadinessTemplate[] = [
  {
    match: /航班|机票|出发城市|出发地/,
    build: (input, text) => ({
      id: "departure_city",
      label: "出发城市",
      description: "Agent 需要知道你从哪个城市出发，才能查询航班和价格。",
      optionQuestion: "你打算从哪个城市出发？",
      options: ["北京", "上海", "广州"],
      inputPlaceholder: "请输入城市名，如 成都",
      source: "user",
      ...
    }),
  },
  // 出行日期、预算约束 同理
];
```

未匹配模板的字段（如 LLM 在运行期识别的新字段）必须在生产端要求 `options.length >= 3`，否则在编译期产出告警并使用 `inputPlaceholder` 引导自由输入。

### 3.3 启动期 Blocker 构造：输出 fields

**文件**：[src/lib/server/taskExecution/preExecutionBlocker.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/preExecutionBlocker.ts)

把 `createPreExecutionInteractionRequirement` 重构为：

```ts
export function createPreExecutionInteractionRequirement(
  readiness: TaskReadinessCheck,
): InteractionRequirement {
  const fields = readiness.missingUserInfo.map(toMissingFieldQuestion);
  const question = fields.length === 1
    ? fields[0].question
    : `请补全本轮所需的 ${fields.length} 项信息`;
  return {
    type: "provide_context",
    timing: "before_execution",
    reason: readiness.summary,
    question,
    fields,                              // 关键：多字段权威来源
    options: fields.length === 1 ? fields[0].options : [],
    suggestedActions: buildSuggestedActions(readiness),
    shouldNotifyUser: true,
  };
}

function toMissingFieldQuestion(item): MissingFieldQuestion {
  return {
    id: item.id,
    label: item.label,
    question: item.optionQuestion?.trim() || `请补充：${item.label}`,
    description: item.description,
    options: pickThreeSpecific(item.options ?? []),  // <3 时记日志
    inputPlaceholder: item.inputPlaceholder,
    source: item.source,
  };
}
```

### 3.4 LLM 协议层：升级到按字段产出

**文件**：[src/lib/server/goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)

将 `interaction_requirement.options` 从一维改为「按字段」结构（保留 `options` 兼容旧数据）：

```jsonc
"interaction_requirement": {
  "type": "provide_context",
  "fields": [
    {
      "id": "departure_city",                          // 与 readiness 对齐
      "label": "出发城市",
      "question": "你打算从哪个城市出发？",
      "description": "查询航班需要明确出发地。",
      "options": ["北京", "上海", "广州"],            // 必须 3 个具体答案
      "inputPlaceholder": "请输入城市，如 成都"
    },
    { "id": "travel_dates", ... },
    { "id": "budget_constraint", ... }
  ],
  "options": []                                         // 旧字段保留为空，避免双源
}
```

Prompt 须明确：
- 「每个 field 必须包含 question/description/options(≥3)，candidate 必须互斥并自带关键参数」
- 「fields 的 id 必须与系统提示中提供的 readiness items 对齐；如有新增字段可自定 id」
- 「禁止把'都不是，我自己描述'放进 options，UI 自动追加」

同时对 LLM 输出做服务端校验：
- 任何 field 缺 options 或 < 3 项 → 用 readiness 模板回退；
- 完全缺失 fields 但有 missingUserInfo → 用 3.3 的静态构造兜底。

新增编译/校验工具：

**文件**：`src/lib/server/informationRequest/compileFields.ts`（新文件，是否真创建在 Decision 中确认）

接口：

```ts
compileInformationRequest(input: {
  llmRequirement?: { fields?, options? };
  readiness: TaskReadinessCheck;
}): InteractionRequirement
```

合并策略：
1. 以 readiness items 为主键集合（保证不漏问）；
2. 对每个 id：先用 LLM field，其次用 readiness 模板，最后回退到 placeholder-only；
3. options 不足时用模板补齐；都没有则只展示 input。

### 3.5 渲染层：以 fields 为唯一数据源

**文件**：[src/components/task/AwaitingUserResumePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx)

重构 `options/optionsForMissingItem` 双源逻辑为单一读取路径：

```ts
const fields = requirement?.fields?.length
  ? requirement.fields
  : deriveLegacyFields(requirement, readiness);     // 兼容旧数据

// 标题 fallback 链：question → description → 请补充${label}
function questionFor(field) {
  return field.question?.trim()
    || field.description?.trim()
    || `请补充：${field.label}`;
}

// 选项渲染：直接用 field.options；UI 始终追加「都不是，我自己描述」
```

去掉「missingItems.length === 1 才用 LLM options」的特殊分支；多字段统一从 fields 取。

### 3.6 完成后可选反馈复用

**文件**：[src/lib/taskResult/optionalFeedback.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/optionalFeedback.ts)

允许 `requirement.fields` 也作为可选反馈来源（场景：完成后让用户标记偏好），保持与启动期一致的 UX。

---

## 四、Assumptions & Decisions

| # | 决策 | 理由 |
|---|---|---|
| 1 | 保留 `InteractionRequirement.options` 字段 | 历史数据（持久化的 instance.result）仍依赖它，强迁移风险大 |
| 2 | 新增 `fields` 而非 `fieldOptions: Record<id, ...>` | 数组保留顺序与位置，UI 渲染稳定 |
| 3 | LLM 协议变更要求向后兼容 | 旧版本 LLM 输出退化时由 `compileInformationRequest` 兜底 |
| 4 | 静态规则集中在 `taskReadinessPolicy` | 单点维护，避免出现散落的字段定义 |
| 5 | UI 不再读取 `structuredOutput.taskReadiness` 中的 `items.options` | 数据契约只走 `interactionRequirement.fields`，单点真实来源 |
| 6 | 新建 `compileFields.ts` 文件 | 合并器逻辑不属于 readiness 也不属于 prompt，独立模块 |
| 7 | 不修改持久化 schema | `interactionRequirement` 是任意 JSON，新增字段天然兼容 |
| 8 | 不引入 i18n | 当前项目仅中文，不超出范围 |

### 范围外（明确不做）

- 不重写交互恢复链路（`resumeBlockedTask` 现有逻辑不动，只增字段读取）
- 不修改 `runtime_jobs` schema
- 不调整 mocks（按需更新最少必要项以通过类型检查）
- 不为 LLM 增加自动重试，仅做服务端兜底

---

## 五、Verification

### 5.1 单元测试

新增/扩展：

| 测试 | 覆盖点 |
|---|---|
| `taskReadinessPolicy.spec.ts` | 三类内置字段都返回 options/question/placeholder |
| `compileFields.spec.ts`（新） | LLM 缺 options → readiness 模板补齐；LLM 缺 field → 用 readiness id 补；都缺 → 自由输入 |
| `preExecutionBlocker.spec.ts` | 多字段场景下 fields 长度正确、id 对齐、options 各自 3 项 |
| `AwaitingUserResumePanel.spec.tsx`（如已有快照） | 三字段场景下每个 question/options 渲染正确，标题用 question，UI 兜底「都不是」存在 |

### 5.2 类型与构建

- `pnpm tsc --noEmit`
- `pnpm lint`
- `pnpm test`（如项目已配 vitest/jest）

### 5.3 手动回归

1. 重启 `pnpm dev`，进入 TPO 任务，触发"等待补充信息"。
2. 验证三个问题各自展示具体 question + 3 个具体 options + 「都不是」兜底。
3. 单字段场景（仅缺出发城市）：仍展示 3 个候选 + 兜底。
4. LLM 运行期产出 awaiting：日志检查 `compileInformationRequest` 路径，UI 表现一致。
5. 历史 instance（v1 数据）打开任务详情：兼容渲染（走 deriveLegacyFields），无破坏。

### 5.4 灰度回退

如线上发现问题，将 `AwaitingUserResumePanel` 的 fields 读取路径以特性开关包裹：`process.env.NEXT_PUBLIC_USE_FIELDS_RENDERING !== "false"` → 默认启用，`"false"` 时回退到旧分支。

---

## 六、Implementation Step Order（执行顺序）

1. **类型层**：扩展 `InteractionRequirement` + 新增 `MissingFieldQuestion`（不破坏旧字段）。
2. **静态规则**：`taskReadinessPolicy` 三类字段补齐 options/question/placeholder。
3. **合并器**：`src/lib/server/informationRequest/compileFields.ts` + 单测。
4. **启动期**：`preExecutionBlocker.createPreExecutionInteractionRequirement` 改为输出 fields。
5. **LLM 协议**：`goalTaskPrompt` 更新输出模板与 instructions；服务端解析时调用 compileFields 兜底。
6. **UI 渲染**：`AwaitingUserResumePanel` 单一数据源化；`optionalFeedback` 同步 fields 支持。
7. **回归与构建**：tsc / lint / test / 手动 5.3。

每步独立可提交，不会破坏现有功能。

