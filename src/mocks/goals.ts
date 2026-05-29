import { createOpaqueId, migrateGoalIds } from "@/lib/opaqueIds";
import { buildExpectedResult as expectedResultFor } from "@/lib/goalPlanning/taskCompiler";
import { normalizeExecutionKind, normalizeTaskResultViewKind } from "@/types/kiki";
import type {
  ExecutionKind,
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  InteractionRequirement,
  Task,
  TaskCollaborationRequirements,
  TaskExecutionStep,
  TaskInstance,
} from "@/types/kiki";
import type { AgentRunPlan } from "@/types/agentOrchestration";
import type { TaskResult } from "@/types/taskResult";

export const INITIAL_NOW = "2026-04-26T10:00:00+08:00";
const ARTIFACT_DEMO_ID = "artifact-demo-1778950506965";
const WEBAPP_DEMO_ID = "artifact-demo-webapp-1778950506965";
const INTERNET_WEBAPP_DEMO_ID = "artifact-demo-internet-webapp-1778950506965";
const YOUTUBE_EMBED_DEMO_ID = "artifact-demo-youtube-1778950506965";

function payloadFor(): ExecutionPayload {
  return { kind: "generic_result", summary: "已生成本轮任务结果。", details: "查看执行链路获取更多上下文。" };
}

function statusToPhase(status: TaskInstance["status"]) {
  if (status === "completed") return "completed" as const;
  if (status === "awaiting_user") return "awaiting_user" as const;
  if (status === "paused") return "failed" as const;
  if (status === "error") return "failed" as const;
  if (status === "in_progress") return "running" as const;
  return "queued" as const;
}

function collaborationFor(_kind: ExecutionKind, description: string, expectedOutcome: string): TaskCollaborationRequirements {
  return {
    mode: "agent_autonomous",
    agentResponsibilities: [description, "自主完成并沉淀结果"],
    userResponsibilities: [],
    userInteractionType: "none",
    userInteractionTiming: "not_required",
    userFacingActionLabel: "查看结果",
    shouldNotifyUser: false,
    completionOwner: "agent",
    completionDefinition: expectedOutcome,
  };
}

function interactionFor(kind: ExecutionKind, reason: string): InteractionRequirement {
  const collaboration = collaborationFor(kind, reason, reason);
  const type =
    collaboration.userInteractionType === "perform_offline_action"
      ? "perform_offline_action"
      : collaboration.userInteractionType;
  return {
    type,
    timing: collaboration.userInteractionTiming,
    reason,
    suggestedActions:
      type === "answer"
        ? ["开始作答", "查看练习内容"]
        : type === "confirm"
          ? ["确认结果", "提出修改建议"]
          : type === "provide_context"
            ? ["补充信息"]
            : undefined,
    shouldNotifyUser: collaboration.shouldNotifyUser,
  };
}

function buildCompletedGenericTaskResult(task: Task, intro: string, createdAt: string): TaskResult {
  const requiredBlocks = task.expectedResult?.requiredBlocks ?? ["heading", "paragraph", "callout"];
  const blocks: TaskResult["blocks"] = [{ kind: "heading", level: 2, text: task.expectedResult?.description || task.expectedOutcome }];

  if (requiredBlocks.includes("comparison_table")) {
    blocks.push({
      kind: "comparison_table",
      columns: ["维度", "内容"],
      rows: [
        { 维度: "任务目标", 内容: task.expectedOutcome },
        { 维度: "当前结果", 内容: intro },
      ],
    });
  } else if (requiredBlocks.includes("list")) {
    blocks.push({
      kind: "list",
      ordered: false,
      items: [intro, `预期结果：${task.expectedOutcome}`],
    });
  } else {
    blocks.push({ kind: "paragraph", text: intro });
  }

  blocks.push({
    kind: "callout",
    tone: "success",
    text: `已完成：${task.expectedOutcome}`,
  });

  return {
    schemaVersion: 1,
    taskId: task.id,
    instanceId: `mock-result-${task.id}`,
    title: task.expectedResult?.description || task.expectedOutcome,
    status: "done",
    blocks,
    meta: {
      producedAt: createdAt,
      surfaces: ["interactive"],
      interactiveSurfaceKind: "blocks",
      presentation: task.expectedResult?.presentation,
      primaryFormat: task.expectedResult?.primaryFormat,
      exportableFormats: task.expectedResult?.exportableFormats,
    },
  };
}

function normalizeMockInstances(task: Task, instances: TaskInstance[]) {
  return instances.map((item) => {
    if (item.status !== "completed") return item;
    if (normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind) !== "generic_result") return item;
    const existingResult = item.result ?? {
      summary: item.intro,
      finalMessage: item.intro,
    };
    if (existingResult.taskResult) return item;
    return {
      ...item,
      result: {
        ...existingResult,
        taskResult: buildCompletedGenericTaskResult(task, item.intro, item.createdAt),
      },
    };
  });
}

function buildInitialTimeline(
  taskId: string,
  createdAt: string,
  status: TaskInstance["status"],
  intro: string,
): TaskExecutionStep[] {
  const phaseStatus = status === "pending" ? "pending" : status === "awaiting_user" ? "awaiting_user" : status === "completed" ? "completed" : status === "in_progress" ? "running" : "failed";
  return [
    {
      id: `${taskId}-phase-queued`,
      title: "任务进入队列",
      type: "phase",
      status: status === "pending" ? "running" : "completed",
      detail: "调度器已生成任务实例，等待 Agent 接手。",
      startedAt: createdAt,
      finishedAt: status === "pending" ? undefined : createdAt,
    },
    {
      id: `${taskId}-phase-main`,
      title: status === "completed" ? "Agent 已完成执行" : status === "awaiting_user" ? "Agent 等待用户参与" : status === "in_progress" ? "Agent 正在执行" : "Agent 执行暂停",
      type: "phase",
      status: phaseStatus,
      detail: intro,
      startedAt: createdAt,
      finishedAt: status === "completed" ? createdAt : undefined,
    },
  ];
}

function instance(
  id: string,
  taskId: string,
  dateLabel: string,
  createdAt: string,
  intro: string,
  kind: ExecutionKind,
  status: TaskInstance["status"] = "pending",
): TaskInstance {
  const interactionRequirement = status === "awaiting_user" ? interactionFor(kind, intro) : undefined;
  return {
    id,
    taskId,
    dateLabel,
    status,
    intro,
    payload: payloadFor(),
    createdAt,
    runner: {
      attemptCount: status === "pending" ? 0 : 1,
      lastAttemptAt: status === "pending" ? undefined : createdAt,
    },
    execution: {
      phase: statusToPhase(status),
      status,
      startedAt: status === "pending" ? undefined : createdAt,
      finishedAt: status === "completed" ? createdAt : undefined,
      lastUpdatedAt: createdAt,
      errorCategory: status === "paused" || status === "error" ? "unknown" : undefined,
    },
    timeline: buildInitialTimeline(taskId, createdAt, status, intro),
    result:
      status === "completed"
        ? {
            summary: intro,
            finalMessage: intro,
          }
        : undefined,
    awaitingUser: interactionRequirement
      ? {
          reason: interactionRequirement.reason,
          suggestedActions: interactionRequirement.suggestedActions,
          interactionRequirement,
        }
      : undefined,
  };
}

function interactiveOnlyDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:03:00+08:00";
  const intro = "双区域 Demo：这张卡片只有交互渲染区，用 blocks 展示结果，不包含文件区域。";
  return {
    id: "inst-surface-demo-interactive",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 交互",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看结构化 blocks 展示。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: createdAt, lastUpdatedAt: createdAt },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "仅交互渲染区 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-interactive",
        title: "交互渲染区 Only Demo",
        status: "done",
        blocks: [
          { kind: "heading", text: "交互渲染区 Only", level: 2 },
          { kind: "paragraph", text: "这个结果只需要页面内展示，所以没有文件区域。" },
          { kind: "comparison_table", columns: ["区域", "是否存在"], rows: [{ 区域: "交互渲染区", 是否存在: "是" }, { 区域: "文件区域", 是否存在: "否" }] },
        ],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive"],
          interactiveSurfaceKind: "blocks",
          presentation: "visual_report",
          primaryFormat: "structured_blocks",
          exportableFormats: ["html", "markdown"],
        },
      },
    },
  };
}

function fileOnlyDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:04:00+08:00";
  const intro = "双区域 Demo：这张卡片只有文件区域，用来验证 file-only 任务不需要强制生成 blocks。";
  return {
    id: "inst-surface-demo-file",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 文件",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看文件产物卡片。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: createdAt, lastUpdatedAt: createdAt },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "仅文件区域 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-file",
        title: "文件区域 Only Demo",
        status: "done",
        blocks: [],
        artifactRefs: [
          {
            id: ARTIFACT_DEMO_ID,
            kind: "file",
            label: "surface-file-only-demo.md",
            summary: "文件区域 only 的 Markdown 样例",
            mime: "text/markdown; charset=utf-8",
            size: 221,
            previewUrl: `/api/artifacts/${ARTIFACT_DEMO_ID}`,
          },
        ],
        meta: {
          producedAt: createdAt,
          surfaces: ["files"],
          fileSurfaceRequired: true,
          presentation: "document",
          primaryFormat: "text",
          exportableFormats: ["text"],
        },
      },
    },
  };
}

function mixedSurfaceDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:05:00+08:00";
  const intro = "双区域 Demo：这张卡片同时包含交互渲染区和文件区域。";
  return {
    id: "inst-surface-demo-mixed",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 混合",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看 blocks 和文件产物卡片。" },
    createdAt,
    runner: {
      attemptCount: 1,
      lastAttemptAt: createdAt,
    },
    execution: {
      phase: "completed",
      status: "completed",
      startedAt: createdAt,
      finishedAt: createdAt,
      lastUpdatedAt: createdAt,
    },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "双区域 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-mixed",
        title: "交互渲染区 + 文件区域 Demo",
        status: "done",
        blocks: [
          { kind: "heading", text: "双区域结果呈现", level: 2 },
          { kind: "paragraph", text: "页面内先展示核心摘要和结论，同时在文件区域提供完整 Markdown 报告。" },
          { kind: "callout", tone: "success", text: "这验证了 blocks 与文件产物可以同时存在，且互不替代。" },
        ],
        artifactRefs: [
          {
            id: ARTIFACT_DEMO_ID,
            kind: "file",
            label: "artifact-demo-report.md",
            summary: "Artifact 功能验证样例",
            mime: "text/markdown; charset=utf-8",
            size: 221,
            previewUrl: `/api/artifacts/${ARTIFACT_DEMO_ID}`,
          },
        ],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive", "files"],
          interactiveSurfaceKind: "blocks",
          fileSurfaceRequired: true,
          presentation: "document",
          primaryFormat: "markdown",
          exportableFormats: ["markdown"],
        },
      },
    },
  };
}

function webAppDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:06:00+08:00";
  const intro = "可执行小应用 Demo：这张卡片会在交互渲染区运行一个预算计算器，并通过受控通信保存输入状态。";
  return {
    id: "inst-surface-demo-webapp",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 小应用",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看 sandbox iframe 小应用。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: createdAt, lastUpdatedAt: createdAt },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "可执行小应用 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-webapp",
        title: "可执行小应用 Demo",
        status: "done",
        blocks: [
          { kind: "callout", tone: "info", text: "如果小应用加载失败，这里作为降级摘要展示。" },
        ],
        artifactRefs: [
          {
            id: WEBAPP_DEMO_ID,
            kind: "webapp",
            label: "预算计算器",
            summary: "输入预算与每月上限后自动计算建议，并保存状态。",
            previewUrl: `/api/artifacts/${WEBAPP_DEMO_ID}/preview`,
            surfaceKind: "webapp",
          },
        ],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive"],
          interactiveSurfaceKind: "webapp",
          presentation: "dashboard",
          primaryFormat: "html",
          exportableFormats: ["html"],
        },
      },
    },
  };
}

function externalEmbedDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:07:00+08:00";
  const intro = "外部嵌入 Demo：这张卡片在交互渲染区嵌入 YouTube，默认点击后加载，避免打开页面就请求第三方。";
  const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const embedUrl = "https://www.youtube.com/embed/dQw4w9WgXcQ";
  return {
    id: "inst-surface-demo-youtube",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 外部嵌入",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看受控外部 iframe 嵌入。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: createdAt, lastUpdatedAt: createdAt },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "外部嵌入 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-youtube",
        title: "YouTube 外部嵌入 Demo",
        status: "done",
        blocks: [{ kind: "callout", tone: "info", text: "如果目标网站禁止 iframe 嵌入，可以使用新窗口打开作为降级。" }],
        artifactRefs: [{
          id: YOUTUBE_EMBED_DEMO_ID,
          kind: "external_embed",
          label: "YouTube 官方播放器",
          summary: "第三方外部内容，点击后加载。",
          url: youtubeUrl,
          embedUrl,
          previewUrl: embedUrl,
          provider: "youtube",
          allowFullScreen: true,
          surfaceKind: "external_embed",
        }],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive"],
          interactiveSurfaceKind: "webapp",
          presentation: "dashboard",
          primaryFormat: "html",
          exportableFormats: ["html"],
        },
      },
    },
  };
}

function internetWebAppDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:08:00+08:00";
  const intro = "联网小应用 Demo：这张卡片通过 KikiBridge.fetchInternet 读取公网文本，同时仍禁止直接访问 KiKi 内部 API。";
  return {
    id: "inst-surface-demo-internet-webapp",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 联网小应用",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看受控联网小应用。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: createdAt, lastUpdatedAt: createdAt },
    timeline: buildInitialTimeline("task-toefl-listening", createdAt, "completed", intro),
    result: {
      summary: "联网小应用 Demo 已生成。",
      finalMessage: intro,
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-internet-webapp",
        title: "联网小应用 Demo",
        status: "done",
        blocks: [{ kind: "callout", tone: "info", text: "公网数据通过受控代理读取，iframe 仍不能读取 KiKi 页面状态。" }],
        artifactRefs: [{
          id: INTERNET_WEBAPP_DEMO_ID,
          kind: "webapp",
          label: "联网资料卡",
          summary: "通过受控代理读取 example.com 文本。",
          previewUrl: `/api/artifacts/${INTERNET_WEBAPP_DEMO_ID}/preview`,
          surfaceKind: "webapp",
        }],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive"],
          interactiveSurfaceKind: "webapp",
          presentation: "dashboard",
          primaryFormat: "html",
          exportableFormats: ["html"],
        },
      },
    },
  };
}

function multiAgentDemoInstance(): TaskInstance {
  const createdAt = "2026-04-26T11:09:00+08:00";
  const intro = "多 Agent Demo：Coordinator、Executor、Reviewer、Presenter 协同生成 mixed 结果，并展示审阅打回后的复查效果。";
  const agentRunPlan: AgentRunPlan = {
    schemaVersion: 1,
    mode: "role_collaboration",
    strategy: "quality_review",
    finalRole: "synthesizer",
    roles: [
      {
        id: "mock-multi-agent-coordinator",
        role: "coordinator",
        title: "Coordinator 明确任务要求",
        objective: "明确 mixed 结果必须同时包含交互摘要和 Markdown 文件。",
        inputSummary: "生成托福听力复盘报告，并提供文件产物。",
        outputSummary: "确认成功标准：摘要卡片、错题原因、下一步练习建议、Markdown 文件。",
        status: "completed",
        startedAt: "2026-04-26T11:09:00+08:00",
        finishedAt: "2026-04-26T11:09:18+08:00",
      },
      {
        id: "mock-multi-agent-executor",
        role: "executor",
        title: "Executor 生成候选产物",
        objective: "生成结构化 blocks 和文件内容。",
        inputSummary: "基于 Coordinator 的完成标准生成候选结果。",
        outputSummary: "生成了听力复盘摘要和 Markdown 报告草稿，但第一轮漏写文件引用。",
        status: "completed",
        startedAt: "2026-04-26T11:09:18+08:00",
        finishedAt: "2026-04-26T11:09:56+08:00",
        filesTouched: ["toefl-listening-review.md"],
      },
      {
        id: "mock-multi-agent-reviewer",
        role: "reviewer",
        title: "Reviewer 审阅候选产物",
        objective: "检查 mixed 模式下 blocks 和 files 是否齐全。",
        inputSummary: "审阅 Executor 第一轮候选结果。",
        outputSummary: "发现 blocks 已满足，但 files/artifactRefs 缺失，要求补齐文件区域。",
        status: "completed",
        startedAt: "2026-04-26T11:09:56+08:00",
        finishedAt: "2026-04-26T11:10:08+08:00",
      },
      {
        id: "mock-multi-agent-executor-attempt-2",
        role: "executor",
        title: "Executor 生成候选产物（第 2 轮）",
        objective: "按 Reviewer 意见补齐文件区域。",
        inputSummary: "补齐 Markdown 文件产物和 artifact 引用。",
        outputSummary: "补充 toefl-listening-review.md，并保持摘要卡片与文件内容一致。",
        status: "completed",
        startedAt: "2026-04-26T11:10:08+08:00",
        finishedAt: "2026-04-26T11:10:28+08:00",
        filesTouched: ["toefl-listening-review.md"],
      },
      {
        id: "mock-multi-agent-reviewer-attempt-2",
        role: "reviewer",
        title: "Reviewer 审阅候选产物（第 2 轮）",
        objective: "复查补齐后的 mixed 结果。",
        inputSummary: "复查 blocks、artifactRefs 和文件摘要一致性。",
        outputSummary: "blocks 与文件区域均满足要求，允许呈现最终结果。",
        status: "completed",
        startedAt: "2026-04-26T11:10:28+08:00",
        finishedAt: "2026-04-26T11:10:39+08:00",
      },
      {
        id: "mock-multi-agent-synthesizer",
        role: "synthesizer",
        title: "Presenter 呈现最终结果",
        objective: "呈现最终 KiKi 结果 JSON。",
        inputSummary: "吸收前序角色输出和复查结论。",
        outputSummary: "输出包含 blocks 和文件产物的最终结果。",
        status: "completed",
        startedAt: "2026-04-26T11:10:39+08:00",
        finishedAt: "2026-04-26T11:10:56+08:00",
      },
    ],
    handoffs: [
      {
        fromRole: "coordinator",
        toRole: "executor",
        summary: "任务必须同时产出页面摘要和可下载 Markdown 文件，Reviewer 需要检查 mixed 模式完整性。",
        claims: [{ text: "mixed 模式要求 blocks 与文件区域同时存在。", confidence: "high" }],
        decisions: ["使用交互摘要卡片 + Markdown 文件的双区域结果。"],
        openQuestions: [],
        risks: ["文件区域容易被遗漏。"],
        createdAt: "2026-04-26T11:09:18+08:00",
      },
      {
        fromRole: "executor",
        toRole: "reviewer",
        summary: "已生成摘要 blocks 和报告内容草稿，请检查是否满足 mixed 结果要求。",
        claims: [{ text: "摘要 blocks 已覆盖正确率、错因和下一步练习。", confidence: "medium" }],
        decisions: ["先交付候选摘要，再由 Reviewer 检查文件区域。"],
        openQuestions: [],
        risks: ["第一轮可能没有完整 artifactRefs。"],
        filesTouched: ["toefl-listening-review.md"],
        createdAt: "2026-04-26T11:09:56+08:00",
      },
      {
        fromRole: "reviewer",
        toRole: "synthesizer",
        summary: "复查通过：blocks 和文件区域均已补齐，可以呈现最终结果。",
        claims: [{ text: "artifactRefs 中存在 Markdown 文件产物。", confidence: "high" }],
        decisions: ["允许 Presenter 呈现最终结果。"],
        openQuestions: [],
        risks: [],
        artifactRefs: [ARTIFACT_DEMO_ID],
        createdAt: "2026-04-26T11:10:39+08:00",
      },
    ],
    review: {
      passed: true,
      severity: "info",
      decisionReason: "第二轮复查确认 mixed 结果完整，交互摘要和文件产物一致。",
      issues: [
        {
          id: "missing-file-surface-first-pass",
          severity: "warning",
          message: "第一轮候选结果缺少文件区域，已由 Executor 第二轮补齐。",
          expected: "mixed 结果同时包含 blocks 和 artifactRefs。",
          actual: "第一轮只有 blocks，第二轮已补齐 artifactRefs。",
          suggestedFix: "保留 Reviewer 打回记录，后续默认检查文件区域。",
        },
      ],
    },
  };
  const timeline: TaskExecutionStep[] = [
    {
      id: "mock-ma-start",
      title: "启用多角色协同：quality_review",
      type: "phase",
      status: "completed",
      detail: "KiKi 将按角色顺序执行、审阅并呈现最终结果。",
      startedAt: "2026-04-26T11:09:00+08:00",
      finishedAt: "2026-04-26T11:09:00+08:00",
    },
    {
      id: "mock-ma-coordinator",
      title: "Coordinator 明确任务要求",
      type: "system",
      status: "completed",
      agentRole: "coordinator",
      detail: "确认 mixed 结果必须同时包含交互摘要和 Markdown 文件。",
      startedAt: "2026-04-26T11:09:00+08:00",
      finishedAt: "2026-04-26T11:09:18+08:00",
    },
    {
      id: "mock-ma-handoff-1",
      title: "coordinator 已移交给 executor",
      type: "phase",
      status: "completed",
      agentRole: "coordinator",
      detail: "任务要求已明确，进入候选产物生成。",
      handoff: {
        fromRole: "coordinator",
        toRole: "executor",
        summary: "必须同时产出页面摘要和可下载 Markdown 文件。",
      },
      startedAt: "2026-04-26T11:09:18+08:00",
      finishedAt: "2026-04-26T11:09:18+08:00",
    },
    {
      id: "mock-ma-executor",
      title: "Executor 生成候选产物",
      type: "assistant",
      status: "completed",
      agentRole: "executor",
      detail: "生成摘要 blocks 和 Markdown 草稿，但第一轮漏了文件区域引用。",
      toolName: "Write",
      startedAt: "2026-04-26T11:09:18+08:00",
      finishedAt: "2026-04-26T11:09:56+08:00",
    },
    {
      id: "mock-ma-reviewer",
      title: "Reviewer 审阅候选产物",
      type: "assistant",
      status: "completed",
      agentRole: "reviewer",
      detail: "发现 blocking 问题：mixed 模式需要文件区域，但第一轮缺少 artifactRefs。",
      startedAt: "2026-04-26T11:09:56+08:00",
      finishedAt: "2026-04-26T11:10:08+08:00",
    },
    {
      id: "mock-ma-executor-2",
      title: "Executor 生成候选产物（第 2 轮）",
      type: "assistant",
      status: "completed",
      agentRole: "executor",
      detail: "补齐 Markdown 文件产物，并保持文件内容与摘要卡片一致。",
      startedAt: "2026-04-26T11:10:08+08:00",
      finishedAt: "2026-04-26T11:10:28+08:00",
    },
    {
      id: "mock-ma-reviewer-2",
      title: "Reviewer 审阅候选产物（第 2 轮）",
      type: "assistant",
      status: "completed",
      agentRole: "reviewer",
      detail: "复查通过：blocks 和文件区域均满足要求。",
      startedAt: "2026-04-26T11:10:28+08:00",
      finishedAt: "2026-04-26T11:10:39+08:00",
    },
    {
      id: "mock-ma-synthesizer",
      title: "Presenter 呈现最终结果",
      type: "result",
      status: "completed",
      agentRole: "synthesizer",
      detail: "输出最终结果：交互摘要 + Markdown 文件产物。",
      startedAt: "2026-04-26T11:10:39+08:00",
      finishedAt: "2026-04-26T11:10:56+08:00",
    },
  ];
  return {
    id: "inst-surface-demo-multi-agent",
    taskId: "task-toefl-listening",
    dateLabel: "Surface Demo · 多 Agent",
    status: "completed",
    intro,
    payload: { kind: "generic_result", summary: intro, details: "查看多角色协同摘要和执行链路。" },
    createdAt,
    runner: { attemptCount: 1, lastAttemptAt: createdAt },
    execution: { phase: "completed", status: "completed", startedAt: createdAt, finishedAt: "2026-04-26T11:10:56+08:00", lastUpdatedAt: "2026-04-26T11:10:56+08:00" },
    timeline,
    result: {
      summary: "多 Agent mixed 结果 Demo 已生成。",
      finalMessage: intro,
      structuredOutput: { agentRunPlan },
      taskResult: {
        schemaVersion: 1,
        taskId: "task-toefl-listening",
        instanceId: "inst-surface-demo-multi-agent",
        title: "多 Agent 托福听力复盘 Demo",
        status: "done",
        blocks: [
          { kind: "heading", text: "听力复盘结论", level: 2 },
          { kind: "paragraph", text: "本轮复盘显示，主要失分来自讲座结构预判不足、转折信号词捕捉偏慢，以及细节题中对例证功能的判断不稳定。下一轮练习应优先强化听前结构预判和听中标记能力。" },
          { kind: "callout", tone: "success", text: "下一轮重点：每天完成 1 篇讲座精听，标出转折、例证、结论三类信号，并复盘错题对应的原文句。" },
          {
            kind: "comparison_table",
            columns: ["问题类型", "典型表现", "练习建议"],
            rows: [
              { 问题类型: "主旨题", 典型表现: "开头背景听懂，但未及时抓住教授真正要展开的主题。", 练习建议: "听前先预测学科场景，开头 30 秒记录主题变化词。" },
              { 问题类型: "细节题", 典型表现: "能听到事实点，但容易忽略该细节服务于解释、反驳还是举例。", 练习建议: "复听时给每个例子标注功能：说明、对比、例外或结论支撑。" },
              { 问题类型: "态度题", 典型表现: "对语气变化和转折词反应偏慢，导致判断倾向不稳定。", 练习建议: "集中整理 however、actually、surprisingly 等信号词后的观点变化。" },
              { 问题类型: "结构题", 典型表现: "段落之间关系记录不足，回看笔记时无法还原讲座层级。", 练习建议: "使用“主题-例证-结论”三列笔记模板训练结构感。" },
            ],
          },
        ],
        artifactRefs: [
          {
            id: ARTIFACT_DEMO_ID,
            kind: "file",
            label: "toefl-listening-review.md",
            summary: "多 Agent 协同生成的托福听力复盘报告",
            mime: "text/markdown; charset=utf-8",
            size: 221,
            previewUrl: `/api/artifacts/${ARTIFACT_DEMO_ID}`,
          },
        ],
        meta: {
          producedAt: createdAt,
          surfaces: ["interactive", "files"],
          interactiveSurfaceKind: "blocks",
          fileSurfaceRequired: true,
          presentation: "visual_report",
          primaryFormat: "markdown",
          exportableFormats: ["markdown"],
          agentRunPlan,
          qualityReview: {
            passed: true,
            issues: agentRunPlan.review?.issues.map((issue) => issue.message) ?? [],
            reviewerRole: "reviewer",
          },
        },
      },
    },
  };
}

function task(data: Omit<Task, "instances"> & { instances?: TaskInstance[] }): Task {
  const executionKind = normalizeExecutionKind(data.executionKind);
  const nextTask: Task = {
    ...data,
    executionKind,
    resultViewKind: normalizeTaskResultViewKind(data.resultViewKind ?? executionKind),
    expectedResult: data.expectedResult ?? expectedResultFor(executionKind, data.expectedOutcome, data.description),
    collaboration: data.collaboration ?? collaborationFor(executionKind, data.description, data.expectedOutcome),
    executionStrategy: data.executionStrategy ?? "agent_autonomous",
    requiresConfirmation: data.requiresConfirmation ?? false,
    instances: data.instances ?? [],
  };
  return {
    ...nextTask,
    instances: normalizeMockInstances(nextTask, nextTask.instances),
  };
}

const rawInitialGoals: Goal[] = [
  {
    id: "goal-toefl",
    title: "托福考试 110 分",
    deadline: "2026-05-01T23:59:59+08:00",
    progress: 59,
    createdAt: "2026-03-01T09:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-toefl-reading",
        goalId: "goal-toefl",
        title: "子目标1：提高阅读分数到 29-30 分",
        tasks: [
          task({
            id: "task-toefl-vocab",
            subGoalId: "sg-toefl-reading",
            title: "任务1：核心学术词汇扫荡",
            description: "每天记忆 100-150 个托福高频词汇，以天体生态科学、天文、地质学等学科词为主。",
            expectedOutcome: "完成 2000 个托福词汇的学习",
            taskType: "repeat",
            triggerRule: "每天 11:00 触发",
            deadline: "2026-05-01T23:59:59+08:00",
            progress: 16,
            executionKind: "generic_result",
            instances: [
              instance("inst-vocab-0426", "task-toefl-vocab", "04-26", "2026-04-26T11:00:00+08:00", "今天先从天文场景高频词开始。我整理了 30 张卡片，先做一轮快速记忆，再把易错词标出来。", "generic_result", "pending"),
              instance("inst-vocab-0425", "task-toefl-vocab", "04-25", "2026-04-25T11:00:00+08:00", "昨天你在天体类词汇里还不够稳定，今天的卡片我补了两条近义辨析。", "generic_result", "completed"),
              instance("inst-vocab-0401", "task-toefl-vocab", "04-01", "2026-04-01T11:00:00+08:00", "开学第一轮词汇训练已经开始，先把 lecture 高频词建立熟悉感。", "generic_result", "completed"),
            ],
          }),
          task({
            id: "task-toefl-note",
            subGoalId: "sg-toefl-reading",
            title: "任务2：逻辑结构拆解练习",
            description: "对每篇学术材料做一页 note-taking 复盘，保留因果-解释-例证主线。",
            expectedOutcome: "每周完成 5 份逻辑结构图",
            taskType: "repeat",
            triggerRule: "每天 15:00 触发",
            progress: 32,
            executionKind: "generic_result",
          }),
          task({
            id: "task-toefl-listening",
            subGoalId: "sg-toefl-reading",
            title: "任务3：限时听力精听分析",
            description: "选取 1-2 篇 lecture 材料做精听，边听边定位中文含义。",
            expectedOutcome: "提升听力正确率到 85% 以上",
            taskType: "repeat",
            triggerRule: "每天 11:00 触发",
            progress: 48,
            executionKind: "generic_result",
            instances: [
              multiAgentDemoInstance(),
              internetWebAppDemoInstance(),
              externalEmbedDemoInstance(),
              webAppDemoInstance(),
              mixedSurfaceDemoInstance(),
              fileOnlyDemoInstance(),
              interactiveOnlyDemoInstance(),
              instance("inst-listen-0426", "task-toefl-listening", "04-26", "2026-04-26T11:00:00+08:00", "昨天听力题目，你已经答对了 9 道题（共 10 题），正确率为 90%。今天我把难度提高了一点，重点看天文类材料。", "generic_result", "awaiting_user"),
              instance("inst-listen-0425", "task-toefl-listening", "04-25", "2026-04-25T11:00:00+08:00", "昨天的校园场景题你做得比较稳，今天尝试跨到 lecture 场景。", "generic_result", "completed"),
              instance("inst-listen-0424", "task-toefl-listening", "04-24", "2026-04-24T11:00:00+08:00", "这组题里需要重点抓教授给出的转折提示词，我帮你把错题整理在最后了。", "generic_result", "completed"),
            ],
          }),
        ],
      },
      {
        id: "sg-toefl-speaking",
        goalId: "goal-toefl",
        title: "子目标2：提高听力能力到 29-30 分",
        tasks: [
          task({
            id: "task-toefl-shadow",
            subGoalId: "sg-toefl-speaking",
            title: "任务1：影子跟读",
            description: "练习 15 分钟 shadowing，建立语音块感。",
            expectedOutcome: "压缩反应时间和听感疲劳。",
            taskType: "repeat",
            triggerRule: "每天 08:30 触发",
            progress: 64,
            executionKind: "generic_result",
          }),
          task({
            id: "task-toefl-summary",
            subGoalId: "sg-toefl-speaking",
            title: "任务2：lecture 摘要复述",
            description: "复述 lecture 的因果链条与教授态度。",
            expectedOutcome: "输出 3 段高质量复述。",
            taskType: "repeat",
            triggerRule: "每天 20:00 触发",
            progress: 40,
            executionKind: "generic_result",
          }),
          task({
            id: "task-toefl-digest",
            subGoalId: "sg-toefl-speaking",
            title: "任务3：阅读素材精读",
            description: "用短篇科普新闻补充背景知识，减少陌生主题负担。",
            expectedOutcome: "每周完成 6 篇精读材料",
            taskType: "repeat",
            executionMode: "monitoring",
            triggerRule: "每天 09:00 触发",
            progress: 51,
            executionKind: "generic_result",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-suv",
    title: "购买 SUV 汽车",
    deadline: "2026-06-15T23:59:59+08:00",
    progress: 34,
    createdAt: "2026-04-02T10:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-suv-budget",
        goalId: "goal-suv",
        title: "子目标1：确定预算与候选车型",
        tasks: [
          task({
            id: "task-suv-budget",
            subGoalId: "sg-suv-budget",
            title: "任务1：明确购车预算与用车场景",
            description: "盘点首付能力、月供上限、家庭用车场景（城市通勤/郊游/长途）与核心诉求。",
            expectedOutcome: "一份购车预算表（总价区间、首付、月供、保险 5 项）+ 一句话用车定位",
            taskType: "one_shot",
            triggerRule: "今天 21:00 触发",
            progress: 100,
            executionKind: "generic_result",
            instances: [
              instance("inst-suv-budget-0410", "task-suv-budget", "04-10", "2026-04-10T21:00:00+08:00", "我整理了你最近 3 个月的现金流和家庭用车场景，初步定在 25–35 万区间，以城市为主、偶尔长途。", "generic_result", "completed"),
            ],
          }),
          task({
            id: "task-suv-compare",
            subGoalId: "sg-suv-budget",
            title: "任务2：候选车型对比",
            description: "每晚更新一轮参数和试驾反馈，覆盖合资、新势力、传统豪华 3 个阵营。",
            expectedOutcome: "保留 2 款最终候选车型，附对比表（价格/空间/智驾/用车成本）",
            taskType: "repeat",
            executionMode: "monitoring",
            triggerRule: "每天 19:00 触发",
            progress: 52,
            executionKind: "generic_result",
          }),
          task({
            id: "task-suv-review",
            subGoalId: "sg-suv-budget",
            title: "任务3：真实车主口碑调研",
            description: "每天读 5 条懂车帝/汽车之家/小红书真实车主点评，提炼高频吐槽。",
            expectedOutcome: "一份车主口碑摘要（每款 5 条正面 + 5 条吐槽）",
            taskType: "repeat",
            triggerRule: "每天 22:00 触发",
            progress: 40,
            executionKind: "generic_result",
          }),
        ],
      },
      {
        id: "sg-suv-testdrive",
        goalId: "goal-suv",
        title: "子目标2：线下看车与试驾",
        tasks: [
          task({
            id: "task-suv-appointment",
            subGoalId: "sg-suv-testdrive",
            title: "任务1：预约试驾",
            description: "根据候选车型，联系最近 3 家 4S 店预约周末试驾时段。",
            expectedOutcome: "确认至少 2 个试驾预约（含门店地址、时间、销售联系方式）",
            taskType: "one_shot",
            triggerRule: "周五 10:00 触发",
            progress: 20,
            executionKind: "generic_result",
          }),
          task({
            id: "task-suv-testdrive-checklist",
            subGoalId: "sg-suv-testdrive",
            title: "任务2：试驾评测清单",
            description: "每次试驾前推送标准化评测清单（NVH、辅助驾驶、底盘调校、智能座舱）。",
            expectedOutcome: "每辆车一份试驾打分表（10 个维度 × 1–5 分）",
            taskType: "one_shot",
            triggerRule: "试驾当天 08:30 触发",
            progress: 10,
            executionKind: "generic_result",
          }),
        ],
      },
      {
        id: "sg-suv-deal",
        goalId: "goal-suv",
        title: "子目标3：成交与上牌",
        tasks: [
          task({
            id: "task-suv-negotiate",
            subGoalId: "sg-suv-deal",
            title: "任务1：议价策略准备",
            description: "结合近 30 天成交价、月末冲量节奏和置换补贴，列出谈判底线与目标价。",
            expectedOutcome: "一份议价话术 + 目标价/底价两个档位",
            taskType: "one_shot",
            triggerRule: "5 月第二周周日 20:00 触发",
            progress: 0,
            executionKind: "generic_result",
          }),
          task({
            id: "task-suv-insurance",
            subGoalId: "sg-suv-deal",
            title: "任务2：保险与上牌方案",
            description: "对比 3 家保险公司首年报价，梳理临牌、上牌预约、过户等流程。",
            expectedOutcome: "最终保险方案（含保费）+ 上牌时间线",
            taskType: "one_shot",
            triggerRule: "成交当天 21:00 触发",
            progress: 0,
            executionKind: "generic_result",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-osaka",
    title: "大阪 6 日游",
    deadline: "2026-05-03T23:59:59+08:00",
    progress: 72,
    createdAt: "2026-03-20T10:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-osaka-plan",
        goalId: "goal-osaka",
        title: "子目标1：行程规划与预订",
        tasks: [
          task({
            id: "task-osaka-flight",
            subGoalId: "sg-osaka-plan",
            title: "任务1：机票与签证",
            description: "比价 3 家航司的往返机票，确认签证有效期与办理进度。",
            expectedOutcome: "确认往返机票 + 签证可出行",
            taskType: "one_shot",
            triggerRule: "4 月第三周周日 20:00 触发",
            progress: 100,
            executionKind: "generic_result",
            instances: [
              instance("inst-osaka-flight-0415", "task-osaka-flight", "04-15", "2026-04-15T20:00:00+08:00", "我比了 3 家航司的往返组合，最终选定了周六出发、次周四返程的吉祥航空直飞。", "generic_result", "completed"),
            ],
          }),
          task({
            id: "task-osaka-hotel",
            subGoalId: "sg-osaka-plan",
            title: "任务2：酒店与民宿预订",
            description: "按照大阪 3 晚 + 京都 2 晚 + 神户 1 晚的安排锁定住宿。",
            expectedOutcome: "6 晚住宿全部确认（含确认号、入住时间、取消政策）",
            taskType: "one_shot",
            triggerRule: "4 月第四周周一 20:00 触发",
            progress: 85,
            executionKind: "generic_result",
          }),
          task({
            id: "task-osaka-ticket",
            subGoalId: "sg-osaka-plan",
            title: "任务3：购买大阪到京都车票",
            description: "确定车次、座位和改签策略。",
            expectedOutcome: "成功预订一张最合适的车票。",
            taskType: "one_shot",
            triggerRule: "今天 12:00 触发",
            progress: 90,
            executionKind: "generic_result",
            instances: [
              instance("inst-osaka-0410", "task-osaka-ticket", "04-10", "2026-04-10T09:00:00+08:00", "我筛选了 3 班从大阪到京都的车次，优先保留了换乘少、到站时间更宽松的方案。", "generic_result", "awaiting_user"),
            ],
          }),
        ],
      },
      {
        id: "sg-osaka-itinerary",
        goalId: "goal-osaka",
        title: "子目标2：每日行程与美食",
        tasks: [
          task({
            id: "task-osaka-daily",
            subGoalId: "sg-osaka-itinerary",
            title: "任务1：每日行程推送",
            description: "出行前一晚自动推送明日路线、预约时间、交通票据与预计步行距离。",
            expectedOutcome: "6 份每日行程卡（每天一张，含早中晚 3 个锚点）",
            taskType: "repeat",
            triggerRule: "出行期间每晚 21:00 触发",
            progress: 60,
            executionKind: "generic_result",
          }),
          task({
            id: "task-osaka-food",
            subGoalId: "sg-osaka-itinerary",
            title: "任务2：美食与餐厅预订",
            description: "筛选 6 家目标餐厅，提前 1–3 天确认是否需要在线预约。",
            expectedOutcome: "一份美食清单（6 家餐厅 + 预约状态）",
            taskType: "repeat",
            executionMode: "monitoring",
            triggerRule: "每天 10:00 触发",
            progress: 70,
            executionKind: "generic_result",
          }),
        ],
      },
      {
        id: "sg-osaka-wrap",
        goalId: "goal-osaka",
        title: "子目标3：回程收尾",
        tasks: [
          task({
            id: "task-osaka-reimburse",
            subGoalId: "sg-osaka-wrap",
            title: "任务1：回程清单与退税",
            description: "整理购物小票、退税单据，准备机场退税动线。",
            expectedOutcome: "退税清单（含每笔金额、店铺、所需单据）",
            taskType: "one_shot",
            triggerRule: "5 月 2 日 20:00 触发",
            progress: 10,
            executionKind: "generic_result",
          }),
          task({
            id: "task-osaka-recap",
            subGoalId: "sg-osaka-wrap",
            title: "任务2：行程复盘与游记",
            description: "回国后一起回顾这次旅行，沉淀一篇图文游记。",
            expectedOutcome: "一篇 1500 字游记 + 精选 20 张照片",
            taskType: "one_shot",
            triggerRule: "5 月 4 日 20:00 触发",
            progress: 0,
            executionKind: "generic_result",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-mail",
    title: "邮件",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 66,
    createdAt: "2026-04-05T10:00:00+08:00",
    kind: "digest",
    summary: "每天在你固定的写邮件时段，KiKi 把待发邮件整理好草稿，等你 10 分钟内完成审阅与发送。",
    subGoals: [{ id: "sg-mail-1", goalId: "goal-mail", title: "子目标1：清理待发送邮件", tasks: [task({ id: "task-mail-review", subGoalId: "sg-mail-1", title: "任务1：邮件草稿审阅", description: "确认 3 封待发邮件的语气、结构和下一步动作。", expectedOutcome: "完成 3 封邮件发送。", taskType: "repeat", triggerRule: "每天 16:00 触发", progress: 70, executionKind: "generic_result", instances: [instance("inst-mail-0401", "task-mail-review", "04-01", "2026-04-01T09:00:00+08:00", "我帮你草拟了 3 封待发送邮件，先从最关键的面试确认邮件开始。", "generic_result", "awaiting_user")] })] }],
  },
  {
    id: "goal-news",
    title: "今日要闻",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 80,
    createdAt: "2026-04-01T08:00:00+08:00",
    kind: "digest",
    summary: "每天早晨 9 点，KiKi 汇总昨晚到今早的 AI 行业重要动态，给你一份可速读的摘要。",
    subGoals: [{ id: "sg-news-1", goalId: "goal-news", title: "子目标1：跟进 AI 方向的重要动态", tasks: [task({ id: "task-news-digest", subGoalId: "sg-news-1", title: "任务1：AI 行业新闻", description: "阅读并标记 3 篇和 Agent 相关的重要新闻。", expectedOutcome: "输出一份简短摘要供晚间复盘。", taskType: "repeat", triggerRule: "每天 09:00 触发", progress: 86, executionKind: "generic_result", instances: [instance("inst-news-0426", "task-news-digest", "04-26", "2026-04-26T09:00:00+08:00", "整理了 4 条 AI 行业的关键信息，OpenAI 发布多智能体协作框架位列第一。", "generic_result", "completed")] })] }],
  },
  {
    id: "goal-job",
    title: "找 AI 产品经理工作",
    deadline: "2026-06-01T23:59:59+08:00",
    progress: 28,
    createdAt: "2026-04-06T08:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-job-positioning",
        goalId: "goal-job",
        title: "子目标1：岗位定位与素材准备",
        tasks: [
          task({
            id: "task-job-role",
            subGoalId: "sg-job-positioning",
            title: "任务1：岗位画像拆解",
            description: "梳理目标岗位（AI PM / Agent PM）的核心职责、能力要求和代表性公司。",
            expectedOutcome: "一份 1 页岗位画像摘要（3 类岗位 × 5 项能力要求）",
            taskType: "one_shot",
            triggerRule: "今天 20:00 触发",
            progress: 80,
            executionKind: "generic_result",
          }),
          task({
            id: "task-job-resume",
            subGoalId: "sg-job-positioning",
            title: "任务2：简历与案例库",
            description: "沉淀 5 个可复用的产品项目案例，覆盖从 0→1、AI 增强、规模化 3 类。",
            expectedOutcome: "一版面向 AI PM 的中英文简历 + 5 个 STAR 项目卡",
            taskType: "repeat",
            triggerRule: "每天 21:00 触发",
            progress: 45,
            executionKind: "generic_result",
          }),
          task({
            id: "task-job-rehearsal",
            subGoalId: "sg-job-positioning",
            title: "任务3：岗位表述 rehearse",
            description: "和 KiKi 练习一句话介绍、项目亮点和 why now。",
            expectedOutcome: "一份精炼的面试开场脚本（30 秒自我介绍 + 3 个项目亮点）",
            taskType: "repeat",
            triggerRule: "每天 20:30 触发",
            progress: 28,
            executionKind: "generic_result",
          }),
        ],
      },
      {
        id: "sg-job-deliver",
        goalId: "goal-job",
        title: "子目标2：投递与面试执行",
        tasks: [
          task({
            id: "task-job-list",
            subGoalId: "sg-job-deliver",
            title: "任务1：投递节奏确认",
            description: "和 KiKi 一起决定本周要投递的公司清单、内推人与投递渠道。",
            expectedOutcome: "每周一份投递计划表（5–10 家公司 × 渠道 × 截止日）",
            taskType: "repeat",
            executionMode: "monitoring",
            triggerRule: "每周日 20:00 触发",
            progress: 20,
            executionKind: "generic_result",
          }),
          task({
            id: "task-job-interview",
            subGoalId: "sg-job-deliver",
            title: "任务2：模拟面试",
            description: "围绕项目经历做 20 分钟口述演练，覆盖产品思维题与场景题。",
            expectedOutcome: "每次面试一份复盘笔记（亮点 + 暴露的 3 个问题）",
            taskType: "repeat",
            triggerRule: "每天 11:00 触发",
            progress: 15,
            executionKind: "generic_result",
          }),
          task({
            id: "task-job-mail",
            subGoalId: "sg-job-deliver",
            title: "任务3：邮件与感谢信",
            description: "检查投递邮件、跟进邮件和面试感谢信。",
            expectedOutcome: "3 个邮件模板 + 每场面试 24 小时内完成感谢信",
            taskType: "repeat",
            triggerRule: "每天 18:00 触发",
            progress: 30,
            executionKind: "generic_result",
          }),
        ],
      },
      {
        id: "sg-job-offer",
        goalId: "goal-job",
        title: "子目标3：复盘与 Offer 谈判",
        tasks: [
          task({
            id: "task-job-recap",
            subGoalId: "sg-job-offer",
            title: "任务1：面试复盘库",
            description: "把每一轮面试的问题、答题结构、暴露的短板归档到复盘库。",
            expectedOutcome: "一份面试复盘库（按题型分类 + 20 道高频题的答法）",
            taskType: "repeat",
            triggerRule: "每天 22:30 触发",
            progress: 10,
            executionKind: "generic_result",
          }),
          task({
            id: "task-job-offer",
            subGoalId: "sg-job-offer",
            title: "任务2：Offer 谈判准备",
            description: "拿到意向后，对比现金、股权、成长空间，准备谈判话术。",
            expectedOutcome: "一份 Offer 对比表 + 3 种谈判剧本（基础/中等/挑战）",
            taskType: "one_shot",
            triggerRule: "拿到首个 offer 当晚 21:00 触发",
            progress: 0,
            executionKind: "generic_result",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-tomato-egg",
    title: "西红柿炒鸡蛋怎么做",
    deadline: "2026-04-10T23:59:59+08:00",
    progress: 100,
    createdAt: "2026-04-08T18:20:00+08:00",
    kind: "chat_history",
    summary: "一次和 KiKi 的简单对话，咨询了一道家常菜的做法。",
    subGoals: [],
    chatTurns: [
      {
        id: "chat-1",
        role: "user",
        content: "西红柿炒鸡蛋怎么做？",
        timestamp: "2026-04-08T18:20:12+08:00",
      },
      {
        id: "chat-2",
        role: "agent",
        content:
          "给你一个简单又好吃的版本：\n\n1. 2 个西红柿去蒂切块，3 个鸡蛋加一小撮盐打散。\n2. 热锅凉油，倒入蛋液，略凝固时用筷子划散，盛出备用。\n3. 原锅加一点油，下西红柿中小火翻炒出汁，加 1 茶匙糖、半茶匙盐。\n4. 倒回鸡蛋快速翻炒 30 秒，撒点葱花出锅。\n\n小 tip：想要汤汁多可以盖盖子焖 1 分钟，拌饭也很香。",
        timestamp: "2026-04-08T18:20:35+08:00",
      },
      {
        id: "chat-3",
        role: "user",
        content: "可以不放糖吗？",
        timestamp: "2026-04-08T18:21:02+08:00",
      },
      {
        id: "chat-4",
        role: "agent",
        content:
          "可以。糖主要是用来中和西红柿的酸味，让味道更圆润。如果你用的西红柿本身就比较甜，或者喜欢酸爽一点的口感，可以不放；也可以换成一小勺番茄酱，同样能让味道更柔和。",
        timestamp: "2026-04-08T18:21:18+08:00",
      },
    ],
  },
];

export const initialGoals: Goal[] = rawInitialGoals.map((goal) => migrateGoalIds(goal));

function scopedDraftTaskKey(subGoalId: string, taskId: string) {
  return `${subGoalId}:${taskId}`;
}

function buildTaskIdResolver(draft: GoalBreakdownDraft) {
  const idCounts = new Map<string, number>();
  for (const subGoal of draft.subGoals) {
    for (const taskItem of subGoal.tasks) {
      idCounts.set(taskItem.id, (idCounts.get(taskItem.id) ?? 0) + 1);
    }
  }

  const taskIdMap = new Map<string, string>();
  for (const subGoal of draft.subGoals) {
    for (const taskItem of subGoal.tasks) {
      const hasDuplicateDraftId = (idCounts.get(taskItem.id) ?? 0) > 1;
      const mapKey = hasDuplicateDraftId ? scopedDraftTaskKey(subGoal.id, taskItem.id) : taskItem.id;
      taskIdMap.set(mapKey, createOpaqueId("task"));
    }
  }

  const resolveTaskId = (subGoalId: string, taskId: string) =>
    taskIdMap.get(scopedDraftTaskKey(subGoalId, taskId)) ?? taskIdMap.get(taskId);

  return { resolveTaskId };
}

export function buildGoalFromDraft(draft: GoalBreakdownDraft): Goal {
  const goalId = createOpaqueId("goal");
  const subGoalIdMap = new Map(draft.subGoals.map((subGoal) => [subGoal.id, createOpaqueId("sg")]));
  const { resolveTaskId } = buildTaskIdResolver(draft);

  return {
    id: goalId,
    title: draft.goalTitle,
    deadline: draft.deadline || "2026-06-30T23:59:59+08:00",
    progress: 0,
    createdAt: INITIAL_NOW,
    kind: "collab",
    summary: draft.summary,
    subGoals: draft.subGoals.map((subGoal) => ({
      id: subGoalIdMap.get(subGoal.id) ?? createOpaqueId("sg"),
      goalId,
      title: subGoal.title,
      description: subGoal.description,
      why: subGoal.why,
      priority: subGoal.priority,
      weight: subGoal.weight,
      dependencies: subGoal.dependencies?.map(
        (dependencyId) => subGoalIdMap.get(dependencyId) ?? dependencyId,
      ),
      estimatedDurationMinutes: subGoal.estimatedDurationMinutes,
      successCriteria: subGoal.successCriteria,
      tasks: subGoal.tasks.map((taskItem) => ({
        id: resolveTaskId(subGoal.id, taskItem.id) ?? createOpaqueId("task"),
        subGoalId: subGoalIdMap.get(subGoal.id) ?? createOpaqueId("sg"),
        title: taskItem.title,
        description: taskItem.description,
        expectedOutcome: taskItem.expectedOutcome,
        taskType: taskItem.taskType,
        triggerRule: taskItem.triggerRule,
        deadline: draft.deadline || "2026-06-30T23:59:59+08:00",
        progress: 0,
        instances: [],
        executionKind: normalizeExecutionKind(taskItem.executionKind),
        resultViewKind: normalizeTaskResultViewKind(taskItem.resultViewKind ?? taskItem.executionKind),
        executionStrategy: taskItem.executionStrategy ?? "agent_autonomous",
        priority: taskItem.priority,
        dependencies: taskItem.dependencies
          ?.map((dependencyId) => resolveTaskId(subGoal.id, dependencyId))
          .filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
        executionMode: taskItem.executionMode,
        expectedResult: taskItem.expectedResult,
        executionObjective: taskItem.executionObjective ?? taskItem.description,
        recommendedWorkingDirectory: taskItem.recommendedWorkingDirectory,
        autoRunDisabled: taskItem.autoRunDisabled,
        requiresConfirmation: taskItem.requiresConfirmation,
        collaboration:
          taskItem.collaboration ??
          collaborationFor(normalizeExecutionKind(taskItem.executionKind), taskItem.description, taskItem.expectedOutcome),
      })),
    })),
  };
}

export function createGeneratedInstance(task: Task, createdAt: string): TaskInstance {
  const date = new Date(createdAt);
  const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    id: createOpaqueId("inst"),
    taskId: task.id,
    dateLabel,
    status: "pending",
    intro: `到了 ${task.triggerRule} 的触发时间，KiKi 已自动排队执行“${task.title.replace(/^任务\d+：/, "")}”。`,
    payload: payloadFor(),
    createdAt,
    runner: {
      attemptCount: 0,
    },
    execution: {
      phase: "queued",
      status: "pending",
      lastUpdatedAt: createdAt,
    },
    timeline: buildInitialTimeline(task.id, createdAt, "pending", "等待 Agent 开始执行。"),
  };
}
