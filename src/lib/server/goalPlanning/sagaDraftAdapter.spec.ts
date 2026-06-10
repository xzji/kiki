import assert from "node:assert/strict";

import { adaptTopicInitSagaToGoalDraft } from "./sagaDraftAdapter";
import type { TopicInitSagaResult } from "./topicInitSaga";

function completedResult(overrides?: Partial<TopicInitSagaResult>): TopicInitSagaResult {
  return {
    saga: {
      id: "saga-1",
      topicId: "topic-1",
      type: "topic_init",
      status: "completed",
      currentStep: "completed",
      retryCount: 0,
      revision: 1,
      startedAt: "2026-06-02T00:00:00.000Z",
      finishedAt: "2026-06-02T00:00:00.000Z",
    },
    status: "completed",
    artifacts: {
      plan: {
        goalAnalysis: {
          coreIntent: "持续跟踪美股科技板块",
          successState: "形成稳定监控机制",
          assumptions: ["行情数据可获得"],
        },
        subGoals: [
          {
            id: 1,
            name: "建立观察清单",
            description: "聚焦核心科技股和 ETF",
            why: "收敛监控范围",
            priority: "high",
            dependencies: [],
            successCriteria: [{ description: "完成首批标的整理", type: "deliverable" }],
            tasks: [
              {
                index: 1,
                title: "整理观察池",
                objective: "筛选 10 个核心标的",
                deliverable: "观察池列表",
                cadence: "每日收盘后",
                acceptanceCriteria: ["覆盖龙头股与 ETF"],
              },
            ],
          },
        ],
        executionOrder: "先建观察池，再建立每日复盘节奏",
        risks: ["信息噪音较多"],
        reasoning: "先缩小范围，再持续跟踪",
      },
      critic: { verdict: "accept", notes: "结构完整" },
      presentation: {
        goalTitle: "美股科技板块全自动监控体系",
        summary: "先建立观察池，再形成日常跟踪节奏。",
        notificationStrategy: "每日收盘后推送摘要，异动时即时提醒。",
      },
    },
    refineLoops: 0,
    ...overrides,
  };
}

export function runSagaDraftAdapterSpecs() {
  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "跟踪美股科技",
      result: completedResult(),
    });
    assert.equal(draft.goalTitle, "美股科技板块全自动监控体系");
    assert.equal(draft.subGoals.length, 1);
    assert.equal(draft.subGoals[0]?.title, "建立观察清单");
    assert.equal(draft.subGoals[0]?.tasks.length, 1);
    assert.equal(draft.subGoals[0]?.tasks[0]?.taskType, "repeat");
    assert.equal(draft.subGoals[0]?.tasks[0]?.triggerRule, "每日收盘后");
  }

  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "跟踪美股科技",
      result: completedResult({
        artifacts: {
          plan: {
            threads: [
              {
                id: "thread-1",
                title: "监控板块异动",
                intent: "观察新闻和价格波动",
              },
            ],
          },
          presentation: {
            goalTitle: "科技板块跟踪",
            summary: "持续关注板块变化",
            notificationStrategy: "有异动即提醒",
          },
        },
      }),
    });
    assert.equal(draft.subGoals[0]?.title, "监控板块异动");
    assert.equal(draft.subGoals[0]?.tasks.length, 0);
  }

  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "跟踪美股科技",
      result: completedResult({
        artifacts: {
          plan: {
            goalAnalysis: {
              coreIntent: "原始意图",
              successState: "原始成功状态",
              assumptions: ["原始假设"],
            },
            subGoals: [{ id: 1, name: "旧计划" }],
          },
          refinedPlan: {
            goalAnalysis: {
              coreIntent: "原始意图",
              successState: "原始成功状态",
              assumptions: ["原始假设"],
            },
            subGoals: [{ id: 1, name: "修正后计划" }],
          },
          presentation: {
            goalTitle: "科技板块跟踪",
            summary: "持续关注板块变化",
            notificationStrategy: "有异动即提醒",
          },
        },
      }),
    });

    assert.equal(draft.subGoals[0]?.title, "修正后计划");
    assert.equal(draft.goalAnalysis?.coreIntent, "原始意图");
  }
}
