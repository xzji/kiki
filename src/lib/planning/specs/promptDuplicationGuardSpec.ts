import assert from "node:assert/strict";

import { normalizeAwaitingInteraction } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import { normalizeResultHeadline } from "@/lib/server/protocol/normalizeResultHeadline";
import type { TaskInstanceAwaitingUser, TaskResultNotificationDecision } from "@/types/kiki";

import {
  buildGoalClarificationPrompt,
  buildGoalFollowUpQuestionsPrompt,
  buildCollectedInfoSummaryPrompt,
} from "@/lib/server/goalPlanning/agents/interviewerPrompt";
import {
  buildDecomposePrompt,
  buildDecompositionNormalizationPrompt,
} from "@/lib/server/goalPlanning/agents/plannerPrompt";
import { buildTaskDraftReviewDecisionPrompt } from "@/lib/server/goalPlanning/agents/criticPrompt";
import { buildPlanPresentationPrompt } from "@/lib/server/goalPlanning/agents/presenterPrompt";
import { buildThreadRunnerDecisionPrompt } from "@/lib/server/thread/threadRunnerPrompt";
import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import type { Thread, Topic } from "@/types/topic";

function buildAwaiting(): TaskInstanceAwaitingUser {
  return {
    reason: "请补充预算。",
    interactionRequirement: {
      type: "provide_context",
      timing: "before_execution",
      reason: "请补充预算。",
      question: "你的预算上限是多少？",
      fields: [
        {
          id: "budget",
          label: "预算",
          question: "你的预算上限是多少？",
          description: "预算会影响方案筛选。",
          options: [],
          source: "user",
        },
      ],
      shouldNotifyUser: true,
    },
  };
}

function buildDecision(): TaskResultNotificationDecision {
  return {
    shouldNotify: true,
    channel: "both",
    notificationType: "context_required",
    priority: "normal",
    reason: "请补充预算。",
    title: "需要补充信息",
    snippet: "[待补充] 你的预算上限是多少？",
    userMessage: "请补充预算后继续。",
    badge: "need_answer",
    resultSummary: {
      headline: "你的预算上限是多少？",
      keyPoints: [],
      nextActions: [],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: false,
    },
    createdAt: "2026-05-30T00:00:00.000Z",
  };
}

export function runPromptDuplicationGuardSpecs() {
  const awaiting = normalizeAwaitingInteraction(buildAwaiting());
  assert.equal(awaiting.interactionRequirement?.question, "你的预算上限是多少？");
  assert.equal(awaiting.interactionRequirement?.fields?.[0]?.question, "");

  const decision = normalizeResultHeadline(buildDecision(), ["你的预算上限是多少？"]);
  assert.equal(decision.snippet, "");

  // ---------------------------------------------------------------------
  // Plan §3.3.5：5 角色 prompt 禁止字面量
  // - 禁止虚构截止日期常量 / 固定日期兜底 (§9.5 问题 18)
  // - 禁止 participationLevel / topicKind / quantifiable 旧字段 (§3.3.1)
  // ---------------------------------------------------------------------
  const FORBIDDEN_LITERALS = [
    ["2026", "06", "30"].join("-"),
    ["DEFAULT", "DEADLINE"].join("_"),
    "participationLevel",
    "topicKind",
    "quantifiable",
  ];

  const prompts: Array<{ label: string; output: string }> = [
    {
      label: "interviewer.clarification",
      output: buildGoalClarificationPrompt("学好英语", "上下文：用户希望 6 个月达到 B2"),
    },
    {
      label: "interviewer.followUp",
      output: buildGoalFollowUpQuestionsPrompt({
        goalText: "学好英语",
        history: [{ questions: ["你的目标水平？"], answer: "B2" }],
        answeredRounds: 1,
        minRounds: 1,
        maxRounds: 3,
      }),
    },
    {
      label: "interviewer.summary",
      output: buildCollectedInfoSummaryPrompt("学好英语", "希望 6 个月达到 B2"),
    },
    {
      label: "planner.decompose",
      output: buildDecomposePrompt({
        goalTitle: "学好英语",
        goalDescription: "6 个月达到 B2",
        userContext: { resources: "每天 1 小时" },
        config: DEFAULT_EASTER_EGG_SETTINGS,
      }),
    },
    {
      label: "planner.normalization",
      output: buildDecompositionNormalizationPrompt({
        goalTitle: "学好英语",
        goalDescription: "6 个月达到 B2",
        userContext: {},
        rawOutput: "原始 markdown 输出占位",
        config: DEFAULT_EASTER_EGG_SETTINGS,
      }),
    },
    {
      label: "critic.decision",
      output: buildTaskDraftReviewDecisionPrompt({
        goalTitle: "学好英语",
        subGoalTitle: "听力提升",
        goalDescription: "6 个月达到 B2",
        drafts: [],
      }),
    },
    {
      label: "presenter.plan",
      output: buildPlanPresentationPrompt({
        goalText: "学好英语",
        collectedInfoSummary: {
          goalDetails: "",
          timeline: "",
          resources: "",
          constraints: "",
          challenges: "",
          preferences: "",
          summary: "",
        },
        decomposition: {
          goalAnalysis: { coreIntent: "", successState: "", assumptions: [] },
          subGoals: [],
          executionOrder: "",
          risks: [],
          reasoning: "",
        },
        taskPlanningSummary: [],
      }),
    },
  ];

  for (const { label, output } of prompts) {
    for (const literal of FORBIDDEN_LITERALS) {
      assert.equal(
        output.includes(literal),
        false,
        `prompt ${label} 不应出现禁止字面量 "${literal}"，否则与 §9.5 / §3.3.1 硬约束冲突`,
      );
    }
  }

  // Presenter prompt 必须显式声明 deadline 缺失合法（§9.5 问题 18 的正向断言）
  const presenterOutput = prompts.find((p) => p.label === "presenter.plan")!.output;
  assert.equal(
    presenterOutput.includes("省略 deadline 字段"),
    true,
    "presenter prompt 必须明确指引模型在缺少 deadline 时省略字段",
  );

  // ---------------------------------------------------------------------
  // ThreadRunner 8 条必备约束断言（计划 §3.3.4 + §3.3.5）
  // ---------------------------------------------------------------------
  const threadRunnerTopic: Topic = {
    id: "topic-runner-spec",
    title: "美股投资监控",
    summary: "持续追踪 NVDA / AMD 大盘热点",
    threads: [],
    status: "active",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    revision: 1,
  };
  const threadRunnerThread: Thread = {
    id: "thread-runner-spec",
    topicId: threadRunnerTopic.id,
    title: "盘前简报",
    intent: "每天盘前 8:00 总结隔夜美股动态",
    loopInterval: "daily",
    status: "active",
    memory: { lastDigest: "2026-05-30 摘要…" },
    silentCount: 0,
    failureCount: 0,
    createdAt: threadRunnerTopic.createdAt,
    updatedAt: threadRunnerTopic.updatedAt,
    revision: 1,
  };
  const threadRunnerPrompt = buildThreadRunnerDecisionPrompt({
    topic: threadRunnerTopic,
    thread: threadRunnerThread,
    recentTaskInstances: [],
    threadMemory: threadRunnerThread.memory,
  });

  const REQUIRED_KEYWORDS: Array<{ key: string; rule: string }> = [
    { key: "决策/展示层拆分", rule: "约束 1：决策/展示层拆分" },
    { key: "Thread memory", rule: "约束 2：数据源限定 Thread memory" },
    { key: "上次 tick 产出", rule: "约束 2：数据源限定 上次 tick 产出" },
    { key: "当前 Task 列表", rule: "约束 2：数据源限定 当前 Task 列表" },
    { key: "最近 7 天 Task instances", rule: "约束 2：数据源限定 最近 7 天 Task instances" },
    { key: "dispatch_task", rule: "约束 3：动作之一 dispatch_task" },
    { key: "update_task", rule: "约束 3：动作之一 update_task" },
    { key: "cancel_task", rule: "约束 3：动作之一 cancel_task" },
    { key: "archive_thread", rule: "约束 3：动作之一 archive_thread" },
    { key: "post_message", rule: "约束 3：动作之一 post_message" },
    { key: "silent", rule: "约束 3：动作之一 silent" },
    { key: "能在本次 tick 一段话讲完的", rule: "约束 4：判断规则" },
    { key: "taskType", rule: "约束 5：dispatch_task 指定 taskType" },
    { key: "triggerRule", rule: "约束 5：dispatch_task 指定 triggerRule" },
    { key: "会话流", rule: "约束 6：会话流 + Inbox 双写" },
    { key: "Inbox", rule: "约束 6：会话流 + Inbox 双写" },
    { key: "threadId", rule: "约束 7：post_message / dispatch_task 必须填 threadId" },
    { key: "8KB", rule: "约束 8：payload ≤ 8KB" },
  ];

  for (const { key, rule } of REQUIRED_KEYWORDS) {
    assert.equal(
      threadRunnerPrompt.includes(key),
      true,
      `ThreadRunner prompt 缺少关键字 "${key}"（${rule}），与 §3.3.4 必备约束冲突`,
    );
  }

  assert.equal(
    threadRunnerPrompt.includes('post_message: { "kind": "post_message", "threadId": "thread-runner-spec"'),
    true,
    "ThreadRunner prompt 必须给出 post_message.threadId 的显式 JSON 形状，避免真实 LLM 输出缺字段",
  );
  assert.equal(
    threadRunnerPrompt.includes('dispatch_task: { "kind": "dispatch_task", "threadId": "thread-runner-spec"'),
    true,
    "ThreadRunner prompt 必须给出 dispatch_task.threadId 的显式 JSON 形状，避免真实 LLM 输出缺字段",
  );
  assert.equal(
    threadRunnerPrompt.includes('update_task: { "kind": "update_task", "threadId": "thread-runner-spec"'),
    true,
    "ThreadRunner prompt 必须给出 update_task.threadId 的显式 JSON 形状，避免真实 LLM 输出缺字段",
  );
  assert.equal(
    threadRunnerPrompt.includes('cancel_task: { "kind": "cancel_task", "threadId": "thread-runner-spec"'),
    true,
    "ThreadRunner prompt 必须给出 cancel_task.threadId 的显式 JSON 形状，避免真实 LLM 输出缺字段",
  );
  assert.equal(
    threadRunnerPrompt.includes('archive_thread: { "kind": "archive_thread", "threadId": "thread-runner-spec"'),
    true,
    "ThreadRunner prompt 必须给出 archive_thread.threadId 的显式 JSON 形状，避免真实 LLM 输出缺字段",
  );

  // ThreadRunner prompt 同样禁止出现已废弃字面量
  for (const literal of FORBIDDEN_LITERALS) {
    assert.equal(
      threadRunnerPrompt.includes(literal),
      false,
      `ThreadRunner prompt 不应出现禁止字面量 "${literal}"`,
    );
  }
}
