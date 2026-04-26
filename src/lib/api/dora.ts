import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { sleep } from "@/lib/utils";

export async function getGoalBreakdown(goalTitle: string) {
  await sleep();
  return getGoalBreakdownDraft(goalTitle);
}

export async function getMockDoraReply(seed: string) {
  await sleep();
  return `我已收到：${seed}。如果你希望，我可以继续把它压缩成下一步可执行动作。`;
}
