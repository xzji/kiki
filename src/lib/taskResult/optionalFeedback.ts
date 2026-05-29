import type { InteractionRequirement, TaskInstance } from "@/types/kiki";

const OPTIONAL_FEEDBACK_TYPES: Array<InteractionRequirement["type"]> = [
  "answer",
  "provide_context",
  "confirm",
];

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function getOptionalResultFeedbackRequirement(instance: TaskInstance) {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  const taskResult = instance.result?.taskResult;
  if (taskResult?.status !== "done" || !requirement) return null;
  if (!OPTIONAL_FEEDBACK_TYPES.includes(requirement.type)) return null;
  if (requirement.timing === "before_execution" || requirement.timing === "core_task_step") return null;
  const options = requirement.options?.map((option) => option.trim()).filter(Boolean) ?? [];
  const fields = requirement.fields
    ?.map((field) => ({
      ...field,
      options: field.options.map((option) => option.trim()).filter(Boolean),
    }))
    .filter((field) => field.options.length > 0) ?? [];
  if (!options.length && !fields.length) return null;
  const flattenedOptions = options.length
    ? options
    : uniqueStrings(fields.flatMap((field) => field.options.map((option) => `${field.label}：${option}`)));
  return {
    ...requirement,
    options: flattenedOptions,
    fields,
  };
}

export function hasOptionalResultFeedback(instance: TaskInstance) {
  return Boolean(getOptionalResultFeedbackRequirement(instance));
}
