/**
 * topicCommandService spec — covers TopicCommand → GoalCommand 命名映射。
 *
 * 设计取舍：本 spec 只验证 mapTopicCommandToGoalCommand 的纯函数语义，不验证
 * DB 写入（DB 写入完全复用 goalCommandService，已在其它 spec 覆盖）。
 *
 * Plan ref: §3.2.3 + §10.10。
 */

import assert from "node:assert/strict";

import { mapTopicCommandToGoalCommand } from "../services/topicCommandService";
import type { Goal } from "@/types/kiki";

function makeGoalStub(): Goal {
  return {
    id: "g-1",
    title: "T1",
    deadline: "",
    progress: 0,
    subGoals: [],
    createdAt: "2026-05-31T00:00:00.000Z",
    conversationId: "c-1",
  };
}

const taskInputStub = {
  title: "T",
  expectedOutcome: "O",
  taskType: "one_shot" as const,
  triggerRule: "now",
  executionKind: "generic_result" as const,
};

export function runTopicCommandServiceSpecs() {
  // 1) create_topic → create_goal，topic 字段透传到 goal
  {
    const goal = makeGoalStub();
    const mapped = mapTopicCommandToGoalCommand({ type: "create_topic", topic: goal });
    assert.equal(mapped.type, "create_goal");
    if (mapped.type === "create_goal") {
      assert.strictEqual(mapped.goal, goal);
    }
  }

  // 2) replace_topic_plan → replace_goal_plan，topic 字段透传到 goal
  {
    const goal = makeGoalStub();
    const mapped = mapTopicCommandToGoalCommand({ type: "replace_topic_plan", topic: goal });
    assert.equal(mapped.type, "replace_goal_plan");
    if (mapped.type === "replace_goal_plan") {
      assert.strictEqual(mapped.goal, goal);
    }
  }

  // 3) confirm_topic_plan → confirm_goal_plan，topicId → goalId
  {
    const mapped = mapTopicCommandToGoalCommand({ type: "confirm_topic_plan", topicId: "g-2" });
    assert.equal(mapped.type, "confirm_goal_plan");
    if (mapped.type === "confirm_goal_plan") {
      assert.equal(mapped.goalId, "g-2");
    }
  }

  // 4) request_topic_plan_revision → request_goal_plan_revision
  {
    const mapped = mapTopicCommandToGoalCommand({
      type: "request_topic_plan_revision",
      topicId: "g-3",
      feedback: "需要再补充",
    });
    assert.equal(mapped.type, "request_goal_plan_revision");
    if (mapped.type === "request_goal_plan_revision") {
      assert.equal(mapped.goalId, "g-3");
      assert.equal(mapped.feedback, "需要再补充");
    }
  }

  // 5) create_thread → create_sub_goal（threadId 暂走 subGoalId 通道）
  {
    const mapped = mapTopicCommandToGoalCommand({
      type: "create_thread",
      topicId: "g-4",
      title: "持续监控",
    });
    assert.equal(mapped.type, "create_sub_goal");
    if (mapped.type === "create_sub_goal") {
      assert.equal(mapped.goalId, "g-4");
      assert.equal(mapped.title, "持续监控");
    }
  }

  // 6) create_task：threadId → subGoalId、topicId → goalId
  {
    const mapped = mapTopicCommandToGoalCommand({
      type: "create_task",
      topicId: "g-5",
      threadId: "sg-5",
      task: taskInputStub,
    });
    assert.equal(mapped.type, "create_task");
    if (mapped.type === "create_task") {
      assert.equal(mapped.goalId, "g-5");
      assert.equal(mapped.subGoalId, "sg-5");
      assert.equal(mapped.task.title, "T");
    }
  }

  // 7) update_task / delete_task：topicId → goalId、taskId 直通
  {
    const upd = mapTopicCommandToGoalCommand({
      type: "update_task",
      topicId: "g-6",
      taskId: "t-6",
      task: taskInputStub,
    });
    assert.equal(upd.type, "update_task");
    if (upd.type === "update_task") {
      assert.equal(upd.goalId, "g-6");
      assert.equal(upd.taskId, "t-6");
    }

    const del = mapTopicCommandToGoalCommand({
      type: "delete_task",
      topicId: "g-7",
      taskId: "t-7",
    });
    assert.equal(del.type, "delete_task");
    if (del.type === "delete_task") {
      assert.equal(del.goalId, "g-7");
      assert.equal(del.taskId, "t-7");
    }
  }

  // 8) delete_topics_by_conversation → delete_goals_by_conversation
  {
    const mapped = mapTopicCommandToGoalCommand({
      type: "delete_topics_by_conversation",
      conversationId: "c-9",
    });
    assert.equal(mapped.type, "delete_goals_by_conversation");
    if (mapped.type === "delete_goals_by_conversation") {
      assert.equal(mapped.conversationId, "c-9");
    }
  }

  console.log("topicCommandService specs passed");
}
