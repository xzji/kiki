import { stripNotificationPrefix } from "@/lib/protocol/displayText";
import { hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import type { InteractionSubmission, MissingFieldQuestion, Task, TaskInstance } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

export { isSameDisplayText, normalizeDisplayText, stripNotificationPrefix } from "@/lib/protocol/displayText";

type ReadinessItem = {
  id: string;
  label: string;
  description: string;
  source: "user" | "agent" | "system";
  status: "available" | "missing_user" | "agent_retrievable" | "not_required";
  reason: string;
  options?: string[];
  optionQuestion?: string;
  inputPlaceholder?: string;
  inputKind?: "text" | "image" | "file" | "image_or_text";
};

type TaskReadiness = {
  status: "ready" | "blocked";
  summary: string;
  items: ReadinessItem[];
};

export type AwaitingDisplayOrigin = "card" | "inbox" | "detail" | "timeline";

export type AwaitingDisplayModel = {
  active: boolean;
  origin: AwaitingDisplayOrigin;
  panelTitle: string;
  statusLabel: string;
  notice?: string;
  headline?: string;
  fields: MissingFieldQuestion[];
  hideFieldQuestions: Set<string>;
  hideOuterSummary: boolean;
  hidePendingTaskResultBlocks: boolean;
  submitted?: InteractionSubmission;
};

function titleFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "请回答问题";
  if (type === "provide_context") return "请补充任务所需信息";
  if (type === "perform_offline_action") return "请完成线下操作";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "请确认后继续";
}

function fieldActionText(field: MissingFieldQuestion) {
  const label = field.label.trim();
  if (field.inputKind === "image_or_text") return `上传或填写${label}`;
  if (field.inputKind === "image") return `上传${label}`;
  if (field.inputKind === "file") return `上传${label}`;
  return `填写${label}`;
}

function titleFromFields(instance: TaskInstance, fields: MissingFieldQuestion[]) {
  if (!fields.length) return titleFor(instance);
  return `请${fields.map(fieldActionText).join("、")}`;
}

function statusLabelFor(instance: TaskInstance, fields: MissingFieldQuestion[]) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (fields.some((field) => field.inputKind === "image" || field.inputKind === "file")) return "需上传";
  if (fields.some((field) => field.inputKind === "image_or_text")) return "需上传/填写";
  if (type === "answer") return "需作答";
  if (type === "provide_context") return "需填写";
  if (type === "perform_offline_action") return "需线下完成";
  if (type === "agent_revision_required") return "等待 Agent";
  if (type === "deliverable_gap") return "未通过验收";
  return "需确认";
}

function isTaskReadiness(value: unknown): value is TaskReadiness {
  if (!value || typeof value !== "object") return false;
  const record = value as { status?: unknown; summary?: unknown; items?: unknown };
  return (
    (record.status === "ready" || record.status === "blocked") &&
    typeof record.summary === "string" &&
    Array.isArray(record.items)
  );
}

function readinessFromInstance(instance: TaskInstance) {
  const readiness = instance.result?.structuredOutput?.taskReadiness;
  return isTaskReadiness(readiness) ? readiness : null;
}

function missingItemsFrom(readiness: TaskReadiness | null) {
  return readiness?.items.filter((item) => item.status === "missing_user" && item.source === "user") ?? [];
}

function fieldsFromInstance(instance: TaskInstance): MissingFieldQuestion[] {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  if (requirement?.fields?.length) return requirement.fields;

  const rawOptions = requirement?.options?.length ? requirement.options : [];
  const missingItems = missingItemsFrom(readinessFromInstance(instance));
  return missingItems.map((item) => ({
    id: item.id,
    label: item.label,
    question: item.optionQuestion?.trim() || item.description?.trim() || `请补充：${item.label}`,
    description: item.description || item.reason || item.label,
    options: item.options?.length ? item.options : missingItems.length === 1 ? rawOptions : [],
    inputPlaceholder: item.inputPlaceholder,
    inputKind: item.inputKind,
    source: item.source,
  }));
}

export function questionForField(field: Pick<MissingFieldQuestion, "question" | "description" | "label">) {
  return field.question?.trim() || field.description?.trim() || `请补充：${field.label}`;
}

function headlineFrom(instance: TaskInstance, fields: MissingFieldQuestion[]) {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  return (
    requirement?.question?.trim() ||
    (fields.length === 1
      ? questionForField(fields[0])
      : fields.length > 1
        ? `请补充：${fields.map((field) => field.label).join("、")}`
        : instance.awaitingUser?.reason || requirement?.reason || "")
  );
}

function noticeFrom(instance: TaskInstance) {
  const notice = stripNotificationPrefix(instance.notification?.snippet);
  return notice || undefined;
}

export function isPendingUserPlaceholderTaskResult(taskResult?: TaskResult) {
  if (!taskResult) return false;
  if (taskResult.meta.role === "pending_user_placeholder") return true;
  if (taskResult.status !== "pending_user") return false;
  const hasDecisionOrMarkdown = taskResult.blocks.some((block) => block.kind === "decision" || block.kind === "markdown");
  if (hasDecisionOrMarkdown) return false;
  const text = [
    taskResult.title,
    ...taskResult.blocks.flatMap((block) => {
      if (block.kind === "heading" || block.kind === "paragraph" || block.kind === "callout") return [block.text];
      if (block.kind === "list") return block.items;
      if (block.kind === "key_value") return block.entries.map((entry) => entry.label);
      return [];
    }),
  ].join("\n");
  return /需要.*补充|缺失.*信息|前置条件未满足/.test(text);
}

export function shouldHidePendingTaskResult(instance: TaskInstance) {
  return Boolean(instance.awaitingUser && !hasOptionalResultFeedback(instance));
}

export function buildAwaitingDisplayModel(
  _task: Task,
  instance: TaskInstance,
  origin: AwaitingDisplayOrigin,
): AwaitingDisplayModel {
  void _task;
  const active = Boolean(instance.awaitingUser && !hasOptionalResultFeedback(instance));
  const submitted = instance.result?.interactionSubmission && !instance.awaitingUser
    ? instance.result.interactionSubmission
    : undefined;
  const fields = active ? fieldsFromInstance(instance) : [];
  const headline = active ? headlineFrom(instance, fields) : undefined;
  const hideFieldQuestions = new Set<string>();

  return {
    active,
    origin,
    panelTitle: titleFromFields(instance, fields),
    statusLabel: statusLabelFor(instance, fields),
    notice: active && headline ? noticeFrom(instance) : undefined,
    headline,
    fields,
    hideFieldQuestions,
    hideOuterSummary: active,
    hidePendingTaskResultBlocks: active,
    submitted,
  };
}
