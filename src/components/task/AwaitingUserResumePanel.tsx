"use client";

import { useMemo, useRef, useState } from "react";

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

function placeholderFor(instance: TaskInstance, missingItems: ReadinessItem[]) {
  if (missingItems.length === 1) return `请输入${missingItems[0].label}`;
  if (missingItems.length > 1) return `请补充：${missingItems.map((item) => item.label).join("、")}`;
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "answer") return "请输入你的答案，KiKi 会基于答案继续执行";
  if (type === "provide_context") return "补充必要背景、约束、偏好或资料链接";
  if (type === "perform_offline_action") return "说明你已完成的线下动作或执行结果";
  return "可选：补充确认意见或修改建议";
}

function primaryLabelFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "answer") return "提交答案并继续";
  if (type === "provide_context") return "提交信息并继续";
  if (type === "perform_offline_action") return "我已完成，继续执行";
  return "确认并继续";
}

function defaultOptionsFor(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "answer") return ["提交我的答案", "需要重新出题", "先看提示"];
  if (type === "provide_context") return ["补充缺失信息", "补充约束或偏好", "说明暂时无法提供"];
  if (type === "perform_offline_action") return ["我已完成", "还没完成", "需要 KiKi 调整任务"];
  return ["确认继续", "需要修改", "补充更多信息"];
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

const GENERIC_CONTEXT_OPTIONS = new Set(["补充具体信息", "补充缺失信息", "补充约束或偏好", "说明暂时无法提供", "填写其他信息"]);

function normalizeSpecificOptions(values: string[]) {
  const options = dedupeKeepOrder(values).filter((item) => item.length >= 2 && item.length <= 24);
  const specificOptions = options.filter((item) => !GENERIC_CONTEXT_OPTIONS.has(item));
  return (specificOptions.length ? specificOptions : options).slice(0, 3);
}

function pickThreeOptions(values: string[]) {
  return normalizeSpecificOptions(values);
}

function optionTextForSubmit(option: string, instance: TaskInstance, item?: ReadinessItem) {
  if (item) return `${item.label}：${option}`;
  const type = instance.awaitingUser?.interactionRequirement?.type;
  if (type === "confirm" && option === "确认继续") return "我确认当前结果，可以继续。";
  if (type === "confirm" && option === "需要修改") return "当前结果需要修改，请根据我的补充意见继续。";
  if (type === "confirm" && option === "补充更多信息") return "我需要补充更多信息，请结合补充内容继续。";
  return option;
}

function mergeFieldFeedback(current: string, item: ReadinessItem, value: string) {
  const nextLine = `${item.label}：${value}`;
  const lines = current
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(`${item.label}：`));
  return [...lines, nextLine].join("\n");
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

function hasFeedbackForMissingItem(feedback: string, fields: Record<string, string>, item: ReadinessItem) {
  if (fields[item.label]?.trim()) return true;
  return feedback.includes(item.label) && feedback.length > item.label.length + 2;
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
  if (/日期|时间/.test(text)) return ["补充出发日期", "补充返回日期", "补充完整日期范围"];
  if (/预算|费用|价格/.test(text)) return ["控制预算", "舒适优先", "高性价比优先"];
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
  const [feedback, setFeedback] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [pending, setPending] = useState<"approve" | "revise" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    const raw = instance.awaitingUser?.suggestedActions ?? [];
    return pickThreeOptions(raw);
  }, [instance.awaitingUser?.suggestedActions]);

  const optionsForMissingItem = (item: ReadinessItem) => {
    if (item.options?.length) return pickThreeOptions(item.options);
    if (suggestedOptions.length) return suggestedOptions;
    return pickThreeOptions(defaultOptionsForMissingItem(item));
  };

  const chooseOption = (option: string, item?: ReadinessItem) => {
    setCustomMode(false);
    setError(null);
    setFeedback((current) => (item ? mergeFieldFeedback(current, item, option) : optionTextForSubmit(option, instance)));
  };

  const chooseCustom = (item?: ReadinessItem) => {
    setCustomMode(true);
    setFeedback((current) => (item ? mergeFieldFeedback(current, item, "") : ""));
    setError(null);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = async (approved: boolean) => {
    if (!blocker) return;
    const normalizedFeedback = feedback.trim();
    if ((type === "answer" || type === "provide_context" || customMode) && !normalizedFeedback) {
      setError("请先选择一个选项，或填写你要补充的信息。");
      return;
    }
    const feedbackFields = extractFeedbackFields(normalizedFeedback);
    if (missingItems.length > 1) {
      const unresolvedItems = missingItems.filter((item) => !hasFeedbackForMissingItem(normalizedFeedback, feedbackFields, item));
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
      setFeedback("");
      setCustomMode(false);
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
              <div key={item.id} className="rounded-lg border border-[#E5D7A8] bg-white/60 p-3">
                <div className="text-[12px] font-medium text-[#8A6D3B]">请选择{item.label}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {itemOptions.map((option) => {
                    const selected = feedback.split("\n").includes(optionTextForSubmit(option, instance, item)) && !customMode;
                    return (
                      <button
                        key={`${item.id}-${option}`}
                        type="button"
                        onClick={() => chooseOption(option, item)}
                        className={
                          selected
                            ? "rounded-full border border-[#8A6D3B] bg-[#8A6D3B] px-3 py-1 text-[12px] text-white"
                            : "rounded-full border border-[#E5D7A8] bg-white px-3 py-1 text-[12px] text-[#6E5A16] hover:border-[#8A6D3B]"
                        }
                      >
                        {option}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => chooseCustom(item)}
                    className={
                      customMode && feedback.startsWith(`${item.label}：`)
                        ? "rounded-full border border-[#8A6D3B] bg-[#8A6D3B] px-3 py-1 text-[12px] text-white"
                        : "rounded-full border border-dashed border-[#E5D7A8] bg-white px-3 py-1 text-[12px] text-[#6E5A16] hover:border-[#8A6D3B]"
                    }
                  >
                    都不是，自己填写
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3">
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((option) => {
              const selected = feedback === optionTextForSubmit(option, instance) && !customMode;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => chooseOption(option)}
                  className={
                    selected
                      ? "rounded-full border border-[#8A6D3B] bg-[#8A6D3B] px-3 py-1 text-[12px] text-white"
                      : "rounded-full border border-[#E5D7A8] bg-white px-3 py-1 text-[12px] text-[#6E5A16] hover:border-[#8A6D3B]"
                  }
                >
                  {option}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => chooseCustom()}
              className={
                customMode
                  ? "rounded-full border border-[#8A6D3B] bg-[#8A6D3B] px-3 py-1 text-[12px] text-white"
                  : "rounded-full border border-dashed border-[#E5D7A8] bg-white px-3 py-1 text-[12px] text-[#6E5A16] hover:border-[#8A6D3B]"
              }
            >
              都不是，自己填写
            </button>
          </div>
        </div>
      )}
      {blocker ? (
        <div className="mt-4 space-y-3">
          <textarea
            ref={textareaRef}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={type === "answer" || type === "provide_context" ? 4 : 3}
            placeholder={placeholderFor(instance, missingItems)}
            className="w-full resize-none rounded-lg border border-[#E5D7A8] bg-white px-3 py-2 text-[13px] leading-6 text-[#1F2328] outline-none focus:border-[#8A6D3B]"
          />
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
