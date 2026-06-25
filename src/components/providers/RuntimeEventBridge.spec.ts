import assert from "node:assert/strict";

import { applyRuntimeStatePayloadToStores } from "@/components/providers/RuntimeEventBridge";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Goal } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { AgentEvent } from "@/types/schedule";

function makeGoal(id: string, title: string): Goal {
  return {
    id,
    title,
    deadline: "",
    progress: 0,
    subGoals: [],
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

function makeEnvironment(id: string, name: string): RuntimeEnvironment {
  return {
    id,
    type: "local",
    name,
    workingDirectory: "/workspace",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function makeScheduleEvent(id: string, title: string): AgentEvent {
  return {
    id,
    title,
    startTime: "2026-06-01T09:00:00.000Z",
    endTime: "2026-06-01T10:00:00.000Z",
    isAllDay: false,
    attendees: [],
    createdByAgent: true,
  };
}

export function runRuntimeEventBridgeSnapshotApplySpecs() {
  const originalGoalState = useGoalStore.getState();
  const originalRuntimeEnvState = useRuntimeEnvStore.getState();
  const originalScheduleState = useScheduleStore.getState();

  try {
    useGoalStore.setState({
      goals: [makeGoal("goal-old", "Old goal")],
      goalProjectionRevision: 1,
      pendingTaskCreates: [],
      pendingSubGoalCreates: [],
      pendingTaskUpdates: [],
      pendingTaskDeletes: [],
      pendingGoalWorkflows: [],
      pendingConversationGoalDeletes: [],
      optimisticTaskRuns: [],
    });
    useRuntimeEnvStore.setState({
      environments: [makeEnvironment("runtime-old", "Old runtime")],
      activeRuntimeEnvId: "runtime-old",
      projectionRevision: 1,
    });
    useScheduleStore.setState({
      events: [makeScheduleEvent("event-old", "Old event")],
      projectionRevision: 1,
    });

    const result = applyRuntimeStatePayloadToStores({
      goals: [makeGoal("goal-new", "New goal")],
      runtimeEnvironments: [makeEnvironment("runtime-new", "New runtime")],
      scheduleEvents: [makeScheduleEvent("event-new", "New event")],
      meta: {
        revisions: {
          goals: 2,
          runtimeEnvironments: 3,
          scheduleEvents: 4,
        },
        etags: {
          goals: "goals-v2",
          runtimeEnvironments: "runtime-v3",
          scheduleEvents: "schedule-v4",
        },
      },
    });

    assert.equal(result.unchanged, false);
    assert.equal(result.revision.goals, 2);
    assert.equal(result.etags.scheduleEvents, "schedule-v4");
    assert.equal(useGoalStore.getState().goals[0]?.title, "New goal");
    assert.equal(useGoalStore.getState().goalProjectionRevision, 2);
    assert.equal(useRuntimeEnvStore.getState().environments[0]?.id, "runtime-new");
    assert.equal(useRuntimeEnvStore.getState().projectionRevision, 3);
    assert.equal(useScheduleStore.getState().events[0]?.id, "event-new");
    assert.equal(useScheduleStore.getState().projectionRevision, 4);
  } finally {
    useGoalStore.setState(originalGoalState);
    useRuntimeEnvStore.setState(originalRuntimeEnvState);
    useScheduleStore.setState(originalScheduleState);
  }
}
