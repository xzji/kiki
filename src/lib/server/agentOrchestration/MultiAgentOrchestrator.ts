import { streamClaudeCli } from "@/lib/server/claudeCli";
import { appendGuardedEvent } from "@/lib/server/agentRuntime/agentExecutor";
import { buildWebAppInteractionContext } from "@/lib/server/taskResult/interactionContext";
import { extractJsonObject } from "@/lib/server/jsonExtraction";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import type {
  AgentHandoff,
  AgentReviewDecision,
  AgentRole,
  AgentRoleRun,
  AgentRunPlan,
} from "@/types/agentOrchestration";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

import { normalizeHandoff } from "./handoff";
import { buildRolePrompt } from "./prompts";
import { normalizeReviewDecision } from "./review";
import { rolesForStrategy, selectAgentCollaborationStrategy, type AgentStrategyInput } from "./strategy";

type AppendTrajectory = (
  step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string },
) => ExecutionTrajectoryStep[];

export type MultiAgentOrchestratorInput = AgentStrategyInput & {
  requestId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
  initialTrajectory?: ExecutionTrajectoryStep[];
  context?: TaskExecutionContext;
  agentRunId?: string;
  signal?: AbortSignal;
  /** 流式进展事件回调，用于上层（ProcessSupervisor）重置空闲超时判定。 */
  onProgressPing?: (kind: string) => void;
  /** Claude CLI spawn 成功后回传 pid，供上层绑定 OS 进程做生命周期管理。 */
  onSpawn?: (pid: number) => void;
  appendTrajectory: AppendTrajectory;
};

export type MultiAgentOrchestratorResult = {
  rawOutput: string;
  agentRunPlan: AgentRunPlan;
};

function nowIso() {
  return new Date().toISOString();
}

function roleTitle(role: AgentRole) {
  const labels: Record<AgentRole, string> = {
    coordinator: "Coordinator 明确任务要求",
    researcher: "Researcher 收集事实依据",
    executor: "Executor 生成候选产物",
    reviewer: "Reviewer 审阅候选产物",
    synthesizer: "Synthesizer 合成最终结果",
  };
  return labels[role];
}

function rolePermission(role: AgentRole, runtimeEnv: RuntimeEnvironment) {
  return role === "executor" ? runtimeEnv.permissionMode : "readonly";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function parseJsonObject(rawOutput: string) {
  try {
    const extracted = extractJsonObject(rawOutput);
    return JSON.parse(extracted) as unknown;
  } catch {
    return null;
  }
}

function appendRoleEvent(input: MultiAgentOrchestratorInput, type: "llm.request" | "llm.response" | "tool_call" | "decision" | "error", payload: Record<string, unknown>) {
  if (!input.agentRunId) return;
  appendGuardedEvent({
    agentRunId: input.agentRunId,
    type,
    payload: {
      requestId: input.requestId,
      goalId: input.goal.id,
      threadId: input.subGoal.id,
      taskId: input.task.id,
      instanceId: input.instance.id,
      phase: "goal_task_multi_agent_orchestration",
      ...payload,
    },
  });
}

function createRoleRun(input: { requestId: string; role: AgentRole; taskTitle: string; attempt?: number }): AgentRoleRun {
  return {
    id: `${input.requestId}-${input.role}${input.attempt && input.attempt > 1 ? `-attempt-${input.attempt}` : ""}`,
    role: input.role,
    title: input.attempt && input.attempt > 1 ? `${roleTitle(input.role)}（第 ${input.attempt} 轮）` : roleTitle(input.role),
    objective: roleTitle(input.role),
    inputSummary: input.taskTitle,
    status: "pending",
  };
}

function completeRoleRun(roleRun: AgentRoleRun, output: Awaited<ReturnType<typeof runRole>>) {
  const parsed = asRecord(output.parsedOutput);
  roleRun.status = "completed";
  roleRun.finishedAt = output.finishedAt;
  roleRun.outputSummary = output.rawOutput.slice(0, 500);
  roleRun.filesTouched = stringArray(parsed?.filesTouched);
}

function failRoleRun(roleRun: AgentRoleRun, error: unknown) {
  roleRun.status = "failed";
  roleRun.finishedAt = nowIso();
  roleRun.error = error instanceof Error ? error.message : String(error);
}

async function runRole(input: MultiAgentOrchestratorInput & {
  role: AgentRole;
  handoffs: AgentHandoff[];
  previousOutputs: Array<{ role: AgentRole; output: string }>;
  review?: AgentReviewDecision;
}) {
  let finalMessage = "";
  const startedAt = nowIso();
  const prompt = buildRolePrompt({
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: input.instance,
    role: input.role,
    handoffs: input.handoffs,
    previousOutputs: input.previousOutputs,
    review: input.review,
    resumeContext: input.resumeContext,
    initialTrajectory: input.initialTrajectory,
    webAppInteractionContext: buildWebAppInteractionContext({ conversationId: input.goal.conversationId }),
    context: input.context,
  });
  const workingDirectory = input.taskWorkspaceDir || input.task.recommendedWorkingDirectory || input.runtimeEnv.workingDirectory;
  input.appendTrajectory({
    type: "system",
    status: "running",
    title: roleTitle(input.role),
    thought: `多角色协同：${input.role} 开始。`,
    agentRole: input.role,
    startedAt,
  });
  appendRoleEvent(input, "llm.request", {
    role: input.role,
    permissionMode: rolePermission(input.role, input.runtimeEnv),
    workingDirectory,
    prompt,
  });
  try {
    await streamClaudeCli({
      message: prompt,
      workingDirectory,
      cliPath: input.runtimeEnv.cliPath,
      permissionMode: rolePermission(input.role, input.runtimeEnv),
      runtimeKind: input.runtimeEnv.runtimeKind,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "task" },
      resumeSessionId: undefined,
      signal: input.signal,
      onSpawn: input.onSpawn,
      onEvent: (event) => {
        input.onProgressPing?.(event.type);
        if (event.type === "message") finalMessage = event.content;
        if (event.type === "tool_call") {
          appendRoleEvent(input, "tool_call", {
            role: input.role,
            toolName: event.toolName,
            input: event.input,
            summary: event.summary,
          });
          input.appendTrajectory({
            type: "tool_call",
            status: "running",
            title: event.summary,
            toolCall: {
              name: event.toolName,
              input: event.input,
              summary: event.summary,
            },
            agentRole: input.role,
          });
        }
        if (event.type === "error") {
          appendRoleEvent(input, "error", {
            role: input.role,
            message: event.message,
          });
          throw new Error(event.message);
        }
      },
    });
  } catch (error) {
    appendRoleEvent(input, "error", {
      role: input.role,
      message: error instanceof Error ? error.message : String(error),
    });
    input.appendTrajectory({
      type: "error",
      status: "failed",
      title: `${roleTitle(input.role)}失败`,
      thought: error instanceof Error ? error.message : String(error),
      agentRole: input.role,
      endedAt: nowIso(),
    });
    throw error;
  }
  if (!finalMessage.trim()) {
    const message = `${input.role} 未返回有效输出。`;
    appendRoleEvent(input, "error", {
      role: input.role,
      message,
    });
    throw new Error(message);
  }
  const parsedOutput = parseJsonObject(finalMessage);
  appendRoleEvent(input, "llm.response", {
    role: input.role,
    rawText: finalMessage,
  });
  appendRoleEvent(input, "decision", {
    role: input.role,
    parsedOutput,
  });
  input.appendTrajectory({
    type: input.role === "synthesizer" ? "result" : "assistant",
    status: "completed",
    title: `${roleTitle(input.role)}完成`,
    thought: finalMessage.slice(0, 2000),
    agentRole: input.role,
    endedAt: nowIso(),
  });
  return {
    rawOutput: finalMessage,
    parsedOutput,
    startedAt,
    finishedAt: nowIso(),
  };
}

export async function runMultiAgentOrchestration(input: MultiAgentOrchestratorInput): Promise<MultiAgentOrchestratorResult> {
  const selectedStrategy = selectAgentCollaborationStrategy(input);
  if (selectedStrategy === "single_agent") {
    throw new Error("多角色编排器收到了 single_agent 策略，请在调用方走单 Agent 执行路径。");
  }
  const agentStrategy = selectedStrategy;
  const roles = rolesForStrategy(agentStrategy);
  const roleRuns: AgentRoleRun[] = roles.map((role) => createRoleRun({ requestId: input.requestId, role, taskTitle: input.task.title }));
  const handoffs: AgentHandoff[] = [];
  const previousOutputs: Array<{ role: AgentRole; output: string }> = [];
  let review: AgentReviewDecision | undefined;
  let finalOutput = "";

  for (const role of roles) {
    const roleRun = roleRuns.find((item) => item.role === role);
    if (roleRun) {
      roleRun.status = "running";
      roleRun.startedAt = nowIso();
    }
    let output: Awaited<ReturnType<typeof runRole>>;
    try {
      output = await runRole({
        ...input,
        role,
        handoffs,
        previousOutputs,
        review,
      });
    } catch (error) {
      if (roleRun) failRoleRun(roleRun, error);
      throw error;
    }
    if (roleRun) {
      completeRoleRun(roleRun, output);
    }
    previousOutputs.push({ role, output: output.rawOutput });
    if (role === "reviewer") {
      review = normalizeReviewDecision(output.parsedOutput, "Reviewer 已完成审阅。");
      if (!review.passed && review.severity === "blocking") {
        const revisionExecutorRun = createRoleRun({ requestId: input.requestId, role: "executor", taskTitle: input.task.title, attempt: 2 });
        revisionExecutorRun.status = "running";
        revisionExecutorRun.startedAt = nowIso();
        roleRuns.push(revisionExecutorRun);
        let revision: Awaited<ReturnType<typeof runRole>>;
        try {
          revision = await runRole({
            ...input,
            role: "executor",
            handoffs,
            previousOutputs,
            review,
          });
        } catch (error) {
          failRoleRun(revisionExecutorRun, error);
          throw error;
        }
        completeRoleRun(revisionExecutorRun, revision);
        previousOutputs.push({ role: "executor", output: revision.rawOutput });
        const revisionReviewerRun = createRoleRun({ requestId: input.requestId, role: "reviewer", taskTitle: input.task.title, attempt: 2 });
        revisionReviewerRun.status = "running";
        revisionReviewerRun.startedAt = nowIso();
        roleRuns.push(revisionReviewerRun);
        let secondReview: Awaited<ReturnType<typeof runRole>>;
        try {
          secondReview = await runRole({
            ...input,
            role: "reviewer",
            handoffs,
            previousOutputs,
            review,
          });
        } catch (error) {
          failRoleRun(revisionReviewerRun, error);
          throw error;
        }
        completeRoleRun(revisionReviewerRun, secondReview);
        previousOutputs.push({ role: "reviewer", output: secondReview.rawOutput });
        review = normalizeReviewDecision(secondReview.parsedOutput, "Reviewer 已完成复查。");
      }
      continue;
    }
    if (role === "synthesizer") {
      finalOutput = output.rawOutput;
      continue;
    }
    const nextRole = roles[roles.indexOf(role) + 1];
    if (nextRole) {
      const handoff = normalizeHandoff({
        fromRole: role,
        toRole: nextRole,
        value: output.parsedOutput,
        rawOutput: output.rawOutput,
      });
      handoffs.push(handoff);
      input.appendTrajectory({
        type: "system",
        status: "completed",
        title: `${role} 已移交给 ${nextRole}`,
        thought: handoff.summary,
        agentRole: role,
        handoff: {
          fromRole: role,
          toRole: nextRole,
          summary: handoff.summary,
        },
        endedAt: nowIso(),
      });
    }
  }

  return {
    rawOutput: finalOutput,
    agentRunPlan: {
      schemaVersion: 1,
      mode: "role_collaboration",
      strategy: agentStrategy,
      roles: roleRuns,
      handoffs,
      review,
      finalRole: "synthesizer",
    },
  };
}
