import assert from "node:assert/strict";

import { normalizeGoalId, normalizeSubGoalId, normalizeTaskId, normalizeInstanceId } from "@/lib/opaqueIds";
import { upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  materializeGoalDeliverable,
  readGoalDeliverable,
} from "@/lib/server/services/goalDeliverableService";
import type { Goal } from "@/types/kiki";

const GOAL_ID = normalizeGoalId("goal-deliverable-spec");
const SUB_GOAL_ID = normalizeSubGoalId(`${GOAL_ID}-sub`);
const TASK_ID = normalizeTaskId(`${GOAL_ID}-task`);
const INSTANCE_ID = normalizeInstanceId(`${TASK_ID}-instance`);

function buildGoal(): Goal {
  return {
    id: GOAL_ID,
    title: "交付包聚合测试",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 100,
    createdAt: "2026-05-30T00:00:00.000Z",
    subGoals: [
      {
        id: SUB_GOAL_ID,
        goalId: GOAL_ID,
        title: "子目标",
        tasks: [
          {
            id: TASK_ID,
            subGoalId: SUB_GOAL_ID,
            title: "任务1：生成完整交付物",
            description: "生成 blocks 与附件",
            expectedOutcome: "完整交付物",
            taskType: "one_shot",
            triggerRule: "立即执行",
            progress: 100,
            executionKind: "generic_result",
            resultViewKind: "generic_result",
            instances: [
              {
                id: INSTANCE_ID,
                taskId: TASK_ID,
                dateLabel: "2026-05-30",
                status: "completed",
                intro: "测试实例",
                createdAt: "2026-05-30T00:00:00.000Z",
                payload: {
                  kind: "generic_result",
                  summary: "payload 摘要",
                  artifacts: [{ id: "payload-artifact", label: "payload", kind: "text", href: "payload.txt" }],
                },
                result: {
                  summary: "result 摘要",
                  taskResult: {
                    schemaVersion: 1,
                    taskId: TASK_ID,
                    instanceId: INSTANCE_ID,
                    title: "完整交付物",
                    status: "done",
                    blocks: [{ kind: "paragraph", text: "真实交付内容" }],
                    meta: { producedAt: "2026-05-30T00:00:00.000Z", role: "agent_deliverable" },
                  },
                  artifacts: [{ id: "result-artifact", label: "result", kind: "markdown", href: "result.md" }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function runGoalDeliverableServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const write = upsertGoalsSnapshot([buildGoal()]);
  assert.equal(write.ok, true);

  const first = materializeGoalDeliverable(GOAL_ID);
  assert.equal(first.changed, true);
  assert.equal(first.deliverable.sections[0]?.blocks[0]?.kind, "paragraph");
  assert.equal(first.deliverable.sections[0]?.artifactRefs.length, 2);
  assert.equal(first.deliverable.attachments.length, 2);

  const second = materializeGoalDeliverable(GOAL_ID);
  assert.equal(second.changed, false);
  assert.equal(second.deliverable.revision, first.deliverable.revision);
  assert.equal(readGoalDeliverable(GOAL_ID)?.revision, first.deliverable.revision);
}
