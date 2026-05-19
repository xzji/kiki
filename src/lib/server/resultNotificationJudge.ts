import type {
  Goal,
  InteractionRequirement,
  SubGoal,
  Task,
  TaskInstance,
  TaskResultNotificationDecision,
  TaskResultNotificationPriority,
  TaskResultViewKind,
  TaskRunArtifact,
} from "@/types/kiki";

type JudgeTaskResultInput = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  result: {
    summary: string;
    finalMessage: string;
    resultViewKind: TaskResultViewKind;
    awaitingUser: boolean;
    awaitingReason?: string;
    suggestedActions?: string[];
    artifacts: TaskRunArtifact[];
    interactionRequirement?: InteractionRequirement;
    structuredOutput: Record<string, unknown> | null;
  };
  now?: string;
};

function cleanTaskTitle(task: Task) {
  return task.title.replace(/^任务\d+：/, "");
}

function titleFor(input: JudgeTaskResultInput) {
  return `${cleanTaskTitle(input.task)} - ${input.goal.title}`;
}

function compactText(value?: string) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function firstSentence(value?: string) {
  const text = compactText(value);
  if (!text) return "";
  const match = text.match(/^(.{1,120}?[。！？.!?])\s*/);
  return match?.[1] ?? text.slice(0, 120);
}

function extractKeyPoints(result: JudgeTaskResultInput["result"]) {
  const source = result.finalMessage || result.summary;
  const lines = source
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter(Boolean)
    .filter((line) => line.length >= 8);
  const unique = Array.from(new Set(lines));
  if (unique.length > 0) return unique.slice(0, 3);
  const sentence = firstSentence(source);
  return sentence ? [sentence] : [];
}

function buildSummary(input: JudgeTaskResultInput, fallbackHeadline: string) {
  const headline =
    compactText(input.result.summary) ||
    firstSentence(input.result.finalMessage) ||
    fallbackHeadline;
  return {
    headline,
    keyPoints: extractKeyPoints(input.result),
    nextActions: input.result.suggestedActions?.slice(0, 3) ?? [],
    primaryArtifactLabel: input.result.artifacts[0]?.label,
  };
}

function hasMeaningfulArtifacts(result: JudgeTaskResultInput["result"]) {
  return result.artifacts.some((artifact) => artifact.label || artifact.content || artifact.href);
}

function hasSubstantialFinalMessage(result: JudgeTaskResultInput["result"]) {
  return compactText(result.finalMessage).length >= 160 || compactText(result.summary).length >= 80;
}

function isHighPriority(task: Task) {
  return task.priority === "critical" || task.priority === "high";
}

function hasImportantSignal(result: JudgeTaskResultInput["result"]) {
  const text = `${result.summary}\n${result.finalMessage}`.toLowerCase();
  return /异常|风险|阻塞|失败|紧急|机会|alert|risk|blocked|urgent|error/.test(text);
}

function taskRequiresUserConfirmationToComplete(task: Task) {
  if (task.expectedResult?.type === "decision" || task.expectedResult?.type === "confirmation") return true;
  const criteria = task.expectedResult?.completionCriteria ?? "";
  if (/用户.*(确认|审批|选择|决定|采纳).*完成|必须.*用户.*(确认|审批|选择|决定|采纳)|经用户.*(确认|审批|选择|决定|采纳)/.test(criteria)) {
    return true;
  }
  return task.requiresConfirmation === true && task.expectedResult?.type !== "information";
}

function baseDecision(
  input: JudgeTaskResultInput,
  overrides: Omit<TaskResultNotificationDecision, "title" | "createdAt"> & {
    title?: string;
  },
): TaskResultNotificationDecision {
  return {
    ...overrides,
    title: overrides.title ?? titleFor(input),
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function actionRequiredDecision(
  input: JudgeTaskResultInput,
  reason: string,
  options?: {
    snippetPrefix?: string;
    userMessage?: string;
    fallbackNextActions?: string[];
  },
): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, reason);
  return baseDecision(input, {
    shouldNotify: true,
    channel: "both",
    notificationType: "action_required",
    priority: "high",
    reason,
    snippet: `[${options?.snippetPrefix ?? "需要确认"}] ${reason}`,
    userMessage: options?.userMessage ?? `任务「${taskTitle}」需要你确认或提出修改建议。${reason}`,
    badge: "need_confirm",
    resultSummary: {
      ...summary,
      nextActions: summary.nextActions.length ? summary.nextActions : (options?.fallbackNextActions ?? ["查看结果", "确认下一步"]),
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
  });
}

function answerRequiredDecision(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, `任务「${taskTitle}」已准备好，需要你继续完成。`);
  return baseDecision(input, {
    shouldNotify: true,
    channel: "both",
    notificationType: "answer_required",
    priority: "high",
    reason: "任务结果需要用户作答或继续互动。",
    snippet: `[需要作答] ${summary.headline}`,
    userMessage: `任务「${taskTitle}」已经准备好，需要你完成本轮作答。`,
    badge: "need_answer",
    resultSummary: {
      ...summary,
      nextActions: summary.nextActions.length ? summary.nextActions : ["开始作答", "查看练习内容"],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
  });
}

function contextRequiredDecision(input: JudgeTaskResultInput, reason: string): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, reason);
  return baseDecision(input, {
    shouldNotify: true,
    channel: "both",
    notificationType: "context_required",
    priority: "high",
    reason,
    snippet: `[待补充] ${summary.headline}`,
    userMessage: `任务「${taskTitle}」需要你补充信息后继续推进。${reason}`,
    badge: "need_confirm",
    resultSummary: {
      ...summary,
      nextActions: summary.nextActions.length ? summary.nextActions : ["补充信息", "查看任务详情"],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
  });
}

function offlineActionRequiredDecision(input: JudgeTaskResultInput, reason: string): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  return actionRequiredDecision(input, reason, {
    snippetPrefix: "待完成",
    userMessage: `任务「${taskTitle}」需要你完成线下动作并记录结果。${reason}`,
    fallbackNextActions: ["记录完成情况", "查看任务详情"],
  });
}

function archiveInteractionGapDecision(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const interaction = input.result.interactionRequirement;
  return baseDecision(input, {
    shouldNotify: false,
    channel: "silent",
    notificationType: "silent_archive",
    priority: "low",
    reason: interaction?.reason || "任务产物未通过验收，等待 Agent 补齐，不需要打扰用户。",
    snippet: interaction?.reason || input.result.summary,
    userMessage: interaction?.reason || input.result.finalMessage,
    badge: null,
    resultSummary: buildSummary(input, "任务产物未通过验收，等待 Agent 补齐。"),
    detailPolicy: {
      showTimelineByDefault: true,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
  });
}

function digestReadyDecision(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, `我整理好了「${taskTitle}」的摘要。`);
  return baseDecision(input, {
    shouldNotify: true,
    channel: "inbox",
    notificationType: "digest_ready",
    priority: "normal",
    reason: "摘要类任务完成后适合进入 Inbox 供用户查看。",
    snippet: summary.headline,
    userMessage: `我整理好了任务「${taskTitle}」的摘要，核心是：${summary.headline}`,
    badge: null,
    resultSummary: summary,
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: false,
    },
  });
}

function resultReadyDecision(
  input: JudgeTaskResultInput,
  priority: TaskResultNotificationPriority = "normal",
): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, `任务「${taskTitle}」已完成。`);
  return baseDecision(input, {
    shouldNotify: true,
    channel: priority === "high" ? "both" : "inbox",
    notificationType: "result_ready",
    priority,
    reason: "任务完成并产出了值得用户查看的结果。",
    snippet: summary.headline,
    userMessage: `任务「${taskTitle}」已完成，点击卡片可以查看结果。`,
    badge: null,
    resultSummary: summary,
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: hasMeaningfulArtifacts(input.result),
    },
  });
}

function silentArchiveDecision(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const taskTitle = cleanTaskTitle(input.task);
  const summary = buildSummary(input, `任务「${taskTitle}」已完成并归档。`);
  return baseDecision(input, {
    shouldNotify: false,
    channel: "silent",
    notificationType: "silent_archive",
    priority: "low",
    reason: "任务完成但无需主动打扰用户。",
    snippet: summary.headline,
    userMessage: `任务「${taskTitle}」已完成，结果已归档到任务详情页。`,
    badge: null,
    resultSummary: summary,
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: false,
    },
  });
}

export function judgeTaskResult(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const kind = input.result.resultViewKind || input.task.resultViewKind || input.task.executionKind;
  const interaction = input.result.interactionRequirement;

  if (interaction?.type === "deliverable_gap" || interaction?.type === "agent_revision_required") {
    return archiveInteractionGapDecision(input);
  }

  if (interaction?.type === "answer") {
    return answerRequiredDecision(input);
  }

  if (interaction?.type === "provide_context") {
    return contextRequiredDecision(input, interaction.reason || "任务需要你补充关键信息。");
  }

  if (interaction?.type === "confirm" && interaction.shouldNotifyUser) {
    return actionRequiredDecision(input, interaction.reason || input.result.awaitingReason || "任务需要你确认或提出修改建议。");
  }

  if (interaction?.type === "perform_offline_action" && interaction.shouldNotifyUser) {
    return offlineActionRequiredDecision(input, interaction.reason || "任务需要你完成线下动作并记录结果。");
  }

  if (input.result.awaitingUser) {
    return actionRequiredDecision(input, input.result.awaitingReason || "任务需要你参与后才能继续。");
  }

  if (taskRequiresUserConfirmationToComplete(input.task)) {
    return actionRequiredDecision(input, "任务已完成，建议你确认结果后继续推进。");
  }

  if (kind === "confirm_action") {
    return actionRequiredDecision(input, input.result.summary || "KiKi 已整理好可执行方案，需要你确认。");
  }

  if (kind === "draft_review") {
    return actionRequiredDecision(input, input.result.summary || "草稿已生成，需要你确认或提出修改建议。");
  }

  if (kind === "flashcard" || kind === "listening_qa" || kind === "freeform_chat") {
    return answerRequiredDecision(input);
  }

  if (kind === "reading_digest") {
    return digestReadyDecision(input);
  }

  if (input.task.taskType === "monitoring" && hasImportantSignal(input.result)) {
    return resultReadyDecision(input, "high");
  }

  if (hasMeaningfulArtifacts(input.result) || hasSubstantialFinalMessage(input.result) || isHighPriority(input.task)) {
    return resultReadyDecision(input, isHighPriority(input.task) ? "high" : "normal");
  }

  return silentArchiveDecision(input);
}
