import { extractJsonObject } from "@/lib/server/jsonExtraction";

export type UserConfirmationOption = {
  label: string;
  hint?: string;
};

export type UserConfirmationMissingItem = {
  id: string;
  label: string;
  description?: string;
  reason?: string;
  inputKind?: "text" | "image" | "file" | "image_or_text";
};

export type UserConfirmationOptionsContext = {
  question: string;
  goalTitle: string;
  goalSummary?: string;
  subGoalTitle: string;
  taskTitle: string;
  taskDescription: string;
  executionObjective?: string;
  expectedOutcome: string;
  expectedResultDescription?: string;
  completionCriteria?: string;
  collaborationSummary?: string;
  missingItems: UserConfirmationMissingItem[];
  resumeContext?: string;
  seedOptions?: string[];
};

export type UserConfirmationOptionItem = {
  id: string;
  label: string;
  question: string;
  options: UserConfirmationOption[];
  inputPlaceholder?: string;
  inputKind?: "text" | "image" | "file" | "image_or_text";
};

export type UserConfirmationOptionsResult = {
  question: string;
  items: UserConfirmationOptionItem[];
};

function contextJson(input: UserConfirmationOptionsContext) {
  return JSON.stringify(input, null, 2);
}

export function buildUserConfirmationOptionsPrompt(input: UserConfirmationOptionsContext) {
  return `# 角色
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
为 missingItems 中的每一项生成候选答案：text / image_or_text 字段优先生成 3 个候选答案；image / file 字段必须生成 0 个候选答案。

候选答案必须满足：
1. 是用户可以直接提交的“答案”，不是动作或说明。
2. 必须紧扣该 missingItem 的 label、description、reason，以及当前任务的 expectedOutcome / completionCriteria。
3. 候选项之间要互斥，覆盖常见分支。
4. 每个候选项要包含区分信息，例如范围、程度、数量、时间、场景、取舍或条件。
5. 每个候选项建议 8-28 个中文字符。
6. text / image_or_text 字段必须优先返回 3 个候选项；只有当前字段本质上需要用户提供精确事实，不能合理枚举候选项时，才允许 options 返回空数组，并给 inputPlaceholder。
7. inputKind 必须沿用 missingItems 中的 inputKind；如果缺失则返回 text。它是 UI 输入形态的权威字段，不能根据文案猜测。
8. inputKind 为 image 或 file 时，options 必须返回空数组，不能生成“上传截图/上传文件”这类动作候选项。

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
      "inputPlaceholder": "没有合适候选项时，提示用户如何手动填写",
      "inputKind": "text|image|file|image_or_text"
    }
  ]
}

# 输出要求
- items 必须覆盖输入中的所有 missingItems，顺序保持一致。
- text / image_or_text 字段优先输出 3 个 options；image / file 字段输出 0 个 options。
- 如果没有合适候选项，options 输出 []，不要硬凑。
- question / inputPlaceholder 要使用用户能看懂的自然语言。

# 上下文 JSON
${contextJson(input)}`;
}

export function buildUserConfirmationOptionsRepairPrompt(input: {
  context: UserConfirmationOptionsContext;
  rawOutput: string;
  errorSummary: string;
}) {
  return `# 角色
你是 KiKi 的“候选项 JSON 修复器”。上一次候选项生成结果不可用，你需要基于同一份上下文重新输出可解析、可展示的 JSON。

# 失败原因
${input.errorSummary}

# 上一次原始输出
${input.rawOutput}

# 修复规则
1. 只输出 JSON，不要输出 Markdown 代码块或解释。
2. 输出必须符合指定 Schema。
3. items 必须覆盖上下文 JSON 中的所有 missingItems，并保持顺序。
4. text / image_or_text 字段优先生成 3 个候选答案；image / file 字段生成 0 个候选答案。
5. 候选答案必须是用户可以直接提交的具体答案。
6. 如果某个字段需要用户提供精确事实，不能合理枚举，则 options 返回 []，并提供 inputPlaceholder。
7. inputKind 必须沿用上下文 missingItems 中的 inputKind；如果缺失则返回 text。
8. inputKind 为 image 或 file 时，options 必须返回空数组，不能生成“上传截图/上传文件”这类动作候选项。
9. 不要使用“主流方案 / 稳妥方案 / 高性价比方案 / 体验优先方案 / 补充信息 / 选项A”等空壳候选项。
10. 不要把同一组选项复制给多个 missingItems。

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
      "inputPlaceholder": "没有合适候选项时，提示用户如何手动填写",
      "inputKind": "text|image|file|image_or_text"
    }
  ]
}

# 上下文 JSON
${contextJson(input.context)}`;
}

function normalizeOption(value: unknown): UserConfirmationOption | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { label?: unknown; hint?: unknown };
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) return null;
  return {
    label: label.slice(0, 48),
    hint: typeof raw.hint === "string" ? raw.hint.trim().slice(0, 80) : "",
  };
}

function normalizeInputKind(value: unknown): UserConfirmationOptionItem["inputKind"] {
  if (value === "image" || value === "file" || value === "image_or_text" || value === "text") return value;
  return "text";
}

function normalizeOptionsForInputKind(value: unknown, inputKind: UserConfirmationOptionItem["inputKind"]) {
  if (inputKind === "image" || inputKind === "file") return [];
  if (!Array.isArray(value)) return [];
  return value.map(normalizeOption).filter((item): item is UserConfirmationOption => Boolean(item)).slice(0, 3);
}

function normalizeOptionItem(value: unknown): UserConfirmationOptionItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    id?: unknown;
    label?: unknown;
    question?: unknown;
    options?: unknown;
    inputPlaceholder?: unknown;
    inputKind?: unknown;
    input_kind?: unknown;
  };
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!id || !label || !Array.isArray(raw.options)) return null;
  const inputKind = normalizeInputKind(raw.inputKind ?? raw.input_kind);
  return {
    id,
    label,
    question: typeof raw.question === "string" ? raw.question.trim() : "",
    options: normalizeOptionsForInputKind(raw.options, inputKind),
    inputPlaceholder: typeof raw.inputPlaceholder === "string" ? raw.inputPlaceholder.trim() : undefined,
    inputKind,
  };
}

export function parseUserConfirmationOptions(raw: string): UserConfirmationOptionsResult {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as {
      question?: unknown;
      items?: unknown;
      options?: unknown;
    };
    if (Array.isArray(parsed.items)) {
      const items = parsed.items.map(normalizeOptionItem).filter((item): item is UserConfirmationOptionItem => Boolean(item));
      if (!items.length) throw new Error("候选项 JSON 缺少有效 items");
      return {
        question: typeof parsed.question === "string" ? parsed.question.trim() : "",
        items,
      };
    }

    if (Array.isArray(parsed.options)) {
      const options = parsed.options.map(normalizeOption).filter((item): item is UserConfirmationOption => Boolean(item)).slice(0, 3);
      return {
        question: typeof parsed.question === "string" ? parsed.question.trim() : "",
        items: [
          {
            id: "default",
            label: "待补充信息",
            question: typeof parsed.question === "string" ? parsed.question.trim() : "",
            options,
            inputKind: "text",
          },
        ],
      };
    }

    throw new Error("候选项 JSON 缺少 items");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "候选项 JSON 解析失败");
  }
}

export function normalizeConfirmationOptionLabels(values: string[], limit = 3) {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = value.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label.slice(0, 48));
    if (labels.length >= limit) break;
  }
  return labels;
}

export function formatOptionLabelsWithHints(result: UserConfirmationOptionsResult | null, itemId?: string) {
  if (!result) return [];
  const item =
    (itemId ? result.items.find((entry) => entry.id === itemId) : undefined) ??
    result.items[0];
  if (!item) return [];
  return normalizeConfirmationOptionLabels(
    item.options.map((option) => {
      if (!option.hint || option.label.includes("（")) return option.label;
      const compactHint = option.hint.replace(/[。；;,.，]/g, "").slice(0, 14);
      return compactHint ? `${option.label}（${compactHint}）` : option.label;
    }),
  );
}
