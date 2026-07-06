"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";

import { respondGoalInstance } from "@/lib/api/goal-commands";
import { buildAwaitingDisplayModel, isSameDisplayText, questionForField } from "@/lib/taskInstance/awaitingDisplayModel";
import type { MissingFieldQuestion, Task, TaskInstance } from "@/types/kiki";

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
    <div className="max-w-[720px] text-[13px] leading-6 text-ink-strong">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{submittedStatusLabel(submission.status)}</span>
        <span className="text-[12px] text-ink-faint">
          {formatSubmittedAt(submission.submittedAt)}
        </span>
      </div>
      {details.length ? (
        <div className="mt-2 text-ink">
          <div className="text-[12px] text-ink-strong">已提交的信息</div>
          <div className="mt-1 space-y-1">
            {details.map((detail) => (
              <div key={detail}>{detail}</div>
            ))}
          </div>
        </div>
      ) : null}
      {instance.status === "in_progress" ? (
        <div className="mt-2 text-[12px] text-ink-faint">KiKi 已收到，正在继续执行。</div>
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

type PromptField = MissingFieldQuestion;

type UploadedAttachment = {
  name: string;
  url: string;
  size: number;
  type?: string;
};

function optionTextForSubmit(option: string, instance: TaskInstance, item?: Pick<PromptField, "label">) {
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

function optionRowClass(selected: boolean) {
  return [
    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-0 py-2 text-left text-[13px] transition",
    selected ? "font-semibold text-ink-strong" : "text-ink-strong hover:text-ink-strong",
  ].join(" ");
}

function optionDotClass(selected: boolean) {
  return [
    "h-2 w-2 shrink-0 rounded-full transition",
    selected ? "bg-ink-strong ring-4 ring-surface-subtle" : "bg-line-strong ring-4 ring-transparent",
  ].join(" ");
}

function fieldDescriptionFor(item: PromptField) {
  const title = item.label.trim();
  const candidates = [item.question, item.description]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return candidates.find((value) => !isSameDisplayText(value, title));
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
  const [selectedOption, setSelectedOption] = useState("");
  const [selectedItemOptions, setSelectedItemOptions] = useState<Record<string, string>>({});
  const [selectedItemFiles, setSelectedItemFiles] = useState<Record<string, UploadedAttachment[]>>({});
  const [customText, setCustomText] = useState("");
  const [customFields, setCustomFields] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState(false);
  const [customItemModes, setCustomItemModes] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<"approve" | "revise" | null>(null);
  const [uploadingFieldId, setUploadingFieldId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const blocker = instance.awaitingUser?.blocker ?? instance.blocker;
  const requirement = instance.awaitingUser?.interactionRequirement;
  const displayModel = useMemo(() => buildAwaitingDisplayModel(task, instance, "card"), [task, instance]);
  const promptFields = useMemo(
    () =>
      displayModel.fields.map((field) => ({
        ...field,
        options: field.inputKind === "image" || field.inputKind === "file" ? [] : pickFieldAnswerOptions(field.options ?? []),
      })),
    [displayModel.fields],
  );
  const type = requirement?.type;
  const showReviseButton = type === "confirm";
  const options = useMemo(() => {
    if (promptFields.length > 0) return [];
    const raw = requirement?.options?.length ? requirement.options : [];
    return pickThreeOptions(raw);
  }, [promptFields.length, requirement?.options]);

  const chooseOption = (option: string, item?: PromptField) => {
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

  const chooseCustom = (item?: PromptField) => {
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

  const updateCustomValue = (value: string, item?: PromptField) => {
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

  const feedbackValueForItem = (item: PromptField) => {
    const fileNames = selectedItemFiles[item.id] ?? [];
    if (fileNames.length) {
      const fileLabel = item.inputKind === "file" ? "已选择文件" : "已选择截图";
      return `${fileLabel}：${fileNames.map((file) => `${file.name}（${file.url}）`).join("、")}`;
    }
    if (customItemModes[item.id]) return customFields[item.id]?.trim() ?? "";
    return selectedItemOptions[item.id]?.trim() ?? "";
  };

  const allowsTextInput = (item: PromptField) =>
    item.inputKind !== "image" && item.inputKind !== "file";

  const uploadAttachment = async (file: File): Promise<UploadedAttachment> => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`/api/goals/instances/${encodeURIComponent(instance.id)}/attachments`, {
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

  const chooseFiles = async (item: PromptField, event: ChangeEvent<HTMLInputElement>) => {
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

  const fieldAcceptFor = (item: PromptField) => {
    if (item.inputKind === "image" || item.inputKind === "image_or_text") return "image/*";
    return undefined;
  };

  const shouldShowFilePicker = (item: PromptField) =>
    item.inputKind === "image" || item.inputKind === "file" || item.inputKind === "image_or_text";

  const customActionLabelFor = (item: PromptField, hasOptions: boolean) => {
    if (item.inputKind === "image_or_text") return "我来填写记录";
    return hasOptions ? "都不是，我自己描述" : "我来填写";
  };

  const inputPlaceholderFor = (item: PromptField) => {
    if (item.inputPlaceholder?.trim()) return item.inputPlaceholder.trim();
    if (item.inputKind === "image_or_text") return `无法上传时，填写${item.label}的文字记录`;
    return `输入${item.label}`;
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
    return selectedOption ? optionTextForSubmit(selectedOption, instance).trim() : "";
  };

  const submit = async (approved: boolean) => {
    if (!blocker) return;
    if (uploadingFieldId) {
      setError("附件仍在上传中，请上传完成后再提交。");
      return;
    }
    const normalizedFeedback = buildFeedback();
    if ((type === "answer" || type === "provide_context" || customMode) && !normalizedFeedback) {
      setError("请先选择一个选项，或填写你要补充的信息。");
      return;
    }
    const feedbackFields = extractFeedbackFields(normalizedFeedback);
    if (promptFields.length > 0) {
      const unresolvedItems = promptFields.filter((item) => !feedbackValueForItem(item));
      if (unresolvedItems.length) {
        setError(`请在本次提交中补全：${unresolvedItems.map((item) => item.label).join("、")}。`);
        return;
      }
    }
    setPending(approved ? "approve" : "revise");
    setError(null);
    try {
      const response = await respondGoalInstance({
        instanceId: instance.id,
        responseId: blocker.resumeToken,
        responseSummary: normalizedFeedback,
        approved,
        fields: feedbackFields,
      });
      setSelectedOption("");
      setSelectedItemOptions({});
      setSelectedItemFiles({});
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

  const headline = displayModel.headline || instance.awaitingUser.reason;

  return (
    <div className="max-w-[720px] text-[13px] leading-6 text-ink-strong">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
        <span>{displayModel.panelTitle}</span>
      </div>
      <div className="mt-4 text-[14px] leading-6 text-ink-strong">{headline}</div>
      {promptFields.length ? (
        <div className="mt-3 space-y-3">
          {promptFields.map((item, index) => {
            const itemOptions = pickFieldAnswerOptions(item.options);
            const customSelected = Boolean(customItemModes[item.id]);
            const selectedFiles = selectedItemFiles[item.id] ?? [];
            const itemTitle = item.label.trim() || questionForField(item);
            const itemDescription = fieldDescriptionFor(item);
            const hideItemQuestion = displayModel.hideFieldQuestions.has(item.id);
            return (
              <div key={item.id}>
                {hideItemQuestion ? null : (
                  <div>
                    <div className="text-[13px] font-semibold text-ink">
                      {index + 1}. {itemTitle}
                    </div>
                    {itemDescription ? (
                      <div className="mt-1 text-[12px] leading-5 text-ink-soft">{itemDescription}</div>
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
                  {shouldShowFilePicker(item) ? (
                    <div className="flex flex-wrap items-center gap-2 py-1">
                      <input
                        ref={(node) => {
                          fileInputRefs.current[item.id] = node;
                        }}
                        type="file"
                        accept={fieldAcceptFor(item)}
                        multiple
                        className="hidden"
                        onChange={(event) => void chooseFiles(item, event)}
                      />
                      <button
                        type="button"
                        disabled={uploadingFieldId === item.id}
                        onClick={() => fileInputRefs.current[item.id]?.click()}
                        className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink-strong transition hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {uploadingFieldId === item.id ? "上传中..." : item.inputKind === "file" ? "上传文件" : "上传截图"}
                      </button>
                      {selectedFiles.length ? (
                        <span className="min-w-0 truncate text-[12px] text-ink-strong">
                          已上传：{selectedFiles.map((file) => file.name).join("、")}
                        </span>
                      ) : (
                        <span className="text-[12px] text-ink-faint">
                          {item.inputKind === "image_or_text" ? "也可以直接填写文字记录" : "请先上传后再提交"}
                        </span>
                      )}
                    </div>
                  ) : null}
                  {allowsTextInput(item) ? (
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
                        className={`${optionRowClass(customSelected)} grid cursor-pointer grid-cols-[8px_minmax(0,1fr)] md:grid-cols-[8px_auto_minmax(0,1fr)]`}
                    >
                      <span className={optionDotClass(customSelected)} />
                      <button
                        type="button"
                        onClick={() => chooseCustom(item)}
                          className="text-left text-[13px] text-inherit md:shrink-0"
                      >
                        {customActionLabelFor(item, itemOptions.length > 0)}
                      </button>
                      <input
                        value={customFields[item.id] ?? ""}
                        onFocus={() => chooseCustom(item)}
                        onChange={(event) => updateCustomValue(event.target.value, item)}
                        placeholder={inputPlaceholderFor(item)}
                          className="col-start-2 min-w-0 border-b border-line-strong bg-transparent px-1 py-1 text-[13px] font-normal text-ink-strong outline-none placeholder:text-ink-faint focus:border-ink md:col-start-auto"
                      />
                    </div>
                  ) : null}
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
                className={`${optionRowClass(customMode)} grid cursor-pointer grid-cols-[8px_minmax(0,1fr)] md:grid-cols-[8px_auto_minmax(0,1fr)]`}
            >
              <span className={optionDotClass(customMode)} />
              <button
                type="button"
                onClick={() => chooseCustom()}
                  className="text-left text-[13px] text-inherit md:shrink-0"
              >
                {options.length ? "都不是，我自己描述" : "我来填写"}
              </button>
              <input
                value={customMode && promptFields.length === 0 ? customText : ""}
                onFocus={() => chooseCustom()}
                onChange={(event) => updateCustomValue(event.target.value)}
                placeholder={options.length ? "请输入你的选择" : "请输入需要补充的信息"}
                  className="col-start-2 min-w-0 border-b border-line-strong bg-transparent px-1 py-1 text-[13px] font-normal text-ink-strong outline-none placeholder:text-ink-faint focus:border-ink md:col-start-auto"
              />
            </div>
          </div>
        </div>
      )}
      {blocker ? (
        <div className="mt-5 space-y-3">
          {error ? <div className="text-[12px] text-danger-hover">{error}</div> : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <button
              type="button"
              disabled={Boolean(pending) || Boolean(uploadingFieldId)}
              onClick={() => void submit(true)}
                className="w-full rounded-lg bg-[#111] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-ink-strong disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {pending === "approve" ? "提交中..." : uploadingFieldId ? "上传中..." : primaryLabelFor(instance)}
            </button>
            {showReviseButton ? (
              <button
                type="button"
                disabled={Boolean(pending) || Boolean(uploadingFieldId)}
                onClick={() => void submit(false)}
                  className="w-full bg-transparent px-0 py-2 text-left text-[13px] text-ink-soft hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
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
