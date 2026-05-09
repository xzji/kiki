import type { EmailDraft } from "@/types/kiki";

export const emailDrafts: EmailDraft[] = [
  {
    id: "email-1",
    recipient: "Amy Chen",
    subject: "关于 AI 产品经理岗位的面试时间确认",
    body: "Amy 你好，感谢你的邀请。我这周三和周四下午都可以参加一面，如果方便的话请帮我确认最终时间，我会提前准备相关案例。",
  },
  {
    id: "email-2",
    recipient: "Kenji Travel",
    subject: "大阪 6 日游酒店改签请求",
    body: "您好，我想将原定 5 月 4 日入住的订单调整为 5 月 5 日入住 2 晚，请帮我确认是否仍有空房，以及改签后的价格变化。",
  },
  {
    id: "email-3",
    recipient: "Study Buddy Group",
    subject: "周末托福听力共学安排",
    body: "大家好，本周六上午 10 点我会组织一次 90 分钟的托福听力共学，内容主要是天文和校园场景题。欢迎回复确认是否参加。",
  },
];
