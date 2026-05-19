import type { AgentReviewDecision } from "@/types/agentOrchestration";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function normalizeReviewDecision(value: unknown, fallbackReason: string): AgentReviewDecision {
  const record = asRecord(value);
  if (!record) {
    return {
      passed: false,
      severity: "warning",
      issues: [],
      decisionReason: fallbackReason,
    };
  }
  const issues: AgentReviewDecision["issues"] = [];
  if (Array.isArray(record.issues)) {
    record.issues.forEach((issue, index) => {
      const item = asRecord(issue);
      if (!item) return;
      const severity =
        item.severity === "info" || item.severity === "warning" || item.severity === "blocking"
          ? item.severity
          : "warning";
      issues.push({
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `issue-${index + 1}`,
        severity,
        message: typeof item.message === "string" ? item.message.trim() : "审阅发现问题。",
        expected: typeof item.expected === "string" ? item.expected.trim() : "满足任务要求。",
        actual: typeof item.actual === "string" ? item.actual.trim() : "当前产出未说明。",
        suggestedFix: typeof item.suggestedFix === "string" ? item.suggestedFix.trim() : undefined,
      });
    });
  }
  const hasBlockingIssue = issues.some((issue) => issue.severity === "blocking");
  const passed = record.passed === true && !hasBlockingIssue;
  const severity =
    record.severity === "info" || record.severity === "warning" || record.severity === "blocking"
      ? record.severity
      : hasBlockingIssue
        ? "blocking"
        : passed
          ? "info"
          : "warning";

  return {
    passed,
    severity,
    issues,
    decisionReason:
      typeof record.decisionReason === "string" && record.decisionReason.trim()
        ? record.decisionReason.trim()
        : fallbackReason,
  };
}
