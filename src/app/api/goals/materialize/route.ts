import { NextRequest, NextResponse } from "next/server";

import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { initialGoals } from "@/mocks/goals";
import type { Goal, Task } from "@/types/kiki";

export const runtime = "nodejs";

type Body = {
  goal?: Goal;
};

function materializeKey(goal: Goal) {
  const workflowUpdatedAt = goal.workflow?.updatedAt ?? goal.createdAt;
  const taskShape = goal.subGoals.map((subGoal) => `${subGoal.id}:${subGoal.tasks.map((task) => task.id).join(",")}`).join("|");
  return `${goal.id}:${workflowUpdatedAt}:${taskShape}`;
}

function isNewerOrEqual(left?: string, right?: string) {
  if (!left) return false;
  if (!right) return true;
  return new Date(left).getTime() >= new Date(right).getTime();
}

function mergeTask(localTask: Task, remoteTask?: Task): Task {
  if (!remoteTask) return localTask;
  const remoteInstances = new Map(remoteTask.instances.map((instance) => [instance.id, instance]));
  const localOnlyInstances = localTask.instances.filter((instance) => !remoteInstances.has(instance.id));
  return {
    ...remoteTask,
    ...localTask,
    progress: Math.max(remoteTask.progress, localTask.progress),
    instances: [...remoteTask.instances, ...localOnlyInstances],
  };
}

function mergeGoalIntoSnapshot(snapshot: Goal[], localGoal: Goal) {
  const existing = snapshot.find((goal) => goal.id === localGoal.id);
  if (!existing) return [...snapshot, localGoal];
  const remoteSubGoals = new Map(existing.subGoals.map((subGoal) => [subGoal.id, subGoal]));
  const nextSubGoals = localGoal.subGoals.map((localSubGoal) => {
    const remoteSubGoal = remoteSubGoals.get(localSubGoal.id);
    if (!remoteSubGoal) return localSubGoal;
    const remoteTasks = new Map(remoteSubGoal.tasks.map((task) => [task.id, task]));
    const localTaskIds = new Set(localSubGoal.tasks.map((task) => task.id));
    const remoteOnlyTasks = remoteSubGoal.tasks.filter((task) => !localTaskIds.has(task.id));
    return {
      ...remoteSubGoal,
      ...localSubGoal,
      tasks: [...localSubGoal.tasks.map((task) => mergeTask(task, remoteTasks.get(task.id))), ...remoteOnlyTasks],
    };
  });
  const localSubGoalIds = new Set(localGoal.subGoals.map((subGoal) => subGoal.id));
  const remoteOnlySubGoals = existing.subGoals.filter((subGoal) => !localSubGoalIds.has(subGoal.id));
  const nextGoal: Goal = {
    ...existing,
    ...localGoal,
    progress: Math.max(existing.progress, localGoal.progress),
    workflow: isNewerOrEqual(localGoal.workflow?.updatedAt, existing.workflow?.updatedAt)
      ? localGoal.workflow
      : existing.workflow,
    subGoals: [...nextSubGoals, ...remoteOnlySubGoals],
  };
  return snapshot.map((goal) => (goal.id === localGoal.id ? nextGoal : goal));
}

export async function POST(request: NextRequest) {
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Body;
  if (!body.goal?.id || !Array.isArray(body.goal.subGoals)) {
    return NextResponse.json({ ok: false, reason: "缺少有效 goal payload" }, { status: 400 });
  }
  const goals = readGoalsSnapshot(initialGoals);
  const existing = goals.find((goal) => goal.id === body.goal?.id);
  if (existing && materializeKey(existing) === materializeKey(body.goal)) {
    return NextResponse.json({ ok: true, idempotencyKey, skipped: true });
  }
  const nextGoals = mergeGoalIntoSnapshot(goals, body.goal);
  const result = upsertGoalsSnapshot(nextGoals);
  return NextResponse.json({ ok: true, result });
}
