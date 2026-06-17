import assert from "node:assert/strict";

import { buildThreadRunnerDecisionPrompt } from "@/lib/server/thread/threadRunnerPrompt";
import type { Task, TaskInstance } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";

function makeTopic(): Topic {
  return {
    id: "topic-prompt-fail",
    title: "失败原因测试 Topic",
    summary: "测试 ThreadRunner prompt 失败原因透传",
    loop: { kind: "weekly" },
    phase: "idle",
    silentCount: 0,
    failureCount: 0,
    infraFailureCount: 0,
    threads: [],
    status: "active",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    revision: 1,
  };
}

function makeThread(topicId: string): Thread {
  return {
    id: "thread-prompt-fail",
    topicId,
    title: "失败原因测试 Thread",
    intent: "确保失败任务通知带原因",
    loopInterval: "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    infraFailureCount: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    revision: 1,
  };
}

function makeInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: "inst-prompt-fail",
    taskId: "task-prompt-fail",
    dateLabel: "2026-06-03",
    status: "error",
    intro: "每日市场情绪速览",
    payload: { kind: "generic_result", summary: "每日市场情绪速览" },
    createdAt: "2026-06-03T00:00:00.000Z",
    execution: {
      phase: "failed",
      status: "error",
      startedAt: "2026-06-03T00:00:00.000Z",
      finishedAt: "2026-06-03T00:01:00.000Z",
      lastUpdatedAt: "2026-06-03T00:01:00.000Z",
      errorMessage: "数据源 502",
    },
    ...overrides,
  };
}

function makeTask(instance: TaskInstance): Task {
  return {
    id: "task-prompt-fail",
    subGoalId: "thread-prompt-fail",
    title: "任务1：每日市场情绪速览",
    description: "",
    expectedOutcome: "",
    taskType: "repeat",
    triggerRule: "每天 09:00",
    progress: 0,
    instances: [instance],
    executionKind: "generic_result",
  };
}

function buildPrompt(input: { currentTasks?: Task[]; recentTaskInstances?: TaskInstance[] }) {
  const topic = makeTopic();
  const thread = makeThread(topic.id);
  return buildThreadRunnerDecisionPrompt({
    topic,
    thread,
    currentTasks: input.currentTasks,
    recentTaskInstances: input.recentTaskInstances ?? [],
    threadMemory: thread.memory,
    now: new Date("2026-06-03T08:00:00.000Z"),
  });
}

export function runThreadRunnerPromptSpecs() {
  {
    const prompt = buildPrompt({
      recentTaskInstances: [makeInstance()],
    });
    assert.equal(
      prompt.includes("failureReason=数据源 502"),
      true,
      "最近失败实例应把 execution.errorMessage 透出给 ThreadRunner",
    );
    assert.equal(
      prompt.includes("禁止猜测外部数据源、配置、权限等原因"),
      true,
      "prompt 必须约束未知失败原因时禁止猜测",
    );
  }

  {
    const prompt = buildPrompt({
      currentTasks: [makeTask(makeInstance())],
    });
    assert.equal(
      prompt.includes("latestFailureReason=数据源 502"),
      true,
      "当前 Task 列表的 latest 失败实例应透出失败原因",
    );
  }

  {
    const prompt = buildPrompt({
      recentTaskInstances: [
        makeInstance({
          execution: {
            phase: "failed",
            status: "error",
            startedAt: "2026-06-03T00:00:00.000Z",
            finishedAt: "2026-06-03T00:01:00.000Z",
            lastUpdatedAt: "2026-06-03T00:01:00.000Z",
          },
        }),
      ],
    });
    assert.equal(
      prompt.includes("failureReason=失败原因未记录"),
      true,
      "无原因失败实例应显式标记失败原因未记录",
    );
  }

  {
    const prompt = buildPrompt({});
    assert.equal(prompt.includes('"assessment"'), true, "prompt 应要求输出 assessment");
    assert.equal(prompt.includes('"confidence"'), true, "prompt 应要求输出 confidence");
    assert.equal(
      prompt.includes("low=禁止 archive_thread/cancel_task/dispatch_task"),
      true,
      "prompt 应声明低置信禁止高风险动作",
    );
    assert.equal(
      prompt.includes("TaskScheduling 层"),
      true,
      "prompt 应保留 ThreadGovernance / TaskScheduling 分层边界",
    );
  }
}
