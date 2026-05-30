import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeGoalId, normalizeSubGoalId, normalizeTaskId } from "../src/lib/opaqueIds";
import { getDatabase } from "../src/lib/server/db/client";
import { readGoalsSnapshotMeta } from "../src/lib/server/runtime/stateSnapshot";
import { applyGoalCommand } from "../src/lib/server/services/goalCommandService";
import type { Goal, TaskInstanceStatus } from "../src/types/kiki";

type DogfoodMetrics = {
  runId: string;
  sampledAt: string;
  goals: number;
  tasks: number;
  instances: number;
  completedInstances: number;
  awaitingUserInstances: number;
  pausedInstances: number;
  errorInstances: number;
  notificationDeliveredEvents: number;
  timeoutPausedEvents: number;
  completionRate: number;
};

const SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DURATION_HOURS = 12;

function nowIso() {
  return new Date().toISOString();
}

function dogfoodDir() {
  return path.join(os.homedir(), ".kiki", "dogfood");
}

function ensureDogfoodDir() {
  fs.mkdirSync(dogfoodDir(), { recursive: true });
}

function buildFixtureGoal(runId: string): Goal {
  const createdAt = nowIso();
  const goalId = normalizeGoalId(`dogfood-${runId}`);
  const subGoalId = normalizeSubGoalId(`${goalId}-sub-1`);
  const taskId = normalizeTaskId(`${goalId}-task-1`);
  return {
    id: goalId,
    title: "Dogfood：后台 daemon 离线执行验收",
    deadline: createdAt,
    progress: 0,
    createdAt,
    conversationId: `dogfood-${runId}`,
    summary: "用于验证关闭浏览器后 daemon 调度、通知与 watchdog 是否稳定。",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: createdAt,
      updatedAt: createdAt,
    },
    subGoals: [
      {
        id: subGoalId,
        goalId,
        title: "收集离线运行信号",
        description: "覆盖信息型任务、等待用户态和通知投递。",
        tasks: [
          {
            id: taskId,
            subGoalId,
            title: "任务1：记录 daemon dogfood 状态",
            description: "读取当前项目状态并生成一段可验收摘要。",
            expectedOutcome: "生成 daemon dogfood 状态摘要，并在完成后投递通知。",
            taskType: "one_shot",
            triggerRule: "立即执行",
            progress: 0,
            instances: [],
            executionKind: "generic_result",
            resultViewKind: "generic_result",
            priority: "high",
            executionMode: "monitoring",
            expectedResult: {
              type: "information",
              description: "daemon 离线执行状态摘要",
              format: "markdown",
              primaryFormat: "structured_blocks",
              surfaces: ["interactive"],
            },
          },
        ],
      },
    ],
  };
}

function countInstancesByStatus(goals: Goal[]) {
  const counts: Record<TaskInstanceStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    awaiting_user: 0,
    paused: 0,
    error: 0,
  };
  let tasks = 0;
  let instances = 0;
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      tasks += subGoal.tasks.length;
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          instances += 1;
          counts[instance.status] += 1;
        }
      }
    }
  }
  return { tasks, instances, counts };
}

function countGoalEvents(goalId: string, kind: string) {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM goal_event_log WHERE goal_id = ? AND kind = ?`)
    .get(goalId, kind) as { count: number } | undefined;
  return row?.count ?? 0;
}

function collectMetrics(runId: string): DogfoodMetrics {
  const goalId = normalizeGoalId(`dogfood-${runId}`);
  const snapshot = readGoalsSnapshotMeta([]);
  const dogfoodGoals = snapshot.value.filter((goal) => goal.id === goalId);
  const { tasks, instances, counts } = countInstancesByStatus(dogfoodGoals);
  return {
    runId,
    sampledAt: nowIso(),
    goals: dogfoodGoals.length,
    tasks,
    instances,
    completedInstances: counts.completed,
    awaitingUserInstances: counts.awaiting_user,
    pausedInstances: counts.paused,
    errorInstances: counts.error,
    notificationDeliveredEvents: countGoalEvents(goalId, "notification.delivered"),
    timeoutPausedEvents: countGoalEvents(goalId, "instance.timeout_paused"),
    completionRate: instances === 0 ? 0 : counts.completed / instances,
  };
}

function appendMetrics(runId: string, metrics: DogfoodMetrics) {
  ensureDogfoodDir();
  fs.appendFileSync(path.join(dogfoodDir(), `${runId}.jsonl`), `${JSON.stringify(metrics)}\n`, "utf8");
}

function seedFixtureGoal(runId: string) {
  const goal = buildFixtureGoal(runId);
  applyGoalCommand({
    command: { type: "create_goal", goal },
    idempotencyKey: `dogfood.seed.${runId}`,
  });
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const durationArg = process.argv.find((item) => item.startsWith("--hours="));
  const runIdArg = process.argv.find((item) => item.startsWith("--run-id="));
  const hours = durationArg ? Number(durationArg.slice("--hours=".length)) : DEFAULT_DURATION_HOURS;
  return {
    seed: args.has("--seed"),
    once: args.has("--once"),
    hours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_DURATION_HOURS,
    runId: runIdArg?.slice("--run-id=".length).trim(),
  };
}

async function main() {
  const input = parseArgs();
  const runId = input.runId || `dogfood-${Date.now()}`;
  if (input.seed) seedFixtureGoal(runId);
  const deadline = Date.now() + input.hours * 60 * 60 * 1000;
  do {
    const metrics = collectMetrics(runId);
    appendMetrics(runId, metrics);
    console.log(JSON.stringify(metrics));
    if (input.once) break;
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
  } while (Date.now() < deadline);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
