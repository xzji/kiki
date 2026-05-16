"use client";

import { useMemo, useState } from "react";

import { resumeTaskRun } from "@/lib/api/taskRuns";
import { useGoalStore } from "@/stores/goalStore";
import type { Task, TaskInstance } from "@/types/kiki";

type ReadinessItem = {
  id: string;
  label: string;
  description: string;
  source: "user" | "agent" | "system";
  status: "available" | "missing_user" | "agent_retrievable" | "not_required";
  reason: string;
  options?: string[];
};

type TaskReadiness = {
  status: "ready" | "blocked";
  summary: string;
  items: ReadinessItem[];
};

function titleFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "等待你作答";
  if (type === "provide_context") return "等待你补充信息";
  if (type === "perform_offline_action") return "等待你完成线下动作";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "等待你确认";
}

function primaryLabelFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "answer") return "提交答案并继续";
  if (type === "provide_context") return "提交信息并继续";
  if (type === "perform_offline_action") return "我已完成，继续执行";
  return "确认并继续";
}

function submittedStatusLabel(status: string) {
  if (status === "confirmed") return "已确认";
  if (status === "rejected") return "已要求修改";
  if (status === "completed") return "已完成";
  return "已提交";
}

function formatSubmittedAt(value: string) {
  try {
    return new Date(value).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function submittedDetails(instance: TaskInstance) {
  const submission = instance.result?.interactionSubmission;
  if (!submission) return [];
  const fieldEntries = Object.entries(submission.fields ?? {})
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value}`);
  if (fieldEntries.length) return fieldEntries;
  return [submission.feedback || submission.action].filter(Boolean);
}

function defaultOptionsFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "answer") return ["主流答案（稳妥）", "高频例外（需说明）", "不确定（让 KiKi 判断）"];
  if (type === "provide_context") return ["主流稳妥方案（风险低）", "高性价比方案（均衡）", "体验优先方案（更舒适）"];
  if (type === "perform_offline_action") return ["我已完成", "还没完成", "需要 KiKi 调整任务"];
  return ["采用推荐方案（稳妥）", "换成保守方案（风险低）", "换成体验优先方案"];
}

export function SubmittedInteractionPanel({ instance }: { instance: TaskInstance }) {
  const submission = instance.result?.interactionSubmission;
  if (!submission || instance.awaitingUser) return null;
  const details = submittedDetails(instance);
  return (
    <div className="rounded-xl border border-[#B7E4C7] bg-[#F0FFF4] p-4 text-[13px] leading-6 text-[#1F5132]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{submittedStatusLabel(submission.status)}</span>
        <span className="rounded-full bg-white px-2 py-0.5 text-[12px] text-[#2F7D4A]">
          {formatSubmittedAt(submission.submittedAt)}
        </span>
      </div>
      {details.length ? (
        <div className="mt-2 rounded-lg bg-white/75 px-3 py-2 text-[#1F2328]">
          <div className="text-[12px] text-[#57606A]">已提交的信息</div>
          <div className="mt-1 space-y-1">
            {details.map((detail) => (
              <div key={detail}>{detail}</div>
            ))}
          </div>
        </div>
      ) : null}
      {instance.status === "in_progress" ? (
        <div className="mt-2 text-[12px] text-[#2F7D4A]">Agent 已收到，正在继续执行。</div>
      ) : null}
    </div>
  );
}

function dedupeKeepOrder(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

const GENERIC_CONTEXT_OPTIONS = new Set([
  "补充具体信息",
  "补充缺失信息",
  "补充约束或偏好",
  "说明暂时无法提供",
  "填写其他信息",
  "补充更多信息",
  "需要更多信息后再决定",
  "需要更多时间考虑",
]);

function normalizeSpecificOptions(values: string[]) {
  const options = dedupeKeepOrder(values)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const specificOptions = options.filter((item) => !GENERIC_CONTEXT_OPTIONS.has(item));
  return specificOptions.slice(0, 3);
}

function pickThreeOptions(values: string[]) {
  return normalizeSpecificOptions(values);
}

function optionTextForSubmit(option: string, instance: TaskInstance, item?: ReadinessItem) {
  if (item) return `${item.label}：${option}`;
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "confirm" && option === "确认继续") return "我确认当前结果，可以继续。";
  if (type === "confirm" && option === "需要修改") return "当前结果需要修改，请根据我的补充意见继续。";
  return option;
}

function extractFeedbackFields(feedback: string) {
  return Object.fromEntries(
    feedback
      .split("\n")
      .map((line) => line.trim().match(/^([^：:\n]{1,40})[:：]\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
}

function isTaskReadiness(value: unknown): value is TaskReadiness {
  if (!value || typeof value !== "object") return false;
  const record = value as { status?: unknown; summary?: unknown; items?: unknown };
  return (
    (record.status === "ready" || record.status === "blocked") &&
    typeof record.summary === "string" &&
    Array.isArray(record.items)
  );
}

function readinessFromInstance(instance: TaskInstance) {
  const readiness = instance.result?.structuredOutput?.taskReadiness;
  return isTaskReadiness(readiness) ? readiness : null;
}

function missingItemsFrom(readiness: TaskReadiness | null) {
  return readiness?.items.filter((item) => item.status === "missing_user" && item.source === "user") ?? [];
}

function defaultOptionsForMissingItem(item: ReadinessItem) {
  if (item.options?.length) return item.options.slice(0, 3);
  const text = `${item.label} ${item.description} ${item.reason}`;
  if (/住宿区域.*酒店类型|酒店类型.*住宿区域|住宿偏好|住哪/.test(text)) {
    return ["海滩区 + 度假酒店", "市中心 + 高性价比酒店", "度假区/珍珠岛 + 一站式酒店"];
  }
  if (/住宿区域|酒店区域|住哪/.test(text)) return ["海滩区", "市中心", "度假区/珍珠岛"];
  if (/酒店类型|酒店档次|酒店偏好|酒店星级|房型/.test(text)) return ["高性价比经济型", "舒适型四星", "度假型五星/海景"];
  if (/城市|出发地|目的地/.test(text)) return ["上海", "广州", "北京"];
  if (/日期|时间/.test(text)) return ["周末短途（2-3天）", "工作日错峰（更便宜）", "节假日出行（需早订）"];
  if (/预算|费用|价格/.test(text)) return ["经济优先（少花钱）", "性价比优先（均衡）", "舒适优先（体验好）"];
  return [];
}

export function AwaitingUserResumePanel({
  task,
  instance,
  onRunning,
}: {
  task: Task;
  instance: TaskInstance;
  onRunning?: () => void;
}) {
  const syncTaskInstanceRun = useGoalStore((state) => state.syncTaskInstanceRun);
  const [selectedOption, setSelectedOption] = useState("");
  const [selectedItemOptions, setSelectedItemOptions] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState("");
  const [customFields, setCustomFields] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState(false);
  const [customItemModes, setCustomItemModes] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<"approve" | "revise" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocker = instance.awaitingUser?.blocker ?? instance.blocker;
  const requirement = instance.awaitingUser?.interactionRequirement;
  const readiness = readinessFromInstance(instance);
  const missingItems = useMemo(() => missingItemsFrom(readiness), [readiness]);
  const type = requirement?.type;
  const showReviseButton = type === "confirm";
  const options = useMemo(() => {
    if (missingItems.length > 0) return [];
    const raw = requirement?.options?.length ? requirement.options : defaultOptionsFor(instance);
    return pickThreeOptions(raw);
  }, [instance, missingItems.length, requirement?.options]);

  const suggestedOptions = useMemo(() => {
    const raw = [
      ...(requirement?.options ?? []),
      ...(instance.awaitingUser?.suggestedActions ?? []),
    ];
    return pickThreeOptions(raw);
  }, [instance.awaitingUser?.suggestedActions, requirement?.options]);

  const optionsForMissingItem = (item: ReadinessItem) => {
    const itemOptions = item.options?.length ? pickThreeOptions(item.options) : [];
    if (itemOptions.length) return itemOptions;
    if (suggestedOptions.length) return suggestedOptions;
    return pickThreeOptions(defaultOptionsForMissingItem(item));
  };

  const chooseOption = (option: string, item?: ReadinessItem) => {
    setError(null);
    if (item) {
      setSelectedItemOptions((current) => ({ ...current, [item.id]: option }));
      setCustomItemModes((current) => ({ ...current, [item.id]: false }));
      return;
    }
    setSelectedOption(option);
    setCustomMode(false);
  };

  const chooseCustom = (item?: ReadinessItem) => {
    setError(null);
    if (item) {
      setCustomItemModes((current) => ({ ...current, [item.id]: true }));
      return;
    }
    setCustomMode(true);
  };

  const updateCustomValue = (value: string, item?: ReadinessItem) => {
    setError(null);
    if (item) {
      setCustomItemModes((current) => ({ ...current, [item.id]: true }));
      setCustomFields((current) => ({ ...current, [item.id]: value }));
      return;
    }
    setCustomMode(true);
    setCustomText(value);
  };

  const feedbackValueForItem = (item: ReadinessItem) => {
    if (customItemModes[item.id]) return customFields[item.id]?.trim() ?? "";
    return selectedItemOptions[item.id]?.trim() ?? "";
  };

  const buildFeedback = () => {
    if (missingItems.length > 0) {
      return missingItems
        .map((item) => {
          const value = feedbackValueForItem(item);
          return value ? `${item.label}：${value}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (customMode) return customText.trim();
    return selectedOption ? optionTextForSubmit(selectedOption, instance).trim() : "";
  };

  const submit = async (approved: boolean) => {
    if (!blocker) return;
    const normalizedFeedback = buildFeedback();
    if ((type === "answer" || type === "provide_context" || customMode) && !normalizedFeedback) {
      setError("请先选择一个选项，或填写你要补充的信息。");
      return;
    }
    const feedbackFields = extractFeedbackFields(normalizedFeedback);
    if (missingItems.length > 0) {
      const unresolvedItems = missingItems.filter((item) => !feedbackValueForItem(item));
      if (unresolvedItems.length) {
        setError(`请在本次提交中补全：${unresolvedItems.map((item) => item.label).join("、")}。`);
        return;
      }
    }
    setPending(approved ? "approve" : "revise");
    setError(null);
    try {
      const state = await resumeTaskRun({
        taskInstanceId: instance.id,
        resumeToken: blocker.resumeToken,
        approved,
        feedback: normalizedFeedback,
        action: approved ? primaryLabelFor(instance) : "让 KiKi 修改后继续",
        fields: feedbackFields,
      });
      syncTaskInstanceRun({
        taskId: task.id,
        instanceId: instance.id,
        progress: state.progress,
        logs: state.logs,
        trajectory: state.trajectory,
        waitingReason: state.waitingReason,
      });
      setSelectedOption("");
      setSelectedItemOptions({});
      setCustomText("");
      setCustomFields({});
      setCustomMode(false);
      setCustomItemModes({});
      if (state.progress?.status === "running") onRunning?.();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "任务恢复失败");
    } finally {
      setPending(null);
    }
  };

  if (!instance.awaitingUser) return null;

  const headline =
    requirement?.question?.trim() ||
    (missingItems.length === 1
      ? `请补充：${missingItems[0].label}`
      : missingItems.length > 1
        ? `请补充：${missingItems.map((item) => item.label).join("、")}`
        : instance.awaitingUser.reason);

  return (
    <div className="rounded-xl border border-[#F5D58B] bg-[#FFF9E8] p-4 text-[13px] leading-6 text-[#6E5A16]">
      <div className="font-medium text-[#8A6D3B]">{titleFor(instance)}</div>
      <div className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-[13px] leading-6 text-[#1F2328]">{headline}</div>
      {missingItems.length ? (
        <div className="mt-3 space-y-3">
          {missingItems.map((item) => {
            const itemOptions = optionsForMissingItem(item);
            return (
              <div key={item.id} className="rounded-lg bg-white/60 px-3 py-3">
                <div className="text-[12px] font-medium text-[#8A6D3B]">请选择{item.label}</div>
                <div className="mt-2 space-y-2">
                  {itemOptions.map((option) => {
                    const selected = selectedItemOptions[item.id] === option && !customItemModes[item.id];
                    return (
                      <button
                        key={`${item.id}-${option}`}
                        type="button"
                        onClick={() => chooseOption(option, item)}
                        className="flex w-full items-center gap-2 py-1 text-left text-[13px] text-[#1F2328] hover:text-[#8A6D3B]"
                      >
                        <span
                          className={
                            selected
                              ? "h-2 w-2 rounded-full bg-[#8A6D3B]"
                              : "h-2 w-2 rounded-full bg-[#D8C995]"
                          }
                        />
                        <span className={selected ? "font-medium" : ""}>{option}</span>
                      </button>
                    );
                  })}
                  <div className="flex items-center gap-2 py-1">
                    <button
                      type="button"
                      onClick={() => chooseCustom(item)}
                      className="shrink-0 text-left text-[13px] text-[#6E5A16] hover:text-[#8A6D3B]"
                    >
                      都不是，我自己描述
                    </button>
                    <input
                      value={customFields[item.id] ?? ""}
                      onFocus={() => chooseCustom(item)}
                      onChange={(event) => updateCustomValue(event.target.value, item)}
                      placeholder={`输入${item.label}`}
                      className="min-w-0 flex-1 border-b border-[#E5D7A8] bg-transparent px-1 py-1 text-[13px] text-[#1F2328] outline-none placeholder:text-[#B7A66A] focus:border-[#8A6D3B]"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3">
          <div className="mt-2 space-y-2">
            {options.map((option) => {
              const selected = selectedOption === option && !customMode;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => chooseOption(option)}
                  className="flex w-full items-center gap-2 py-1 text-left text-[13px] text-[#1F2328] hover:text-[#8A6D3B]"
                >
                  <span
                    className={
                      selected
                        ? "h-2 w-2 rounded-full bg-[#8A6D3B]"
                        : "h-2 w-2 rounded-full bg-[#D8C995]"
                    }
                  />
                  <span className={selected ? "font-medium" : ""}>{option}</span>
                </button>
              );
            })}
            <div className="flex items-center gap-2 py-1">
              <button
                type="button"
                onClick={() => chooseCustom()}
                className="shrink-0 text-left text-[13px] text-[#6E5A16] hover:text-[#8A6D3B]"
              >
                都不是，我自己描述
              </button>
              <input
                value={customMode && missingItems.length === 0 ? customText : ""}
                onFocus={() => chooseCustom()}
                onChange={(event) => updateCustomValue(event.target.value)}
                placeholder="请输入你的选择"
                className="min-w-0 flex-1 border-b border-[#E5D7A8] bg-transparent px-1 py-1 text-[13px] text-[#1F2328] outline-none placeholder:text-[#B7A66A] focus:border-[#8A6D3B]"
              />
            </div>
          </div>
        </div>
      )}
      {blocker ? (
        <div className="mt-4 space-y-3">
          {error ? <div className="text-[12px] text-[#B42318]">{error}</div> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void submit(true)}
              className="rounded-md bg-[#111] px-4 py-2 text-[12px] font-medium text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === "approve" ? "提交中..." : primaryLabelFor(instance)}
            </button>
            {showReviseButton ? (
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() => void submit(false)}
                className="rounded-md border border-[#D0D7DE] bg-white px-4 py-2 text-[12px] font-medium text-[#1F2328] hover:border-[#111] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending === "revise" ? "提交中..." : "让 KiKi 修改后继续"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
