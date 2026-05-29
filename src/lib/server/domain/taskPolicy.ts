import type {
  InteractionRequirement,
  Task,
  TaskExecutionMode,
  TaskExpectedResult,
  TaskResultViewKind,
  TaskRunErrorCategory,
  UserInteractionTiming,
  UserInteractionType,
} from "@/types/kiki";

type ConfirmationPolicyInput =
  | Pick<Task, "expectedResult" | "requiresConfirmation" | "collaboration">
  | {
      expectedOutputType?: TaskExpectedResult["type"];
      completionCriteria?: string;
      requiresConfirmation?: boolean;
      completionOwner?: NonNullable<Task["collaboration"]>["completionOwner"];
    };

type ConfirmationPolicyOptions = {
  includeRequiresConfirmation?: boolean;
  includeUserCompletionOwner?: boolean;
};

const USER_CONFIRMATION_COMPLETION_PATTERN =
  /用户.*(确认|审批|选择|决定|采纳).*完成|必须.*用户.*(确认|审批|选择|决定|采纳)|经用户.*(确认|审批|选择|决定|采纳)/;

const NOTIFIABLE_INTERACTION_TYPES = new Set<InteractionRequirement["type"]>([
  "confirm",
  "answer",
  "provide_context",
  "perform_offline_action",
  "deliverable_gap",
  "agent_revision_required",
]);

function expectedResultType(input: ConfirmationPolicyInput) {
  if ("expectedResult" in input) return input.expectedResult?.type;
  return "expectedOutputType" in input ? input.expectedOutputType : undefined;
}

function completionCriteria(input: ConfirmationPolicyInput) {
  if ("expectedResult" in input) return input.expectedResult?.completionCriteria;
  return "completionCriteria" in input ? input.completionCriteria : undefined;
}

function requiresConfirmationFlag(input: ConfirmationPolicyInput) {
  return "requiresConfirmation" in input ? input.requiresConfirmation : undefined;
}

function completionOwner(input: ConfirmationPolicyInput) {
  if ("collaboration" in input) return input.collaboration?.completionOwner;
  return "completionOwner" in input ? input.completionOwner : undefined;
}

export function requiresUserConfirmationToComplete(
  input: ConfirmationPolicyInput,
  options: ConfirmationPolicyOptions = {},
) {
  const expectedType = expectedResultType(input);
  if (expectedType === "decision" || expectedType === "confirmation") return true;
  if (USER_CONFIRMATION_COMPLETION_PATTERN.test(completionCriteria(input) ?? "")) return true;
  if (options.includeRequiresConfirmation && requiresConfirmationFlag(input) === true && expectedType !== "information") {
    return true;
  }
  if (options.includeUserCompletionOwner && completionOwner(input) === "user" && expectedType !== "information") {
    return true;
  }
  return false;
}

export function inferUserInteractionType(input: {
  resultViewKind?: TaskResultViewKind;
  executionKind?: TaskResultViewKind;
  executionMode?: TaskExecutionMode;
  expectedOutputType?: TaskExpectedResult["type"];
}): UserInteractionType {
  if (input.expectedOutputType === "decision" || input.expectedOutputType === "confirmation") return "confirm";
  if (input.expectedOutputType === "action" && input.executionMode === "interactive") return "perform_offline_action";
  if (input.executionMode === "interactive") return "confirm";
  return "none";
}

export function inferInteractionTiming(input: {
  interactionType: InteractionRequirement["type"];
  explicitTiming?: UserInteractionTiming;
}): UserInteractionTiming {
  if (input.explicitTiming) return input.explicitTiming;
  if (input.interactionType === "none") return "not_required";
  if (input.interactionType === "answer" || input.interactionType === "perform_offline_action") {
    return "core_task_step";
  }
  return "after_agent_output";
}

export function shouldNotifyUser(input: {
  explicit?: boolean;
  interactionType?: InteractionRequirement["type"] | UserInteractionType;
  fallback?: boolean;
  task?: Pick<Task, "collaboration" | "expectedResult" | "requiresConfirmation">;
}) {
  if (typeof input.explicit === "boolean") return input.explicit;
  if (typeof input.fallback === "boolean") return input.fallback;
  if (input.task?.collaboration?.shouldNotifyUser !== undefined) {
    return input.task.collaboration.shouldNotifyUser;
  }
  if (input.interactionType && NOTIFIABLE_INTERACTION_TYPES.has(input.interactionType)) return true;
  if (input.task && requiresUserConfirmationToComplete(input.task, { includeRequiresConfirmation: true })) return true;
  return false;
}

export function inferInteractionRequirement(input: {
  interactionType?: InteractionRequirement["type"];
  executionKind?: TaskResultViewKind;
  resultViewKind?: TaskResultViewKind;
  executionMode?: TaskExecutionMode;
  expectedOutputType?: TaskExpectedResult["type"];
  timing?: UserInteractionTiming;
  reason?: string;
  question?: string;
  options?: string[];
  fields?: InteractionRequirement["fields"];
  suggestedActions?: string[];
  shouldNotifyUser?: boolean;
  fallbackShouldNotifyUser?: boolean;
  task?: Pick<Task, "collaboration" | "expectedResult" | "requiresConfirmation">;
}): InteractionRequirement {
  const interactionType =
    input.interactionType ??
    inferUserInteractionType({
      resultViewKind: input.resultViewKind,
      executionKind: input.executionKind,
      executionMode: input.executionMode,
      expectedOutputType: input.expectedOutputType,
    });
  return {
    type: interactionType,
    timing: inferInteractionTiming({ interactionType, explicitTiming: input.timing }),
    reason: input.reason ?? "",
    question: input.question,
    options: input.options,
    fields: input.fields,
    suggestedActions: input.suggestedActions,
    shouldNotifyUser: shouldNotifyUser({
      explicit: input.shouldNotifyUser,
      fallback: input.fallbackShouldNotifyUser,
      interactionType,
      task: input.task,
    }),
  };
}

export function classifyTaskRunError(error: unknown): TaskRunErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|中断|cancel/i.test(message)) return "aborted";
  if (/permission|权限|accept/i.test(message)) return "permission";
  if (/network|fetch|ECONN|timed out|timeout|socket/i.test(message)) return "transient_network";
  if (/spawn|ENOENT|启动失败|cli/i.test(message)) return "transient_cli";
  if (/json|parse|格式|schema/i.test(message)) return "logic";
  return "unknown";
}
