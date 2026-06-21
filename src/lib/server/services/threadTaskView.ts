/**
 * ThreadTaskView —— 治理层 → 调度层只读视图：给定 (topicId, threadId) 返回 thread 名下的 Task[]。
 *
 * 这是治理层读取 task 列表的公共边界 adapter。隐式投影约定只集中在本文件内：
 * - topicId 投影到 goal.id
 * - threadId 投影到 subGoal.id
 *
 * 未来 topic/thread 与 goal/subGoal/task 模型统一时，只需要替换本 adapter 实现。
 */

import { readComposedGoalsSnapshot } from "@/lib/server/runtime/instanceComposition";
import type { Task } from "@/types/kiki";

export type ThreadTaskViewQuery = {
  topicId: string;
  threadId: string;
};

export type ThreadTaskView = {
  listByThread(query: ThreadTaskViewQuery): Task[];
};

export const goalsSnapshotThreadTaskView: ThreadTaskView = {
  listByThread({ topicId, threadId }) {
    const goal = readComposedGoalsSnapshot([]).find((candidate) => candidate.id === topicId);
    const subGoal = goal?.subGoals.find((candidate) => candidate.id === threadId);
    return subGoal?.tasks ?? [];
  },
};
