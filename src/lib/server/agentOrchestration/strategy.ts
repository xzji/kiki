import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";
import type { AgentCollaborationStrategy, AgentRole } from "@/types/agentOrchestration";
import type { Task } from "@/types/kiki";

export type AgentStrategyInput = {
  task: Task;
  isResumeRun?: boolean;
};

const SIMPLE_RESULT_KINDS = new Set(["flashcard", "listening_qa", "freeform_chat"]);

export function selectAgentCollaborationStrategy(input: AgentStrategyInput): AgentCollaborationStrategy {
  const { task } = input;
  if (input.isResumeRun) return "single_agent";
  if (SIMPLE_RESULT_KINDS.has(task.resultViewKind ?? task.executionKind)) return "single_agent";

  const expectedSurfaces = resolveExpectedSurfaces(task.expectedResult);
  const hasFiles = expectedSurfaces.includes("files") || task.expectedResult?.fileSurface?.required === true;
  const hasInteractive = expectedSurfaces.includes("interactive");
  const interactiveKind = task.expectedResult?.interactiveSurface?.kind;
  const presentation = task.expectedResult?.presentation;
  const isHighValue = task.priority === "high" || task.priority === "critical";
  const needsResearch =
    task.expectedResult?.presentation === "comparison_table" ||
    task.expectedResult?.type === "decision" ||
    /调研|比较|推荐|分析|评估|决策/.test(`${task.title}\n${task.description}\n${task.expectedOutcome}`);

  if (hasInteractive && interactiveKind === "webapp") return "build_then_review";
  if (hasFiles && hasInteractive) return "quality_review";
  if (needsResearch && (isHighValue || presentation === "comparison_table")) return "research_then_write";
  if (hasFiles || presentation === "dashboard" || presentation === "handoff_package" || presentation === "visual_report") {
    return "quality_review";
  }
  return "single_agent";
}

export function rolesForStrategy(strategy: Exclude<AgentCollaborationStrategy, "single_agent"> | "custom"): AgentRole[] {
  if (strategy === "research_then_write") return ["coordinator", "researcher", "executor", "reviewer", "synthesizer"];
  return ["coordinator", "executor", "reviewer", "synthesizer"];
}
