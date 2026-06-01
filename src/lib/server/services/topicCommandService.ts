/**
 * Topic 命令服务 — PR6 阶段最小骨架（thin wrapper）。
 *
 * 设计意图：
 *   - 在 P0/P1 阶段保留 goalCommandService 的全部实现细节（snapshot 读写、
 *     idempotency、revision 锁、事件投影），仅在外层提供 Topic/Thread
 *     语义的命令名映射，方便页面/路由层先行迁移到新命名而不破坏底层逻辑。
 *   - PR9-10 之后真正切到 Topic/Thread 数据模型时，再把这里的实现内化，
 *     反向把 goalCommandService 改造为 thin wrapper（§9.4 问题 15 — 必须
 *     内部转发，不能 308 redirect）。
 *
 * 已知 leak（有意为之，PR9-10 一并清理，避免本期重构面扩散）：
 *   1. 底层 createSubGoal 会把 title 强制改写为「子目标N：xxx」，从 /api/topics
 *      入口创建 thread 时仍会落到 goal 措辞；
 *   2. 错误信息（如「未找到目标」「目标已存在」）继承自 goalCommandService，
 *      不在本文件改写以维持 catch 链兼容；UI 层在 P0 阶段直接展示透传文案；
 *   3. 写出的事件 kind 仍为 goal.structure_changed / goal.workflow_changed，
 *      Topic/Thread 专属事件 kind 留待 PR11+ 引入 ThreadRunner 后再切换。
 */

import {
  applyGoalCommand,
  GoalCommandConflictError,
  GoalCommandIdempotencyConflictError,
  GoalCommandValidationError,
  type ApplyGoalCommandResult,
  type GoalCommand,
} from "@/lib/server/services/goalCommandService";
import type { ExecutionKind, Goal, Task } from "@/types/kiki";

type TaskCommandInput = {
  title: string;
  description?: string;
  expectedOutcome: string;
  taskType: Task["taskType"];
  triggerRule: string;
  deadline?: string;
  executionKind: ExecutionKind;
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
