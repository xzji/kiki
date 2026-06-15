import type { Conversation } from "@/types/kiki";

/**
 * 会话列表排序的「唯一事实来源」。前端（store / Sidebar）与服务端（repository）
 * 共用同一比较器，杜绝多处各写一份导致的语义发散。
 *
 * 排序规则：
 *   pinned DESC
 *   -> effectiveLastMessageAt DESC   // lastMessageAt ?? lastMessage?.createdAt ?? createdAt
 *   -> createdAt DESC
 *   -> id DESC                        // 最终稳定 tiebreaker
 */

type ConversationOrderInput = Pick<
  Conversation,
  "id" | "createdAt" | "pinned"
> & {
  lastMessageAt?: string;
  lastMessage?: Conversation["lastMessage"];
};

/** 计算用于排序的「有效最后活跃时间」，带回退链。 */
export function getConversationSortAt(conversation: ConversationOrderInput): string {
  return conversation.lastMessageAt ?? conversation.lastMessage?.createdAt ?? conversation.createdAt ?? "";
}

function compareDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/** 会话列表比较器：置顶 > 最后消息时间 > 创建时间 > id。 */
export function compareConversations(a: ConversationOrderInput, b: ConversationOrderInput): number {
  const pinnedDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDiff !== 0) return pinnedDiff;

  const sortAtDiff = compareDesc(getConversationSortAt(a), getConversationSortAt(b));
  if (sortAtDiff !== 0) return sortAtDiff;

  const createdAtDiff = compareDesc(a.createdAt ?? "", b.createdAt ?? "");
  if (createdAtDiff !== 0) return createdAtDiff;

  return compareDesc(a.id, b.id);
}

/** 对会话数组做不可变排序，返回新数组。 */
export function sortConversations<T extends ConversationOrderInput>(conversations: readonly T[]): T[] {
  return [...conversations].sort(compareConversations);
}

export type { ConversationOrderInput };
