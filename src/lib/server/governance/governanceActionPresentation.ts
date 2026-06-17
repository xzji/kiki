import type { DispatchThreadActionsResult } from "@/lib/server/governance/dispatchActions";
import type { GovernanceTickTopicOutcome } from "@/lib/server/governance/governanceTickProtocol";
import type { TopicTickAction } from "@/lib/server/governance/topicRunner";
import type { ThreadTickOutput } from "@/types/topic";
import type { Topic } from "@/types/topic";

export type GovernanceActionSeverity = "info" | "success" | "warning" | "danger";

export type GovernanceFieldChange = {
  field: string;
  label: string;
  before?: string;
  after?: string;
};

export type GovernanceActionPresentation =
  | {
      scope: "topic";
      kind: "silent" | "mark_running" | "mark_completed" | "mark_failed" | "adjust_loop";
      title: string;
      reason: string;
      summary: string;
      severity: GovernanceActionSeverity;
      before?: string;
      after?: string;
    }
  | {
      scope: "thread";
      kind: "dispatch_task" | "update_task" | "cancel_task" | "archive_thread" | "post_message" | "silent";
      title: string;
      reason: string;
      summary: string;
      severity: GovernanceActionSeverity;
      taskId?: string;
      taskTitle?: string;
      instanceId?: string;
      fieldChanges?: GovernanceFieldChange[];
    };

const TITLE_LIMIT = 60;
const SUMMARY_LIMIT = 120;
const REASON_LIMIT = 180;
const FIELD_VALUE_LIMIT = 120;

export function clipGovernanceText(value: unknown, limit: number) {
  const text = stringifyValue(value).trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

export function clipGovernanceFieldChanges(changes: GovernanceFieldChange[] | undefined) {
  return (changes ?? []).map((change) => ({
    field: clipGovernanceText(change.field, TITLE_LIMIT),
    label: clipGovernanceText(change.label, TITLE_LIMIT),
    before: change.before === undefined ? undefined : clipGovernanceText(change.before, FIELD_VALUE_LIMIT),
    after: change.after === undefined ? undefined : clipGovernanceText(change.after, FIELD_VALUE_LIMIT),
  }));
}

export function normalizeGovernanceActionDetails(details: GovernanceActionPresentation[]) {
  return details.map((detail) => ({
    ...detail,
    title: clipGovernanceText(detail.title, TITLE_LIMIT),
    summary: clipGovernanceText(detail.summary, SUMMARY_LIMIT),
    reason: clipGovernanceText(detail.reason, REASON_LIMIT),
    ...("before" in detail && detail.before !== undefined
      ? { before: clipGovernanceText(detail.before, FIELD_VALUE_LIMIT) }
      : {}),
    ...("after" in detail && detail.after !== undefined
      ? { after: clipGovernanceText(detail.after, FIELD_VALUE_LIMIT) }
      : {}),
    ...("fieldChanges" in detail
      ? { fieldChanges: clipGovernanceFieldChanges(detail.fieldChanges) }
      : {}),
  })) as GovernanceActionPresentation[];
}

export function buildThreadActionDetails(input: {
  output?: ThreadTickOutput;
  dispatch?: DispatchThreadActionsResult;
}): GovernanceActionPresentation[] {
  if (!input.output) return [];
  const dispatched = [...(input.dispatch?.dispatchedTasks ?? [])];
  const updated = [...(input.dispatch?.updatedTasks ?? [])];
  const cancelled = [...(input.dispatch?.cancelledTasks ?? [])];
  const sent = [...(input.dispatch?.sentMessages ?? [])];
  const details: GovernanceActionPresentation[] = [];

  for (const action of input.output.actions) {
    if (action.kind === "dispatch_task") {
      const record = dispatched.shift();
      const taskTitle = record?.draft.title ?? action.taskDraft.title;
      const trigger = action.taskDraft.triggerRule ?? action.taskDraft.cadence ?? action.taskDraft.triggerCondition;
      details.push(threadDetail({
        kind: "dispatch_task",
        title: `新增任务「${taskTitle}」`,
        summary: trigger
          ? `新增任务「${taskTitle}」，触发规则：${stringifyValue(trigger)}`
          : `新增任务「${taskTitle}」`,
        reason: action.reason,
        severity: "success",
        taskId: record?.taskId,
        instanceId: record?.instanceId,
        taskTitle,
      }));
      continue;
    }

    if (action.kind === "update_task") {
      const record = updated.shift();
      const taskTitle = record?.currentTaskTitle ?? action.taskId;
      const firstChange = record?.fieldChanges?.[0];
      details.push(threadDetail({
        kind: "update_task",
        title: `调整任务「${taskTitle}」`,
        summary: firstChange
          ? `调整任务「${taskTitle}」：${firstChange.label} 已变化`
          : `调整任务「${taskTitle}」`,
        reason: action.reason,
        severity: "warning",
        taskId: record?.taskId ?? action.taskId,
        taskTitle,
        fieldChanges: record?.fieldChanges,
      }));
      continue;
    }

    if (action.kind === "cancel_task") {
      const record = cancelled.shift();
      const taskTitle = record?.currentTaskTitle ?? action.taskId;
      details.push(threadDetail({
        kind: "cancel_task",
        title: `取消任务「${taskTitle}」`,
        summary: `取消任务「${taskTitle}」`,
        reason: action.reason,
        severity: "danger",
        taskId: record?.taskId ?? action.taskId,
        taskTitle,
      }));
      continue;
    }

    if (action.kind === "archive_thread") {
      details.push(threadDetail({
        kind: "archive_thread",
        title: "归档 Thread",
        summary: "Thread 已归档",
        reason: action.reason,
        severity: "success",
      }));
      continue;
    }

    if (action.kind === "post_message") {
      const record = sent.shift();
      details.push(threadDetail({
        kind: "post_message",
        title: "发送治理消息",
        summary: `发送治理消息：${clipGovernanceText(record?.text ?? action.text, 70)}`,
        reason: record?.text ?? action.text,
        severity: action.severity === "important" ? "warning" : "info",
      }));
      continue;
    }

    details.push(threadDetail({
      kind: "silent",
      title: "本次检查无改动",
      summary: "本次检查无改动",
      reason: action.reason,
      severity: "info",
    }));
  }

  return normalizeGovernanceActionDetails(details);
}

export function buildTopicActionDetails(input: {
  outcome: GovernanceTickTopicOutcome;
  topicSnapshot?: Topic;
}): GovernanceActionPresentation[] {
  const output = input.outcome.output;
  if (!output) {
    if (!input.outcome.ok || input.outcome.patch.phase === "failed") {
      return normalizeGovernanceActionDetails([topicDetail({
        kind: "mark_failed",
        title: "主题治理失败",
        summary: "主题治理失败",
        reason: input.outcome.error ?? "topic_tick_failed",
        severity: "danger",
      })]);
    }
    return [];
  }

  return normalizeGovernanceActionDetails(output.actions.map((action) => topicActionDetail({
    action,
    beforeLoop: input.topicSnapshot?.loop,
    afterLoop: input.outcome.patch.loop,
    previousPhase: input.topicSnapshot?.phase,
  })));
}

function topicActionDetail(input: {
  action: TopicTickAction;
  beforeLoop?: unknown;
  afterLoop?: unknown;
  previousPhase?: string;
}): Extract<GovernanceActionPresentation, { scope: "topic" }> {
  const { action } = input;
  if (action.kind === "adjust_loop") {
    const before = stringifyValue(input.beforeLoop);
    const after = stringifyValue(input.afterLoop ?? action.loop);
    return topicDetail({
      kind: "adjust_loop",
      title: "调整回顾周期",
      summary: before && after ? `回顾周期从「${before}」调整为「${after}」` : "调整回顾周期",
      reason: action.reason,
      severity: "warning",
      before,
      after,
    });
  }
  if (action.kind === "mark_completed") {
    return topicDetail({
      kind: "mark_completed",
      title: "主题已完成",
      summary: "主题已完成",
      reason: action.reason,
      severity: "success",
    });
  }
  if (action.kind === "mark_failed") {
    return topicDetail({
      kind: "mark_failed",
      title: "主题进入失败状态",
      summary: "主题进入失败状态",
      reason: action.reason,
      severity: "danger",
    });
  }
  if (action.kind === "mark_running") {
    const recovered = input.previousPhase === "failed";
    return topicDetail({
      kind: "mark_running",
      title: recovered ? "主题已恢复为治理中" : "主题保持治理中",
      summary: recovered ? "主题已恢复为治理中" : "主题保持治理中",
      reason: action.reason,
      severity: recovered ? "success" : "info",
    });
  }
  return topicDetail({
    kind: "silent",
    title: "本次检查无改动",
    summary: "本次检查无改动",
    reason: action.reason,
    severity: "info",
  });
}

function threadDetail(
  detail: Omit<Extract<GovernanceActionPresentation, { scope: "thread" }>, "scope">,
): Extract<GovernanceActionPresentation, { scope: "thread" }> {
  return { scope: "thread", ...detail };
}

function topicDetail(
  detail: Omit<Extract<GovernanceActionPresentation, { scope: "topic" }>, "scope">,
): Extract<GovernanceActionPresentation, { scope: "topic" }> {
  return { scope: "topic", ...detail };
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
