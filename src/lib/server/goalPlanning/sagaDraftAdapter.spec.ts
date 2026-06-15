import assert from "node:assert/strict";

import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import { buildDecomposePrompt } from "@/lib/server/goalPlanning";
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
    const previous = process.env.KIKI_LOOP_V2_PLANNER;
    delete process.env.KIKI_LOOP_V2_PLANNER;
    const legacyPrompt = buildDecomposePrompt({
      goalTitle: "跟踪美股科技",
      goalDescription: "关注交易窗口",
      userContext: {},
      config: { ...DEFAULT_EASTER_EGG_SETTINGS, minSubGoals: 1, maxSubGoals: 3 },
    });
    assert.ok(!legacyPrompt.includes('"topicLoop"'), "默认保持旧 planner 词表");
    process.env.KIKI_LOOP_V2_PLANNER = "1";
    const v2Prompt = buildDecomposePrompt({
      goalTitle: "跟踪美股科技",
      goalDescription: "关注交易窗口",
      userContext: {},
      config: { ...DEFAULT_EASTER_EGG_SETTINGS, minSubGoals: 1, maxSubGoals: 3 },
    });
    assert.ok(v2Prompt.includes('"topicLoop"'), "flag 开启后要求 topicLoop");
    assert.ok(v2Prompt.includes('"triggerSpec"'), "flag 开启后要求 Task triggerSpec");
    assert.ok(v2Prompt.includes("cron/phased"), "flag 开启后允许 cron/phased reviewInterval");
    assert.ok(legacyPrompt.includes('"requiredUserInputs"'), "decompose prompt 暴露 requiredUserInputs schema");
    if (previous === undefined) delete process.env.KIKI_LOOP_V2_PLANNER;
    else process.env.KIKI_LOOP_V2_PLANNER = previous;
  }

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
      topicText: "2026 年国庆蜜月规划与落地",
      result: completedResult({
        artifacts: {
          plan: {
            subGoals: [
              {
                id: 1,
                name: "需求画像与目的地决策",
                dependencies: [],
                tasks: [
                  {
                    id: "1-1",
                    title: "发起蜜月需求画像问卷",
                    description: "收集偏好与限制",
                    expectedOutcome: "需求画像摘要",
                    taskType: "one_shot",
                    triggerRule: "立即触发",
                  },
                  {
                    id: "1-2",
                    title: "产出候选目的地对比方案",
                    description: "基于需求画像生成候选对比",
                    expectedOutcome: "候选目的地对比表",
                    taskType: "one_shot",
                    triggerRule: "满足条件：需求画像已确认",
                    dependencies: ["1-1"],
                  },
                ],
              },
              {
                id: 2,
                name: "机票与酒店预订",
                dependencies: [1],
                tasks: [
                  {
                    id: "2-1",
                    title: "产出机票方案并完成出票",
                    description: "基于目的地与日期处理机票",
                    expectedOutcome: "出票确认",
                    taskType: "one_shot",
                    triggerRule: "满足条件：目的地与日期已锁定",
                  },
                ],
              },
            ],
          },
          presentation: {
            goalTitle: "2026 年国庆蜜月规划与落地",
            summary: "形成蜜月落地计划。",
            notificationStrategy: "关键节点提醒。",
          },
        },
      }),
    });

    assert.deepEqual(draft.subGoals[0]?.tasks[1]?.dependencies, ["1-1"]);
    assert.deepEqual(draft.subGoals[1]?.tasks[0]?.dependencies, ["1-1", "1-2"]);
  }

  {
    // saga JSON 路径透传 requiredUserInputs
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "蜜月偏好与预算澄清",
      result: completedResult({
        artifacts: {
          plan: {
            subGoals: [
              {
                id: 1,
                name: "需求澄清",
                dependencies: [],
                tasks: [
                  {
                    id: "1-1",
                    title: "澄清蜜月偏好与预算",
                    description: "收集出发城市、日期、预算与偏好",
                    expectedOutcome: "需求摘要",
                    taskType: "one_shot",
                    triggerRule: "立即触发",
                    requiredUserInputs: [
                      { id: "departure_city", label: "出发城市", question: "你从哪出发？", options: ["北京", "上海"] },
                      { id: "budget", label: "预算", question: "预算多少？", satisfiedHint: "出现明确金额或不设上限" },
                    ],
                  },
                ],
              },
            ],
          },
          presentation: {
            goalTitle: "蜜月偏好与预算澄清",
            summary: "澄清需求。",
            notificationStrategy: "完成后提醒。",
          },
        },
      }),
    });
    const inputs = draft.subGoals[0]?.tasks[0]?.requiredUserInputs;
    assert.equal(inputs?.length, 2);
    assert.equal(inputs?.[0]?.id, "departure_city");
    assert.deepEqual(inputs?.[0]?.options, ["北京", "上海"]);
    assert.equal(inputs?.[1]?.satisfiedHint, "出现明确金额或不设上限");
  }

  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "把想法落成可试用版本",
      result: completedResult({
        artifacts: {
          plan: {
            goalAnalysis: {
              coreIntent: "让别人能试用这个想法",
              successState: "别人能试用并反馈",
              deliveryContract: {
                finalDeliverable: "可试用版本",
                doneEvidence: ["完成一次试用", "反馈被记录"],
                nonCompletionExamples: ["只有方案"],
              },
            },
            subGoals: [{ id: 1, name: "原型落地" }],
          },
          presentation: {
            goalTitle: "想法试用版",
            summary: "形成可试用版本",
            notificationStrategy: "完成后提醒试用",
          },
        },
      }),
    });
    assert.equal(draft.deliveryContract?.finalDeliverable, "可试用版本");
    assert.equal(draft.goalAnalysis?.deliveryContract?.doneEvidence[0], "完成一次试用");
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

  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "跟踪美股科技",
      result: completedResult({
        artifacts: {
          plan: {
            topicLoop: { kind: "cron", expr: "0 9 * * 1", timezone: "Asia/Shanghai" },
            subGoals: [
              {
                id: 1,
                name: "美股交易窗口监控",
                reviewInterval: {
                  kind: "phased",
                  timezone: "America/New_York",
                  phases: [
                    {
                      id: "market",
                      start: "09:30",
                      end: "16:00",
                      daysOfWeek: [1, 2, 3, 4, 5],
                      trigger: { kind: "interval", value: 15, unit: "m", everyMs: 900000 },
                    },
                  ],
                },
                tasks: [
                  {
                    id: "1-1",
                    title: "盘中异动巡检",
                    description: "检查科技股异动",
                    expectedOutcome: "异动摘要",
                    taskType: "repeat",
                    triggerSpec: { kind: "cron", expr: "*/15 9-16 * * 1-5", timezone: "America/New_York" },
                  },
                ],
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
    assert.deepEqual(draft.topicLoop, { kind: "cron", expr: "0 9 * * 1", timezone: "Asia/Shanghai" });
    assert.equal(draft.subGoals[0]?.reviewTrigger?.kind, "phased");
    assert.deepEqual(draft.subGoals[0]?.tasks[0]?.triggerSpec, {
      kind: "cron",
      expr: "*/15 9-16 * * 1-5",
      timezone: "America/New_York",
    });
    assert.equal(draft.subGoals[0]?.tasks[0]?.triggerRule, "cron:*/15 9-16 * * 1-5 tz=America/New_York");
  }

  {
    const draft = adaptTopicInitSagaToGoalDraft({
      topicText: "跟踪美股科技",
      result: completedResult({
        artifacts: {
          plan: {
            topicLoop: "phased:not-json",
            loop: "weekly",
            subGoals: [
              {
                id: 1,
                name: "兼容非法触发器",
                reviewInterval: "phased:not-json",
                loopInterval: "daily",
                tasks: [
                  {
                    id: "1-1",
                    title: "保留旧触发规则",
                    description: "验证非法 triggerSpec 不会吞掉旧路径",
                    expectedOutcome: "兼容路径正常",
                    taskType: "repeat",
                    triggerSpec: "phased:not-json",
                    trigger: "interval:15m",
                  },
                ],
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

    assert.deepEqual(draft.topicLoop, { kind: "weekly" });
    assert.deepEqual(draft.subGoals[0]?.reviewTrigger, { kind: "daily" });
    assert.deepEqual(draft.subGoals[0]?.tasks[0]?.triggerSpec, {
      kind: "interval",
      everyMs: 900_000,
      value: 15,
      unit: "m",
    });
    assert.equal(draft.subGoals[0]?.tasks[0]?.triggerRule, "interval:15m");
    assert.ok(
      (draft.reviewSummary ?? []).filter((item) => item.includes("planner warning") && item.includes("非法 TriggerSpec")).length >= 3,
      "非法 TriggerSpec 应记录 planner warning",
    );
  }
}
