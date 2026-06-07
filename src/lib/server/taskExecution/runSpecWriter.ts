import { executeAgentRun, type LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import {
  buildTaskSpecPrompt,
  type SpecWriterGoalContext,
  type SpecWriterTaskInput,
} from "@/lib/server/taskExecution/taskSpecPrompt";

export type RunSpecWriterInput = {
  tasks: SpecWriterTaskInput[];
  goalContext: SpecWriterGoalContext;
  attribution: {
    topicId: string;
    sagaInstanceId?: string;
    threadId?: string;
    taskId?: string;
  };
  invoke: LlmInvoke;
};

export type RunSpecWriterResult = {
  specs: Array<{ taskId: string; content: string }>;
  degraded: boolean;
};

function parseSpecs(value: unknown, allowedIds: Set<string>) {
  if (!value || typeof value !== "object") return [];
  const specs = (value as { specs?: unknown }).specs;
  if (!Array.isArray(specs)) return [];
  const seen = new Set<string>();
  return specs.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { taskId?: unknown; content?: unknown };
    if (typeof record.taskId !== "string" || !allowedIds.has(record.taskId)) return [];
    if (seen.has(record.taskId)) return [];
    if (typeof record.content !== "string" || !record.content.trim()) return [];
    seen.add(record.taskId);
    return [{ taskId: record.taskId, content: record.content.trim() }];
  });
}

export async function runSpecWriter(input: RunSpecWriterInput): Promise<RunSpecWriterResult> {
  if (input.tasks.length === 0) return { specs: [], degraded: false };

  const allowedIds = new Set(input.tasks.map((task) => task.taskId));
  const run = createAgentRun({
    role: "spec_writer",
    topicId: input.attribution.topicId,
    sagaInstanceId: input.attribution.sagaInstanceId,
    threadId: input.attribution.threadId,
    taskId: input.attribution.taskId,
  });

  try {
    const result = await executeAgentRun({
      agentRunId: run.id,
      prompt: buildTaskSpecPrompt(input.tasks, input.goalContext),
      context: { role: "spec_writer", ...input.attribution },
      invoke: input.invoke,
    });
    const specs = parseSpecs(result.parsed, allowedIds);
    return { specs, degraded: specs.length !== input.tasks.length };
  } catch {
    return { specs: [], degraded: true };
  }
}
