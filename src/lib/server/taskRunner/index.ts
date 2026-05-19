import { ClaudeJsonRunner } from "@/lib/server/taskRunner/ClaudeJsonRunner";
import type { Runner, RunnerKind } from "@/lib/server/taskRunner/Runner";
import type { Task } from "@/types/kiki";

export function selectRunnerKind(task: Task): RunnerKind {
  void task;
  return "claude_json";
}

export function selectRunner(task: Task): Runner {
  selectRunnerKind(task);
  return new ClaudeJsonRunner();
}
