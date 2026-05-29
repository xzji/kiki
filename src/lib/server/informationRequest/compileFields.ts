import type { TaskReadinessCheck, TaskReadinessInfoItem } from "@/lib/server/taskReadinessPolicy";
import type { InteractionRequirement, MissingFieldQuestion } from "@/types/kiki";

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

function normalizeOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string")).slice(0, 3);
}

function normalizeFieldSource(value: unknown): MissingFieldQuestion["source"] {
  if (value === "agent" || value === "system") return value;
  return "user";
}

function normalizeDisplayText(value: string) {
  return value
    .replace(/[“”"「」『』《》\[\]【】]/g, "")
    .replace(/[，。！？；：、,.\s]/g, "")
    .trim();
}

function dedupeRepeatedQuestionsByLabel(fields: MissingFieldQuestion[]) {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const normalized = normalizeDisplayText(field.question);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return fields.map((field) => {
    const normalized = normalizeDisplayText(field.question);
    if (!normalized || (counts.get(normalized) ?? 0) <= 1) return field;
    return {
      ...field,
      question: `请补充：${field.label}`,
    };
  });
}

function fieldFromReadinessItem(item: TaskReadinessInfoItem): MissingFieldQuestion {
  return {
    id: item.id,
    label: item.label,
    question: item.optionQuestion?.trim() || item.description?.trim() || `请补充：${item.label}`,
    description: item.description || item.reason || item.label,
    options: normalizeOptions(item.options ?? []),
    inputPlaceholder: item.inputPlaceholder,
    source: item.source,
  };
}

export function normalizeMissingFieldQuestions(value: unknown): MissingFieldQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => {
      const label =
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim()
          : typeof item.question === "string" && item.question.trim()
            ? item.question.trim().slice(0, 24)
            : `待补充信息 ${index + 1}`;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `field_${index + 1}`;
      const question =
        typeof item.question === "string" && item.question.trim() ? item.question.trim() : `请补充：${label}`;
      const description =
        typeof item.description === "string" && item.description.trim() ? item.description.trim() : question;
      const inputPlaceholder =
        typeof item.inputPlaceholder === "string" && item.inputPlaceholder.trim()
          ? item.inputPlaceholder.trim()
          : typeof item.input_placeholder === "string" && item.input_placeholder.trim()
            ? item.input_placeholder.trim()
            : undefined;
      return {
        id,
        label,
        question,
        description,
        options: normalizeOptions(item.options),
        inputPlaceholder,
        source: normalizeFieldSource(item.source),
      };
    });
}

export function compileMissingFieldQuestions(input: {
  readiness?: TaskReadinessCheck | null;
  fields?: unknown;
  options?: unknown;
  fallbackQuestion?: string;
}): MissingFieldQuestion[] {
  const llmFields = normalizeMissingFieldQuestions(input.fields);
  const llmById = new Map(llmFields.map((field) => [field.id, field]));
  const llmByLabel = new Map(llmFields.map((field) => [field.label, field]));
  const readinessItems = input.readiness?.missingUserInfo ?? [];
  const fallbackOptions = normalizeOptions(input.options);

  if (!readinessItems.length) {
    if (llmFields.length) return dedupeRepeatedQuestionsByLabel(llmFields);
    if (!fallbackOptions.length) return [];
    const question = input.fallbackQuestion?.trim() || "请补充完成任务所需的关键信息。";
    return [
      {
        id: "user_context",
        label: "补充信息",
        question,
        description: question,
        options: fallbackOptions,
        source: "user",
      },
    ];
  }

  return dedupeRepeatedQuestionsByLabel(readinessItems.map((item) => {
    const readinessField = fieldFromReadinessItem(item);
    const llmField = llmById.get(item.id) ?? llmByLabel.get(item.label);
    if (!llmField) return readinessField;
    return {
      ...readinessField,
      ...llmField,
      id: item.id,
      label: item.label,
      question: llmField.question || readinessField.question,
      description: llmField.description || readinessField.description,
      options: llmField.options.length ? llmField.options : readinessField.options,
      inputPlaceholder: llmField.inputPlaceholder || readinessField.inputPlaceholder,
      source: item.source,
    };
  }));
}

export function createInteractionRequirementFields(readiness: TaskReadinessCheck): MissingFieldQuestion[] {
  return compileMissingFieldQuestions({ readiness });
}

export function singleFieldOptions(fields: MissingFieldQuestion[]) {
  return fields.length === 1 ? fields[0].options : [];
}

export function fieldsSuggestedActions(fields: MissingFieldQuestion[]) {
  return uniqueStrings([
    ...fields.flatMap((field) => field.options),
    ...fields.map((field) => `补充${field.label}`),
  ]).slice(0, 5);
}

export function withCompiledInteractionFields(
  requirement: InteractionRequirement,
  input: {
    readiness?: TaskReadinessCheck | null;
    fields?: unknown;
    options?: unknown;
    fallbackQuestion?: string;
  },
): InteractionRequirement {
  const fields = compileMissingFieldQuestions(input);
  if (!fields.length) return requirement;
  return {
    ...requirement,
    fields,
    options: fields.length === 1 ? fields[0].options : requirement.options ?? [],
  };
}
