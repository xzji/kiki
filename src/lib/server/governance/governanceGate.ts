import type { Conversation } from "@/types/kiki";
import type { ClaudeChatRequest } from "@/types/runtime";

const GOVERNANCE_KEYWORDS =
  /重跑|重新|再跑|重做|返工|修改|调整|改成|改为|换个|增加|补充|删除|取消|暂停|恢复|执行|派发|下次|以后|这个任务|任务标准|来源链接|验收标准|方向不对|不是这样|不太对|重新来/;

export type GovernanceGateResult =
  | { pass: false; reason: string }
  | { pass: true; signals: { hasTaskRef: boolean; hasKeyword: boolean; hasGoalBinding: boolean } };

export function evaluateGovernanceGate(input: {
  message: string;
  conversation?: Pick<Conversation, "goalId"> | null;
  taskRef?: ClaudeChatRequest["taskRef"] | null;
}): GovernanceGateResult {
  const hasGoalBinding = Boolean(input.conversation?.goalId || input.taskRef?.goalId);
  if (!hasGoalBinding) {
    return { pass: false, reason: "conversation has no bound goal" };
  }
  const hasTaskRef = Boolean(input.taskRef);
  const hasKeyword = GOVERNANCE_KEYWORDS.test(input.message);
  if (!hasTaskRef && !hasKeyword) {
    return { pass: false, reason: "no governance signal" };
  }
  return {
    pass: true,
    signals: {
      hasTaskRef,
      hasKeyword,
      hasGoalBinding,
    },
  };
}
