/**
 * ThreadRunner.tick prompt builder — 计划 §3.3.4。
 *
 * 设计要点：
 *  - 单 prompt 实现（决策 A4），不拆 4 次 LLM 调用。
 *  - 决策层 prompt：仅返回 `{ actions, memoryDelta? }` JSON；
 *    展示层 fire-and-forget 由 ThreadRunner 在 post_message.text > 500 字时
 *    异步触发，与本文件无关。
 *  - 8 条必备约束写进 system instruction（必须以 substring 形式可被
 *    promptDuplicationGuardSpec 校验）。
 */

import type { Task, TaskInstance } from "@/types/kiki";
import type { Thread, ThreadTickOutput, Topic } from "@/types/topic";

export type ThreadRunnerDecisionPromptInput = {
  topic: Topic;
  thread: Thread;
  /** 当前 Thread 下的 Task 列表，用于治理增/改/删。 */
  currentTasks?: Task[];
  /** 最近 7 天 Task instances（由 collect 步骤注入），prompt 仅作上下文摘要使用。 */
  recentTaskInstances: TaskInstance[];
  /** Thread 共享 memory 池（payload ≤ 8KB）。 */
  threadMemory: Record<string, unknown>;
  /** 上一轮 tick 的输出，用于让模型判断是否需要继续推进。 */
  lastTickOutput?: ThreadTickOutput;
};

const RECENT_INSTANCES_LIMIT = 12;
const CURRENT_TASKS_LIMIT = 20;
const SUMMARY_TEXT_LIMIT = 600;

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function summarizeTaskInstance(instance: TaskInstance): string {
  const headline = clip(instance.intro || instance.payload?.summary || instance.taskId, 80);
  const status = instance.status;
  const finishedAt = instance.execution?.finishedAt ?? "";
  const resultSnippet = clip(
    instance.result?.summary ?? instance.result?.finalMessage ?? "",
    120,
  );
  return `- [${status}] ${headline}${finishedAt ? ` @ ${finishedAt}` : ""}${
    resultSnippet ? ` -> ${resultSnippet}` : ""
  }`;
}

function summarizeTask(task: Task): string {
  const latest = task.instances[0];
  const latestStatus = latest ? `, latest=${latest.status}` : "";
  const latestResult = latest?.result?.summary ?? latest?.result?.finalMessage ?? "";
  return `- ${task.id}: ${clip(task.title, 60)} (taskType=${task.taskType}, triggerRule=${clip(task.triggerRule, 60)}${latestStatus})${
    latestResult ? ` -> ${clip(latestResult, 100)}` : ""
  }`;
}

function summarizeMemory(memory: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(memory ?? {}, null, 0);
    return clip(json, SUMMARY_TEXT_LIMIT);
  } catch {
    return "{}";
  }
}

function summarizeLastTickOutput(output?: ThreadTickOutput): string {
  if (!output) return "（无）";
  const actionList = Array.isArray(output.actions) ? output.actions : [];
  const actions = actionList
    .map((a) => {
      switch (a.kind) {
        case "dispatch_task":
          return `dispatch_task(${clip(a.taskDraft.title, 40)})`;
        case "update_task":
          return `update_task(${a.taskId})`;
        case "cancel_task":
          return `cancel_task(${a.taskId})`;
        case "post_message":
          return `post_message(${a.severity}: ${clip(a.text, 40)})`;
        case "silent":
          return `silent(${clip(a.reason, 40)})`;
      }
    })
    .join("; ");
  return clip(actions || "（无动作）", SUMMARY_TEXT_LIMIT);
}

/**
 * 构造 ThreadRunner 决策层 prompt。
 *
 * 必须保证输出包含 §3.3.4 列出的 8 条约束关键字（详见 promptDuplicationGuardSpec）：
 *  1. "决策/展示层拆分"
 *  2. "Thread memory" + "上次 tick 产出" + "最近 7 天 Task instances"
 *  3. "dispatch_task / update_task / cancel_task / post_message / silent"
 *  4. "能在本次 tick 一段话讲完的"
 *  5. "taskType" + "triggerRule"
 *  6. "会话流" + "Inbox"
 *  7. "threadId"
 *  8. "8KB"
 */
export function buildThreadRunnerDecisionPrompt(input: ThreadRunnerDecisionPromptInput): string {
  const { topic, thread, currentTasks = [], recentTaskInstances, threadMemory, lastTickOutput } = input;

  const currentTaskList = currentTasks
    .slice(0, CURRENT_TASKS_LIMIT)
    .map(summarizeTask)
    .join("\n") || "（当前 Thread 下暂无 Task）";

  const recentList = recentTaskInstances
    .slice(0, RECENT_INSTANCES_LIMIT)
    .map(summarizeTaskInstance)
    .join("\n") || "（最近 7 天无 Task 实例）";

  return [
    "你是 ThreadRunner，负责治理当前 Thread 板块下的 Task 集合。",
    "你不直接执行 Task；你只决定本板块应该有哪些 Task、是否要调整 Task 配置，以及是否发板块小结。",
    "",
    "# 必备约束（不可违反）",
    "1. 决策/展示层拆分：仅返回 { actions, memoryDelta? } 单 JSON 对象，禁止 markdown 解释。",
    "2. 数据源仅来自 ① Thread memory ② 上次 tick 产出 ③ 当前 Task 列表 ④ 最近 7 天 Task instances，不接外部源。",
    "3. 输出 5 类动作可叠加：dispatch_task / update_task / cancel_task / post_message / silent；仅当无结构性动作与 post_message 时才允许 silent。",
    "4. 判断规则：能在本次 tick 一段话讲完的 → post_message；现有 Task 无法覆盖的新关注点 → dispatch_task；既有 Task 目标/频率/触发条件需变化 → update_task；关注点消失或已永久完成 → cancel_task。",
    "5. dispatch_task 必须为新 Task 指定合适的 taskType 与 triggerRule/cadence/triggerCondition：持续关注用 repeat，一次性交付用 one_shot，事件型需求降级为 repeat 周期巡检。",
    "6. post_message 固定双写会话流 + Inbox（无需选择渠道），单条 text ≤ 500 字。",
    `7. 所有 post_message / dispatch_task / update_task / cancel_task 必须填 threadId="${thread.id}"，只能治理当前 Thread 下的 Task，禁止跨 Thread。`,
    "8. 整体 payload ≤ 8KB 硬约束；超长请压缩或拆分到下一次 tick。",
    "",
    "# 上下文",
    `Topic: ${clip(topic.title, 80)} (status=${topic.status})`,
    `Thread: ${clip(thread.title, 80)} (intent=${clip(thread.intent, 120)}, reviewInterval=${
      typeof thread.loopInterval === "string" ? thread.loopInterval : `cron:${thread.loopInterval.expr}`
    }, terminationCondition=${clip(thread.terminationCondition ?? "（无）", 80)}, status=${thread.status})`,
    `Thread memory: ${summarizeMemory(threadMemory)}`,
    `上次 tick 产出: ${summarizeLastTickOutput(lastTickOutput)}`,
    "",
    "# 当前 Thread 下的 Task 列表",
    currentTaskList,
    "",
    "# 最近 7 天 Task instances",
    recentList,
    "",
    "# 输出格式",
    '{ "actions": [...], "memoryDelta"?: {...} }',
    "",
    "# action JSON 形状",
    `post_message: { "kind": "post_message", "threadId": "${thread.id}", "text": "≤500字", "severity": "info|warning|important" }`,
    `dispatch_task: { "kind": "dispatch_task", "threadId": "${thread.id}", "reason": "原因", "taskDraft": { "title": "任务标题", "objective": "目标", "deliverable": "交付物", "acceptanceCriteria": ["标准"], "cadence": "每天 09:00", "triggerCondition": "可选条件" } }`,
    `update_task: { "kind": "update_task", "threadId": "${thread.id}", "taskId": "当前 Task id", "reason": "原因", "patch": { "cadence": "每周一", "objective": "新目标" } }`,
    `cancel_task: { "kind": "cancel_task", "threadId": "${thread.id}", "taskId": "当前 Task id", "reason": "原因" }`,
    'silent: { "kind": "silent", "reason": "原因" }',
  ].join("\n");
}
