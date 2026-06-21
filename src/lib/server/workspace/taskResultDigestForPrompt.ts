import { extractDependencyDigest } from "@/lib/server/taskExecution/dependencyDigest";
import { DEFAULT_TASK_EXECUTION_CONTEXT_BUDGET } from "@/lib/server/taskExecution/types";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { PromptSafeTaskResultDigest } from "@/lib/server/workspace/contextPack";

const DIGEST_RELEVANT_STATUS = new Set([
  "completed",
  "error",
  "awaiting_user",
  "paused",
]);

function pickDigestInstance(task: Task): TaskInstance | undefined {
  const candidates = task.instances.filter((instance) => DIGEST_RELEVANT_STATUS.has(instance.status));
  if (candidates.length === 0) return undefined;
  const completed = candidates.filter((instance) => instance.status === "completed");
  const pool = completed.length > 0 ? completed : candidates;
  return [...pool].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
}

/**
 * 把某个 goal 下最近的任务结果蒸馏成 Class A 安全投影（无结果正文落盘字段，
 * 仅 summary/关键结论/产物名）。供会话 prompt 注入，让会话 Agent 看见任务结果。
 * 内部 ID 由 buildConversationContextPack 的最终脱敏统一处理。
 */
export function pickTaskResultDigestsForPrompt(input: {
  conversationId: string;
  goal: Goal;
  maxTasks?: number;
}): PromptSafeTaskResultDigest[] {
  const maxTasks = input.maxTasks ?? 6;
  const rows: Array<{ digest: PromptSafeTaskResultDigest; createdAt: string }> = [];

  for (const subGoal of input.goal.subGoals) {
    for (const task of subGoal.tasks) {
      const instance = pickDigestInstance(task);
      if (!instance) continue;
      const digest = extractDependencyDigest({
        conversationId: input.conversationId,
        task,
        instance,
        budget: DEFAULT_TASK_EXECUTION_CONTEXT_BUDGET,
      });
      rows.push({
        createdAt: instance.createdAt,
        digest: {
          taskTitle: task.title.replace(/^任务\d+：/, ""),
          status: instance.status,
          dateLabel: instance.dateLabel,
          summary: digest.summary,
          keyPoints: digest.keyPoints,
          artifacts: digest.artifacts.map((artifact) => artifact.label).filter(Boolean),
          blocker: digest.userDecision,
        },
      });
    }
  }

  return rows
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, maxTasks)
    .map((row) => row.digest);
}
