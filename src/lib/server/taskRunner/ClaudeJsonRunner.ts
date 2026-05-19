import type { Runner, RunnerInput, RunnerOutput } from "@/lib/server/taskRunner/Runner";

export class ClaudeJsonRunner implements Runner {
  readonly kind = "claude_json" as const;

  async run(_input: RunnerInput): Promise<RunnerOutput> {
    void _input;
    throw new Error("ClaudeJsonRunner 由 goalTaskRunner 现有执行流水线承载，暂不直接调用。");
  }
}
