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
  if (item.options?.length) return item.options;
  if (/城市|出发地|目的地/.test(item.label)) return ["上海", "广州", "北京", "深圳", "其他城市"];
  if (/日期|时间/.test(item.label)) return ["今天", "明天", "本周末", "指定日期"];
  if (/预算|费用|价格/.test(item.label)) return ["预算不限", "性价比优先", "补充预算上限"];
  return [`补充${item.label}`, "暂时无法提供"];
}

function readinessStatusLabel(item: ReadinessItem) {
  if (item.status === "missing_user") return "需要你提供";
  if (item.status === "agent_retrievable") return "KiKi 可获取";
  if (item.status === "available") return "已具备";
  return "不需要";
}

function readinessStatusClassName(item: ReadinessItem) {
  if (item.status === "missing_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (item.status === "agent_retrievable") return "bg-[#EEF6FF] text-[#0D47A1]";
  if (item.status === "available") return "bg-[#E8F5E9] text-[#25663A]";
  return "bg-[#F5F6F8] text-[#6B7280]";
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
    return Array.from(new Set(raw.map((item) => item.trim()).filter(Boolean))).slice(0, 5);
  }, [instance, missingItems.length, requirement?.options]);

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

  return (
    <div className="rounded-xl border border-[#F5D58B] bg-[#FFF9E8] p-4 text-[13px] leading-6 text-[#6E5A16]">
      <div className="font-medium text-[#8A6D3B]">{titleFor(instance)}</div>
      <div className="mt-2">{instance.awaitingUser.reason}</div>
      {requirement?.question ? (
        <div className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-[#1F2328]">{requirement.question}</div>
      ) : null}
      {readiness?.items.length ? (
        <div className="mt-3 rounded-lg border border-[#E5D7A8] bg-white/70 p-3">
          <div className="text-[12px] font-medium text-[#8A6D3B]">执行所需信息检查</div>
          <div className="mt-2 space-y-2">
            {readiness.items.map((item) => (
              <div key={item.id} className="rounded-lg bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-[#1F2328]">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${readinessStatusClassName(item)}`}>
                    {readinessStatusLabel(item)}
                  </span>
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{item.description}</div>
                {item.status === "missing_user" ? (
                  <div className="mt-1 text-[12px] leading-5 text-[#8A6D3B]">{item.reason}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {missingItems.length ? (
        <div className="mt-3 space-y-3">
          {missingItems.map((item) => {
            const itemOptions = defaultOptionsForMissingItem(item);
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
                    其他{item.label}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-[12px] font-medium text-[#8A6D3B]">请选择一个操作，或填写其他信息</div>
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
      {instance.awaitingUser.suggestedActions?.length ? (
        <div className="mt-2">建议操作：{instance.awaitingUser.suggestedActions.join(" / ")}</div>
      ) : null}
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
