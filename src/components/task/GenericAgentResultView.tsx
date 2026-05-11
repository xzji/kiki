"use client";

import { TaskResultBlockView } from "@/components/execution/BlockRenderer";
import type { TaskInstanceNotificationState } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

export function GenericAgentResultView({
  summary,
  finalMessage,
  taskResult,
  artifacts,
  structuredOutput,
  notification,
  hideSummaryCard = false,
}: {
  summary?: string;
  finalMessage?: string;
  taskResult?: TaskResult;
  artifacts?: unknown[];
  structuredOutput?: Record<string, unknown> | null;
  notification?: TaskInstanceNotificationState;
  hideSummaryCard?: boolean;
}) {
  void summary;
  void finalMessage;
  void structuredOutput;
  void notification;
  void hideSummaryCard;
  void artifacts;

  if (!taskResult) return null;

  return (
    <div>
      <TaskResultBlockView result={taskResult} />
    </div>
  );
}
