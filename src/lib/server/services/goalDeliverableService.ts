import { getDatabaseAdapter } from "@/lib/server/adapters/database";
import type { StorageRef } from "@/lib/server/adapters/storage";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal, Task, TaskInstance, TaskRunArtifact } from "@/types/kiki";

export type GoalDeliverableSection = {
  taskId: string;
  taskTitle: string;
  instanceId: string;
  headline: string;
  summary: string;
  artifactRefs: StorageRef[];
  agentRoleId?: string;
};

export type GoalDeliverableAttachment = {
  kind: TaskRunArtifact["kind"];
  name: string;
  sourceTaskId: string;
  storageRef: StorageRef;
};

export type GoalDeliverable = {
  goalId: string;
  title: string;
  summary: string;
  sections: GoalDeliverableSection[];
  attachments: GoalDeliverableAttachment[];
  generatedAt: string;
  revision: number;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeTaskTitle(title: string) {
  return title.replace(/^任务\d+[：:]\s*/, "");
}

function latestCompletedInstance(task: Task) {
  return [...task.instances]
    .filter((instance) => instance.status === "completed")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function artifactStorageRef(goalId: string, taskId: string, artifact: TaskRunArtifact): StorageRef {
  if (artifact.href) return { adapter: "local-fs", key: artifact.href };
  return { adapter: "local-fs", key: `goal-deliverables/${goalId}/${taskId}/${artifact.id}` };
}

function summarizeInstance(task: Task, instance: TaskInstance) {
  return (
    instance.result?.summary ||
    instance.payload.summary ||
    instance.payload.details ||
    task.expectedOutcome ||
    "该任务已完成。"
  );
}

function buildSection(goalId: string, task: Task, instance: TaskInstance): GoalDeliverableSection {
  const artifacts = instance.payload.artifacts ?? [];
  const summary = summarizeInstance(task, instance);
  return {
    taskId: task.id,
    taskTitle: normalizeTaskTitle(task.title),
    instanceId: instance.id,
    headline: normalizeTaskTitle(task.title),
    summary,
    artifactRefs: artifacts.map((artifact) => artifactStorageRef(goalId, task.id, artifact)),
  };
}

function buildAttachments(goalId: string, task: Task, artifacts: TaskRunArtifact[]): GoalDeliverableAttachment[] {
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    name: artifact.label,
    sourceTaskId: task.id,
    storageRef: artifactStorageRef(goalId, task.id, artifact),
  }));
}

function findGoal(goalId: string) {
  return readGoalsSnapshot([]).find((goal) => goal.id === goalId) ?? null;
}

function getStoredRevision(goalId: string) {
  const row = getDatabaseAdapter()
    .prepare(`SELECT revision FROM goal_deliverables WHERE goal_id = ? LIMIT 1`)
    .get(goalId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

export function composeGoalDeliverable(goalId: string): GoalDeliverable {
  const goal = findGoal(goalId);
  if (!goal) {
    throw new Error("未找到目标");
  }
  const completed = goal.subGoals.flatMap((subGoal) =>
    subGoal.tasks
      .map((task) => ({ task, instance: latestCompletedInstance(task) }))
      .filter((entry): entry is { task: Task; instance: TaskInstance } => Boolean(entry.instance)),
  );
  const sections = completed.map(({ task, instance }) => buildSection(goal.id, task, instance));
  const attachments = completed.flatMap(({ task, instance }) =>
    buildAttachments(goal.id, task, instance.payload.artifacts ?? []),
  );
  const revision = getStoredRevision(goalId) + 1;
  return {
    goalId: goal.id,
    title: goal.title,
    summary: goal.summary || `${sections.length} 个任务已形成交付内容。`,
    sections,
    attachments,
    generatedAt: nowIso(),
    revision,
  };
}

export function saveGoalDeliverable(deliverable: GoalDeliverable) {
  getDatabaseAdapter()
    .prepare(
      `
        INSERT INTO goal_deliverables (goal_id, payload_json, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `,
    )
    .run(deliverable.goalId, JSON.stringify(deliverable), deliverable.revision, deliverable.generatedAt);
  return deliverable;
}

export function readGoalDeliverable(goalId: string) {
  const row = getDatabaseAdapter()
    .prepare(`SELECT payload_json FROM goal_deliverables WHERE goal_id = ? LIMIT 1`)
    .get(goalId) as { payload_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.payload_json) as GoalDeliverable;
}

export function getOrComposeGoalDeliverable(goalId: string) {
  return readGoalDeliverable(goalId) ?? saveGoalDeliverable(composeGoalDeliverable(goalId));
}

export function goalHasCompletedTasks(goal: Goal) {
  return goal.subGoals.some((subGoal) =>
    subGoal.tasks.some((task) => task.instances.some((instance) => instance.status === "completed")),
  );
}
