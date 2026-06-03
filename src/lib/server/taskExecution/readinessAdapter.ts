import {
  buildTaskReadinessCheck,
  type TaskReadinessCheck,
  type TaskReadinessInfoItem,
} from "@/lib/server/taskReadinessPolicy";
import type { ContextBlocker, TaskExecutionContext } from "@/lib/server/taskExecution/types";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

function blockerFromReadinessItem(item: TaskReadinessInfoItem): ContextBlocker {
  return {
    kind: "missing_user_input",
    severity: "soft_wait",
    source: item.source,
    id: item.id,
    label: item.label,
    message: item.reason,
    reason: item.reason,
    value: item.value,
    options: item.options,
    optionQuestion: item.optionQuestion,
    inputPlaceholder: item.inputPlaceholder,
    inputKind: item.inputKind,
    suggestedActions: [{ kind: "free_text", label: `补充${item.label}` }],
  };
}

export function buildSyncReadiness(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance?: TaskInstance;
  resumeContext?: string;
  dependencyContextText?: string;
}): TaskReadinessCheck {
  const instance =
    input.instance ??
    ({
      id: "admit-preview",
      taskId: input.task.id,
      dateLabel: "",
      status: "pending",
      intro: "",
      payload: { kind: "generic_result", summary: "" },
      createdAt: new Date().toISOString(),
    } satisfies TaskInstance);

  const syntheticInstance = {
    ...instance,
    intro: [instance.intro, input.dependencyContextText].filter(Boolean).join("\n"),
  };
  return buildTaskReadinessCheck({
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: syntheticInstance,
    resumeContext: input.resumeContext,
  });
}

export function contextBlockersFromReadiness(readiness: TaskReadinessCheck) {
  return readiness.missingUserInfo.map(blockerFromReadinessItem);
}

export function readinessFromContext(context: TaskExecutionContext): TaskReadinessCheck {
  const items: TaskReadinessInfoItem[] = context.readiness.blockers
    .filter((blocker) => blocker.kind === "missing_user_input")
    .map((blocker) => ({
      id: blocker.id,
      label: blocker.label,
      description: blocker.message,
      source: blocker.source,
      status: "missing_user",
      reason: blocker.reason || blocker.message,
      value: blocker.value,
      options: blocker.options,
      optionQuestion: blocker.optionQuestion,
      inputPlaceholder: blocker.inputPlaceholder,
      inputKind: blocker.inputKind,
    }));
  return {
    status: items.length ? "blocked" : "ready",
    generatedAt: new Date().toISOString(),
    summary: context.readiness.summary,
    items,
    missingUserInfo: items,
    agentRetrievableInfo: [],
    availableInfo: [],
  };
}
