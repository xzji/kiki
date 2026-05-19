import { sleep } from "@/lib/utils";

export async function getGoalBreakdown(goalTitle: string) {
  await sleep();
  if (process.env.NODE_ENV !== "development") {
    throw new Error("示例目标拆解仅在开发模式可用");
  }
  const { getGoalBreakdownDraft } = await import("@/mocks/goal-breakdown");
  return getGoalBreakdownDraft(goalTitle);
}

export async function getMockKikiReply(seed: string) {
  await sleep();
  return `我已收到：${seed}。如果你希望，我可以继续把它压缩成下一步可执行动作。`;
}
