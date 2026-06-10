import fs from "fs";
import path from "path";

import { getConversationWorkspacesRootDir } from "@/lib/server/storage/paths";
import { sanitizeWorkspaceSegment, writeJsonFileAtomic, writeTextFileAtomic } from "@/lib/server/workspace/conversationWorkspace";

export type ClaudeTraceStatus = "running" | "completed" | "failed" | "aborted";

export type ClaudeTraceMetadata = {
  traceId: string;
  conversationId?: string;
  requestId?: string;
  scope?: string;
  phase?: string;
  stepLabel?: string;
  status: ClaudeTraceStatus;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  cwd: string;
  cliPath: string;
  args: string[];
  permissionMode?: string;
  toolPolicy?: unknown;
  resumeSessionId?: string;
  traceDir: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  thinkingPath: string;
  outputPath: string;
  parsedEventsPath: string;
  errorMessage?: string;
};

export type ClaudeTraceSummary = ClaudeTraceMetadata & {
  relativeTraceDir: string;
};

export type ClaudeTraceDetail = ClaudeTraceSummary & {
  prompt: string;
  stdout: string;
  stderr: string;
  thinking: string;
  output: string;
  parsedEvents: string;
};

export type ClaudeTraceWriter = {
  traceId: string;
  relativeTraceDir: string;
  writePrompt: (value: string) => void;
  appendStdout: (value: string) => void;
  appendStderr: (value: string) => void;
  appendParsedEvent: (value: unknown) => void;
  appendThinking: (value: string) => void;
  writeOutput: (value: string) => void;
  finish: (status: ClaudeTraceStatus, errorMessage?: string) => void;
};

type ConversationWorkspaceRoot = {
  workspaceDir: string;
  conversationId?: string;
};

function isDevTraceEnabled() {
  return process.env.NODE_ENV === "development";
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function appendText(filePath: string, value: string) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, value, "utf8");
}

function readTextFile(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function assertInside(parentDir: string, targetPath: string) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  if (target !== parent && !target.startsWith(`${parent}${path.sep}`)) {
    throw new Error("Claude Trace 路径不在会话 workspace 内");
  }
}

function findConversationWorkspaceRoot(cwd: string): ConversationWorkspaceRoot | null {
  const rootDir = path.resolve(getConversationWorkspacesRootDir());
  let current = path.resolve(cwd);
  if (!current.startsWith(`${rootDir}${path.sep}`) && current !== rootDir) return null;

  while (current.startsWith(rootDir)) {
    const workspaceFile = path.join(current, "workspace.json");
    if (fs.existsSync(workspaceFile)) {
      const metadata = readJsonFile<{ conversationId?: string; workspaceDir?: string }>(workspaceFile);
      return {
        workspaceDir: current,
        conversationId: metadata?.conversationId,
      };
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  return null;
}

function relativeToWorkspace(workspaceDir: string, filePath: string) {
  return path.relative(workspaceDir, filePath);
}

function appendJsonLine(filePath: string, value: unknown) {
  appendText(filePath, `${JSON.stringify(value)}\n`);
}

function toTraceSummary(workspaceDir: string, metadata: ClaudeTraceMetadata): ClaudeTraceSummary {
  return {
    ...metadata,
    relativeTraceDir: relativeToWorkspace(workspaceDir, metadata.traceDir),
  };
}

export function createClaudeTrace(input: {
  cwd: string;
  cliPath: string;
  args: string[];
  permissionMode?: string;
  toolPolicy?: unknown;
  resumeSessionId?: string;
  requestId?: string;
  scope?: string;
  phase?: string;
  stepLabel?: string;
}): ClaudeTraceWriter | null {
  if (!isDevTraceEnabled()) return null;

  const workspace = findConversationWorkspaceRoot(input.cwd);
  if (!workspace) return null;

  const startedAt = new Date().toISOString();
  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const label = sanitizeWorkspaceSegment(input.stepLabel ?? input.phase ?? "claude");
  const traceDir = path.join(
    workspace.workspaceDir,
    "logs",
    "claude-traces",
    `${startedAt.replace(/[:.]/g, "-")}-${label}-${traceId}`,
  );
  assertInside(workspace.workspaceDir, traceDir);
  ensureDir(traceDir);

  const promptPath = path.join(traceDir, "prompt.txt");
  const stdoutPath = path.join(traceDir, "stdout.jsonl");
  const stderrPath = path.join(traceDir, "stderr.txt");
  const thinkingPath = path.join(traceDir, "thinking.txt");
  const outputPath = path.join(traceDir, "output.txt");
  const parsedEventsPath = path.join(traceDir, "parsed-events.jsonl");
  const metadataPath = path.join(traceDir, "metadata.json");

  let metadata: ClaudeTraceMetadata = {
    traceId,
    conversationId: workspace.conversationId,
    requestId: input.requestId,
    scope: input.scope,
    phase: input.phase,
    stepLabel: input.stepLabel,
    status: "running",
    startedAt,
    cwd: input.cwd,
    cliPath: input.cliPath,
    args: input.args,
    permissionMode: input.permissionMode,
    toolPolicy: input.toolPolicy,
    resumeSessionId: input.resumeSessionId,
    traceDir,
    promptPath,
    stdoutPath,
    stderrPath,
    thinkingPath,
    outputPath,
    parsedEventsPath,
  };

  const writeMetadata = () => writeJsonFileAtomic(metadataPath, metadata);
  writeMetadata();
  writeTextFileAtomic(promptPath, "");
  writeTextFileAtomic(stdoutPath, "");
  writeTextFileAtomic(stderrPath, "");
  writeTextFileAtomic(thinkingPath, "");
  writeTextFileAtomic(outputPath, "");
  writeTextFileAtomic(parsedEventsPath, "");

  return {
    traceId,
    relativeTraceDir: relativeToWorkspace(workspace.workspaceDir, traceDir),
    writePrompt: (value) => writeTextFileAtomic(promptPath, value),
    appendStdout: (value) => appendText(stdoutPath, value),
    appendStderr: (value) => appendText(stderrPath, value),
    appendParsedEvent: (value) => appendJsonLine(parsedEventsPath, value),
    appendThinking: (value) => appendText(thinkingPath, value),
    writeOutput: (value) => writeTextFileAtomic(outputPath, value),
    finish: (status, errorMessage) => {
      const finishedAt = new Date().toISOString();
      metadata = {
        ...metadata,
        status,
        finishedAt,
        elapsedMs: Date.parse(finishedAt) - Date.parse(metadata.startedAt),
        errorMessage,
      };
      writeMetadata();
    },
  };
}

export function listClaudeTraces(input: { conversationId?: string; limit?: number } = {}): ClaudeTraceSummary[] {
  if (!isDevTraceEnabled()) return [];

  const rootDir = getConversationWorkspacesRootDir();
  const conversationDirs = input.conversationId
    ? [path.join(rootDir, sanitizeWorkspaceSegment(input.conversationId))]
    : fs.existsSync(rootDir)
      ? fs.readdirSync(rootDir).map((name) => path.join(rootDir, name))
      : [];

  const traces: ClaudeTraceSummary[] = [];
  for (const workspaceDir of conversationDirs) {
    const tracesDir = path.join(workspaceDir, "logs", "claude-traces");
    if (!fs.existsSync(tracesDir)) continue;
    for (const entry of fs.readdirSync(tracesDir)) {
      const metadataPath = path.join(tracesDir, entry, "metadata.json");
      const metadata = readJsonFile<ClaudeTraceMetadata>(metadataPath);
      if (!metadata) continue;
      traces.push(toTraceSummary(workspaceDir, metadata));
    }
  }

  return traces
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, Math.max(1, Math.min(input.limit ?? 50, 200)));
}

export function readClaudeTrace(traceId: string): ClaudeTraceDetail | null {
  if (!isDevTraceEnabled()) return null;
  const summary = listClaudeTraces({ limit: 200 }).find((trace) => trace.traceId === traceId);
  if (!summary) return null;
  const metadataPath = path.join(summary.traceDir, "metadata.json");
  const metadata = readJsonFile<ClaudeTraceMetadata>(metadataPath);
  if (!metadata) return null;
  const workspace = findConversationWorkspaceRoot(metadata.traceDir);
  const workspaceDir = workspace?.workspaceDir ?? path.dirname(path.dirname(path.dirname(metadata.traceDir)));

  return {
    ...toTraceSummary(workspaceDir, metadata),
    prompt: readTextFile(metadata.promptPath),
    stdout: readTextFile(metadata.stdoutPath),
    stderr: readTextFile(metadata.stderrPath),
    thinking: readTextFile(metadata.thinkingPath),
    output: readTextFile(metadata.outputPath),
    parsedEvents: readTextFile(metadata.parsedEventsPath),
  };
}
