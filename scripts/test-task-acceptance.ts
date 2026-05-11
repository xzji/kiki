import { buildAcceptanceJudgePrompt, buildLocalValidationRepairPrompt, buildSemanticRepairPrompt } from "@/lib/server/goalTaskAcceptancePrompt";
import { validateTaskResultLocally } from "@/lib/taskResult/localValidation";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { AcceptanceReport } from "@/types/taskAcceptance";
import type { TaskResult } from "@/types/taskResult";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const now = new Date().toISOString();

const instance: TaskInstance = {
  id: "instance-test-1",
  taskId: "task-test-1",
  dateLabel: "2026-05-10",
  status: "completed",
  intro: "调研胡志明市到芽庄的三种交通方式",
  payload: {
    kind: "generic_result",
    summary: "已完成调研",
  },
  createdAt: now,
};

const task: Task = {
  id: "task-test-1",
  subGoalId: "subgoal-test-1",
  title: "0510 调研胡志明市至芽庄交通方式",
  description: "比较航班、火车、大巴三种交通方式，给出推荐方案。",
  expectedOutcome: "产出三种交通方式的基础信息对比表，并给出推荐方案。",
  taskType: "one_shot",
  triggerRule: "2026-05-10 21:00",
  progress: 0,
  instances: [instance],
  executionKind: "generic_result",
  resultViewKind: "generic_result",
  expectedResult: {
    type: "information",
    description: "输出三种交通方式的对比信息和推荐结论",
    format: "table",
    presentation: "visual_report",
    primaryFormat: "structured_blocks",
    exportableFormats: ["html", "markdown"],
    requiredBlocks: ["heading", "comparison_table", "callout"],
    completionCriteria: "必须展示三种方式对比，并明确推荐方案和适用条件。",
  },
  executionObjective: "完成交通方式对比与推荐结论",
};

const subGoal: SubGoal = {
  id: "subgoal-test-1",
  goalId: "goal-test-1",
  title: "完成交通调研",
  tasks: [task],
};

const goal: Goal = {
  id: "goal-test-1",
  conversationId: "conv-test-1",
  title: "越南旅行交通调研",
  summary: "为胡志明市到芽庄行程做交通方式分析",
  deadline: "2026-05-10",
  progress: 0,
  kind: "collab",
  createdAt: now,
  subGoals: [subGoal],
};

const failedArtifactOnlyResult = {
  summary: "已调研三种交通方式。",
  finalMessage: "航班最快，火车最稳，大巴最便宜。",
  artifacts: [
    {
      id: "artifact-1",
      label: "交通方式说明",
      kind: "markdown",
      content: "航班最快，火车最稳，大巴最便宜。",
    },
  ],
  taskResult: null,
  deliverableCheck: null,
  awaitingUser: false,
  interactionRequirement: {
    type: "none",
    timing: "not_required",
    reason: "",
    shouldNotifyUser: false,
  },
};

const localFailedReport = validateTaskResultLocally({
  task,
  rawOutput: JSON.stringify(failedArtifactOnlyResult),
  parsedResult: failedArtifactOnlyResult,
});

assert(!localFailedReport.passed, "artifact-only 结果应当无法通过本地校验");
assert(localFailedReport.issues.some((item) => item.code === "missing_task_result"), "应识别缺少 task_result");
assert(localFailedReport.issues.some((item) => item.code === "artifact_only"), "应识别 artifact-only");

const localRepairPrompt = buildLocalValidationRepairPrompt({
  goal,
  subGoal,
  task,
  instance,
  rawAgentOutput: JSON.stringify(failedArtifactOnlyResult, null, 2),
  parsedResult: failedArtifactOnlyResult,
  report: localFailedReport,
});

assert(localRepairPrompt.includes("task_result.blocks"), "本地修复 Prompt 必须要求输出 task_result.blocks");
assert(localRepairPrompt.includes("artifact"), "本地修复 Prompt 必须提到 artifact 不能作为唯一产出");

const repairedTaskResult: TaskResult = {
  schemaVersion: 1,
  taskId: task.id,
  instanceId: instance.id,
  title: "胡志明市至芽庄交通方式对比",
  status: "done",
  blocks: [
    { kind: "heading", text: "三种交通方式对比", level: 2 },
    {
      kind: "comparison_table",
      columns: ["方式", "时长", "价格", "优点", "缺点"],
      rows: [
        { 方式: "航班", 时长: "1h", 价格: "高", 优点: "最快", 缺点: "价格高" },
        { 方式: "火车", 时长: "7h", 价格: "中", 优点: "稳定", 缺点: "时间较长" },
        { 方式: "大巴", 时长: "8h", 价格: "低", 优点: "便宜", 缺点: "舒适度一般" },
      ],
    },
    { kind: "callout", tone: "success", text: "如果优先节省时间，推荐航班；若追求性价比，优先火车。" },
  ],
  meta: {
    producedAt: now,
    presentation: "visual_report",
    primaryFormat: "structured_blocks",
    exportableFormats: ["html", "markdown"],
  },
};

const repairedResult = {
  summary: "已完成三种交通方式对比并给出推荐。",
  finalMessage: "已补齐对比表和推荐结论。",
  artifacts: [],
  taskResult: repairedTaskResult,
  deliverableCheck: {
    matched: true,
    missingDeliverables: [],
    criteriaResults: [{ status: "passed" }],
  },
  awaitingUser: false,
  interactionRequirement: {
    type: "none",
    timing: "not_required",
    reason: "",
    shouldNotifyUser: false,
  },
};

const localPassedReport = validateTaskResultLocally({
  task,
  rawOutput: JSON.stringify(repairedResult),
  parsedResult: repairedResult,
});

assert(localPassedReport.passed, "补齐后的结果应当通过本地校验");

const judgePrompt = buildAcceptanceJudgePrompt({
  goal,
  subGoal,
  task,
  instance,
  localValidationReport: localPassedReport,
  currentResult: repairedResult,
});

assert(judgePrompt.includes("任务验收员"), "验收员 Prompt 应正确生成");
assert(judgePrompt.includes("needs_repair"), "验收员 Prompt 应包含 verdict 输出格式");

const mockedAcceptanceReport: AcceptanceReport = {
  verdict: "needs_repair",
  confidence: "high",
  summary: "结果有对比表，但还缺少适用条件说明。",
  hardFailures: [],
  passedCriteria: [
    {
      criterion: "展示三种交通方式对比",
      evidence: "comparison_table 已覆盖三种方式的时长、价格、优缺点。",
    },
  ],
  failedCriteria: [
    {
      criterion: "明确推荐方案的适用条件",
      evidence: "callout 有推荐，但没有列出适用场景。",
      severity: "major",
      repairableByAgent: true,
      requiresUserInput: false,
    },
  ],
  blockAssessment: {
    keepBlocks: ["heading", "comparison_table"],
    rewriteBlocks: ["callout"],
    missingBlocks: [],
  },
  repairStrategy: {
    mode: "presentation_only",
    reuseExistingContent: true,
    allowNewToolCalls: false,
  },
  repairInstructions: ["补充推荐方案适用条件，不要改动已通过的对比表。"],
  userBlockers: [],
};

const semanticRepairPrompt = buildSemanticRepairPrompt({
  goal,
  subGoal,
  task,
  instance,
  currentResult: repairedResult,
  acceptanceReport: mockedAcceptanceReport,
});

assert(semanticRepairPrompt.includes("不要无关重写"), "内容补齐 Prompt 应强调定向补齐");
assert(semanticRepairPrompt.includes("补充推荐方案适用条件"), "内容补齐 Prompt 应包含验收员给出的修复指令");

console.log("PASS local validation detects artifact-only failure");
console.log("PASS local repair prompt contains task_result.blocks requirement");
console.log("PASS repaired result passes local validation");
console.log("PASS acceptance judge prompt contains expected output schema");
console.log("PASS semantic repair prompt contains targeted repair instructions");
