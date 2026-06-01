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

import type { TaskInstance } from "@/types/kiki";
import type { Thread, ThreadTickOutput, Topic } from "@/types/topic";

export type ThreadRunnerDecisionPromptInput = {
  topic: Topic;
  thread: Thread;
  /** 最近 7 天 Task instances（由 collect 步骤注入），prompt 仅作上下文摘要使用。 */
  recentTaskInstances: TaskInstance[];
  /** Thread 共享 memory 池（payload ≤ 8KB）。 */
  threadMemory: Record<string, unknown>;
  /** 上一轮 tick 的输出，用于让模型判断是否需要继续推进。 */
  lastTickOutput?: ThreadTickOutput;
};

const RECENT_INSTANCES_LIMIT = 12;
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
 *  3. "dispatch_task / post_message / silent"
 *  4. "能在本次 tick 一段话讲完的"
 *  5. "taskType" + "one_shot"
 *  6. "会话流" + "Inbox"
 *  7. "threadId"
 *  8. "8KB"
 */
export function buildThreadRunnerDecisionPrompt(input: ThreadRunnerDecisionPromptInput): string {
  const { topic, thread, recentTaskInstances, threadMemory, lastTickOutput } = input;

  const recentList = recentTaskInstances
    .slice(0, RECENT_INSTANCES_LIMIT)
    .map(summarizeTaskInstance)
    .join("\n") || "（最近 7 天无 Task 实例）";

  return [
    "你是 ThreadRunner，负责在 Thread 周期性 tick 中决策下一步动作。",
    "",
    "# 必备约束（不可违反）",
    "1. 决策/展示层拆分：仅返回 { actions, memoryDelta? } 单 JSON 对象，禁止 markdown 解释。",
    "2. 数据源仅来自 ① Thread memory ② 上次 tick 产出 ③ 最近 7 天 Task instances，不接外部源。",
    "3. 输出 3 类动作可叠加：dispatch_task / post_message / silent；仅当无 dispatch_task 与 post_message 时才允许 silent。",
    "4. 判断规则：能在本次 tick 一段话讲完的 → post_message；要再起一次完整执行流程的 → dispatch_task。",
    "5. dispatch_task 派发的 Task 强制为 one_shot 模式（taskType 由 ThreadRunner 固定写入，taskDraft 中无需也禁止包含 taskType 字段），避免与 Thread tick 同频造成双重重复触发。",
    "6. post_message 固定双写会话流 + Inbox（无需选择渠道），单条 text ≤ 500 字。",
    "7. 所有 dispatch_task 必须填 threadId，绑定当前 Thread；禁止跨 Thread 派发。",
    "8. 整体 payload ≤ 8KB 硬约束；超长请压缩或拆分到下一次 tick。",
    "",
    "# 上下文",
    `Topic: ${clip(topic.title, 80)} (status=${topic.status})`,
    `Thread: ${clip(thread.title, 80)} (intent=${clip(thread.intent, 120)}, loopInterval=${
      typeof thread.loopInterval === "string" ? thread.loopInterval : `cron:${thread.loopInterval.expr}`
    }, status=${thread.status})`,
    `Thread memory: ${summarizeMemory(threadMemory)}`,
    `上次 tick 产出: ${summarizeLastTickOutput(lastTickOutput)}`,
    "",
    "# 最近 7 天 Task instances",
    recentList,
    "",
    "# 输出格式",
    '{ "actions": [...], "memoryDelta"?: {...} }',
  ].join("\n");
}
