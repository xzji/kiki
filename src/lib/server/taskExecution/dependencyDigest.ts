import fs from "fs";
import path from "path";

import { getTaskWorkspaceDir } from "@/lib/server/workspace/conversationWorkspace";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import type { Task, TaskInstance, TaskInstanceResult, TaskRunArtifact } from "@/types/kiki";
import type { ResultBlock, ResultCell } from "@/types/taskResult";

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "text" in value && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text.trim();
  }
  return JSON.stringify(value);
}

function truncate(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function readPersistedResult(input: { conversationId: string; taskId: string; instanceId: string }) {
  if (!input.conversationId) {
    return { resultFilePath: "", result: null as TaskInstanceResult | null };
  }
  const resultFilePath = path.join(getTaskWorkspaceDir(input), "result.json");
  if (!fs.existsSync(resultFilePath)) {
    return { resultFilePath, result: null as TaskInstanceResult | null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resultFilePath, "utf8")) as TaskInstanceResult;
    return { resultFilePath, result: parsed };
  } catch {
    return { resultFilePath, result: null as TaskInstanceResult | null };
  }
}

function chooseResult(instance: TaskInstance, persisted: TaskInstanceResult | null) {
  return {
    ...(persisted ?? {}),
    ...(instance.result ?? {}),
    taskResult: instance.result?.taskResult ?? persisted?.taskResult,
    structuredOutput: instance.result?.structuredOutput ?? persisted?.structuredOutput,
    artifacts: instance.result?.artifacts ?? persisted?.artifacts,
    interactionRequirement: instance.result?.interactionRequirement ?? persisted?.interactionRequirement,
    interactionSubmission: instance.result?.interactionSubmission ?? persisted?.interactionSubmission,
  } satisfies TaskInstanceResult;
}

function artifactDigest(artifacts: TaskRunArtifact[] | undefined, maxArtifacts: number) {
  return (artifacts ?? []).slice(0, maxArtifacts).map((artifact, index) => ({
    id: artifact.id || `artifact-${index + 1}`,
    label: artifact.label || artifact.kind || `产物 ${index + 1}`,
    localPath: "localPath" in artifact && typeof artifact.localPath === "string" ? artifact.localPath : undefined,
  }));
}

function extractUserDecision(result: TaskInstanceResult, instance: TaskInstance) {
  const parts: string[] = [];
  const submission = result.interactionSubmission as unknown;
  if (submission && typeof submission === "object") {
    const record = submission as Record<string, unknown>;
    if (typeof record.feedback === "string") parts.push(record.feedback);
    if (record.fields && typeof record.fields === "object") parts.push(JSON.stringify(record.fields));
    if (typeof record.action === "string") parts.push(record.action);
  }
  if (instance.awaitingUser?.reason) parts.push(instance.awaitingUser.reason);
  if (result.interactionRequirement?.question) parts.push(result.interactionRequirement.question);
  return truncate(parts.filter(Boolean).join("\n"), 600) || undefined;
}

function extractBlockDigest(blocks: ResultBlock[] | undefined, budget: TaskExecutionContext["budget"]) {
  const keyPoints: string[] = [];
  const tableRows: Array<Record<string, string>> = [];
  const keyValues: Array<{ key: string; value: string }> = [];
  const lists: Array<{ heading?: string; items: string[] }> = [];
  let currentHeading: string | undefined;

  for (const block of blocks ?? []) {
    if (block.kind === "heading") {
      currentHeading = block.text;
      keyPoints.push(truncate(block.text, 200));
    } else if (block.kind === "paragraph" || block.kind === "callout") {
      keyPoints.push(truncate(block.text, 200));
    } else if (block.kind === "markdown") {
      keyPoints.push(truncate(block.content.replace(/\s+/g, " "), 200));
    } else if (block.kind === "list") {
      const items = block.items.map((item) => truncate(item, 200)).slice(0, budget.maxKeyPoints);
      lists.push({ heading: currentHeading, items });
      keyPoints.push(...items);
    } else if (block.kind === "key_value") {
      for (const entry of block.entries) {
        keyValues.push({ key: entry.label, value: truncate(text(entry.value), 200) });
      }
    } else if (block.kind === "comparison_table") {
      for (const row of block.rows.slice(0, 5)) {
        const normalized: Record<string, string> = {};
        for (const column of block.columns) {
          normalized[column] = truncate(text((row as Record<string, ResultCell>)[column]), 160);
        }
        tableRows.push(normalized);
      }
    } else if (block.kind === "decision") {
      keyPoints.push(truncate(block.question, 200));
      keyPoints.push(...block.options.map((option) => truncate(`${option.label}${option.rationale ? `：${option.rationale}` : ""}`, 200)));
    }
  }

  return {
    keyPoints: keyPoints.filter(Boolean).slice(0, budget.maxKeyPoints),
    tableRows: tableRows.length ? tableRows : undefined,
    keyValues: keyValues.length ? keyValues.slice(0, budget.maxKeyPoints) : undefined,
    lists: lists.length ? lists.slice(0, 3) : undefined,
  };
}

export function extractDependencyDigest(input: {
  conversationId: string;
  task: Task;
  instance: TaskInstance;
  budget: TaskExecutionContext["budget"];
}) {
  const persisted = readPersistedResult({
    conversationId: input.conversationId,
    taskId: input.task.id,
    instanceId: input.instance.id,
  });
  const result = chooseResult(input.instance, persisted.result);
  const blockDigest = extractBlockDigest(result.taskResult?.blocks, input.budget);
  const payloadSummary = input.instance.payload.kind === "generic_result" ? input.instance.payload.summary : undefined;
  const summary = result.summary || result.taskResult?.title || payloadSummary;

  return {
    summary: truncate(summary || input.task.expectedOutcome || input.task.title, 600),
    userDecision: extractUserDecision(result, input.instance),
    keyPoints: blockDigest.keyPoints,
    tableRows: blockDigest.tableRows,
    keyValues: blockDigest.keyValues,
    lists: blockDigest.lists,
    artifacts: artifactDigest(result.artifacts, input.budget.maxArtifacts),
    resultPointer: {
      kind: "fs" as const,
      relativePath: `dependencies/${input.task.id}/result.json`,
    },
    sourceResultFilePath: persisted.resultFilePath && fs.existsSync(persisted.resultFilePath) ? persisted.resultFilePath : undefined,
  };
}
