import type { InteractionRequirement, TaskInstance } from "@/types/kiki";

const OPTIONAL_FEEDBACK_TYPES: Array<InteractionRequirement["type"]> = [
  "answer",
  "provide_context",
  "confirm",
];

export function getOptionalResultFeedbackRequirement(instance: TaskInstance) {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  const taskResult = instance.result?.taskResult;
  if (taskResult?.status !== "done" || !requirement) return null;
  if (!OPTIONAL_FEEDBACK_TYPES.includes(requirement.type)) return null;
  if (requirement.timing === "before_execution" || requirement.timing === "core_task_step") return null;
  const options = requirement.options?.map((option) => option.trim()).filter(Boolean) ?? [];
  if (!options.length) return null;
  return {
    ...requirement,
    options,
  };
}

export function hasOptionalResultFeedback(instance: TaskInstance) {
  return Boolean(getOptionalResultFeedbackRequirement(instance));
}
