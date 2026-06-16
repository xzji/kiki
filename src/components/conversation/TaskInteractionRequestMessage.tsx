"use client";

import { ChangeEvent, useRef, useState } from "react";

import { respondGoalInstance } from "@/lib/api/goal-commands";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { questionForField } from "@/lib/taskInstance/awaitingDisplayModel";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import type { ConversationMessage, InteractionRequirement, InteractionSubmission, MissingFieldQuestion } from "@/types/kiki";

type UploadedAttachment = {
  name: string;
  url: string;
  size: number;
  type?: string;
};

type Props = {
  conversationId: string;
  message: Extract<ConversationMessage, { kind: "task_interaction_request" }>;
  onOpen?: () => void;
};

function submittedStatusLabel(status: InteractionSubmission["status"]) {
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

function submittedDetails(submission: InteractionSubmission) {
  const fieldEntries = Object.entries(submission.fields ?? {})
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value}`);
  if (fieldEntries.length) return fieldEntries;
  return [submission.feedback || submission.action].filter(Boolean);
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

function isActionLikeOption(option: string) {
  return /^(确认继续|需要修改|重新执行任务|调整任务完成标准|让\s*KiKi\s*修改后继续|提交答案并继续|提交信息并继续|我已完成，继续执行|确认并继续)$/.test(option.trim());
}

function pickFieldAnswerOptions(values: string[] | undefined) {
  return dedupeKeepOrder(values ?? [])
    .filter((item) => item.length >= 2)
    .filter((option) => !isActionLikeOption(option))
    .slice(0, 3);
}

function pickOptions(values: string[] | undefined) {
  return dedupeKeepOrder(values ?? [])
    .filter((item) => item.length >= 2)
    .slice(0, 3);
}

function optionTextForSubmit(option: string, requirementType: InteractionRequirement["type"], item?: Pick<MissingFieldQuestion, "label">) {
  if (item) return `${item.label}：${option}`;
  if (requirementType === "confirm" && option === "确认继续") return "我确认当前结果，可以继续。";
  if (requirementType === "confirm" && option === "需要修改") return "当前结果需要修改，请根据我的补充意见继续。";
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

function submittedPanel(submission: InteractionSubmission, pending: boolean) {
  const details = submittedDetails(submission);
  return (
    <div className="max-w-[720px] text-[13px] leading-6 text-[#374151]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[#1F2328]">{submittedStatusLabel(submission.status)}</span>
        <span className="text-[12px] text-[#8C9198]">{formatSubmittedAt(submission.submittedAt)}</span>
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
      {pending ? <div className="mt-2 text-[12px] text-[#8C9198]">KiKi 已收到，正在继续执行。</div> : null}
    </div>
  );
}

export function TaskInteractionRequestMessage({ conversationId, message, onOpen }: Props) {
  const updateMessage = useConversationStore((state) => state.updateMessage);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const snapshot = message.interactionSnapshot;
  const [selectedOption, setSelectedOption] = useState("");
  const [selectedItemOptions, setSelectedItemOptions] = useState<Record<string, string>>({});
  const [selectedItemFiles, setSelectedItemFiles] = useState<Record<string, UploadedAttachment[]>>({});
  const [customText, setCustomText] = useState("");
  const [customFields, setCustomFields] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState(false);
  const [customItemModes, setCustomItemModes] = useState<Record<string, boolean>>({});
  const [optimisticSubmission, setOptimisticSubmission] = useState<InteractionSubmission | null>(null);
  const [pending, setPending] = useState<"approve" | "revise" | null>(null);
  const [uploadingFieldId, setUploadingFieldId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const submitted = snapshot.submitted ?? optimisticSubmission;
  const promptFields = snapshot.fields;
  const hiddenQuestions = new Set(snapshot.hideFieldQuestions);
  const showReviseButton = snapshot.requirementType === "confirm";

  const chooseOption = (option: string, item?: MissingFieldQuestion) => {
    setError(null);
    if (item) {
      setSelectedItemOptions((current) => ({ ...current, [item.id]: option }));
      setCustomItemModes((current) => ({ ...current, [item.id]: false }));
      setSelectedItemFiles((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setCustomFields((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    setSelectedOption(option);
    setCustomMode(false);
  };

  const chooseCustom = (item?: MissingFieldQuestion) => {
    setError(null);
    if (item) {
      setCustomItemModes((current) => ({ ...current, [item.id]: true }));
      setSelectedItemOptions((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSelectedItemFiles((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    setCustomMode(true);
  };

  const updateCustomValue = (value: string, item?: MissingFieldQuestion) => {
    setError(null);
    if (item) {
      setCustomItemModes((current) => ({ ...current, [item.id]: true }));
      setCustomFields((current) => ({ ...current, [item.id]: value }));
      setSelectedItemOptions((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSelectedItemFiles((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    setCustomMode(true);
    setCustomText(value);
  };

  const feedbackValueForItem = (item: MissingFieldQuestion) => {
    const files = selectedItemFiles[item.id] ?? [];
    if (files.length) {
      const fileLabel = item.inputKind === "file" ? "已选择文件" : "已选择截图";
      return `${fileLabel}：${files.map((file) => `${file.name}（${file.url}）`).join("、")}`;
    }
    if (customItemModes[item.id]) return customFields[item.id]?.trim() ?? "";
    return selectedItemOptions[item.id]?.trim() ?? "";
  };

  const uploadAttachment = async (file: File): Promise<UploadedAttachment> => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`/api/goals/instances/${encodeURIComponent(message.taskRef.instanceId)}/attachments`, {
      method: "POST",
      body: formData,
    });
    const payload = (await response.json().catch(() => null)) as
      | { attachment?: UploadedAttachment; reason?: string }
      | null;
    if (!response.ok || !payload?.attachment) {
      throw new Error(payload?.reason || "附件上传失败");
    }
    return payload.attachment;
  };

  const chooseFiles = async (item: MissingFieldQuestion, event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setUploadingFieldId(item.id);
    try {
      const uploadedFiles = await Promise.all(files.map(uploadAttachment));
      setError(null);
      setSelectedItemFiles((current) => ({ ...current, [item.id]: uploadedFiles }));
      setCustomItemModes((current) => ({ ...current, [item.id]: false }));
      setSelectedItemOptions((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setCustomFields((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "附件上传失败");
    } finally {
      setUploadingFieldId(null);
    }
  };

  const buildFeedback = () => {
    if (promptFields.length > 0) {
      return promptFields
        .map((item) => {
          const value = feedbackValueForItem(item);
          return value ? `${item.label}：${value}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (customMode) return customText.trim();
    return selectedOption ? optionTextForSubmit(selectedOption, snapshot.requirementType).trim() : "";
  };

  const submit = async (approved: boolean) => {
    if (uploadingFieldId) {
      setError("附件仍在上传中，请上传完成后再提交。");
      return;
    }
    const normalizedFeedback = buildFeedback();
    if ((snapshot.requirementType === "answer" || snapshot.requirementType === "provide_context" || customMode) && !normalizedFeedback) {
      setError("请先选择一个选项，或填写你要补充的信息。");
      return;
    }
    if (promptFields.length > 0) {
      const unresolvedItems = promptFields.filter((item) => !feedbackValueForItem(item));
      if (unresolvedItems.length) {
        setError(`请在本次提交中补全：${unresolvedItems.map((item) => item.label).join("、")}。`);
        return;
      }
    }
    const fields = extractFeedbackFields(normalizedFeedback);
    const submission: InteractionSubmission = {
      type: snapshot.requirementType,
      status: approved === false ? "rejected" : "submitted",
      action: approved === false ? "要求修改" : "提交反馈",
      approved,
      feedback: normalizedFeedback,
      fields,
      submittedAt: new Date().toISOString(),
    };
    setPending(approved ? "approve" : "revise");
    setOptimisticSubmission(submission);
    setError(null);
    try {
      const response = await respondGoalInstance({
        instanceId: message.taskRef.instanceId,
        responseId: snapshot.resumeToken,
        responseSummary: normalizedFeedback,
        approved,
        fields,
      });
      updateMessage(conversationId, message.id, (current) =>
        current.kind === "task_interaction_request"
          ? {
              ...current,
              interactionSnapshot: {
                ...current.interactionSnapshot,
                submitted: submission,
              },
            }
          : current,
      );
      if (response.resumed) {
        const runtimeSnapshot = await fetchRuntimeStateSnapshot().catch(() => null);
        if (runtimeSnapshot) applyGoalsProjection(runtimeSnapshot.goals, runtimeSnapshot.meta?.revisions?.goals);
      }
    } catch (submitError) {
      setOptimisticSubmission(null);
      setError(submitError instanceof Error ? submitError.message : "任务恢复失败");
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="mt-3 w-full cursor-pointer rounded-[20px] border border-[#D0D7DE] bg-white p-6 text-left transition hover:border-[#111] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#D0D7DE]"
    >
      <div className="text-[15px] font-semibold text-[#1F2328]">{snapshot.panelTitle}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
        <span>Agent 任务</span>
        <span className="text-[#D0D7DE]">/</span>
        <span>{submitted ? "已提交" : snapshot.statusLabel}</span>
      </div>
      <div className="mt-4 text-[14px] leading-6 text-[#374151]">{snapshot.headline || snapshot.reason}</div>
      <div className="mt-4" onClick={(event) => event.stopPropagation()}>
        {submitted ? (
          submittedPanel(submitted, Boolean(pending))
        ) : (
          <div className="max-w-[720px] text-[13px] leading-6 text-[#374151]">
            {promptFields.length ? (
              <div className="space-y-3">
                {promptFields.map((item, index) => {
                  const itemOptions = pickFieldAnswerOptions(item.options);
                  const customSelected = Boolean(customItemModes[item.id]);
                  const selectedFiles = selectedItemFiles[item.id] ?? [];
                  const hideItemQuestion = hiddenQuestions.has(item.id);
                  const canUpload = item.inputKind === "image" || item.inputKind === "file" || item.inputKind === "image_or_text";
                  const allowsTextInput = item.inputKind !== "image" && item.inputKind !== "file";
                  return (
                    <div key={item.id}>
                      {hideItemQuestion ? null : (
                        <div>
                          <div className="text-[13px] font-semibold text-[#1F2328]">
                            {index + 1}. {item.label.trim() || questionForField(item)}
                          </div>
                          {item.description ? (
                            <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{item.description}</div>
                          ) : null}
                        </div>
                      )}
                      <div className={`${hideItemQuestion ? "" : "mt-2"} space-y-1.5`}>
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
                        {canUpload ? (
                          <div className="flex flex-wrap items-center gap-2 py-1">
                            <input
                              ref={(node) => {
                                fileInputRefs.current[item.id] = node;
                              }}
                              type="file"
                              accept={item.inputKind === "image" || item.inputKind === "image_or_text" ? "image/*" : undefined}
                              multiple
                              className="hidden"
                              onChange={(event) => void chooseFiles(item, event)}
                            />
                            <button
                              type="button"
                              disabled={uploadingFieldId === item.id}
                              onClick={() => fileInputRefs.current[item.id]?.click()}
                              className="rounded-lg border border-[#D0D7DE] px-3 py-1.5 text-[12px] font-medium text-[#374151] transition hover:border-[#1F2328] hover:text-[#1F2328] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {uploadingFieldId === item.id ? "上传中..." : item.inputKind === "file" ? "上传文件" : "上传截图"}
                            </button>
                            {selectedFiles.length ? (
                              <span className="min-w-0 truncate text-[12px] text-[#57606A]">
                                已上传：{selectedFiles.map((file) => file.name).join("、")}
                              </span>
                            ) : (
                              <span className="text-[12px] text-[#8C9198]">
                                {item.inputKind === "image_or_text" ? "也可以直接填写文字记录" : "请先上传后再提交"}
                              </span>
                            )}
                          </div>
                        ) : null}
                        {allowsTextInput ? (
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
                            <button type="button" onClick={() => chooseCustom(item)} className="shrink-0 text-left text-[13px] text-inherit">
                              {itemOptions.length ? "都不是，我自己描述" : "我来填写"}
                            </button>
                            <input
                              value={customFields[item.id] ?? ""}
                              onFocus={() => chooseCustom(item)}
                              onChange={(event) => updateCustomValue(event.target.value, item)}
                              placeholder={item.inputPlaceholder?.trim() || `输入${item.label}`}
                              className="min-w-0 border-b border-[#D0D7DE] bg-transparent px-1 py-1 text-[13px] font-normal text-[#1F2933] outline-none placeholder:text-[#8C9198] focus:border-[#1F2328]"
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {pickOptions(snapshot.options).map((option) => {
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
                  <button type="button" onClick={() => chooseCustom()} className="shrink-0 text-left text-[13px] text-inherit">
                    {pickOptions(snapshot.options).length ? "都不是，我自己描述" : "我来填写"}
                  </button>
                  <input
                    value={customMode ? customText : ""}
                    onFocus={() => chooseCustom()}
                    onChange={(event) => updateCustomValue(event.target.value)}
                    placeholder={pickOptions(snapshot.options).length ? "请输入你的选择" : "请输入需要补充的信息"}
                    className="min-w-0 border-b border-[#D0D7DE] bg-transparent px-1 py-1 text-[13px] font-normal text-[#1F2933] outline-none placeholder:text-[#8C9198] focus:border-[#1F2328]"
                  />
                </div>
              </div>
            )}
            <div className="mt-5 space-y-3">
              {error ? <div className="text-[12px] text-[#B42318]">{error}</div> : null}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={Boolean(pending) || Boolean(uploadingFieldId)}
                  onClick={() => void submit(true)}
                  className="rounded-lg bg-[#111] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-[#2B2B2B] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending === "approve" ? "提交中..." : uploadingFieldId ? "上传中..." : "提交信息并继续"}
                </button>
                {showReviseButton ? (
                  <button
                    type="button"
                    disabled={Boolean(pending) || Boolean(uploadingFieldId)}
                    onClick={() => void submit(false)}
                    className="bg-transparent px-0 py-2 text-[13px] text-[#6B7280] hover:text-[#1F2933] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending === "revise" ? "提交中..." : "让 KiKi 修改后继续"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
