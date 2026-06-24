import type { RuntimeJobRecord } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry } from "@/types/goalTelemetry";

const MAX_CONTEXT_CHARS = 8000;
const MAX_TRAJECTORY_STEPS = 18;
const MAX_LOG_ENTRIES = 16;

export function isRuntimeJobTerminationReason(reason?: string) {
  return Boolean(reason && /终止|中止|停止|terminate|stop/i.test(reason));
}

export function isPausedRuntimeJob(job: RuntimeJobRecord | null): job is RuntimeJobRecord {
  return Boolean(job && job.status === "cancelled" && !isRuntimeJobTerminationReason(job.lastError));
}

function isTrajectoryStep(value: unknown): value is ExecutionTrajectoryStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const maybe = value as Partial<ExecutionTrajectoryStep>;
  return typeof maybe.id === "string" && typeof maybe.title === "string" && typeof maybe.status === "string";
}

function readProgressTrajectory(job: RuntimeJobRecord) {
  const value = job.progress?.resultPayload?.trajectory;
  if (!Array.isArray(value)) return [];
  return value.filter(isTrajectoryStep);
}

export function extractCheckpointTrajectory(job: RuntimeJobRecord): ExecutionTrajectoryStep[] {
  if (job.trajectory.length > 0) return job.trajectory;
  return readProgressTrajectory(job);
}

function clip(value: string | undefined, max = 600) {
  const text = value?.trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatTrajectoryStep(step: ExecutionTrajectoryStep) {
  const parts = [`[${step.index}] ${step.status} ${step.type}: ${step.title}`];
  if (step.toolCall?.name) {
    parts.push(`工具: ${step.toolCall.name}${step.toolCall.summary ? ` - ${clip(step.toolCall.summary, 240)}` : ""}`);
  }
  if (step.toolResult) {
    parts.push(step.toolResult.ok ? "工具结果: 成功" : `工具结果: 失败 ${clip(step.toolResult.error, 240)}`);
  }
  if (step.thought) parts.push(`摘要: ${clip(step.thought, 360)}`);
  return parts.join("；");
}

function formatLogEntry(log: GoalServerLogEntry) {
  const parts = [`${log.timestamp} ${log.level}${log.phase ? `/${log.phase}` : ""}: ${log.message}`];
  if (log.toolName) parts.push(`工具: ${log.toolName}`);
  if (log.details) parts.push(`详情: ${clip(log.details, 360)}`);
  return parts.join("；");
}

function trimContext(value: string) {
  if (value.length <= MAX_CONTEXT_CHARS) return value;
  return `${value.slice(0, MAX_CONTEXT_CHARS)}\n\n[系统提示] 上下文已按长度截断，请优先依据保留的最近步骤继续。`;
}

export function buildPauseResumeContext(
  job: RuntimeJobRecord,
  input: { reason?: string; pausedAt?: string } = {},
) {
  const trajectory = extractCheckpointTrajectory(job);
  const recentSteps = trajectory.slice(-MAX_TRAJECTORY_STEPS);
  const recentLogs = job.logs.slice(-MAX_LOG_ENTRIES);
  const pausedAt = input.pausedAt ?? job.finishedAt ?? job.updatedAt;
  const reason = input.reason ?? job.lastError ?? "用户暂停任务执行";
  const progress = job.progress;
  const lines = [
    "这是一次由用户暂停后恢复的任务，请基于上一轮执行上下文继续，而不是从头重做。",
    "",
    "恢复规则：",
    "- 已完成的工具调用、检索、文件读取和分析结论默认视为可复用。",
    "- 避免重复执行上一轮已经完成且结果明确的工具调用；如必须重复，请先说明原因。",
    "- 从最后一个 running/未完成步骤或最近进展继续推进。",
    "- 如果上一轮中止发生在工具授权或外部等待点附近，优先恢复该步骤之后的执行。",
    "",
    "暂停信息：",
    `- 暂停时间：${pausedAt}`,
    `- 暂停原因：${reason}`,
    `- 上一轮 requestId：${job.requestId ?? "unknown"}`,
    `- taskInstanceId：${job.taskInstanceId ?? job.payload.instance.id}`,
    "",
    "上一轮最后进展：",
    progress
      ? `- ${progress.phase} / ${progress.status}: ${progress.message}${progress.error ? `；错误：${progress.error}` : ""}`
      : "- 无 progress 记录",
    "",
    "上一轮最近执行轨迹：",
    ...(recentSteps.length > 0 ? recentSteps.map((step) => `- ${formatTrajectoryStep(step)}`) : ["- 无 trajectory 记录"]),
    "",
    "上一轮最近运行日志：",
    ...(recentLogs.length > 0 ? recentLogs.map((log) => `- ${formatLogEntry(log)}`) : ["- 无运行日志"]),
  ];
  return trimContext(lines.join("\n"));
}

export function buildPausedJobResumePatch(
  job: RuntimeJobRecord,
  input: { reason?: string; pausedAt?: string } = {},
): {
  resumeContext: string;
  trajectory: ExecutionTrajectoryStep[];
  result: Record<string, unknown>;
} {
  const trajectory = extractCheckpointTrajectory(job);
  const pausedAt = input.pausedAt ?? job.finishedAt ?? job.updatedAt;
  return {
    resumeContext: buildPauseResumeContext(job, { ...input, pausedAt }),
    trajectory,
    result: {
      ...(job.result ?? {}),
      pauseResumeCheckpoint: {
        sourceJobId: job.id,
        sourceRequestId: job.requestId,
        pausedAt,
        previousTrajectorySteps: trajectory.length,
      },
    },
  };
}
