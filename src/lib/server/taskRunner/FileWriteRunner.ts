import type { ArtifactRef } from "@/types/artifact";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

export type FileWriteSpec = {
  filename: string;
  mime: string;
  content: string;
};

export type FileWriteRunnerResult = {
  taskResult: TaskResult;
  artifactRefs: ArtifactRef[];
};

export function normalizeFileWriteSpecs(value: unknown): FileWriteSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      filename: typeof item.filename === "string" ? item.filename.trim() : "",
      mime: typeof item.mime === "string" && item.mime.trim() ? item.mime.trim() : "text/plain; charset=utf-8",
      content: typeof item.content === "string" ? item.content : "",
    }))
    .filter((item) => item.filename && /\.(md|txt|csv|json)$/i.test(item.filename) && item.content.trim().length > 0);
}

export function ensureFileWriteSummaryBlocks(input: { taskResult: TaskResult; fileCount: number }): TaskResult {
  if (input.taskResult.blocks.length > 0) return input.taskResult;
  const blocks: ResultBlock[] = [
    { kind: "heading", text: input.taskResult.title || "文件产物已生成", level: 2 },
    { kind: "callout", tone: "info", text: `已生成 ${input.fileCount} 个文件产物，请在下方下载查看。` },
  ];
  return {
    ...input.taskResult,
    blocks,
  };
}
