import type { TaskPriority } from "@/types/kiki";
import type { TaskDraft } from "./taskDraftSchema";

export type DecompositionSubGoalContext = {
  id: number;
  name: string;
  description: string;
  criteria: string[];
  priority?: TaskPriority;
};

export type TaskDraftReviewPayload = {
  reviewResults: Array<{
    taskId: string;
    goalContribution: TaskPriority;
    subGoalContribution: TaskPriority;
    aligned: boolean;
    reasoning: string;
    suggestions?: string[];
  }>;
};

export function buildTaskDraftReviewPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
}) {
  return `请 Review 以下 TaskDraft 是否与目标和子目标对齐。

目标：${input.goalTitle}
子目标：${input.subGoalTitle}
目标描述：${input.goalDescription}

TaskDraft：
${JSON.stringify(input.drafts.map((draft, index) => ({ index: draft.index ?? index + 1, ...draft })), null, 2)}

要求：
1. 只能输出严格 JSON 对象，不要包含 Markdown、代码块或额外解释。
2. reviewResults 必须覆盖每个 TaskDraft，taskId 使用 TaskDraft 的 index 字符串。
3. goalContribution/subGoalContribution 只能是 critical/high/medium/low。

JSON schema：
{
  "reviewResults": [
    {
      "taskId": "1",
      "goalContribution": "high",
      "subGoalContribution": "high",
      "aligned": true,
      "reasoning": "评估理由",
      "suggestions": ["建议"]
    }
  ]
}`;
}

export function applyDraftReview(drafts: TaskDraft[], review: TaskDraftReviewPayload) {
  const reviewMap = new Map(review.reviewResults.map((item) => [item.taskId, item]));
  const retained = drafts.filter((draft, index) => {
    const item = reviewMap.get(String(draft.index ?? index + 1));
    return !(item && !item.aligned && item.goalContribution === "low" && item.subGoalContribution === "low");
  });
  return retained.length > 0 ? retained : drafts.slice(0, 1);
}
