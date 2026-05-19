import type { ClaudeStreamEvent } from "@/lib/server/claudeCli";
import type { ArtifactRef } from "@/types/artifact";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export type RunnerKind = "claude_json" | "file_write";

export type RunnerInput = {
  requestId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
  initialTrajectory?: ExecutionTrajectoryStep[];
  signal?: AbortSignal;
  onEvent?: (event: ClaudeStreamEvent) => void;
};

export type RunnerOutput = {
  rawOutput: string;
  artifactRefs: ArtifactRef[];
  trajectory: ExecutionTrajectoryStep[];
};

export interface Runner {
  readonly kind: RunnerKind;
  run(input: RunnerInput): Promise<RunnerOutput>;
}
