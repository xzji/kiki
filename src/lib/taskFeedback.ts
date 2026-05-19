import type { ArtifactRef } from "@/types/artifact";
import type { Task, TaskInstance } from "@/types/kiki";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

export type TaskFeedbackDecision = "acknowledge" | "clarify" | "rerun";

export type TaskFeedbackRecord = {
  id: string;
  sourceMessageId?: string;
  userMessage: string;
  decision: TaskFeedbackDecision;
  assistantMessage: string;
  revisionContext?: string;
  createdAt: string;
  rerunInstanceId?: string;
};

function truncate(value: string, max = 600) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function resultCellToText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "text" in value && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  return "";
}

function blockTitle(block: ResultBlock) {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "paragraph":
      return block.text;
    case "markdown":
      return block.content;
    case "list":
      return block.items.slice(0, 3).join("；");
    case "key_value":
      return block.entries.slice(0, 3).map((entry) => `${entry.label}: ${resultCellToText(entry.value)}`).join("；");
    case "comparison_table":
      return `对比表：${block.columns.join(" / ")}，${block.rows.length} 行`;
    case "decision":
      return `决策：${block.question}`;
    case "callout":
      return block.text;
    default:
      return "";
  }
}

function artifactLabel(ref: ArtifactRef) {
  if (ref.kind === "file") return ref.label || "文件产物";
  if (ref.kind === "external_link") return ref.label || ref.url || "外部链接";
  if (ref.kind === "webapp") return ref.label || "可执行小应用";
  if (ref.kind === "external_embed") return ref.label || "外部嵌入";
  return ref.id;
}

export function summarizeTaskResult(taskResult?: TaskResult) {
  if (!taskResult) return "";
  const blockLines = (taskResult.blocks ?? [])
    .slice(0, 6)
    .map((block, index) => `${index + 1}. [${block.kind}] ${truncate(blockTitle(block), 180)}`)
    .filter((line) => !line.endsWith("] "));
  const artifactLines = (taskResult.artifactRefs ?? [])
    .slice(0, 6)
    .map((ref, index) => `${index + 1}. [${ref.kind}] ${truncate(artifactLabel(ref), 180)}`);
  return [
    `标题：${taskResult.title}`,
    `状态：${taskResult.status}`,
    blockLines.length ? `主要内容：\n${blockLines.join("\n")}` : "",
    artifactLines.length ? `产物文件/链接：\n${artifactLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export function buildTaskQuoteContent(task: Task, instance: TaskInstance) {
  const resultSummary = summarizeTaskResult(instance.result?.taskResult);
  const fallback = instance.result?.summary || instance.result?.finalMessage || instance.intro;
  return [
    `任务：${task.title.replace(/^任务\d+：/, "")}`,
    `状态：${instance.status}`,
    resultSummary || `摘要：${truncate(fallback, 500)}`,
  ].filter(Boolean).join("\n");
}

export function getFeedbackHistory(instance: TaskInstance): TaskFeedbackRecord[] {
  const raw = instance.result?.structuredOutput?.userFeedbackHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is TaskFeedbackRecord => {
    return Boolean(
      item &&
        typeof item === "object" &&
        typeof (item as TaskFeedbackRecord).id === "string" &&
        typeof (item as TaskFeedbackRecord).userMessage === "string" &&
        typeof (item as TaskFeedbackRecord).decision === "string" &&
        typeof (item as TaskFeedbackRecord).assistantMessage === "string",
    );
  });
}

export function withFeedbackRecord(instance: TaskInstance, record: TaskFeedbackRecord): TaskInstance {
  const history = getFeedbackHistory(instance);
  const nextHistory = history.some((item) => item.id === record.id || (record.sourceMessageId && item.sourceMessageId === record.sourceMessageId))
    ? history
    : [...history, record];
  return {
    ...instance,
    result: {
      ...instance.result,
      structuredOutput: {
        ...(instance.result?.structuredOutput ?? {}),
        userFeedbackHistory: nextHistory,
      },
    },
  };
}
