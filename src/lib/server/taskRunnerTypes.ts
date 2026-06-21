import type {
  InteractionRequirement,
  TaskResultViewKind,
  TaskRunArtifact,
} from "@/types/kiki";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { TaskResult } from "@/types/taskResult";

/**
 * runGoalTask 解析 Claude 任务输出后得到的中间结构。它是 taskResultParser、
 * awaitingUserResolver、以及编排层（acceptance/repair）共享的数据契约，
 * 单独抽出到此文件，避免三个模块互相 import 对方去拿一个本属共享的类型。
 */
export type ParsedTaskRunnerResult = {
  summary: string;
  finalMessage: string;
  resultViewKind: TaskResultViewKind;
  awaitingUser: boolean;
  awaitingReason?: string;
  suggestedActions?: string[];
  artifacts: TaskRunArtifact[];
  taskResult: TaskResult | null;
  deliverableCheck: DeliverableCheck | null;
  interactionRequirement: InteractionRequirement;
  blocker: ExecutionBlocker | null;
  structuredOutput: Record<string, unknown> | null;
};

export type DeliverableCheckStatus = "passed" | "failed" | "unknown";

export type DeliverableCheck = {
  matched: boolean;
  confidence: "high" | "medium" | "low";
  deliveredArtifacts: string[];
  missingDeliverables: string[];
  criteriaResults: Array<{
    criterion: string;
    status: DeliverableCheckStatus;
    evidence?: string;
  }>;
  gapReason?: string;
};
