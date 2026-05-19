import { streamClaudeCli } from "@/lib/server/claudeCli";
import { buildTaskQuoteContent, summarizeTaskResult } from "@/lib/taskFeedback";
import type { TaskFeedbackDecision } from "@/lib/taskFeedback";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export type TaskFeedbackJudgeResult = {
  decision: TaskFeedbackDecision;
  reason: string;
  assistantMessage: string;
  revisionContext?: string;
  clarifyingQuestion?: string;
};

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeJudgeResult(value: unknown, fallbackMessage: string): TaskFeedbackJudgeResult {
  const record = asRecord(value);
  if (!record) {
    return {
      decision: "clarify",
      reason: "反馈判断结果不是合法对象",
      assistantMessage: fallbackMessage,
      clarifyingQuestion: fallbackMessage,
    };
  }
  const rawDecision = nonEmptyString(record.decision);
  const decision: TaskFeedbackDecision =
    rawDecision === "acknowledge" || rawDecision === "clarify" || rawDecision === "rerun"
      ? rawDecision
      : "clarify";
  const reason = nonEmptyString(record.reason) ?? "已根据任务结果和用户反馈完成判断。";
  const assistantMessage =
    nonEmptyString(record.assistant_message) ??
    nonEmptyString(record.assistantMessage) ??
    (decision === "clarify" ? fallbackMessage : "我已收到你对任务结果的反馈。");
  const revisionContext = nonEmptyString(record.revision_context) ?? nonEmptyString(record.revisionContext);
  const clarifyingQuestion = nonEmptyString(record.clarifying_question) ?? nonEmptyString(record.clarifyingQuestion);

  if (decision === "rerun" && !revisionContext) {
    return {
      decision: "clarify",
      reason: "反馈看起来需要调整，但缺少可执行的修订上下文",
      assistantMessage: clarifyingQuestion ?? fallbackMessage,
      clarifyingQuestion: clarifyingQuestion ?? fallbackMessage,
    };
  }
  return {
    decision,
    reason,
    assistantMessage,
    revisionContext,
    clarifyingQuestion,
  };
}

function buildFeedbackJudgePrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  userMessage: string;
}) {
  return `你是 KiKi 的任务结果反馈判断器。你只能判断用户对“被引用任务结果”的反馈下一步应该怎么处理，不要执行任务本身。

请基于任务要求、原结果摘要和用户反馈，判断为三类之一：
- acknowledge：用户只是表示满意、已阅、感谢、普通评价，或表达偏好但没有要求修改当前结果。
- clarify：用户表达不满意或想改，但没有足够具体的修改方向，无法形成可执行修订要求。
- rerun：用户明确指出错误、遗漏、事实不准、格式不对，或要求补充、替换、重写、重新生成当前结果。

禁止仅靠关键词判断，必须结合语义。只能输出严格 JSON，不要 Markdown，不要解释。

JSON schema:
{
  "decision": "acknowledge" | "clarify" | "rerun",
  "reason": "判断理由",
  "assistant_message": "给用户的对话流回应",
  "revision_context": "仅 rerun 时填写：给任务执行 Agent 的具体修订要求",
  "clarifying_question": "仅 clarify 时填写：追问用户需要明确的信息"
}

目标：${input.goal.title}
子目标：${input.subGoal.title}
任务标题：${input.task.title}
任务描述：${input.task.description}
任务预期结果：${input.task.expectedOutcome}
完成标准：${input.task.expectedResult?.completionCriteria ?? "无"}

原结果引用摘要：
${buildTaskQuoteContent(input.task, input.instance)}

原结果结构摘要：
${summarizeTaskResult(input.instance.result?.taskResult) || "无结构化结果摘要"}

用户反馈：
${input.userMessage}`;
}

export async function judgeTaskFeedback(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  userMessage: string;
  runtimeEnv: RuntimeEnvironment;
  workingDirectory: string;
}) {
  let finalMessage = "";
  let errorMessage = "";
  await streamClaudeCli({
    message: buildFeedbackJudgePrompt(input),
    workingDirectory: input.workingDirectory,
    cliPath: input.runtimeEnv.cliPath,
    permissionMode: "readonly",
    workspacePolicy: "conversation",
    onEvent: (event) => {
      if (event.type === "message") finalMessage = event.content;
      if (event.type === "error") errorMessage = event.message;
    },
  });
  if (errorMessage) {
    return {
      decision: "clarify" as const,
      reason: errorMessage,
      assistantMessage: "我暂时没能判断你希望我怎么修改这个结果。你可以具体说明要改哪里、补什么或按什么标准重做。",
      clarifyingQuestion: "你希望我具体修改这份任务结果的哪一部分？",
    };
  }
  const json = extractJsonObject(finalMessage);
  if (!json) {
    return normalizeJudgeResult(null, "我没能判断你是否希望重做。请明确说明要修改哪里、补充什么，或确认只是记录反馈。");
  }
  try {
    return normalizeJudgeResult(
      JSON.parse(json) as unknown,
      "我没能判断你是否希望重做。请明确说明要修改哪里、补充什么，或确认只是记录反馈。",
    );
  } catch {
    return normalizeJudgeResult(null, "我没能解析反馈判断结果。请再明确一下你希望修改哪里。");
  }
}
