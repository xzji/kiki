import { normalizeGoalId, normalizeTaskId } from "@/lib/opaqueIds";
import type { InboxItem } from "@/types/kiki";

function taskLink(goalId: string, taskId: string, view: "exec" | "list") {
  return `/goals/${normalizeGoalId(goalId)}/tasks/${normalizeTaskId(taskId)}?view=${view}`;
}

export const initialInboxItems: InboxItem[] = [
  {
    id: "inbox-listening",
    iconType: "task",
    title: "听力练习 - 托福考试 110 分",
    snippet: "[需要作答] 昨天你已经对了 9 道题（共10题），正确率为 90%，并且已经连续 3 天状态稳定。",
    badge: "need_answer",
    unreadCount: 1,
    timeLabel: "11:00",
    linkTo: taskLink("goal-toefl", "task-toefl-listening", "list"),
    goalId: normalizeGoalId("goal-toefl"),
    createdAt: "2026-04-26T11:00:00+08:00",
  },
  {
    id: "inbox-news",
    iconType: "news",
    title: "AI 行业新闻",
    snippet: "整理了 4 条 AI 行业的重点大新闻，OpenAI 发布多智能体协作框架位列第一。",
    unreadCount: 1,
    timeLabel: "09:00",
    linkTo: taskLink("goal-news", "task-news-digest", "exec"),
    goalId: normalizeGoalId("goal-news"),
    createdAt: "2026-04-26T09:00:00+08:00",
  },
  {
    id: "inbox-booking",
    iconType: "booking",
    title: "购买大阪到京都车票 - 大阪 6 日游",
    snippet: "你明晚前往大阪后，帮你看的行李较多、你需要提前到站的车次，我已经帮你筛完。",
    badge: "need_confirm",
    unreadCount: 1,
    timeLabel: "04-10",
    linkTo: taskLink("goal-osaka", "task-osaka-ticket", "exec"),
    goalId: normalizeGoalId("goal-osaka"),
    createdAt: "2026-04-10T09:00:00+08:00",
  },
  {
    id: "inbox-vocab",
    iconType: "task",
    title: "单词卡 - 托福考试 110 分",
    snippet: "我整理了 30 张高频学术词卡片，先快速走一轮，再把难词标记出来。",
    unreadCount: 1,
    timeLabel: "04-01",
    linkTo: taskLink("goal-toefl", "task-toefl-vocab", "list"),
    goalId: normalizeGoalId("goal-toefl"),
    createdAt: "2026-04-01T11:00:00+08:00",
  },
  {
    id: "inbox-mail",
    iconType: "mail",
    title: "邮件",
    snippet: "[需要确认] 我共草拟了 3 封邮件，其中 1 封是最重要的面试确认邮件，建议先处理。",
    badge: "need_confirm",
    unreadCount: 1,
    timeLabel: "04-01",
    linkTo: taskLink("goal-mail", "task-mail-review", "exec"),
    goalId: normalizeGoalId("goal-mail"),
    createdAt: "2026-04-01T09:00:00+08:00",
  },
];
