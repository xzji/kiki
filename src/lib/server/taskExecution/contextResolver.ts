import { buildTaskGraph, detectCycleFromTask } from "@/lib/server/taskExecution/dependencyGraph";
import { extractDependencyDigest } from "@/lib/server/taskExecution/dependencyDigest";
import { renderDependencySection } from "@/lib/server/taskExecution/contextRenderer";
import { materializeTaskExecutionContext } from "@/lib/server/taskExecution/contextWorkspace";
import {
  buildSyncReadiness,
  contextBlockersFromReadiness,
} from "@/lib/server/taskExecution/readinessAdapter";
import {
  DEFAULT_TASK_EXECUTION_CONTEXT_BUDGET,
  type ContextBlocker,
  type DependencyStatus,
  type DependencyView,
  type TaskExecutionContext,
} from "@/lib/server/taskExecution/types";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

function latestInstance(task: Task) {
  return task.instances[0];
}

function dependencyStatus(task: Task | undefined): DependencyStatus {
  if (!task) return "missing";
  const instance = latestInstance(task);
  if (!instance) return task.progress >= 100 ? "completed" : "not_started";
  if (instance.status === "completed") return "completed";
  if (instance.status === "awaiting_user") return "awaiting_user";
  if (instance.status === "error") return "failed";
  if (instance.status === "in_progress" || instance.status === "paused" || instance.status === "pending") {
    return "in_progress";
  }
  if (task.progress >= 100) return "completed";
  return "in_progress";
}

function dependencyBlocker(dependency: DependencyView): ContextBlocker | null {
  if (dependency.status === "completed") return null;
  const title = dependency.ref.title || dependency.ref.taskId;
  const messageByStatus: Record<Exclude<DependencyStatus, "completed">, string> = {
    missing: `依赖任务「${dependency.ref.taskId}」不存在，请先修复任务依赖配置。`,
    not_started: `等待上游任务「${title}」启动后再继续。`,
    in_progress: `等待上游任务「${title}」完成后再继续。`,
    awaiting_user: `上游任务「${title}」需要你先回答后才能继续。`,
    failed: `上游任务「${title}」未达标，请先处理后再继续。`,
  };
  const severity = dependency.status === "missing" || dependency.status === "failed" ? "block" : "soft_wait";
  return {
    kind: dependency.status === "missing" ? "config" : "dependency",
    severity,
    source: "system",
    id: `dep:${dependency.ref.taskId}`,
    label: `依赖任务：${title}`,
    message: messageByStatus[dependency.status],
    reason: dependency.blocker?.reason || messageByStatus[dependency.status],
    suggestedActions:
      dependency.status === "missing"
        ? [{ kind: "free_text", label: "修复任务依赖配置" }]
        : [{ kind: "navigate_task", label: `查看「${title}」`, taskId: dependency.ref.taskId }],
  };
}

function cycleBlocker(cycle: string[]): ContextBlocker {
  const path = cycle.join(" -> ");
  return {
    kind: "cycle",
    severity: "block",
    source: "system",
    id: "dependency_cycle",
    label: "依赖循环",
    message: `任务依赖出现循环：${path}，已暂停自动运行。`,
    reason: `检测到依赖循环：${path}`,
    suggestedActions: [{ kind: "free_text", label: "调整任务依赖关系" }],
  };
}

function buildDependencies(input: {
  conversationId: string;
  goal: Goal;
  task: Task;
  budget: TaskExecutionContext["budget"];
}) {
  const { taskMap } = buildTaskGraph(input.goal);
  return (input.task.dependencies ?? []).map((dependencyId): DependencyView => {
    const dependencyTask = taskMap.get(dependencyId);
    const status = dependencyStatus(dependencyTask);
    const base = {
      ref: {
        taskId: dependencyId,
        title: dependencyTask?.title ?? dependencyId,
        expectedOutcome: dependencyTask?.expectedOutcome ?? "",
      },
      status,
    };
    if (!dependencyTask) {
      return {
        ...base,
        blocker: {
          reason: "依赖任务 id 在当前目标中不存在。",
          hint: "请重新规划或修复 task.dependencies。",
        },
      };
    }
    if (status !== "completed") {
      return {
        ...base,
        blocker: {
          reason: latestInstance(dependencyTask)?.awaitingUser?.reason || `依赖任务当前状态为 ${status}。`,
          hint: "请先处理上游任务。",
        },
      };
    }
    const instance = latestInstance(dependencyTask);
    return {
      ...base,
      digest: instance
        ? extractDependencyDigest({
            conversationId: input.conversationId,
            task: dependencyTask,
            instance,
            budget: input.budget,
          })
        : undefined,
    };
  });
}

function buildContext(input: {
  conversationId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance?: TaskInstance;
  requestId?: string;
}) {
  const budget = DEFAULT_TASK_EXECUTION_CONTEXT_BUDGET;
  const dependencies = buildDependencies({
    conversationId: input.conversationId,
    goal: input.goal,
    task: input.task,
    budget,
  });
  const dependencyBlockers = dependencies.map(dependencyBlocker).filter((item): item is ContextBlocker => Boolean(item));
  const cycle = detectCycleFromTask(input.goal, input.task.id);
  const cycleBlockers = cycle ? [cycleBlocker(cycle)] : [];
  const dependencyContextText = dependencies.length ? renderDependencySection({
    identity: {
      conversationId: input.conversationId,
      goalId: input.goal.id,
      subGoalId: input.subGoal.id,
      taskId: input.task.id,
      instanceId: input.instance?.id,
      requestId: input.requestId,
    },
    readiness: { state: "ready", blockers: [], summary: "" },
    dependencies,
    inputs: { goal: input.goal, subGoal: input.subGoal, task: input.task, instance: input.instance },
    budget,
  }) : "";
  const syncReadiness = buildSyncReadiness({
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: input.instance,
    dependencyContextText,
  });
  const userInputBlockers = contextBlockersFromReadiness(syncReadiness);
  const blockers = [...cycleBlockers, ...dependencyBlockers, ...userInputBlockers];
  const state = blockers.length ? "blocked" : "ready";

  return {
    identity: {
      conversationId: input.conversationId,
      goalId: input.goal.id,
      subGoalId: input.subGoal.id,
      taskId: input.task.id,
      instanceId: input.instance?.id,
      requestId: input.requestId,
    },
    readiness: {
      state,
      blockers,
      summary: blockers.length
        ? blockers.map((blocker) => blocker.message).join("；")
        : "执行当前任务所需上下文已就绪。",
    },
    dependencies,
    inputs: {
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
    },
    budget,
  } satisfies TaskExecutionContext;
}

export function resolveAdmitDecision(input: {
  conversationId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
}) {
  return buildContext(input);
}

export function resolveExecutionContext(input: {
  conversationId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  requestId: string;
}) {
  return materializeTaskExecutionContext(buildContext(input));
}
