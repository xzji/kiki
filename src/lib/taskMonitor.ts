import type {
  RuntimeActivityPayload,
  SagaActivity,
  ThreadRunnerActivity,
} from "@/lib/api/runtime-daemon";
import type { Goal, Task, TaskInstance, TaskInstanceStatus } from "@/types/kiki";

export type TaskMonitorGroup = "queued" | "running" | "paused" | "done";

/** 执行项来源：Goal 任务实例 / ThreadRunner 治理循环 / Topic 规划 Saga。 */
export type TaskMonitorKind = "task" | "thread" | "saga";

export type TaskMonitorRow = {
  /** 列表项稳定 key。 */
  rowKey: string;
  kind: TaskMonitorKind;
  goalId: string;
  goalTitle: string;
  subGoalId?: string;
  subGoalTitle?: string;
  /** 仅 kind==="task" 时存在；用于打开任务详情侧栏。 */
  taskId?: string;
  taskTitle: string;
  taskType?: Task["taskType"];
  triggerRule?: string;
  /** 仅 kind==="task" 时存在。 */
  instanceId?: string;
  instance?: TaskInstance;
  group: TaskMonitorGroup;
  /** 来源标签，用于卡片副标题展示（如「治理循环」「规划」）。 */
  sourceLabel: string;
  statusLabel: string;
  result?: "ok" | "fail";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 治理循环额外信息：积压 tick 数量。 */
  backlogCount?: number;
};

export const TASK_MONITOR_GROUP_ORDER: TaskMonitorGroup[] = ["queued", "running", "paused", "done"];

export const TASK_MONITOR_GROUP_LABEL: Record<TaskMonitorGroup, string> = {
  queued: "待执行",
  running: "执行中",
  paused: "已暂停",
  done: "已完成",
};

/**
 * 聚合三类执行源为统一的监控行：
 *  1. Goal 任务实例（goals）
 *  2. ThreadRunner 治理循环（runtime.threadRunners，已按 thread 折叠）
 *  3. Topic 规划 Saga（runtime.sagas）
 *
 * `runtime` 可为空（接口未就绪 / Runtime 离线），此时仅展示 Goal 任务实例。
 */
export function selectTaskMonitorRows(
  goals: Goal[],
  runtime?: RuntimeActivityPayload | null,
): TaskMonitorRow[] {
  const rows: TaskMonitorRow[] = [];
  const goalTitleById = new Map<string, string>();
  const subGoalTitleById = new Map<string, string>();
  const goalIdBySubGoalId = new Map<string, string>();

  for (const goal of goals) {
    goalTitleById.set(goal.id, goal.title);
    for (const subGoal of goal.subGoals) {
      subGoalTitleById.set(subGoal.id, subGoal.title);
      goalIdBySubGoalId.set(subGoal.id, goal.id);
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const group = getMonitorGroup(instance);
          if (!group) continue;
          rows.push({
            rowKey: `task:${instance.id}`,
            kind: "task",
            goalId: goal.id,
            goalTitle: goal.title,
            subGoalId: subGoal.id,
            subGoalTitle: subGoal.title,
            taskId: task.id,
            taskTitle: stripTaskPrefix(task.title),
            taskType: task.taskType,
            triggerRule: task.triggerRule,
            instanceId: instance.id,
            instance,
            group,
            sourceLabel: goal.title,
            statusLabel: monitorStatusLabel(instance, group),
            result: monitorResult(instance, group),
            createdAt: instance.createdAt,
            startedAt: instance.execution?.startedAt,
            finishedAt: instance.execution?.finishedAt,
          });
        }
      }
    }
  }

  if (runtime) {
    for (const tr of runtime.threadRunners ?? []) {
      rows.push(buildThreadRow(tr, subGoalTitleById, goalIdBySubGoalId, goalTitleById));
    }
    for (const saga of runtime.sagas ?? []) {
      rows.push(buildSagaRow(saga, goalTitleById));
    }
  }

  return rows.sort(compareRows);
}

export function groupTaskMonitorRows(rows: TaskMonitorRow[]) {
  return rows.reduce<Record<TaskMonitorGroup, TaskMonitorRow[]>>(
    (acc, row) => {
      acc[row.group].push(row);
      return acc;
    },
    { queued: [], running: [], paused: [], done: [] },
  );
}

function buildThreadRow(
  tr: ThreadRunnerActivity,
  subGoalTitleById: Map<string, string>,
  goalIdBySubGoalId: Map<string, string>,
  goalTitleById: Map<string, string>,
): TaskMonitorRow {
  const group: TaskMonitorGroup =
    tr.runningCount > 0 ? "running" : tr.pendingCount > 0 ? "queued" : "done";
  const result: "ok" | "fail" | undefined =
    group === "done" ? (tr.failedCount > 0 && tr.completedCount === 0 ? "fail" : "ok") : undefined;
  const goalId = tr.topicId ?? goalIdBySubGoalId.get(tr.threadId) ?? "";
  const goalTitle = goalTitleById.get(goalId) ?? "未知 Topic";
  const subGoalTitle = subGoalTitleById.get(tr.threadId) ?? "板块治理循环";
  return {
    rowKey: `thread:${tr.threadId}`,
    kind: "thread",
    goalId,
    goalTitle,
    subGoalId: tr.threadId,
    subGoalTitle,
    taskTitle: subGoalTitle,
    group,
    sourceLabel: "治理循环",
    statusLabel:
      group === "running"
        ? "治理执行中"
        : group === "queued"
          ? `待治理 · ${tr.pendingCount} 次`
          : result === "fail"
            ? "治理失败"
            : "治理完成",
    result,
    backlogCount: tr.pendingCount,
    createdAt: tr.latestStartedAt,
    startedAt: tr.latestStartedAt,
    finishedAt: tr.latestFinishedAt ?? undefined,
  };
}

function buildSagaRow(saga: SagaActivity, goalTitleById: Map<string, string>): TaskMonitorRow {
  const group = sagaGroup(saga.status);
  const goalTitle = goalTitleById.get(saga.topicId) ?? saga.topicId;
  const typeLabel = saga.type === "topic_init" ? "目标规划" : "板块循环";
  return {
    rowKey: `saga:${saga.id}`,
    kind: "saga",
    goalId: saga.topicId,
    goalTitle,
    taskTitle: typeLabel,
    group,
    sourceLabel: "规划 Saga",
    statusLabel: sagaStatusLabel(saga.status, saga.currentStep),
    result: saga.status === "failed" ? "fail" : saga.status === "completed" ? "ok" : undefined,
    createdAt: saga.startedAt,
    startedAt: saga.startedAt,
    finishedAt: saga.finishedAt,
  };
}

function sagaGroup(status: SagaActivity["status"]): TaskMonitorGroup {
  if (status === "running") return "running";
  if (status === "pending") return "queued";
  if (status === "awaiting_user") return "paused";
  return "done";
}

function sagaStatusLabel(status: SagaActivity["status"], step?: string): string {
  const stepSuffix = step ? ` · ${step}` : "";
  switch (status) {
    case "running":
      return `规划中${stepSuffix}`;
    case "pending":
      return "等待规划";
    case "awaiting_user":
      return "等待用户";
    case "failed":
      return "规划失败";
    default:
      return "规划完成";
  }
}

function getMonitorGroup(instance: TaskInstance): TaskMonitorGroup | null {
  if (instance.status === "pending") return "queued";
  if (instance.status === "in_progress") return "running";
  if (instance.status === "paused" || instance.status === "awaiting_user" || instance.awaitingUser)
    return "paused";
  if (instance.status === "completed" || instance.status === "error" || instance.status === "terminated")
    return "done";
  return null;
}

function monitorStatusLabel(
  instance: TaskInstance,
  group: TaskMonitorGroup,
): string {
  if (instance.status === "terminated") return "已终止";
  if (instance.status === "error") return "执行失败";
  return TASK_MONITOR_GROUP_LABEL[group];
}

function monitorResult(
  instance: TaskInstance,
  group: TaskMonitorGroup,
): "ok" | "fail" | undefined {
  if (group !== "done") return undefined;
  if (instance.status === "error") return "fail";
  if (instance.status === "completed") return "ok";
  return undefined;
}

function compareRows(a: TaskMonitorRow, b: TaskMonitorRow) {
  if (a.group !== b.group) {
    return TASK_MONITOR_GROUP_ORDER.indexOf(a.group) - TASK_MONITOR_GROUP_ORDER.indexOf(b.group);
  }
  const aTime = +new Date(a.finishedAt ?? a.startedAt ?? a.createdAt);
  const bTime = +new Date(b.finishedAt ?? b.startedAt ?? b.createdAt);
  return bTime - aTime;
}

function stripTaskPrefix(value: string) {
  return value.replace(/^任务\d+：/, "");
}

export type { TaskInstanceStatus };
