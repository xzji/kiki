/**
 * Topic 命令服务 — API 命名层（§candidate-5 P6 收敛后）。
 *
 * **当前作用范围**：仅作为 `/api/topics/commands` route 的命名映射；
 * 治理 / 调度链路（governance / scheduling / dispatchTaskFromThread）不再
 * 经过本模块，已直调 `applyGoalCommand`。
 *
 * 设计意图：
 *   - PR9-10 之后真正切到 Topic/Thread 数据模型时，本文件会反向变成
 *     "Topic/Thread 一等模型 → legacy goal 命令"的 adapter；目前暂为浅命名层，
 *     不再被业务代码穿透引用，是 hypothetical seam 的占位（§9.4 问题 15）。
 *
 * 已知 leak（PR9-10 一并清理）：
 *   1. 底层 createSubGoal 会把 title 强制改写为「子目标N：xxx」；
 *   2. 错误信息（如「未找到目标」「目标已存在」）继承自 goalCommandService；
 *   3. 写出的事件 kind 仍为 goal.structure_changed / goal.workflow_changed。
 */

import {
  applyGoalCommand,
  GoalCommandConflictError,
  GoalCommandIdempotencyConflictError,
  GoalCommandValidationError,
  type ApplyGoalCommandResult,
  type GoalCommand,
} from "@/lib/server/services/goalCommandService";
import type { ExecutionKind, Goal, Task, TaskExpectedResult, TaskSpec } from "@/types/kiki";
import type { TriggerSpec } from "@/types/trigger";

type TaskCommandInput = {
  title: string;
  description?: string;
  expectedOutcome: string;
  expectedResult?: TaskExpectedResult;
  taskType: Task["taskType"];
  triggerRule: string;
  trigger?: TriggerSpec;
  deadline?: string;
  executionKind: ExecutionKind;
  taskSpec?: TaskSpec;
};

/**
 * Topic / Thread 语义的命令联合。
 *
 * 命名映射约定（与 §3.2.3 对齐）：
 *   - create_topic        ↔ create_goal
 *   - confirm_topic_plan  ↔ confirm_goal_plan
 *   - request_topic_plan_revision ↔ request_goal_plan_revision
 *   - create_thread       ↔ create_sub_goal
 *   - create_task / update_task / delete_task：保留原命名，但语义上 task 归属
 *     thread（threadId 字段在 P1 之前用 subGoalId 兜底，运行期等价）
 *   - delete_topics_by_conversation ↔ delete_goals_by_conversation
 */
export type TopicCommand =
  | {
      type: "create_topic";
      topic: Goal;
    }
  | {
      type: "replace_topic_plan";
      topic: Goal;
    }
  | {
      type: "confirm_topic_plan";
      topicId: string;
    }
  | {
      type: "request_topic_plan_revision";
      topicId: string;
      feedback: string;
    }
  | {
      type: "create_thread";
      topicId: string;
      title: string;
    }
  | {
      type: "create_task";
      topicId: string;
      threadId: string;
      task: TaskCommandInput;
    }
  | {
      type: "update_task";
      topicId: string;
      taskId: string;
      task: TaskCommandInput;
    }
  | {
      type: "delete_task";
      topicId: string;
      taskId: string;
    }
  | {
      type: "delete_topics_by_conversation";
      conversationId: string;
    };

export type ApplyTopicCommandInput = {
  command: TopicCommand;
  idempotencyKey: string;
  baseRevision?: number;
};

export type ApplyTopicCommandResult = ApplyGoalCommandResult;

/**
 * 暴露给上层路由的错误类（沿用 goalCommand 的错误对象，保持 catch 链兼容）。
 */
export {
  GoalCommandConflictError as TopicCommandConflictError,
  GoalCommandIdempotencyConflictError as TopicCommandIdempotencyConflictError,
  GoalCommandValidationError as TopicCommandValidationError,
};

/**
 * 把 TopicCommand 映射为底层 GoalCommand。
 * 暂不引入新字段（threadId 直接走 subGoalId 通道），仅做命名翻译。
 */
export function mapTopicCommandToGoalCommand(command: TopicCommand): GoalCommand {
  switch (command.type) {
    case "create_topic":
      return { type: "create_goal", goal: command.topic };
    case "replace_topic_plan":
      return { type: "replace_goal_plan", goal: command.topic };
    case "confirm_topic_plan":
      return { type: "confirm_goal_plan", goalId: command.topicId };
    case "request_topic_plan_revision":
      return {
        type: "request_goal_plan_revision",
        goalId: command.topicId,
        feedback: command.feedback,
      };
    case "create_thread":
      return { type: "create_sub_goal", goalId: command.topicId, title: command.title };
    case "create_task":
      return {
        type: "create_task",
        goalId: command.topicId,
        subGoalId: command.threadId,
        task: command.task,
      };
    case "update_task":
      return {
        type: "update_task",
        goalId: command.topicId,
        taskId: command.taskId,
        task: command.task,
      };
    case "delete_task":
      return {
        type: "delete_task",
        goalId: command.topicId,
        taskId: command.taskId,
      };
    case "delete_topics_by_conversation":
      return {
        type: "delete_goals_by_conversation",
        conversationId: command.conversationId,
      };
  }
}

export function applyTopicCommand(input: ApplyTopicCommandInput): ApplyTopicCommandResult {
  const goalCommand = mapTopicCommandToGoalCommand(input.command);
  return applyGoalCommand({
    command: goalCommand,
    idempotencyKey: input.idempotencyKey,
    baseRevision: input.baseRevision,
  });
}
