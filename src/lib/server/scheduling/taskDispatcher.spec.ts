import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { upsertRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runWithUserContext } from "@/lib/server/context/userContext";
import {
  getRuntimeJob,
  cancelRuntimeJobByTaskRun,
  upsertRuntimeJob,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  cancelActiveTunnelDispatch,
  dispatchReadyTasksToMachines,
  registerTunnelDispatchCallbacks,
} from "@/lib/server/scheduling/taskDispatcher";
import {
  getPendingToolPermissionRequest,
  getToolPermissionRequestState,
} from "@/lib/server/toolPermission/toolPermissionBroker";
import {
  registerMachineWsConnection,
  submitMachineResult,
  unregisterMachineWsConnection,
  type MachineCommand,
} from "@/lib/server/tunnel/tunnelHub";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import { DEFAULT_RUNTIME_FILE_POLICY, type RuntimeEnvironment } from "@/types/runtime";

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-task-dispatcher-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function payloadParts() {
  const instance: TaskInstance = {
    id: "inst-task-dispatcher-spec",
    taskId: "task-task-dispatcher-spec",
    dateLabel: "2026-06-12",
    status: "pending",
    intro: "测试任务",
    payload: { kind: "generic_result", summary: "" },
    createdAt: "2026-06-12T00:00:00.000Z",
  };
  const task: Task = {
    id: "task-task-dispatcher-spec",
    subGoalId: "sub-task-dispatcher-spec",
    title: "测试调度下发",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即触发",
    progress: 0,
    instances: [instance],
    executionKind: "generic_result",
  };
  const subGoal: SubGoal = {
    id: "sub-task-dispatcher-spec",
    goalId: "goal-task-dispatcher-spec",
    title: "子目标",
    tasks: [task],
  };
  const goal: Goal = {
    id: "goal-task-dispatcher-spec",
    title: "调度测试目标",
    conversationId: "conv-task-dispatcher-spec",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
    subGoals: [subGoal],
  };
  return { goal, subGoal, task, instance };
}

function seedQueuedCloudJob(id: string) {
  const now = new Date().toISOString();
  const { goal, subGoal, task, instance } = payloadParts();
  const job: RuntimeJobRecord = {
    id,
    taskInstanceId: instance.id,
    taskId: task.id,
    goalId: goal.id,
    conversationId: goal.conversationId,
    userId: "spec-test-user",
    kind: "goal_task",
    status: "queued",
    requestId: `req-${id}`,
    runtimeEnvId: runtimeEnv().id,
    runtimeTransport: "cloud_control_plane",
    payload: {
      goal,
      subGoal,
      task,
      instance,
      runtimeEnv: runtimeEnv(),
    },
    progress: null,
    logs: [],
    trajectory: [],
    blocker: null,
    result: null,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  upsertRuntimeJob(job);
  return job;
}

export async function runTaskDispatcherSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const job = seedQueuedCloudJob("job-task-dispatcher-no-machine");
  const result = await runWithUserContext("spec-test-user", () =>
    dispatchReadyTasksToMachines({
      leaseOwner: "cloud-orchestrator-spec",
      limit: 1,
    }),
  );

  assert.equal(result.processed, 0);
  assert.equal(result.skippedOffline, true);
  assert.equal(getRuntimeJob(job.id)?.status, "queued", "machine 离线时不应 claim queued job");
  upsertRuntimeJob({ ...job, status: "cancelled", updatedAt: new Date().toISOString() });

  registerTunnelDispatchCallbacks();
  const machineId = `machine-task-dispatcher-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sent: MachineCommand[] = [];
  const sender = (command: MachineCommand) => {
    sent.push(command);
    return true;
  };
  registerMachineWsConnection({ machineId, userId: "spec-test-user", sender });
  try {
    const awaitingJob = seedQueuedCloudJob("job-task-dispatcher-awaiting-tool-permission");
    const dispatchResult = await runWithUserContext("spec-test-user", () =>
      dispatchReadyTasksToMachines({
        leaseOwner: "cloud-orchestrator-spec",
        limit: 1,
      }),
    );
    assert.equal(dispatchResult.processed, 1);
    assert.equal(sent.at(-1)?.type, "execute");

    const requestId = "tool-permission-task-dispatcher-spec";
    const blocker: ExecutionBlocker = {
      kind: "tool_permission",
      executionId: awaitingJob.id,
      taskId: awaitingJob.payload.task.id,
      instanceId: awaitingJob.payload.instance.id,
      blockedStepIndex: 0,
      resumeToken: requestId,
      interactionRequirement: {
        type: "confirm",
        timing: "during_execution",
        reason: "需要授权工具 mcp__tavily__tavily_search",
        fields: [],
        shouldNotifyUser: true,
      },
      resumeStrategy: "rerun_with_feedback",
      status: "waiting",
      createdAt: new Date().toISOString(),
      toolPermission: {
        requestId,
        runtimeEnvId: runtimeEnv().id,
        toolName: "mcp__tavily__tavily_search",
        suggestedRule: "mcp__tavily__*",
      },
    };

    submitMachineResult({
      type: "execute_progress",
      jobId: awaitingJob.id,
      progress: {
        requestId: awaitingJob.requestId ?? `goal-task-${awaitingJob.id}`,
        scope: "goal_task_execute",
        status: "running",
        phase: "reviewing",
        message: "等待工具授权",
        startedAt: awaitingJob.startedAt ?? awaitingJob.createdAt,
        updatedAt: new Date().toISOString(),
        resultPayload: {
          runtimeJobStatus: "awaiting_user",
          blocker,
        },
      },
    });
    assert.equal(getPendingToolPermissionRequest(requestId)?.id, requestId);

    submitMachineResult({
      type: "execute",
      jobId: awaitingJob.id,
      ok: true,
      status: "awaiting_user",
      blocker,
      result: {
        runtimeJobStatus: "awaiting_user",
        blocker,
      },
    });

    assert.equal(getRuntimeJob(awaitingJob.id)?.status, "awaiting_user");
    assert.equal(getPendingToolPermissionRequest(requestId)?.id, requestId);
    assert.equal(getToolPermissionRequestState(requestId), "detached");

    const cancellableJob = seedQueuedCloudJob("job-task-dispatcher-cancel-active");
    const cancellableDispatchResult = await runWithUserContext("spec-test-user", () =>
      dispatchReadyTasksToMachines({
        leaseOwner: "cloud-orchestrator-spec",
        limit: 1,
      }),
    );
    assert.equal(cancellableDispatchResult.processed, 1);
    assert.equal(sent.at(-1)?.type, "execute");

    const cancelledJob = cancelRuntimeJobByTaskRun({
      requestId: cancellableJob.requestId,
      reason: "用户终止任务执行",
    });
    assert.equal(cancelledJob?.status, "cancelled");
    const cancelDispatch = cancelActiveTunnelDispatch(cancellableJob.id, { reason: "用户终止任务执行" });
    assert.equal(cancelDispatch.sent, true);
    const cancelCommand = sent.at(-1);
    assert.equal(cancelCommand?.type, "cancel");
    if (cancelCommand?.type !== "cancel") throw new Error("expected cancel command");
    assert.equal(cancelCommand.jobId, cancellableJob.id);

    submitMachineResult({
      type: "execute",
      jobId: cancellableJob.id,
      ok: true,
      status: "completed",
      result: { finalMessage: "late result should be ignored" },
    });
    assert.equal(getRuntimeJob(cancellableJob.id)?.status, "cancelled", "cancelled job must ignore late daemon result");

    const resumeTrajectory: ExecutionTrajectoryStep[] = [
      {
        id: "trajectory-task-dispatcher-resume",
        index: 0,
        type: "tool_call",
        status: "completed",
        title: "已完成上一轮搜索",
        toolCall: { name: "mcp__tavily__tavily_search", summary: "搜索上轮资料" },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      },
    ];
    const resumeJob = seedQueuedCloudJob("job-task-dispatcher-resume-context");
    const sessionRule = {
      id: "tool-rule-session-task-dispatcher-spec",
      pattern: "mcp__session__*",
      label: "mcp__session__*",
      source: "user" as const,
      createdAt: new Date().toISOString(),
    };
    const runtimeRule = {
      id: "tool-rule-runtime-task-dispatcher-spec",
      pattern: "mcp__runtime__*",
      label: "mcp__runtime__*",
      source: "user" as const,
      createdAt: new Date().toISOString(),
    };
    upsertRuntimeEnvironmentsSnapshot([
      {
        ...runtimeEnv(),
        filePolicy: {
          ...DEFAULT_RUNTIME_FILE_POLICY,
          custom: { ...DEFAULT_RUNTIME_FILE_POLICY.custom },
          allowedToolRules: [runtimeRule],
        },
      },
    ]);
    upsertRuntimeJob({
      ...resumeJob,
      payload: {
        ...resumeJob.payload,
        resumeContext: "用户暂停后恢复，请基于上一轮上下文继续执行。",
        toolPermissionSessionRules: [sessionRule],
      },
      trajectory: resumeTrajectory,
    });
    const resumeDispatchResult = await runWithUserContext("spec-test-user", () =>
      dispatchReadyTasksToMachines({
        leaseOwner: "cloud-orchestrator-spec",
        limit: 1,
      }),
    );
    assert.equal(resumeDispatchResult.processed, 1);
    const resumeExecuteCommand = sent.at(-1);
    assert.equal(resumeExecuteCommand?.type, "execute");
    if (resumeExecuteCommand?.type !== "execute") throw new Error("expected resume execute command");
    assert.equal(
      (resumeExecuteCommand.payload as { resumeContext?: string }).resumeContext,
      "用户暂停后恢复，请基于上一轮上下文继续执行。",
    );
    assert.equal(
      ((resumeExecuteCommand.payload as { trajectory?: unknown[] }).trajectory ?? []).length,
      1,
      "resume execute payload should carry checkpoint trajectory",
    );
    assert.equal(
      ((resumeExecuteCommand.payload as { toolPermissionSessionRules?: typeof sessionRule[] }).toolPermissionSessionRules ?? [])[0]
        ?.pattern,
      sessionRule.pattern,
      "execute payload should carry session-scoped tool permission rules across process boundary",
    );
    assert.equal(
      (resumeExecuteCommand.payload as { runtimeEnv?: RuntimeEnvironment }).runtimeEnv?.filePolicy?.allowedToolRules?.some(
        (rule) => rule.pattern === runtimeRule.pattern,
      ),
      true,
      "execute payload should refresh latest runtime-scoped tool permission rules before dispatch",
    );
  } finally {
    unregisterMachineWsConnection(machineId, sender);
  }

  console.log("taskDispatcher specs passed");
}
