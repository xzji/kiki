import { streamClaudeCli } from "@/lib/server/claudeCli";
import { appendGuardedEvent } from "@/lib/server/agentRuntime/agentExecutor";
import { buildWebAppInteractionContext } from "@/lib/server/taskResult/interactionContext";
import { extractJsonObject } from "@/lib/server/jsonExtraction";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import { updateGoalRuntimeJobExecution } from "@/lib/server/services/goalRuntimeService";
import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";
import type {
  AgentHandoff,
  AgentUserDecisionRequest,
  AgentReviewDecision,
  AgentRole,
  AgentRoleRun,
  AgentRunPlan,
} from "@/types/agentOrchestration";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

import { assembleFinalTaskResult, extractCandidateBlocks, normalizeAssemblyPlan } from "./assemble";
import { normalizeHandoff } from "./handoff";
import { buildRolePrompt } from "./prompts";
import { normalizeReviewDecision } from "./review";
import { sanitizeDeliverableMetaNarration } from "./sanitize";
import { rolesForStrategy, selectAgentCollaborationStrategy, type AgentStrategyInput } from "./strategy";

type AppendTrajectory = (
  step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string },
) => ExecutionTrajectoryStep[];

function createRoleToolPermissionBlocker(input: MultiAgentOrchestratorInput, request: {
  requestId: string;
  runtimeEnvId: string;
  toolName: string;
  suggestedRule: string;
}): ExecutionBlocker {
  const now = new Date().toISOString();
  return {
    kind: "tool_permission",
    executionId: input.requestId,
    taskId: input.task.id,
    instanceId: input.instance.id,
    blockedStepIndex: Math.max((input.initialTrajectory?.length ?? 1) - 1, 0),
    resumeToken: request.requestId,
    interactionRequirement: {
      type: "confirm",
      timing: "during_execution",
      reason: `Claude 请求使用工具 ${request.toolName}，需要用户授权后继续执行。`,
      question: `是否允许工具 ${request.toolName} 运行？`,
      suggestedActions: ["本次允许", "本会话内始终允许", "始终允许并写入 Runtime 策略", "拒绝"],
      shouldNotifyUser: true,
    },
    resumeStrategy: "rerun_with_feedback",
    status: "waiting",
    createdAt: now,
    toolPermission: {
      requestId: request.requestId,
      runtimeEnvId: request.runtimeEnvId,
      toolName: request.toolName,
      suggestedRule: request.suggestedRule,
    },
  };
}

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
  writtenFiles?: string[];
  userDecisionRequest?: AgentUserDecisionRequest;
  unresolvedBlockingReview?: AgentReviewDecision;
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

function roleNeedsWriteAccess(role: AgentRole, task: Task) {
  if (role !== "executor" && role !== "synthesizer") return false;
  const expectedSurfaces = resolveExpectedSurfaces(task.expectedResult);
  return (
    expectedSurfaces.includes("files") ||
    task.expectedResult?.fileSurface?.required === true ||
    task.expectedResult?.interactiveSurface?.kind === "webapp"
  );
}

function rolePermission(role: AgentRole, task: Task, runtimeEnv: RuntimeEnvironment) {
  if (!roleNeedsWriteAccess(role, task)) return "readonly";
  return runtimeEnv.permissionMode;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function readWritablePath(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  for (const key of ["file_path", "path", "target_file", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = asRecord(record.input);
  if (nested) {
    for (const key of ["file_path", "path", "target_file", "file"]) {
      const value = nested[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function isWriteTool(toolName: string) {
  return /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName);
}

function uniqueOrdered(items: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function buildTaskResultFromCandidate(input: MultiAgentOrchestratorInput, candidateBlocks: ResultBlock[], planSource: unknown): TaskResult {
  const expectedSurfaces = resolveExpectedSurfaces(input.task.expectedResult);
  const presentation = input.task.expectedResult?.presentation;
  const primaryFormat = input.task.expectedResult?.primaryFormat;
  return sanitizeDeliverableMetaNarration(assembleFinalTaskResult({
    base: {
      schemaVersion: 1,
      taskId: input.task.id,
      instanceId: input.instance.id,
      title: input.task.expectedOutcome || input.task.title,
      status: "done",
      blocks: candidateBlocks,
      meta: {
        producedAt: new Date().toISOString(),
        surfaces: expectedSurfaces,
        interactiveSurfaceKind: expectedSurfaces.includes("interactive")
          ? input.task.expectedResult?.interactiveSurface?.kind ?? "blocks"
          : undefined,
        fileSurfaceRequired: expectedSurfaces.includes("files"),
        presentation,
        primaryFormat,
        exportableFormats: input.task.expectedResult?.exportableFormats,
      },
    },
    candidateBlocks,
    plan: normalizeAssemblyPlan(planSource),
  }));
}

function buildFinalJsonFromCandidate(input: MultiAgentOrchestratorInput, options: {
  taskResult: TaskResult;
  writtenFiles: string[];
  review?: AgentReviewDecision;
  unresolvedBlockingReview?: AgentReviewDecision;
}) {
  const missingDeliverables = options.unresolvedBlockingReview
    ? options.unresolvedBlockingReview.issues.map((issue) => issue.message)
    : [];
  return JSON.stringify({
    summary: options.unresolvedBlockingReview ? "候选产物仍有未解决的审阅问题。" : "已完成最终结果装配。",
    final_message: options.unresolvedBlockingReview
      ? options.unresolvedBlockingReview.decisionReason
      : "已根据候选产物和审阅意见完成最终结果装配。",
    result_view_kind: input.task.resultViewKind ?? input.task.executionKind,
    awaiting_user: false,
    awaiting_reason: "",
    interaction_requirement: {
      type: "none",
      timing: "not_required",
      reason: "",
      question: "",
      options: [],
      fields: [],
      suggested_actions: [],
      should_notify_user: false,
    },
    suggested_actions: [],
    artifacts: [],
    task_result: options.taskResult,
    deliverable_check: {
      matched: !options.unresolvedBlockingReview,
      confidence: options.unresolvedBlockingReview ? "low" : "medium",
      delivered_artifacts: ["task_result.blocks"],
      missing_deliverables: missingDeliverables,
      criteria_results: [
        {
          criterion: input.task.expectedResult?.completionCriteria || input.task.expectedOutcome,
          status: options.unresolvedBlockingReview ? "unknown" : "passed",
          evidence: options.unresolvedBlockingReview?.decisionReason || "已由候选产物确定性装配。",
        },
      ],
      gap_reason: options.unresolvedBlockingReview?.decisionReason || "",
    },
    structured_output: {
      writtenFiles: options.writtenFiles,
      ...(options.review ? { qualityReview: options.review } : {}),
      ...(options.unresolvedBlockingReview ? { unresolvedBlockingReview: options.unresolvedBlockingReview } : {}),
    },
  });
}

function buildAwaitingJsonFromUserDecision(input: MultiAgentOrchestratorInput, decision: AgentUserDecisionRequest) {
  return JSON.stringify({
    summary: "执行中发现需要用户确认的关键分叉。",
    final_message: decision.partialSummary || decision.reason,
    result_view_kind: input.task.resultViewKind ?? input.task.executionKind,
    awaiting_user: true,
    awaiting_reason: decision.reason,
    interaction_requirement: {
      type: "confirm",
      timing: "during_execution",
      reason: decision.reason,
      question: decision.question,
      options: decision.options,
      fields: [],
      suggested_actions: [],
      should_notify_user: true,
    },
    suggested_actions: [],
    artifacts: [],
    task_result: {
      schemaVersion: 1,
      taskId: input.task.id,
      instanceId: input.instance.id,
      title: "需要你确认后继续",
      status: "pending_user",
      blocks: [
        { kind: "callout", tone: "warn", text: decision.reason },
        { kind: "paragraph", text: decision.question },
      ],
      meta: {
        producedAt: new Date().toISOString(),
        role: "pending_user_placeholder",
      },
    },
    deliverable_check: {
      matched: false,
      confidence: "high",
      delivered_artifacts: decision.partialSummary ? ["已完成候选稿摘要"] : [],
      missing_deliverables: [decision.question],
      criteria_results: [
        {
          criterion: input.task.expectedResult?.completionCriteria || input.task.expectedOutcome,
          status: "unknown",
          evidence: decision.reason,
        },
      ],
      gap_reason: decision.reason,
    },
    structured_output: {
      userDecisionRequest: decision,
    },
  });
}

function parseJsonObject(rawOutput: string) {
  try {
    const extracted = extractJsonObject(rawOutput);
    return JSON.parse(extracted) as unknown;
  } catch {
    return null;
  }
}

function appendRoleEvent(input: MultiAgentOrchestratorInput, type: "llm.request" | "llm.response" | "tool_call" | "decision" | "error" | "awaiting_user" | "log", payload: Record<string, unknown>) {
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
  roleRun.rawOutput = output.rawOutput;
  roleRun.parsedOutput = asRecord(output.parsedOutput) ?? undefined;
  roleRun.filesTouched = uniqueOrdered([...stringArray(parsed?.filesTouched), ...output.writtenFiles]);
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
  const writtenFiles: string[] = [];
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
    permissionMode: rolePermission(input.role, input.task, input.runtimeEnv),
    workingDirectory,
    prompt,
  });
  try {
    await streamClaudeCli({
      message: prompt,
      workingDirectory,
      cliPath: input.runtimeEnv.cliPath,
      permissionMode: rolePermission(input.role, input.task, input.runtimeEnv),
      runtimeKind: input.runtimeEnv.runtimeKind,
      runtimeEnvId: input.runtimeEnv.id,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "task" },
      conversationId: input.goal.conversationId,
      taskInstanceId: input.instance.id,
      taskId: input.task.id,
      agentRunId: input.agentRunId,
      resumeSessionId: undefined,
      signal: input.signal,
      onSpawn: input.onSpawn,
      onEvent: (event) => {
        input.onProgressPing?.(event.type);
        if (event.type === "message") finalMessage = event.content;
        if (event.type === "tool_call") {
          if (isWriteTool(event.toolName)) {
            const filePath = readWritablePath(event.input);
            if (filePath) writtenFiles.push(filePath);
          }
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
        if (event.type === "tool_permission_request") {
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "awaiting_user",
            blocker: createRoleToolPermissionBlocker(input, event),
          });
          appendRoleEvent(input, "awaiting_user", {
            role: input.role,
            kind: "tool_permission.requested",
            requestId: event.requestId,
            runtimeEnvId: event.runtimeEnvId,
            toolName: event.toolName,
            suggestedRule: event.suggestedRule,
          });
          input.appendTrajectory({
            type: "system",
            status: "running",
            title: `等待工具授权：${event.toolName}`,
            thought: `多角色 ${input.role} 需要用户授权工具规则 ${event.suggestedRule}。`,
            agentRole: input.role,
          });
        }
        if (event.type === "tool_permission_resolved") {
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "running",
            blocker: null,
          });
          appendRoleEvent(input, "log", {
            role: input.role,
            kind: "tool_permission.resolved",
            requestId: event.requestId,
            decision: event.decision,
            scope: event.scope,
            rule: event.rule,
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
    writtenFiles: uniqueOrdered(writtenFiles),
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
  let unresolvedBlockingReview: AgentReviewDecision | undefined;
  let candidateBlocks: ResultBlock[] = [];
  let finalOutput = "";
  const writtenFiles: string[] = [];

  const buildAgentRunPlan = (finalRole: AgentRole): AgentRunPlan => ({
    schemaVersion: 1,
    mode: "role_collaboration",
    strategy: agentStrategy,
    roles: roleRuns,
    handoffs,
    review,
    finalRole,
    writtenFiles: uniqueOrdered(writtenFiles),
  });

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
    writtenFiles.push(...output.writtenFiles);
    if (role === "executor") {
      const nextCandidateBlocks = extractCandidateBlocks(output.parsedOutput);
      if (nextCandidateBlocks.length > 0) {
        candidateBlocks = nextCandidateBlocks;
      }
    }
    previousOutputs.push({ role, output: output.rawOutput });
    if (role === "reviewer") {
      review = normalizeReviewDecision(output.parsedOutput, "Reviewer 已完成审阅。");
      if (review.needsUserDecision) {
        const rawOutput = buildAwaitingJsonFromUserDecision(input, review.needsUserDecision);
        return {
          rawOutput,
          agentRunPlan: buildAgentRunPlan("reviewer"),
          userDecisionRequest: review.needsUserDecision,
          writtenFiles: uniqueOrdered(writtenFiles),
        };
      }
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
        writtenFiles.push(...revision.writtenFiles);
        // 修订轮 executor 不会新建 handoff，但其写盘事实必须并入 executor→reviewer handoff，
        // 否则 Presenter 的「已落盘事实」会遗漏修订轮写入的文件。
        if (revision.writtenFiles.length > 0) {
          const executorHandoff = [...handoffs].reverse().find((handoff) => handoff.fromRole === "executor");
          if (executorHandoff) {
            executorHandoff.filesTouched = uniqueOrdered([
              ...(executorHandoff.filesTouched ?? []),
              ...revision.writtenFiles,
            ]);
          }
        }
        {
          const revisedCandidateBlocks = extractCandidateBlocks(revision.parsedOutput);
          if (revisedCandidateBlocks.length > 0) {
            candidateBlocks = revisedCandidateBlocks;
          }
        }
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
        writtenFiles.push(...secondReview.writtenFiles);
        previousOutputs.push({ role: "reviewer", output: secondReview.rawOutput });
        review = normalizeReviewDecision(secondReview.parsedOutput, "Reviewer 已完成复查。");
        if (review.needsUserDecision) {
          const rawOutput = buildAwaitingJsonFromUserDecision(input, review.needsUserDecision);
          return {
            rawOutput,
            agentRunPlan: buildAgentRunPlan("reviewer"),
            userDecisionRequest: review.needsUserDecision,
            writtenFiles: uniqueOrdered(writtenFiles),
          };
        }
        if (!review.passed && review.severity === "blocking") {
          unresolvedBlockingReview = review;
        }
      }
      continue;
    }
    if (role === "synthesizer") {
      finalOutput = candidateBlocks.length > 0
        ? buildFinalJsonFromCandidate(input, {
            taskResult: buildTaskResultFromCandidate(input, candidateBlocks, output.parsedOutput),
            writtenFiles: uniqueOrdered(writtenFiles),
            review,
            unresolvedBlockingReview,
          })
        : output.rawOutput;
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
      handoff.filesTouched = uniqueOrdered([...(handoff.filesTouched ?? []), ...output.writtenFiles]);
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
    agentRunPlan: buildAgentRunPlan("synthesizer"),
    writtenFiles: uniqueOrdered(writtenFiles),
    unresolvedBlockingReview,
  };
}
