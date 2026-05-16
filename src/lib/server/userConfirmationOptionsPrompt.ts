import { extractJsonObject } from "@/lib/server/jsonExtraction";

export type UserConfirmationOption = {
  label: string;
  hint?: string;
};

export type UserConfirmationOptionsResult = {
  question: string;
  options: UserConfirmationOption[];
};

const SELF_DESCRIBE_LABEL = "都不是，我自己描述";

const GENERIC_OPTION_PATTERNS = [
  /补充.*信息/,
  /补充.*偏好/,
  /补充.*约束/,
  /提供.*信息/,
  /提供.*偏好/,
  /说明暂时无法提供/,
  /填写其他信息/,
  /确认继续/,
  /提交我的答案/,
  /需要重新出题/,
  /先看提示/,
  /补充更多信息/,
  /需要更多信息/,
  /需要更多时间/,
];

export function buildUserConfirmationOptionsPrompt(input: {
  question: string;
  context: string;
  optionCount?: 3 | 4;
}) {
  const optionCount = input.optionCount ?? 3;
  return `# 角色
你是一个擅长将开放式问题转化为可点选答案的助手。

# 任务
针对下方【待确认问题】，生成 ${optionCount} 个候选答案，让用户一键即可回复。

# 候选项生成规则（强约束）
1. 【是答案，不是动作】每个候选项必须是该问题的一个具体答案，而不是"补充更多信息""提供偏好"这类元操作描述。
   - 错误示例："补充具体信息" / "补充约束或偏好" / "说明暂时无法提供"
   - 正确示例：针对"选哪种越南签证？" → "电子签 e-Visa（90天，约¥200）" / "落地签（需邀请函）" / "贴纸签（使馆办理）"
2. 【覆盖主流分支】候选项之间应互斥，并尽量覆盖该问题最常见的 2-3 个主流答案。
3. 【自带关键参数】每个候选项要带上区分性的关键信息（时长 / 价格 / 适用场景 / 条件），让用户不点开也能判断。
   - 错误示例："电子签"
   - 正确示例："电子签 e-Visa（90天，约¥200）"
4. 【口语化、短】每个候选项控制在 8-25 字，用用户视角的措辞，不要用"方案 A""选项一"这种空壳标签。
5. 【保留兜底】最后固定追加一个"${SELF_DESCRIBE_LABEL}"，但前面的候选项绝对不能是这种通用兜底。

# 输出格式
严格输出 JSON：
{
  "question": "<对用户问题的一句话复述>",
  "options": [
    {"label": "<候选答案1>", "hint": "<可选：一句话补充>"},
    {"label": "<候选答案2>", "hint": "..."},
    {"label": "<候选答案3>", "hint": "..."},
    {"label": "${SELF_DESCRIBE_LABEL}", "hint": ""}
  ]
}

# 待确认问题
${input.question}

# 上下文（用于让候选项更贴合）
${input.context}

# 提交前自检（必做）
逐条检查 options[0..n-2]：
- 是否是【该问题的具体答案】？若仍是"补充 XX""提供 XX"等元操作描述，必须重写。
- 是否带了【可区分的关键参数】？若只是空壳名词，必须补充。
- 候选项之间是否互斥、能覆盖主流情况？若雷同，必须替换。
任一不通过 → 重新生成，直到全部通过再输出。`;
}

export function parseUserConfirmationOptions(raw: string): UserConfirmationOptionsResult | null {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as {
      question?: unknown;
      options?: Array<{ label?: unknown; hint?: unknown }>;
    };
    if (!Array.isArray(parsed.options)) return null;
    const options = parsed.options
      .map((item) => ({
        label: typeof item.label === "string" ? item.label.trim() : "",
        hint: typeof item.hint === "string" ? item.hint.trim() : "",
      }))
      .filter((item) => item.label);
    if (!options.length) return null;
    return {
      question: typeof parsed.question === "string" && parsed.question.trim() ? parsed.question.trim() : "",
      options,
    };
  } catch {
    return null;
  }
}

export function isGenericConfirmationOption(label: string) {
  const normalized = label.trim();
  if (!normalized) return true;
  if (normalized === SELF_DESCRIBE_LABEL || /都不是.*自己/.test(normalized)) return true;
  return GENERIC_OPTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeConfirmationOptionLabels(values: string[], limit = 3) {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = value.trim();
    if (!label || seen.has(label) || isGenericConfirmationOption(label)) continue;
    seen.add(label);
    labels.push(label.slice(0, 32));
    if (labels.length >= limit) break;
  }
  return labels;
}

export function formatOptionLabelsWithHints(result: UserConfirmationOptionsResult | null) {
  if (!result) return [];
  return normalizeConfirmationOptionLabels(
    result.options.map((option) => {
      if (!option.hint || option.label.includes("（")) return option.label;
      const compactHint = option.hint.replace(/[。；;,.，]/g, "").slice(0, 14);
      return compactHint ? `${option.label}（${compactHint}）` : option.label;
    }),
  );
}
