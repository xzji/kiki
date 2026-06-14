import assert from "node:assert/strict";
import { compileTaskDraftsToDraftTasks } from "./taskCompiler";
import {
  buildCollaboration,
  buildExpectedResult,
  inferRequiredBlocks,
  mergeCrossSubGoalTaskDependencies,
  validateCadence,
} from "@/lib/goalPlanning/taskCompiler";
import type { GoalBreakdownDraft } from "@/types/kiki";
import type { TaskDraft } from "./taskDraftSchema";

const base: TaskDraft = {
  index: 1,
  title: "周报看板",
  objective: "生成候选人进度周报和风险提示",
  deliverable: "候选人对比表和行动清单",
  acceptanceCriteria: ["包含表格", "包含行动清单"],
  cadence: "每周日 20:00 触发",
  priorityHint: "high",
};

function task(id: string, title: string, extra: Partial<GoalBreakdownDraft["subGoals"][number]["tasks"][number]> = {}) {
  return {
    id,
    title,
    description: `${title} 描述`,
    expectedOutcome: `${title} 结果`,
    taskType: "one_shot" as const,
    triggerRule: "准备好后执行一次",
    executionKind: "generic_result" as const,
    executionMode: "standard" as const,
    ...extra,
  };
}

export function runTaskCompilerSpecs() {
  assert.equal(validateCadence(base).cadence, "每周日 20:00 触发");
  assert.equal(validateCadence({ ...base, cadence: "晚上触发" }).cadence, undefined);
  assert.equal(buildCollaboration({ ...base, userInvolvement: { mode: "confirm" } }, base.objective, base.deliverable).userInteractionType, "confirm");
  assert.equal(buildExpectedResult("generic_result", "确认方案", "生成方案").type, "deliverable");
  assert.equal(inferRequiredBlocks("generic_result", "候选人对比表", "输出矩阵").includes("comparison_table"), true);
  const compiled = compileTaskDraftsToDraftTasks({
    drafts: [base, { ...base, index: 2, title: "依赖任务", dependencyHints: ["1"], cadence: undefined }],
    subGoalContext: { id: 1, name: "子目标", description: "描述", criteria: ["完成"], priority: "high" },
    taskIdBatchSeed: "seed",
    subGoalDraftId: "draft-subgoal-1",
    subGoalIndex: 1,
  });
  assert.equal(compiled.tasks.length, 2);
  assert.equal(compiled.tasks[1]?.dependencies?.length, 1);

  const offsetCompiled = compileTaskDraftsToDraftTasks({
    drafts: [{ ...base, cadence: undefined }],
    subGoalContext: { id: 1, name: "子目标", description: "描述", criteria: ["完成"], priority: "high" },
    taskIdBatchSeed: "seed",
    subGoalDraftId: "draft-subgoal-1",
    subGoalIndex: 1,
    taskIndexOffset: 2,
  });
  assert.ok(offsetCompiled.tasks[0]?.id.includes("-t3-"));

  const gameDemo = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "game-demo-preferences",
        title: "小游戏 Demo 偏好收集",
        description: "确认玩家偏好、参考案例和互动边界",
        dependencies: [],
        tasks: [task("collect-player-preferences", "收集用户偏好与参考案例")],
      },
      {
        id: "game-demo-story",
        title: "剧情设计",
        description: "基于偏好设计世界观和剧情线",
        dependencies: ["game-demo-preferences"],
        tasks: [task("write-story", "设计小游戏 Demo 剧情")],
      },
      {
        id: "game-demo-ai",
        title: "AI 机制设计",
        description: "基于偏好设计 AI 交互机制",
        dependencies: ["game-demo-preferences"],
        tasks: [task("design-ai", "设计 AI 对话与反馈机制")],
      },
      {
        id: "game-demo-prototype",
        title: "原型实现",
        description: "基于偏好和设计产出实现 Demo 原型",
        dependencies: ["game-demo-preferences"],
        tasks: [task("build-prototype", "实现可试玩原型")],
      },
    ],
  });
  assert.deepEqual(gameDemo.subGoals[1]?.tasks[0]?.dependencies, ["collect-player-preferences"]);
  assert.deepEqual(gameDemo.subGoals[2]?.tasks[0]?.dependencies, ["collect-player-preferences"]);
  assert.deepEqual(gameDemo.subGoals[3]?.tasks[0]?.dependencies, ["collect-player-preferences"]);

  const mergedByTitle = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "偏好收集",
        description: "描述",
        dependencies: [],
        tasks: [task("taste", "确认用户偏好")],
      },
      {
        id: "draft-subgoal-2",
        title: "原型设计",
        description: "描述",
        dependencies: ["draft-subgoal-1"],
        tasks: [task("prototype", "生成原型", { planningDependencyHints: ["确认用户偏好"] })],
      },
    ],
  });
  assert.deepEqual(mergedByTitle.subGoals[1]?.tasks[0]?.dependencies, ["taste"]);

  const autoMerged = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "前置信息",
        description: "描述",
        dependencies: [],
        tasks: [
          task("watch", "持续监控", { taskType: "repeat", executionMode: "monitoring" }),
          task("decision", "确定核心方案"),
        ],
      },
      {
        id: "draft-subgoal-2",
        title: "执行",
        description: "描述",
        dependencies: ["draft-subgoal-1"],
        tasks: [task("execute", "推进执行")],
      },
    ],
  });
  assert.deepEqual(autoMerged.subGoals[1]?.tasks[0]?.dependencies, ["decision"]);

  const explicitRepeat = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "监控",
        description: "描述",
        dependencies: [],
        tasks: [task("watch", "持续监控", { taskType: "repeat", executionMode: "monitoring" })],
      },
      {
        id: "draft-subgoal-2",
        title: "复盘",
        description: "描述",
        dependencies: ["draft-subgoal-1"],
        tasks: [task("review", "生成复盘", { planningDependencyHints: ["watch"] })],
      },
    ],
  });
  assert.deepEqual(explicitRepeat.subGoals[1]?.tasks[0]?.dependencies, ["watch"]);

  const mergedBySequence = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "draft-subgoal-9",
        title: "输入",
        description: "描述",
        dependencies: [],
        tasks: [task("input-1", "收集输入")],
      },
      {
        id: "draft-subgoal-10",
        title: "输出",
        description: "描述",
        dependencies: ["draft-subgoal-9"],
        tasks: [task("output-1", "生成输出", { planningDependencyHints: ["9-1"] })],
      },
    ],
  });
  assert.deepEqual(mergedBySequence.subGoals[1]?.tasks[0]?.dependencies, ["input-1"]);

  const cycle = mergeCrossSubGoalTaskDependencies({
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "A",
        description: "描述",
        dependencies: [],
        tasks: [task("a", "任务 A", { dependencies: ["b"] })],
      },
      {
        id: "draft-subgoal-2",
        title: "B",
        description: "描述",
        dependencies: [],
        tasks: [task("b", "任务 B", { dependencies: ["a"] })],
      },
    ],
  });
  assert.deepEqual(cycle.subGoals[0]?.tasks[0]?.dependencies, ["b"]);
  assert.deepEqual(cycle.subGoals[1]?.tasks[0]?.dependencies, []);
  assert.equal(cycle.warnings.some((warning) => warning.code === "dependency_cycle"), true);
}
