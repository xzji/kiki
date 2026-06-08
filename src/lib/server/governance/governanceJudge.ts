import {
  buildJsonParseCandidates,
  normalizeClaudeJsonText,
  parseJsonWithCandidates,
} from "@/lib/server/claude/jsonRepair";
import { runPromptJson } from "@/lib/server/claude/transport";
import { buildGovernanceJudgePrompt } from "@/lib/server/governance/governancePrompt";
import {
  buildDegradedGovernanceResult,
  normalizeGovernanceJudgeResult,
  type GovernanceJudgeResult,
  type TaskRef,
} from "@/lib/server/governance/governanceIntent";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { QuotedConversationMessageContext, RuntimeEnvironment } from "@/types/runtime";

export async function judgeGovernanceIntent(input: {
  goal: Goal;
  subGoal?: SubGoal;
  task?: Task;
  instance?: TaskInstance;
  userMessage: string;
  quotedMessage?: QuotedConversationMessageContext | null;
  runtimeEnv: RuntimeEnvironment;
  workingDirectory: string;
  conversationId?: string;
  fallbackRef?: TaskRef;
  signal?: AbortSignal;
}): Promise<GovernanceJudgeResult> {
  try {
    const result = await runPromptJson({
      prompt: buildGovernanceJudgePrompt(input),
      runtimeEnv: input.runtimeEnv,
      cwd: input.workingDirectory,
      conversationId: input.conversationId,
      permissionMode: "readonly",
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "readonly_json" },
      abortSignal: input.signal,
      abortMessage: "治理意图判断已中断",
      failureMessage: "治理意图判断失败",
    });
    const normalized = normalizeClaudeJsonText(result.raw);
    const attempt = parseJsonWithCandidates(
      buildJsonParseCandidates(normalized),
      (value) => normalizeGovernanceJudgeResult(value, input.fallbackRef),
    );
    if (!attempt.ok) {
      return buildDegradedGovernanceResult("我暂时没能判断这条消息是否要操作任务，将按普通对话处理。");
    }
    return attempt.parsed;
  } catch (error) {
    return buildDegradedGovernanceResult(
      error instanceof Error ? `治理意图判断失败：${error.message}` : "治理意图判断失败。",
    );
  }
}
