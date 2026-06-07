import type { TaskExpectedResult } from "@/types/kiki";

export type TaskFieldPath =
  | "title"
  | "description"
  | "expectedOutcome"
  | "expectedResult.completionCriteria"
  | "expectedResult.requiredBlocks"
  | "triggerRule";

export type TaskFieldMergeStrategy = "replace" | "append";

export type TaskFieldSpec = {
  path: TaskFieldPath;
  type: "string" | "string[]";
  mergeStrategy: TaskFieldMergeStrategy;
  confirmLevel: "required" | "light";
};

export const TASK_FIELD_REGISTRY: TaskFieldSpec[] = [
  { path: "title", type: "string", mergeStrategy: "replace", confirmLevel: "required" },
  { path: "description", type: "string", mergeStrategy: "replace", confirmLevel: "required" },
  { path: "expectedOutcome", type: "string", mergeStrategy: "replace", confirmLevel: "required" },
  {
    path: "expectedResult.completionCriteria",
    type: "string",
    mergeStrategy: "append",
    confirmLevel: "required",
  },
  {
    path: "expectedResult.requiredBlocks",
    type: "string[]",
    mergeStrategy: "append",
    confirmLevel: "required",
  },
  { path: "triggerRule", type: "string", mergeStrategy: "replace", confirmLevel: "required" },
];

const REQUIRED_BLOCKS: NonNullable<TaskExpectedResult["requiredBlocks"]> = [
  "heading",
  "paragraph",
  "markdown",
  "list",
  "key_value",
  "comparison_table",
  "decision",
  "callout",
];

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\n|；|;/)
      .map((item) => item.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export function appendText(existing: string | undefined, addition: string | undefined) {
  const lines = normalizeStringList([...(existing ? existing.split(/\n/) : []), ...(addition ? addition.split(/\n/) : [])]);
  return lines.length ? Array.from(new Set(lines)).join("\n") : undefined;
}

export function normalizeRequiredBlocks(value: unknown): TaskExpectedResult["requiredBlocks"] | undefined {
  const blocks = normalizeStringList(value).filter(
    (item): item is NonNullable<TaskExpectedResult["requiredBlocks"]>[number] =>
      REQUIRED_BLOCKS.includes(item as NonNullable<TaskExpectedResult["requiredBlocks"]>[number]),
  );
  return blocks.length ? Array.from(new Set(blocks)) : undefined;
}
