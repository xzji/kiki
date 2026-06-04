const DEFAULT_REASON_LIMIT = 240;

export type FailureReasonLogLike = {
  level?: string;
  details?: string;
  message?: string;
};

export type ExtractFailureReasonInput = {
  progressError?: unknown;
  resultPayload?: Record<string, unknown> | null;
  executionErrorMessage?: unknown;
  resultSummary?: unknown;
  resultFinalMessage?: unknown;
  logs?: FailureReasonLogLike[];
};

export function compactFailureReason(value?: unknown, limit = DEFAULT_REASON_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function latestErrorLog(logs?: FailureReasonLogLike[]) {
  if (!logs?.length) return undefined;
  return logs.slice().reverse().find((log) => log.level === "error");
}

export function extractFailureReason(input: ExtractFailureReasonInput): string | undefined {
  const payload = input.resultPayload ?? {};
  const errorLog = latestErrorLog(input.logs);
  const candidates = [
    input.executionErrorMessage,
    input.progressError,
    payload.errorMessage,
    payload.lastError,
    payload.error,
    errorLog?.details,
    errorLog?.message,
    input.resultSummary,
    input.resultFinalMessage,
  ];
  for (const candidate of candidates) {
    const reason = compactFailureReason(candidate);
    if (reason) return reason;
  }
  return undefined;
}

export function formatFailureReasonForPrompt(reason?: string): string {
  return `failureReason=${reason || "失败原因未记录"}`;
}
