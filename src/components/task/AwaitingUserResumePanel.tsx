"use client";

import { useMemo, useState } from "react";

import { respondGoalInstance } from "@/lib/api/goal-commands";
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
  optionQuestion?: string;
  inputPlaceholder?: string;
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

export function SubmittedInteractionPanel({ instance }: { instance: TaskInstance }) {
  const submission = instance.result?.interactionSubmission;
  if (!submission || instance.awaitingUser) return null;
  const details = submittedDetails(instance);
  return (
    <div className="max-w-[720px] text-[13px] leading-6 text-[#374151]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[#1F2328]">{submittedStatusLabel(submission.status)}</span>
        <span className="text-[12px] text-[#8C9198]">
          {formatSubmittedAt(submission.submittedAt)}
        </span>
      </div>
      {details.length ? (
        <div className="mt-2 text-[#1F2328]">
          <div className="text-[12px] text-[#57606A]">已提交的信息</div>
          <div className="mt-1 space-y-1">
            {details.map((detail) => (
              <div key={detail}>{detail}</div>
            ))}
          </div>
        </div>
      ) : null}
      {instance.status === "in_progress" ? (
        <div className="mt-2 text-[12px] text-[#8C9198]">KiKi 已收到，正在继续执行。</div>
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

function normalizeSpecificOptions(values: string[]) {
  return dedupeKeepOrder(values)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 3);
}

function pickThreeOptions(values: string[]) {
  return normalizeSpecificOptions(values);
}

function isActionLikeOption(option: string) {
  return /^(确认继续|需要修改|重新执行任务|调整任务完成标准|让\s*KiKi\s*修改后继续|提交答案并继续|提交信息并继续|我已完成，继续执行|确认并继续)$/.test(option.trim());
}

function pickFieldAnswerOptions(values: string[]) {
  return pickThreeOptions(values.filter((option) => !isActionLikeOption(option)));
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

function optionRowClass(selected: boolean) {
  return [
    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-0 py-2 text-left text-[13px] transition",
    selected ? "font-semibold text-[#1F2933]" : "text-[#4B5563] hover:text-[#1F2933]",
  ].join(" ");
}

function optionDotClass(selected: boolean) {
  return [
    "h-2 w-2 shrink-0 rounded-full transition",
    selected ? "bg-[#64748B] ring-4 ring-[#EEF0F3]" : "bg-[#D0D7DE] ring-4 ring-transparent",
  ].join(" ");
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
  const resolveTaskInstanceAwaitingUser = useGoalStore((state) => state.resolveTaskInstanceAwaitingUser);
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
    const raw = requirement?.options?.length ? requirement.options : [];
    return pickThreeOptions(raw);
  }, [missingItems.length, requirement?.options]);
  const requirementFieldOptions = useMemo(() => {
    const raw = requirement?.options?.length ? requirement.options : [];
    return pickFieldAnswerOptions(raw);
  }, [requirement?.options]);

  const optionsForMissingItem = (item: ReadinessItem) => {
    if (missingItems.length === 1 && requirementFieldOptions.length > 0) return requirementFieldOptions;
    return item.options?.length ? pickThreeOptions(item.options) : [];
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
      const action = approved ? primaryLabelFor(instance) : "让 KiKi 修改后继续";
      const response = await respondGoalInstance({
        instanceId: instance.id,
        responseId: blocker.resumeToken,
        responseSummary: normalizedFeedback,
        approved,
        fields: feedbackFields,
      });
      resolveTaskInstanceAwaitingUser(task.id, instance.id, {
        type: requirement?.type ?? "confirm",
        status: approved ? "submitted" : "rejected",
        action,
        approved,
        feedback: normalizedFeedback || "用户已提交反馈，请继续执行。",
        fields: feedbackFields,
        submittedAt: new Date().toISOString(),
      });
      setSelectedOption("");
      setSelectedItemOptions({});
      setCustomText("");
      setCustomFields({});
      setCustomMode(false);
      setCustomItemModes({});
      if (response.resumed) onRunning?.();
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
    <div className="max-w-[720px] text-[13px] leading-6 text-[#374151]">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[#1F2328]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#8C9198]" />
        <span>{titleFor(instance)}</span>
      </div>
      <div className="mt-4 text-[14px] leading-6 text-[#374151]">{headline}</div>
      {missingItems.length ? (
        <div className="mt-3 space-y-3">
          {missingItems.map((item) => {
            const itemOptions = optionsForMissingItem(item);
            const customSelected = Boolean(customItemModes[item.id]);
            return (
              <div key={item.id}>
                <div className="text-[12px] font-medium text-[#6B7280]">{item.optionQuestion?.trim() || `请选择${item.label}`}</div>
                <div className="mt-2 space-y-1.5">
                  {itemOptions.map((option) => {
                    const selected = selectedItemOptions[item.id] === option && !customItemModes[item.id];
                    return (
                      <button
                        key={`${item.id}-${option}`}
                        type="button"
                        onClick={() => chooseOption(option, item)}
                        className={optionRowClass(selected)}
                      >
                        <span className={optionDotClass(selected)} />
                        <span>{option}</span>
                      </button>
                    );
                  })}
                  <div
                    role="radio"
                    aria-checked={customSelected}
                    tabIndex={0}
                    onClick={() => chooseCustom(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        chooseCustom(item);
                      }
                    }}
                    className={`${optionRowClass(customSelected)} grid cursor-pointer grid-cols-[8px_auto_minmax(0,1fr)]`}
                  >
                    <span className={optionDotClass(customSelected)} />
                    <button
                      type="button"
                      onClick={() => chooseCustom(item)}
                      className="shrink-0 text-left text-[13px] text-inherit"
                    >
                      都不是，我自己描述
                    </button>
                    <input
                      value={customFields[item.id] ?? ""}
                      onFocus={() => chooseCustom(item)}
                      onChange={(event) => updateCustomValue(event.target.value, item)}
                      placeholder={item.inputPlaceholder?.trim() || `输入${item.label}`}
                      className="min-w-0 border-b border-[#D0D7DE] bg-transparent px-1 py-1 text-[13px] font-normal text-[#1F2933] outline-none placeholder:text-[#8C9198] focus:border-[#1F2328]"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3">
          <div className="space-y-1.5">
            {options.map((option) => {
              const selected = selectedOption === option && !customMode;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => chooseOption(option)}
                  className={optionRowClass(selected)}
                >
                  <span className={optionDotClass(selected)} />
                  <span>{option}</span>
                </button>
              );
            })}
            <div
              role="radio"
              aria-checked={customMode}
              tabIndex={0}
              onClick={() => chooseCustom()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  chooseCustom();
                }
              }}
              className={`${optionRowClass(customMode)} grid cursor-pointer grid-cols-[8px_auto_minmax(0,1fr)]`}
            >
              <span className={optionDotClass(customMode)} />
              <button
                type="button"
                onClick={() => chooseCustom()}
                className="shrink-0 text-left text-[13px] text-inherit"
              >
                都不是，我自己描述
              </button>
              <input
                value={customMode && missingItems.length === 0 ? customText : ""}
                onFocus={() => chooseCustom()}
                onChange={(event) => updateCustomValue(event.target.value)}
                placeholder={options.length ? "请输入你的选择" : "请输入需要补充的信息"}
                className="min-w-0 border-b border-[#D0D7DE] bg-transparent px-1 py-1 text-[13px] font-normal text-[#1F2933] outline-none placeholder:text-[#8C9198] focus:border-[#1F2328]"
              />
            </div>
          </div>
        </div>
      )}
      {blocker ? (
        <div className="mt-5 space-y-3">
          {error ? <div className="text-[12px] text-[#B42318]">{error}</div> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void submit(true)}
              className="rounded-lg bg-[#111] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-[#2B2B2B] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === "approve" ? "提交中..." : primaryLabelFor(instance)}
            </button>
            {showReviseButton ? (
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() => void submit(false)}
                className="bg-transparent px-0 py-2 text-[13px] text-[#6B7280] hover:text-[#1F2933] disabled:cursor-not-allowed disabled:opacity-50"
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
