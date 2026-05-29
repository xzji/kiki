import fs from "fs";
import path from "path";

import { getConversationWorkspacesRootDir } from "@/lib/server/storage/paths";

export type ConversationWorkspaceInfo = {
  conversationId: string;
  workspaceDir: string;
  contextDir: string;
  planningDir: string;
  goalsDir: string;
  tasksDir: string;
  createdAt: string;
  version: 1;
};

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function sanitizeWorkspaceSegment(value: string) {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return sanitized || "unknown";
}

export function getConversationWorkspaceDir(conversationId: string) {
  return path.join(getConversationWorkspacesRootDir(), sanitizeWorkspaceSegment(conversationId));
}

export function getConversationContextDir(conversationId: string) {
  return path.join(getConversationWorkspaceDir(conversationId), "context");
}

export function getConversationContextFilePath(conversationId: string) {
  return path.join(getConversationContextDir(conversationId), "context.md");
}

export function getConversationMessagesFilePath(conversationId: string) {
  return path.join(getConversationContextDir(conversationId), "messages.json");
}

export function getPlanningStateFilePath(conversationId: string) {
  return path.join(getConversationWorkspaceDir(conversationId), "planning", "state.json");
}

export function getPlanningCheckpointFilePath(conversationId: string) {
  return path.join(getConversationWorkspaceDir(conversationId), "planning", "checkpoint.json");
}

export function getGoalSnapshotFilePath(conversationId: string) {
  return path.join(getConversationWorkspaceDir(conversationId), "goals", "goal.json");
}

export function getTaskWorkspaceDir(input: { conversationId: string; taskId: string; instanceId: string }) {
  return path.join(
    getConversationWorkspaceDir(input.conversationId),
    "tasks",
    sanitizeWorkspaceSegment(input.taskId),
    sanitizeWorkspaceSegment(input.instanceId),
  );
}

export function assertPathInsideWorkspace(input: { workspaceDir: string; targetPath: string }) {
  const workspaceDir = path.resolve(input.workspaceDir);
  const targetPath = path.resolve(input.targetPath);
  if (targetPath !== workspaceDir && !targetPath.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new Error("目标路径不在当前会话 workspace 内");
  }
}

export function writeTextFileAtomic(filePath: string, value: string) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, value, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function writeJsonFileAtomic(filePath: string, value: unknown) {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePlanningParseFailureSnapshot(input: {
  conversationId: string;
  requestId?: string;
  phase?: string;
  stage?: "draft_parse" | "draft_validate" | "compile" | "review" | "final_validate";
  stepLabel?: string;
  errorMessage: string;
  rawOutput: string;
  repairedOutput?: string;
  repairedCandidate?: string;
  schemaErrors?: unknown;
  artifactCandidates?: unknown;
  recoveredArtifactPath?: string;
  successDraftCount?: number;
  failedDraftIndices?: number[];
  droppedReasons?: unknown;
  rawDraftBatch?: string;
  compiledTasksPreview?: unknown;
}) {
  const workspace = ensureConversationWorkspace(input.conversationId);
  const parseFailuresDir = ensureDir(path.join(workspace.planningDir, "raw", "parse-failures"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = sanitizeWorkspaceSegment(`${input.phase ?? "unknown"}-${input.stepLabel ?? "parse_failure"}`);
  const filePath = path.join(parseFailuresDir, `${timestamp}-${label}.json`);
  assertPathInsideWorkspace({ workspaceDir: workspace.workspaceDir, targetPath: filePath });
  writeJsonFileAtomic(filePath, {
    capturedAt: new Date().toISOString(),
    requestId: input.requestId,
    phase: input.phase,
    stage: input.stage,
    stepLabel: input.stepLabel,
    errorMessage: input.errorMessage,
    rawOutput: input.rawOutput,
    repairedOutput: input.repairedOutput,
    repairedCandidate: input.repairedCandidate,
    schemaErrors: input.schemaErrors,
    artifactCandidates: input.artifactCandidates,
    recoveredArtifactPath: input.recoveredArtifactPath,
    successDraftCount: input.successDraftCount,
    failedDraftIndices: input.failedDraftIndices,
    droppedReasons: input.droppedReasons,
    rawDraftBatch: input.rawDraftBatch,
    compiledTasksPreview: input.compiledTasksPreview,
  });
  return {
    filePath,
    relativePath: path.relative(workspace.workspaceDir, filePath),
  };
}

export function writeTaskParseFailureSnapshot(input: {
  workspaceDir: string;
  taskWorkspaceDir: string;
  requestId?: string;
  taskId: string;
  instanceId: string;
  errorMessage: string;
  rawOutput: string;
  balancedSnippet?: string;
  contextExcerpt?: string;
  parseCandidates?: Array<{
    label: string;
    value: string;
    error?: string;
  }>;
}) {
  const parseFailuresDir = ensureDir(path.join(input.taskWorkspaceDir, "parse-failures"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(parseFailuresDir, `${timestamp}-task-result-parse-failure.json`);
  assertPathInsideWorkspace({ workspaceDir: input.workspaceDir, targetPath: filePath });
  writeJsonFileAtomic(filePath, {
    capturedAt: new Date().toISOString(),
    requestId: input.requestId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    errorMessage: input.errorMessage,
    contextExcerpt: input.contextExcerpt,
    rawOutput: input.rawOutput,
    balancedSnippet: input.balancedSnippet,
    parseCandidates: input.parseCandidates,
  });
  return {
    filePath,
    relativePath: path.relative(input.workspaceDir, filePath),
  };
}

export function ensureConversationWorkspace(conversationId: string): ConversationWorkspaceInfo {
  const workspaceDir = ensureDir(getConversationWorkspaceDir(conversationId));
  const contextDir = ensureDir(path.join(workspaceDir, "context"));
  const planningDir = ensureDir(path.join(workspaceDir, "planning"));
  ensureDir(path.join(planningDir, "raw"));
  const goalsDir = ensureDir(path.join(workspaceDir, "goals"));
  const tasksDir = ensureDir(path.join(workspaceDir, "tasks"));
  ensureDir(path.join(workspaceDir, "attachments"));
  ensureDir(path.join(workspaceDir, "exports"));
  ensureDir(path.join(workspaceDir, "logs"));

  const workspaceFilePath = path.join(workspaceDir, "workspace.json");
  let createdAt = new Date().toISOString();
  if (fs.existsSync(workspaceFilePath)) {
    try {
      const current = JSON.parse(fs.readFileSync(workspaceFilePath, "utf8")) as { createdAt?: string };
      createdAt = current.createdAt || createdAt;
    } catch {
      // Rewrite invalid metadata below.
    }
  }
  const info: ConversationWorkspaceInfo = {
    conversationId,
    workspaceDir,
    contextDir,
    planningDir,
    goalsDir,
    tasksDir,
    createdAt,
    version: 1,
  };
  writeJsonFileAtomic(workspaceFilePath, info);
  if (!fs.existsSync(getConversationMessagesFilePath(conversationId))) {
    writeJsonFileAtomic(getConversationMessagesFilePath(conversationId), []);
  }
  if (!fs.existsSync(getConversationContextFilePath(conversationId))) {
    writeTextFileAtomic(getConversationContextFilePath(conversationId), "# 当前会话上下文\n\n暂无会话上下文。\n");
  }
  return info;
}

export function ensureTaskWorkspace(input: { conversationId: string; taskId: string; instanceId: string }) {
  ensureConversationWorkspace(input.conversationId);
  const taskWorkspaceDir = ensureDir(getTaskWorkspaceDir(input));
  ensureDir(path.join(taskWorkspaceDir, "artifacts"));
  return taskWorkspaceDir;
}

export function deleteConversationWorkspace(conversationId: string) {
  const workspaceDir = getConversationWorkspaceDir(conversationId);
  const rootDir = getConversationWorkspacesRootDir();
  assertPathInsideWorkspace({ workspaceDir: rootDir, targetPath: workspaceDir });
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

export function writeTaskPromptFile(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
  content: string;
}) {
  const taskWorkspaceDir = ensureTaskWorkspace(input);
  const filePath = path.join(taskWorkspaceDir, "prompt.md");
  writeTextFileAtomic(filePath, input.content);
  return filePath;
}

export function writeTaskMarkdownLogFile(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
  fileName: string;
  content: string;
}) {
  const taskWorkspaceDir = ensureTaskWorkspace(input);
  const logsDir = ensureDir(path.join(taskWorkspaceDir, "logs"));
  const safeFileName = sanitizeWorkspaceSegment(input.fileName.replace(/\.md$/i, ""));
  const filePath = path.join(logsDir, `${safeFileName}.md`);
  writeTextFileAtomic(filePath, input.content.endsWith("\n") ? input.content : `${input.content}\n`);
  return filePath;
}

export function writeTaskRunSnapshot(input: {
  conversationId: string;
  taskId: string;
  instanceId: string;
  trajectory?: unknown;
  progress?: unknown;
  result?: unknown;
}) {
  const taskWorkspaceDir = ensureTaskWorkspace(input);
  if (input.trajectory !== undefined) writeJsonFileAtomic(path.join(taskWorkspaceDir, "trajectory.json"), input.trajectory);
  if (input.progress !== undefined) writeJsonFileAtomic(path.join(taskWorkspaceDir, "progress.json"), input.progress);
  if (input.result !== undefined) writeJsonFileAtomic(path.join(taskWorkspaceDir, "result.json"), input.result);
}
