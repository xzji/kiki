import type { AgentEvent } from "@/types/schedule";

export const initialScheduleEvents: AgentEvent[] = [
  {
    id: "evt-all-day-toefl",
    title: "托福考试 110 分 · 学习冲刺日",
    description: "全天沉浸式复习，重点冲刺阅读与听力。",
    startTime: "2026-04-27T00:00:00+08:00",
    endTime: "2026-04-27T23:59:59+08:00",
    isAllDay: true,
    attendees: [{ id: "u-self", name: "Josh" }],
    color: "orange",
    location: "书房",
    status: "normal",
    createdByAgent: true,
    agentActions: [
      { label: "开始学习", type: "primary" },
      { label: "稍后提醒", type: "secondary" }
    ]
  },
  {
    id: "evt-osaka-trip",
    title: "大阪 6 日游 · 行前准备",
    description: "打包、确认酒店、兑换日元、下载离线地图。",
    startTime: "2026-04-29T09:00:00+08:00",
    endTime: "2026-04-30T18:00:00+08:00",
    isAllDay: false,
    attendees: [
      { id: "u-self", name: "Josh" },
      { id: "u-partner", name: "Sky" }
    ],
    color: "purple",
    location: "家 / 机场",
    status: "normal",
    createdByAgent: true
  },
  {
    id: "evt-focus-morning",
    title: "专注学习时段",
    description: "KiKi 建议的核心学术词汇扫荡 90 分钟专注。",
    startTime: "2026-04-26T13:00:00+08:00",
    endTime: "2026-04-26T15:00:00+08:00",
    isAllDay: false,
    attendees: [{ id: "u-self", name: "Josh" }],
    color: "orange",
    location: "书房",
    status: "normal",
    createdByAgent: true,
    agentActions: [
      { label: "开始专注", type: "primary" },
      { label: "换个时间", type: "secondary" }
    ]
  },
  {
    id: "evt-listening",
    title: "听力练习反馈会",
    description: "和 KiKi 一起回顾昨日听力错题，重点覆盖讲座题型。",
    startTime: "2026-04-28T10:00:00+08:00",
    endTime: "2026-04-28T11:00:00+08:00",
    isAllDay: false,
    attendees: [{ id: "u-self", name: "Josh" }],
    color: "blue",
    location: "线上会议",
    status: "normal",
    createdByAgent: true
  },
  {
    id: "evt-listening-overlap",
    title: "教练 1v1",
    description: "与托福教练的 1v1，聚焦笔记法优化。",
    startTime: "2026-04-28T10:30:00+08:00",
    endTime: "2026-04-28T11:30:00+08:00",
    isAllDay: false,
    attendees: [
      { id: "u-self", name: "Josh" },
      { id: "u-coach", name: "Coach" }
    ],
    color: "green",
    location: "Zoom",
    status: "normal",
    createdByAgent: false
  },
  {
    id: "evt-vocab",
    title: "单词背诵复盘",
    description: "回顾本周 500 个学术词汇的掌握情况。",
    startTime: "2026-04-28T14:30:00+08:00",
    endTime: "2026-04-28T15:30:00+08:00",
    isAllDay: false,
    attendees: [
      { id: "u-self", name: "Josh" },
      { id: "u-partner", name: "Sky" },
      { id: "u-coach", name: "Coach" }
    ],
    color: "green",
    location: "书房",
    status: "normal",
    createdByAgent: true
  },
  {
    id: "evt-interview",
    title: "AI 产品经理面试准备",
    description: "原定的准备会，已取消。",
    startTime: "2026-04-29T16:00:00+08:00",
    endTime: "2026-04-29T17:00:00+08:00",
    isAllDay: false,
    attendees: [{ id: "u-self", name: "Josh" }],
    color: "pink",
    location: "线上",
    status: "cancelled",
    createdByAgent: false
  },
  {
    id: "evt-agent-focus",
    title: "KiKi 建议的深度思考时段",
    description: "两小时无打扰的深度思考，适合梳理目标拆解。",
    startTime: "2026-04-30T09:00:00+08:00",
    endTime: "2026-04-30T11:00:00+08:00",
    isAllDay: false,
    attendees: [{ id: "u-self", name: "Josh" }],
    color: "cyan",
    location: "书房",
    status: "normal",
    createdByAgent: true,
    agentActions: [
      { label: "接受建议", type: "primary" },
      { label: "改到下午", type: "secondary" }
    ]
  }
];
