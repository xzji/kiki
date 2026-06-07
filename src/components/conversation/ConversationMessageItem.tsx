"use client";

import { Ellipsis, LayoutList } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
import { formatMessageTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useSagaInstancesStore } from "@/stores/sagaInstancesStore";
import type { SagaInstance } from "@/types/agentRuntime";
import type {
  ConversationMessage,
  Goal,
  Task,
  TaskExpectedResult,
} from "@/types/kiki";

/**
 * 单条对话消息。
 * - KiKi：头像 + 昵称 + 文本 +（可选）任务卡片
 * - 用户：右侧气泡
 * - 未读：消息左侧有小红点（仅 KiKi）
 * - hover：右上角「更多」菜单（仅 KiKi task_card）
 */
export function ConversationMessageItem({
  message,
  onQuote,
  onOpenResult,
  onOpenTaskInfo,
  onOpenGoalPlan,
  onTaskOptionalFeedback,
  onGovernanceConfirm,
  onGovernanceCancel,
  onDelete,
}: {
  message: ConversationMessage;
  onQuote: (message: ConversationMessage) => void;
  onOpenResult?: (message: ConversationMessage) => void;
  onOpenTaskInfo?: (message: ConversationMessage) => void;
  onOpenGoalPlan?: (goalId: string) => void;
  onTaskOptionalFeedback?: (
    message: ConversationMessage,
    feedback: string,
  ) => Promise<void> | void;
  onGovernanceConfirm?: (message: ConversationMessage) => Promise<void> | void;
  onGovernanceCancel?: (message: ConversationMessage) => void;
  onDelete: (messageId: string) => void;
}) {
  const goals = useGoalStore(selectVisibleGoals);
  const sagaRequestId =
    message.kind === "text" || message.kind === "goal_plan_card"
      ? message.sagaRequestId
      : undefined;
  const saga = useSagaInstancesStore((state) =>
    sagaRequestId
      ? (Object.values(state.sagas).find(
          (item) => item.idempotencyKey === sagaRequestId,
        ) ?? null)
      : null,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const taskInfo = useMemo(() => {
    if (message.kind !== "task_card") return null;
    const goal = goals.find((g) => g.id === message.taskRef.goalId);
    if (!goal) {
      return message.taskSnapshot
        ? { goal: null, subGoal: null, ...message.taskSnapshot }
        : null;
    }
    const subGoal = goal.subGoals.find(
      (sg) => sg.id === message.taskRef.subGoalId,
    );
    if (!subGoal) {
      return message.taskSnapshot
        ? { goal, subGoal: null, ...message.taskSnapshot }
        : null;
    }
    const task = subGoal.tasks.find((t) => t.id === message.taskRef.taskId);
    if (!task) {
      return message.taskSnapshot
        ? { goal, subGoal, ...message.taskSnapshot }
        : null;
    }
    const instance = task.instances.find(
      (i) => i.id === message.taskRef.instanceId,
    );
    if (!instance) {
      return message.taskSnapshot
        ? {
            goal,
            subGoal,
            task: message.taskSnapshot.task,
            instance: message.taskSnapshot.instance,
          }
        : null;
    }
    return { goal, subGoal, task, instance };
  }, [goals, message]);

  const timeLabel = formatMessageTime(message.createdAt);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  if (message.role === "user") {
    return (
      <div className="group flex justify-end">
        <div className="flex max-w-[66%] items-end gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-end gap-2 text-[12px]">
              <div className="text-[#8C9198] opacity-0 transition-opacity group-hover:opacity-100">
                {timeLabel}
              </div>
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  aria-label="更多"
                  onClick={() => setMenuOpen((prev) => !prev)}
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-md text-[#9AA0A6] transition-opacity hover:bg-[#F5F6F8] hover:text-[#1F2328]",
                    "opacity-0 group-hover:opacity-100",
                    menuOpen && "opacity-100",
                  )}
                >
                  <Ellipsis className="h-4 w-4" />
                </button>
                {menuOpen ? (
                  <MessageMenu
                    canOpenTaskInfo={false}
                    onQuote={() => onQuote(message)}
                    onOpenTaskInfo={
                      onOpenTaskInfo ? () => onOpenTaskInfo(message) : undefined
                    }
                    onDelete={() => onDelete(message.id)}
                    onClose={() => setMenuOpen(false)}
                  />
                ) : null}
              </div>
            </div>
            {message.kind === "text" && message.quotedMessage ? (
              <SentQuotePreview
                roleLabel={message.quotedMessage.roleLabel}
                content={message.quotedMessage.content}
              />
            ) : null}
            <div className="rounded-2xl rounded-br-sm bg-[#111] px-4 py-2.5 text-sm leading-6 text-white">
              {message.content}
            </div>
          </div>
          <div className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-[11px] text-[#5F5AA2]">
            J
          </div>
        </div>
      </div>
    );
  }

  const isKikiLoading =
    message.status === "streaming" && message.content.trim().length === 0;

  return (
    <div className="group relative flex items-start gap-3">
      <KikiAvatar size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <div className="text-[13px] font-medium text-[#1F2328]">KiKi</div>
          <div ref={menuRef} className="relative flex items-center gap-1.5">
            <div className="text-[12px] text-[#8C9198] opacity-0 transition-opacity group-hover:opacity-100">
              {timeLabel}
            </div>
            <button
              type="button"
              aria-label="更多"
              onClick={() => setMenuOpen((prev) => !prev)}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md text-[#9AA0A6] transition-opacity hover:bg-[#F5F6F8] hover:text-[#1F2328]",
                "opacity-0 group-hover:opacity-100",
                menuOpen && "opacity-100",
              )}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <MessageMenu
                canOpenTaskInfo={Boolean(taskInfo)}
                onQuote={() => onQuote(message)}
                onOpenTaskInfo={
                  onOpenTaskInfo ? () => onOpenTaskInfo(message) : undefined
                }
                onDelete={() => onDelete(message.id)}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </div>
        </div>
        <div className="max-w-3xl">
          {isKikiLoading ? (
            <LoadingDots />
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
        </div>

        {sagaRequestId && (message.status === "streaming" || saga) ? (
          <SagaProgressCard saga={saga} />
        ) : null}

        {message.kind === "task_card" && taskInfo ? (
          <TaskMessageCard
            task={taskInfo.task}
            instance={taskInfo.instance}
            onOpen={() => onOpenResult?.(message)}
            onOptionalFeedbackSelect={
              message.kind === "task_card" && onTaskOptionalFeedback
                ? (feedback) => onTaskOptionalFeedback(message, feedback)
                : undefined
            }
          />
        ) : null}

        {message.kind === "goal_plan_card" ? (
          <GoalPlanMessageCard
            title={message.goalRef.title}
            summary={message.goalRef.summary}
            subGoalCount={message.goalRef.subGoalCount}
            taskCount={message.goalRef.taskCount}
            onOpen={() => onOpenGoalPlan?.(message.goalRef.goalId)}
          />
        ) : null}

        {message.kind === "governance_confirmation" ? (
          <GovernanceConfirmationCard
            message={message}
            goals={goals}
            onConfirm={() => onGovernanceConfirm?.(message)}
            onCancel={() => onGovernanceCancel?.(message)}
          />
        ) : null}
      </div>
    </div>
  );
}

function GovernanceConfirmationCard({
  message,
  goals,
  onConfirm,
  onCancel,
}: {
  message: Extract<ConversationMessage, { kind: "governance_confirmation" }>;
  goals: Goal[];
  onConfirm?: () => Promise<void> | void;
  onCancel?: () => void;
}) {
  const pending = message.governance.status === "pending";
  const applied =
    message.governance.status === "applied" ||
    message.governance.status === "confirmed";
  const cancelled = message.governance.status === "cancelled";
  const errored = message.governance.status === "error";
  const taskPreview = buildGovernanceTaskPreview(message, goals);
  const changeItems = buildGovernanceChangeItems(
    message,
    taskPreview.beforeTask,
    taskPreview.afterTask,
  );
  const noActualMutationChange =
    isTaskMutationIntent(message.governance.payload.intent) &&
    changeItems.length === 0;
  return (
    <div className="mt-3 w-full max-w-2xl rounded-2xl border border-[#D0D7DE] bg-[#FBFCFE] p-4">
      <div className="text-[13px] font-medium text-[#1F2328]">确认任务变更</div>
      <div className="mt-1 text-[13px] leading-6 text-[#4B5563]">
        {message.governance.summary}
      </div>
      {changeItems.length ? (
        <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white px-3 py-2">
          <div className="text-[12px] font-medium text-[#1F2328]">
            本次修改内容
          </div>
          <div className="mt-2 space-y-2">
            {changeItems.map((item) => (
              <div
                key={item.field}
                className="rounded-lg border border-[#EEF0F3] bg-[#FBFCFE] px-2.5 py-2"
              >
                <div className="flex items-center gap-2 text-[12px] font-medium text-[#1F2328]">
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[11px]",
                      item.action === "新增" && "bg-[#DAFBE1] text-[#1A7F37]",
                      item.action === "删除" && "bg-[#FFEBE9] text-[#B42318]",
                      item.action === "修改" && "bg-[#FFF8C5] text-[#7D4E00]",
                    )}
                  >
                    {item.action}
                  </span>
                  <span>{item.field}</span>
                </div>
                <div className="mt-1 grid gap-2 text-[12px] leading-5 text-[#6B7280] md:grid-cols-2">
                  <div>
                    <div className="mb-0.5 text-[#8C9198]">修改前</div>
                    <div className="whitespace-pre-wrap rounded-lg bg-[#F6F8FA] p-2">
                      {item.before || "空"}
                    </div>
                  </div>
                  <div>
                    <div className="mb-0.5 text-[#8C9198]">修改后</div>
                    <div className="whitespace-pre-wrap rounded-lg bg-[#F0FDF4] p-2 text-[#1F2328]">
                      {item.after || "空"}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : isTaskMutationIntent(message.governance.payload.intent) ? (
        <div className="mt-3 rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-[12px] leading-5 text-[#6B7280]">
          未检测到实际字段变化，当前任务内容可能已经包含这次要求。
        </div>
      ) : null}
      {taskPreview.fullItems.length ? (
        <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white px-3 py-2">
          <div className="text-[12px] font-medium text-[#1F2328]">
            修改后的完整任务内容
          </div>
          <div className="mt-2 space-y-2">
            {taskPreview.fullItems.map((item) => (
              <div key={item.label} className="text-[12px] leading-5">
                <div className="mb-0.5 text-[#8C9198]">{item.label}</div>
                <div className="whitespace-pre-wrap rounded-lg bg-[#F0FDF4] p-2 text-[#1F2328]">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {message.governance.error ? (
        <div className="mt-3 rounded-lg border border-[#FFB4A8] bg-[#FFF4F2] px-3 py-2 text-[12px] text-[#B42318]">
          {message.governance.error}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        {pending ? (
          <>
            <button
              type="button"
              disabled={noActualMutationChange}
              onClick={() => void onConfirm?.()}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[12px] font-medium",
                noActualMutationChange
                  ? "cursor-not-allowed bg-[#D0D7DE] text-white"
                  : "bg-[#111] text-white hover:bg-[#333]",
              )}
            >
              {noActualMutationChange ? "无需执行" : "确认执行"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              取消
            </button>
          </>
        ) : (
          <span
            className={cn(
              "rounded-md px-2 py-1 text-[12px]",
              applied && "bg-[#DAFBE1] text-[#1A7F37]",
              cancelled && "bg-[#F6F8FA] text-[#6B7280]",
              errored && "bg-[#FFEBE9] text-[#B42318]",
            )}
          >
            {applied ? "已执行" : cancelled ? "已取消" : "执行失败"}
          </span>
        )}
      </div>
    </div>
  );
}

type GovernanceChangeItem = {
  field: string;
  action: "新增" | "删除" | "修改";
  before: string;
  after: string;
};

function buildGovernanceTaskPreview(
  message: Extract<ConversationMessage, { kind: "governance_confirmation" }>,
  goals: Goal[],
): {
  beforeTask: Task | null;
  afterTask: Partial<Task> | null;
  fullItems: Array<{ label: string; value: string }>;
} {
  const patch = message.governance.payload.patch;
  const patchRecord = isRecord(patch) ? patch : null;
  const expectedResult =
    patchRecord && isRecord(patchRecord.expectedResult)
      ? patchRecord.expectedResult
      : null;
  const currentTask = findGovernanceTask(message, goals);
  const afterTask = currentTask
    ? mergeTaskPreview(currentTask, patch)
    : buildPartialTaskPreview(patch);

  const fullItems = buildFullTaskItems(afterTask, expectedResult);
  return { beforeTask: currentTask, afterTask, fullItems };
}

function buildGovernanceChangeItems(
  message: Extract<ConversationMessage, { kind: "governance_confirmation" }>,
  beforeTask: Task | null,
  afterTask: Partial<Task> | null,
): GovernanceChangeItem[] {
  if (message.governance.diffs?.length) {
    return message.governance.diffs
      .map((diff) => ({
        field: humanizeTaskField(diff.field),
        action: inferChangeAction(diff.before, diff.after),
        before: diff.before || "",
        after: diff.after || "",
      }))
      .filter((item) => !isSameDisplayValue(item.before, item.after));
  }

  const patch = message.governance.payload.patch;
  if (!isRecord(patch)) return [];
  const expectedResult = isRecord(patch.expectedResult)
    ? patch.expectedResult
    : null;
  const descriptionPatch = buildDescriptionPatchValue(patch);
  const expectedOutcomePatch = readFirstPatchedValue(patch, [
    "expectedOutcome",
    "deliverable",
  ]);
  const triggerRulePatch = readTriggerRulePatchValue(patch);
  const items: GovernanceChangeItem[] = [];

  appendChangeItem(
    items,
    "任务标题",
    beforeTask?.title,
    patch.title,
    afterTask?.title,
  );
  appendChangeItem(
    items,
    "任务说明",
    beforeTask?.description,
    descriptionPatch,
    afterTask?.description,
  );
  appendChangeItem(
    items,
    "预期产出",
    beforeTask?.expectedOutcome,
    expectedOutcomePatch,
    afterTask?.expectedOutcome,
  );
  appendChangeItem(
    items,
    "产出说明",
    beforeTask?.expectedResult?.description,
    expectedResult?.description,
    afterTask?.expectedResult?.description,
  );
  appendChangeItem(
    items,
    "验收标准",
    beforeTask?.expectedResult?.completionCriteria,
    expectedResult?.completionCriteria ?? patch.completionCriteria,
    afterTask?.expectedResult?.completionCriteria,
  );
  appendChangeItem(
    items,
    "必须包含的内容",
    beforeTask?.expectedResult?.requiredBlocks,
    expectedResult?.requiredBlocks ?? patch.requiredBlocks,
    afterTask?.expectedResult?.requiredBlocks,
  );
  appendChangeItem(
    items,
    "任务类型",
    beforeTask?.taskType,
    readTaskTypePatchValue(patch),
    afterTask?.taskType,
  );
  appendChangeItem(
    items,
    "触发规则",
    beforeTask?.triggerRule,
    triggerRulePatch,
    afterTask?.triggerRule,
  );
  appendChangeItem(
    items,
    "截止时间",
    beforeTask?.deadline,
    patch.deadline,
    afterTask?.deadline,
  );

  return items;
}

function findGovernanceTask(
  message: Extract<ConversationMessage, { kind: "governance_confirmation" }>,
  goals: Goal[],
): Task | null {
  const ref = message.governance.payload.taskRef;
  if (!ref) return null;
  const goal = goals.find((item) => item.id === ref.goalId);
  const subGoal = goal?.subGoals.find((item) => item.id === ref.subGoalId);
  return subGoal?.tasks.find((item) => item.id === ref.taskId) ?? null;
}

function mergeTaskPreview(task: Task, patch: unknown): Partial<Task> {
  if (!isRecord(patch)) return task;
  const expectedResult = mergeExpectedResultPreview(
    task.expectedResult,
    patch,
    task.expectedOutcome,
  );
  const timing = readTimingPatchValue(patch, task);
  return {
    ...task,
    title: readPatchedString(patch, "title", task.title),
    description: buildDescriptionPreview(patch, task.description),
    expectedOutcome: readPatchedString(
      patch,
      "expectedOutcome",
      readPatchedString(patch, "deliverable", task.expectedOutcome),
    ),
    taskType: timing.taskType,
    triggerRule: timing.triggerRule,
    deadline: hasOwn(patch, "deadline")
      ? (formatPatchValue(patch.deadline) ?? undefined)
      : task.deadline,
    expectedResult,
  };
}

function buildPartialTaskPreview(patch: unknown): Partial<Task> | null {
  if (!isRecord(patch)) return null;
  const timing = readTimingPatchValue(patch, {
    taskType: "one_shot",
    triggerRule: "",
  });
  return {
    title: formatPatchValue(patch.title) ?? undefined,
    description: buildDescriptionPreview(patch, "") || undefined,
    expectedOutcome:
      formatPatchValue(
        readFirstPatchedValue(patch, ["expectedOutcome", "deliverable"]),
      ) ?? undefined,
    taskType: timing.taskType,
    triggerRule: timing.triggerRule || undefined,
    deadline: formatPatchValue(patch.deadline) ?? undefined,
    expectedResult: mergeExpectedResultPreview(
      undefined,
      patch,
      formatPatchValue(patch.expectedOutcome) ?? "",
    ),
  };
}

function mergeExpectedResultPreview(
  current: TaskExpectedResult | undefined,
  patch: Record<string, unknown>,
  fallbackDescription: string,
): TaskExpectedResult | undefined {
  const patchExpected = isRecord(patch.expectedResult)
    ? patch.expectedResult
    : null;
  const hasCompletionPatch =
    (patchExpected ? hasOwn(patchExpected, "completionCriteria") : false) ||
    hasOwn(patch, "completionCriteria");
  const completionPatch =
    patchExpected?.completionCriteria ?? patch.completionCriteria;
  const completionCriteria = hasCompletionPatch
    ? mergeTextPreview(current?.completionCriteria, completionPatch)
    : current?.completionCriteria;
  const requiredBlocks = mergeRequiredBlocksPreview(
    current?.requiredBlocks,
    patchExpected?.requiredBlocks ?? patch.requiredBlocks,
  );
  const description =
    patchExpected && hasOwn(patchExpected, "description")
      ? (formatPatchValue(patchExpected.description) ?? "")
      : (current?.description ?? fallbackDescription);

  if (!current && !patchExpected && !completionCriteria && !requiredBlocks)
    return undefined;
  return {
    ...(current ?? {
      type: "deliverable",
      description: fallbackDescription,
      format: "markdown",
    }),
    ...((patchExpected ?? {}) as Partial<TaskExpectedResult>),
    description,
    completionCriteria,
    requiredBlocks,
  } as TaskExpectedResult;
}

function buildFullTaskItems(
  task: Partial<Task> | null,
  fallbackExpectedResult: Record<string, unknown> | null,
): Array<{ label: string; value: string }> {
  if (!task) return [];
  const items: Array<{ label: string; value: string }> = [];

  appendPatchItem(items, "任务标题", task.title);
  appendPatchItem(items, "任务说明", task.description);
  appendPatchItem(items, "预期产出", task.expectedOutcome);
  appendPatchItem(
    items,
    "产出说明",
    task.expectedResult?.description ?? fallbackExpectedResult?.description,
  );
  appendPatchItem(
    items,
    "验收标准",
    task.expectedResult?.completionCriteria ??
      fallbackExpectedResult?.completionCriteria,
  );
  appendPatchItem(
    items,
    "必须包含的内容",
    task.expectedResult?.requiredBlocks ??
      fallbackExpectedResult?.requiredBlocks,
  );
  appendPatchItem(items, "任务类型", task.taskType);
  appendPatchItem(items, "触发规则", task.triggerRule);
  appendPatchItem(items, "截止时间", task.deadline);
  appendPatchItem(items, "执行类型", task.executionKind);

  return items;
}

function appendChangeItem(
  items: GovernanceChangeItem[],
  field: string,
  beforeValue: unknown,
  patchValue: unknown,
  mergedAfterValue?: unknown,
) {
  if (patchValue === undefined) return;
  const before = formatPatchValue(beforeValue) ?? "";
  const after = formatPatchValue(mergedAfterValue ?? patchValue) ?? "";
  if (!before && !after) return;
  if (isSameDisplayValue(before, after)) return;
  items.push({
    field,
    action: inferChangeAction(before, after),
    before,
    after,
  });
}

function buildDescriptionPreview(
  patch: Record<string, unknown>,
  fallback: string,
) {
  if (hasOwn(patch, "description"))
    return formatPatchValue(patch.description) ?? "";
  const objective = formatPatchValue(patch.objective);
  const acceptanceCriteria = normalizeStringArray(patch.acceptanceCriteria);
  if (!objective && !acceptanceCriteria.length) return fallback;
  const acceptance = acceptanceCriteria.length
    ? `\n验收标准：\n${acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
    : "";
  return `${objective ?? fallback}${acceptance}`.trim();
}

function buildDescriptionPatchValue(patch: Record<string, unknown>) {
  if (hasOwn(patch, "description")) return patch.description;
  if (hasOwn(patch, "objective") || hasOwn(patch, "acceptanceCriteria")) {
    return buildDescriptionPreview(patch, "");
  }
  return undefined;
}

function readTimingPatchValue(
  patch: Record<string, unknown>,
  fallback: Pick<Task, "taskType" | "triggerRule">,
): Pick<Task, "taskType" | "triggerRule"> {
  const explicitTaskType = readTaskTypePatchValue(patch);
  const triggerRule = formatPatchValue(readTriggerRulePatchValue(patch));
  const hasCadenceOrCondition =
    hasOwn(patch, "cadence") || hasOwn(patch, "triggerCondition");
  return {
    taskType:
      explicitTaskType ??
      (hasCadenceOrCondition ? "repeat" : fallback.taskType),
    triggerRule: triggerRule ?? fallback.triggerRule,
  };
}

function readTaskTypePatchValue(patch: Record<string, unknown>) {
  return patch.taskType === "repeat" || patch.taskType === "one_shot"
    ? patch.taskType
    : undefined;
}

function readTriggerRulePatchValue(patch: Record<string, unknown>) {
  if (hasOwn(patch, "triggerRule")) return patch.triggerRule;
  if (hasOwn(patch, "cadence")) return patch.cadence;
  if (hasOwn(patch, "triggerCondition")) {
    const triggerCondition = formatPatchValue(patch.triggerCondition);
    return triggerCondition
      ? `满足条件：${triggerCondition}`
      : patch.triggerCondition;
  }
  return undefined;
}

function readFirstPatchedValue(
  record: Record<string, unknown>,
  keys: string[],
) {
  for (const key of keys) {
    if (hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function mergeTextPreview(
  beforeValue: unknown,
  patchValue: unknown,
): string | undefined {
  const before = formatPatchValue(beforeValue);
  const patch = formatPatchValue(patchValue);
  if (!before) return patch ?? undefined;
  if (!patch || before.includes(patch)) return before;
  return `${before}\n${patch}`;
}

function mergeRequiredBlocksPreview(
  beforeValue: unknown,
  patchValue: unknown,
): TaskExpectedResult["requiredBlocks"] | undefined {
  const merged = [
    ...normalizeStringArray(beforeValue),
    ...normalizeStringArray(patchValue),
  ];
  const unique = Array.from(new Set(merged));
  return unique.length
    ? (unique as TaskExpectedResult["requiredBlocks"])
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function humanizeTaskField(field: string) {
  const fieldMap: Record<string, string> = {
    title: "任务标题",
    description: "任务说明",
    expectedOutcome: "预期产出",
    "expectedResult.description": "产出说明",
    "expectedResult.completionCriteria": "验收标准",
    completionCriteria: "验收标准",
    "expectedResult.requiredBlocks": "必须包含的内容",
    requiredBlocks: "必须包含的内容",
    taskType: "任务类型",
    triggerRule: "触发规则",
    deadline: "截止时间",
  };
  return fieldMap[field] ?? field;
}

function inferChangeAction(
  before: unknown,
  after: unknown,
): GovernanceChangeItem["action"] {
  const beforeText = formatPatchValue(before) ?? "";
  const afterText = formatPatchValue(after) ?? "";
  if (!beforeText && afterText) return "新增";
  if (beforeText && !afterText) return "删除";
  return "修改";
}

function isTaskMutationIntent(intent: string) {
  return (
    intent === "amend_task" ||
    intent === "update_task" ||
    intent === "create_task"
  );
}

function isSameDisplayValue(before: unknown, after: unknown) {
  return normalizeDisplayValue(before) === normalizeDisplayValue(after);
}

function normalizeDisplayValue(value: unknown) {
  return (formatPatchValue(value) ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendPatchItem(
  items: Array<{ label: string; value: string }>,
  label: string,
  value: unknown,
) {
  const formatted = formatPatchValue(value);
  if (!formatted) return;
  items.push({ label, value: formatted });
}

function readPatchedString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  if (!hasOwn(record, key)) return fallback;
  return formatPatchValue(record[key]) ?? "";
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function formatPatchValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const formattedItems = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!isRecord(item)) return "";
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const description =
          typeof item.description === "string" ? item.description.trim() : "";
        if (title && description) return `${title}：${description}`;
        return title || description;
      })
      .filter(Boolean);
    return formattedItems.length > 0
      ? formattedItems.map((item) => `- ${item}`).join("\n")
      : null;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => {
        const formatted = formatPatchValue(entryValue);
        return formatted ? `${key}：${formatted}` : "";
      })
      .filter(Boolean);
    return entries.length > 0 ? entries.join("\n") : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function SentQuotePreview({
  roleLabel,
  content,
}: {
  roleLabel: string;
  content: string;
}) {
  return (
    <div className="mb-1.5 rounded-xl border border-[#D0D7DE] bg-[#F8F9FB] px-3 py-2 text-left">
      <div className="text-[11px] font-medium text-[#1F2328]">
        引用 {roleLabel}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[#6B7280]">
        {content}
      </div>
    </div>
  );
}

const SAGA_STEPS = [
  {
    key: "interview",
    role: "Interviewer",
    title: "理解目标",
    description: "确认背景信息与关键约束",
  },
  {
    key: "plan",
    role: "Planner",
    title: "拆解方案",
    description: "生成板块与任务草案",
  },
  {
    key: "critic",
    role: "Critic",
    title: "评审草案",
    description: "检查是否贴合目标",
  },
  {
    key: "refine",
    role: "Refiner",
    title: "按需修正",
    description: "根据评审意见调整草案",
  },
  {
    key: "present",
    role: "Presenter",
    title: "整理结果",
    description: "生成可确认的目标规划",
  },
] as const;

function SagaProgressCard({ saga }: { saga: SagaInstance | null }) {
  const currentStep = normalizeSagaProgressStep(saga?.currentStep);
  const currentIndex = SAGA_STEPS.findIndex((step) => step.key === currentStep);
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;
  const isTerminal = saga?.status === "completed" || saga?.status === "failed";

  return (
    <div className="mt-3 w-full max-w-xl rounded-2xl border border-[#E5E7EB] bg-[#FBFCFE] px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-[#1F2328]">拆解进度</div>
        <div className="text-[12px] text-[#6B7280]">
          {saga ? formatSagaStatus(saga) : "启动中"}
        </div>
      </div>
      <div className="space-y-2">
        {SAGA_STEPS.map((step, index) => {
          const state = resolveSagaStepState({
            index,
            activeIndex,
            saga,
            isTerminal,
          });
          return (
            <div key={step.key} className="flex items-start gap-3">
              <div
                className={cn(
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium",
                  state === "completed" &&
                    "border-[#1A7F37] bg-[#DAFBE1] text-[#1A7F37]",
                  state === "running" &&
                    "border-[#8250DF] bg-[#F0EDFF] text-[#5B3DBE]",
                  state === "failed" &&
                    "border-[#D1242F] bg-[#FFEBE9] text-[#D1242F]",
                  state === "pending" &&
                    "border-[#D0D7DE] bg-white text-[#8C9198]",
                )}
              >
                {state === "completed" ? "✓" : index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-[#1F2328]">
                    {step.title}
                  </span>
                  <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#6B7280]">
                    {step.role}
                  </span>
                  <span
                    className={cn("text-[11px]", sagaStepStateClassName(state))}
                  >
                    {formatSagaStepState(state)}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-5 text-[#6B7280]">
                  {step.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolveSagaStepState(input: {
  index: number;
  activeIndex: number;
  saga: SagaInstance | null;
  isTerminal: boolean;
}) {
  if (!input.saga) return input.index === 0 ? "running" : "pending";
  if (input.saga.status === "failed" && input.index === input.activeIndex)
    return "failed";
  if (input.saga.status === "completed") return "completed";
  if (input.index < input.activeIndex) return "completed";
  if (input.index === input.activeIndex && !input.isTerminal) return "running";
  return "pending";
}

function formatSagaStatus(saga: SagaInstance) {
  if (saga.status === "awaiting_user") return "等待补充信息";
  if (saga.status === "completed") return "已完成";
  if (saga.status === "failed") return "执行失败";
  const step = SAGA_STEPS.find((item) => item.key === normalizeSagaProgressStep(saga.currentStep));
  return step ? `进行中：${step.title}` : "进行中";
}

function normalizeSagaProgressStep(step: string | undefined) {
  if (step === "spec") return "present";
  return step ?? "interview";
}

function formatSagaStepState(state: ReturnType<typeof resolveSagaStepState>) {
  if (state === "completed") return "已完成";
  if (state === "running") return "进行中";
  if (state === "failed") return "失败";
  return "待开始";
}

function sagaStepStateClassName(
  state: ReturnType<typeof resolveSagaStepState>,
) {
  if (state === "completed") return "text-[#1A7F37]";
  if (state === "running") return "text-[#5B3DBE]";
  if (state === "failed") return "text-[#D1242F]";
  return "text-[#8C9198]";
}

function GoalPlanMessageCard({
  title,
  summary,
  subGoalCount,
  taskCount,
  onOpen,
}: {
  title: string;
  summary?: string;
  subGoalCount: number;
  taskCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-3 block w-full max-w-xl rounded-2xl border border-[#D0D7DE] bg-white p-4 text-left shadow-sm transition hover:border-[#111] hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-[#F0EDFF] text-[#5B3DBE]">
          <LayoutList className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[#6B7280]">
            目标规划草案
          </div>
          <div className="mt-1 text-base font-semibold leading-6 text-[#1F2328]">
            {title}
          </div>
          {summary ? (
            <div className="mt-2 line-clamp-2 text-[13px] leading-5 text-[#6B7280]">
              {summary}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
            <span className="rounded-md bg-[#F5F6F8] px-2 py-1">
              {subGoalCount} 个子目标
            </span>
            <span className="rounded-md bg-[#F5F6F8] px-2 py-1">
              {taskCount} 个任务
            </span>
            <span className="ml-auto font-medium text-[#1F2328]">打开规划</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function LoadingDots() {
  return (
    <span
      className="inline-flex h-6 items-center gap-1"
      aria-label="KiKi 正在输入"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#9AA0A6]"
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  );
}

function MessageMenu({
  canOpenTaskInfo,
  onQuote,
  onOpenTaskInfo,
  onDelete,
  onClose,
}: {
  canOpenTaskInfo: boolean;
  onQuote: () => void;
  onOpenTaskInfo?: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328] shadow-sm">
      <button
        type="button"
        onClick={() => {
          onQuote();
          onClose();
        }}
        className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
      >
        引用
      </button>
      <button
        type="button"
        disabled={!canOpenTaskInfo}
        onClick={() => {
          if (!canOpenTaskInfo || !onOpenTaskInfo) return;
          onOpenTaskInfo();
          onClose();
        }}
        className={cn(
          "block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]",
          !canOpenTaskInfo &&
            "cursor-not-allowed text-[#B0B6BE] hover:bg-white",
        )}
      >
        查看任务信息
      </button>
      <button
        type="button"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="block w-full px-3 py-2 text-left text-[#D1242F] hover:bg-[#F8F9FB]"
      >
        删除
      </button>
    </div>
  );
}
