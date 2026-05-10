"use client";

import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import type { GoalBreakdownDraft } from "@/types/kiki";

const TOEFL_PLAN_MOCK_DRAFT: GoalBreakdownDraft = {
  goalTitle: "托福备考冲刺 110 分",
  summary:
    "围绕阅读、听力、口语、写作四条主线拆分阶段任务，先快速完成基线诊断与策略搭建，再进入高频循环训练和结果复盘。",
  deadline: "2026-08-31T23:59:59+08:00",
  reasoning:
    "先用一次性任务建立当前分数基线、薄弱项画像和备考素材，再切到高频重复训练，保证后续确认启动后可以立即进入真实任务执行链路。",
  notificationStrategy: "高优任务优先通过会话卡片提醒，待确认节点同步进入收件箱。",
  subGoals: [
    {
      id: "toefl-subgoal-1",
      title: "子目标1：完成基线诊断并确定冲刺策略",
      tasks: [
        {
          id: "toefl-task-1",
          title: "任务1：托福模考基线诊断",
          description:
            "完成一套 TOEFL 全真模考并输出阅读、听力、口语、写作四科的分项表现与主要失分原因。",
          expectedOutcome: "得到一份四科分数基线和薄弱项清单。",
          taskType: "one_shot",
          triggerRule: "立即触发",
          executionKind: "generic_result",
          priority: "critical",
          executionObjective: "整理一份可用于后续规划复盘的托福基线诊断报告。",
        },
        {
          id: "toefl-task-2",
          title: "任务2：阅读错因模式归纳",
          description:
            "归纳最近 3 套阅读练习中的错题类型，拆成词汇、指代、句间逻辑、主旨题四类并给出对应训练建议。",
          expectedOutcome: "一份阅读错因地图和对应训练重点。",
          taskType: "one_shot",
          triggerRule: "立即触发",
          executionKind: "reading_digest",
          priority: "high",
        },
        {
          id: "toefl-task-3",
          title: "任务3：每日学术词记忆卡",
          description:
            "按学科主题整理托福高频学术词，优先覆盖天文、生态、地质与生物四类 lecture 词汇。",
          expectedOutcome: "形成当天可直接开始记忆的一组学术词卡。",
          taskType: "daily_repeat",
          triggerRule: "每天 07:30 触发",
          executionKind: "flashcard",
          priority: "high",
        },
      ],
    },
    {
      id: "toefl-subgoal-2",
      title: "子目标2：提升听力与口语输出稳定性",
      tasks: [
        {
          id: "toefl-task-4",
          title: "任务1：lecture 精听问答",
          description:
            "基于 lecture 音频做一轮限时听力问答，重点训练信息定位、态度判断和转折提示词识别。",
          expectedOutcome: "输出一组可直接作答的听力题并记录错因。",
          taskType: "one_shot",
          triggerRule: "立即触发",
          executionKind: "listening_qa",
          priority: "high",
        },
        {
          id: "toefl-task-5",
          title: "任务2：独立口语结构化表达",
          description:
            "根据常见独立口语题目生成答题框架，补齐观点、例子和转承句，形成 45 秒可复用模板。",
          expectedOutcome: "一版可直接练习的独立口语模板稿。",
          taskType: "daily_repeat",
          triggerRule: "每天 19:30 触发",
          executionKind: "draft_review",
          priority: "medium",
        },
      ],
    },
    {
      id: "toefl-subgoal-3",
      title: "子目标3：建立写作反馈和复盘闭环",
      tasks: [
        {
          id: "toefl-task-6",
          title: "任务1：综合写作首轮批改",
          description:
            "对一篇综合写作样稿进行结构、听读信息映射和语言准确度批改，并给出二次修改建议。",
          expectedOutcome: "一份包含问题定位与修改建议的写作批改结果。",
          taskType: "one_shot",
          triggerRule: "立即触发",
          executionKind: "draft_review",
          priority: "high",
        },
        {
          id: "toefl-task-7",
          title: "任务2：每周提分复盘",
          description:
            "汇总本周训练结果，判断四科投入是否均衡，并调整下周任务重心与触发节奏。",
          expectedOutcome: "一份下周训练调整建议。",
          taskType: "monitoring",
          triggerRule: "每天 21:00 触发",
          executionKind: "generic_result",
          priority: "medium",
        },
      ],
    },
  ],
};

function taskCountFromDraft(draft: GoalBreakdownDraft) {
  return draft.subGoals.reduce((sum, subGoal) => sum + subGoal.tasks.length, 0);
}

function buildIso(baseMs: number, offsetMs: number) {
  return new Date(baseMs + offsetMs).toISOString();
}

export function seedToeflMockGoalPlanConversation() {
  const conversationStore = useConversationStore.getState();
  const goalStore = useGoalStore.getState();
  const baseMs = Date.now();

  const conversation = conversationStore.createConversation("托福备考 Mock");

  conversationStore.appendMessage(conversation.id, {
    id: `msg-toefl-mock-user-${baseMs}`,
    kind: "text",
    role: "user",
    content: "/goal 我想在接下来几个月把托福成绩提升到 110 分，请帮我给出一套能直接执行的备考计划。",
    createdAt: buildIso(baseMs, 0),
    status: "done",
    source: "user",
  });

  conversationStore.appendMessage(conversation.id, {
    id: `msg-toefl-mock-kiki-${baseMs + 1}`,
    kind: "text",
    role: "kiki",
    content:
      "已注入一份托福备考的 mock 目标规划草案。这个会话跳过了规划生成等待时间，但后续从规划里确认并启动后，任务仍会走真实执行链路。",
    createdAt: buildIso(baseMs, 1),
    status: "done",
    source: "system",
  });

  const goal = goalStore.createGoalFromDraft(TOEFL_PLAN_MOCK_DRAFT, {
    conversationId: conversation.id,
  });

  conversationStore.setGoalForConversation(conversation.id, goal.id);
  conversationStore.renameConversation(conversation.id, goal.title);

  conversationStore.appendMessage(conversation.id, {
    id: `msg-toefl-mock-goal-${goal.id}`,
    kind: "goal_plan_card",
    role: "kiki",
    content: "目标规划草案已准备就绪。点击卡片查看并确认启动。",
    createdAt: buildIso(baseMs, 2),
    unread: true,
    status: "done",
    source: "system",
    goalRef: {
      goalId: goal.id,
      title: goal.title,
      summary: goal.summary,
      subGoalCount: goal.subGoals.length,
      taskCount: taskCountFromDraft(TOEFL_PLAN_MOCK_DRAFT),
    },
  });

  return {
    conversationId: conversation.id,
    goalId: goal.id,
  };
}
