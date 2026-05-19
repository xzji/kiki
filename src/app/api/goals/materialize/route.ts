import { NextRequest, NextResponse } from "next/server";

import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { initialGoals } from "@/mocks/goals";
import type { Goal, Task } from "@/types/kiki";

export const runtime = "nodejs";

type Body = {
  goal?: Goal;
};

function mergeTask(localTask: Task, remoteTask?: Task): Task {
  if (!remoteTask) return localTask;
  const remoteInstances = new Map(remoteTask.instances.map((instance) => [instance.id, instance]));
  const localOnlyInstances = localTask.instances.filter((instance) => !remoteInstances.has(instance.id));
  return {
    ...remoteTask,
    ...localTask,
    instances: [...remoteTask.instances, ...localOnlyInstances],
  };
}

function mergeGoalIntoSnapshot(snapshot: Goal[], localGoal: Goal) {
  const existing = snapshot.find((goal) => goal.id === localGoal.id);
  if (!existing) return [...snapshot, localGoal];
  const remoteSubGoals = new Map(existing.subGoals.map((subGoal) => [subGoal.id, subGoal]));
  const nextGoal: Goal = {
    ...existing,
    ...localGoal,
    subGoals: localGoal.subGoals.map((localSubGoal) => {
      const remoteSubGoal = remoteSubGoals.get(localSubGoal.id);
      if (!remoteSubGoal) return localSubGoal;
      const remoteTasks = new Map(remoteSubGoal.tasks.map((task) => [task.id, task]));
      return {
        ...remoteSubGoal,
        ...localSubGoal,
        tasks: localSubGoal.tasks.map((task) => mergeTask(task, remoteTasks.get(task.id))),
      };
    }),
  };
  return snapshot.map((goal) => (goal.id === localGoal.id ? nextGoal : goal));
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  if (!body.goal?.id || !Array.isArray(body.goal.subGoals)) {
    return NextResponse.json({ ok: false, reason: "缺少有效 goal payload" }, { status: 400 });
  }
  const goals = readGoalsSnapshot(initialGoals);
  const nextGoals = mergeGoalIntoSnapshot(goals, body.goal);
  const result = upsertGoalsSnapshot(nextGoals);
  return NextResponse.json({ ok: true, result });
}
