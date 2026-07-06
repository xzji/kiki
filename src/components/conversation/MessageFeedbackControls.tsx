"use client";

import { Check, Copy, Loader2, Share2, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { ShareCard } from "@/components/conversation/ShareCard";
import { cn } from "@/lib/utils";
import type {
  MessageFeedbackRating,
  MessageFeedbackReasonCode,
  MessageFeedbackRecord,
} from "@/types/messageFeedback";

const BAD_REASON_OPTIONS: Array<{ code: MessageFeedbackReasonCode; label: string }> = [
  { code: "not_helpful", label: "没有解决问题" },
  { code: "incorrect", label: "内容不准确" },
  { code: "missed_context", label: "没理解上下文" },
  { code: "too_verbose", label: "太啰嗦" },
  { code: "unsafe_or_risky", label: "有风险或不安全" },
  { code: "other", label: "其他" },
];

/**
 * 把页面里所有 <img> 的跨域 src 替换为内联 dataURL，避免导出时污染 canvas。
 * html-to-image 会在导出前内联样式，但外部图片若无 CORS 仍会导致 tainted，
 * 所以这里先主动 fetch 成 base64。
 */
async function inlineImages(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        const response = await fetch(src, { mode: "cors", cache: "force-cache" });
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("图片读取失败"));
          reader.readAsDataURL(blob);
        });
        img.setAttribute("src", dataUrl);
      } catch {
        // 无法内联的图片直接移除，避免污染画布导致整图导出失败
        img.remove();
      }
    }),
  );
}

/**
 * 把分享卡片渲染到离屏 DOM，用 html-to-image 截图为 PNG Blob。
 */
async function createShareImageBlob(input: { question: string; answer: string }): Promise<Blob> {
  await document.fonts?.ready;
  const { toBlob } = await import("html-to-image");

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-99999px";
  host.style.top = "0";
  host.style.zIndex = "-1";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  const root = createRoot(host);
  try {
    await new Promise<void>((resolve) => {
      root.render(<ShareCard question={input.question} answer={input.answer} />);
      // 等待两帧确保布局与字体完成
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const card = host.firstElementChild as HTMLElement | null;
    if (!card) throw new Error("分享内容渲染失败");
    await inlineImages(card);

    const blob = await toBlob(card, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "#F3F4F6",
      width: card.offsetWidth,
      height: card.offsetHeight,
    });
    if (!blob) throw new Error("图片生成失败");
    return blob;
  } finally {
    root.unmount();
    host.remove();
  }
}

export function MessageFeedbackControls({
  feedback,
  content,
  question,
  onSubmit,
  onClear,
}: {
  feedback?: MessageFeedbackRecord | null;
  content: string;
  question?: string;
  onSubmit: (input: {
    rating: MessageFeedbackRating;
    reasonCodes?: MessageFeedbackReasonCode[];
    comment?: string;
  }) => Promise<void> | void;
  onClear: () => Promise<void> | void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedReasons, setSelectedReasons] = useState<MessageFeedbackReasonCode[]>(
    feedback?.rating === "bad" ? feedback.reasonCodes : [],
  );
  const [comment, setComment] = useState(feedback?.rating === "bad" ? (feedback.comment ?? "") : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedReasons), [selectedReasons]);
  const canSubmitBad = selectedReasons.length > 0 || comment.trim().length > 0;

  const submit = async (input: {
    rating: MessageFeedbackRating;
    reasonCodes?: MessageFeedbackReasonCode[];
    comment?: string;
  }) => {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(input);
      if (input.rating === "bad") {
        setDialogOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "反馈保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleReason = (code: MessageFeedbackReasonCode) => {
    setSelectedReasons((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  };

  const markTransient = (setter: (value: boolean) => void) => {
    setter(true);
    window.setTimeout(() => setter(false), 1200);
  };

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    markTransient(setCopied);
  };

  const clearFeedback = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onClear();
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消反馈失败");
    } finally {
      setSubmitting(false);
    }
  };

  const shareMessage = async () => {
    if (sharing) return;
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      throw new Error("当前浏览器不支持复制图片到剪贴板");
    }
    setSharing(true);
    try {
      const blob = await createShareImageBlob({
        question: question ?? "",
        answer: content,
      });
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);
      markTransient(setShared);
      showToast("生成分享了图片，已保存到剪贴板");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div
      className="mt-1.5 flex max-w-3xl justify-end"
      data-has-feedback={feedback ? "true" : "false"}
    >
      <div className="flex items-center gap-0.5 text-ink-faint">
        <button
          type="button"
          aria-label="答得好"
          title="答得好"
          disabled={submitting}
          onClick={() =>
            feedback?.rating === "good"
              ? void clearFeedback()
              : void submit({ rating: "good", reasonCodes: [] })
          }
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface hover:text-ink disabled:opacity-60",
            feedback?.rating === "good" && "bg-success-bg text-success opacity-100",
          )}
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="答得不好"
          title="答得不好"
          disabled={submitting}
          onClick={() => {
            if (feedback?.rating === "bad") {
              void clearFeedback();
              return;
            }
            setSelectedReasons([]);
            setComment("");
            setError(null);
            setDialogOpen(true);
          }}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface hover:text-ink disabled:opacity-60",
            feedback?.rating === "bad" && "bg-warning-bg text-warning-strong opacity-100",
          )}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="复制"
          title="复制"
          onClick={() => void copyText(content)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface hover:text-ink"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label={sharing ? "正在生成分享图片" : "分享"}
          title={sharing ? "正在生成分享图片" : "分享"}
          disabled={sharing}
          onClick={() => {
            void shareMessage().catch((err) => {
              showToast(err instanceof Error ? err.message : "生成分享图片失败");
            });
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface hover:text-ink disabled:opacity-70"
        >
          {sharing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : shared ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Share2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {sharing || toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink-strong px-4 py-2 text-[13px] text-white shadow-lg">
          {sharing ? "正在生成分享图片..." : toast}
        </div>
      ) : null}

      {dialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-line-strong bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[14px] font-medium text-ink">这次回答哪里不好？</div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setDialogOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-surface hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {BAD_REASON_OPTIONS.map((option) => (
                <button
                  key={option.code}
                  type="button"
                  onClick={() => toggleReason(option.code)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[12px] transition-colors",
                    selectedSet.has(option.code)
                      ? "border-ink bg-ink text-white"
                      : "border-line-strong bg-white text-ink-strong hover:bg-surface",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {selectedSet.has("other") ? (
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="补充具体问题"
                className="mt-3 min-h-24 w-full resize-none rounded-xl border border-line-strong px-3 py-2 text-[13px] leading-5 text-ink outline-none focus:border-ink"
              />
            ) : null}
            {error ? <div className="mt-2 text-[12px] text-danger-hover">{error}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-ink-soft hover:bg-surface"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!canSubmitBad || submitting}
                onClick={() =>
                  submit({
                    rating: "bad",
                    reasonCodes: selectedReasons,
                    comment: comment.trim() || undefined,
                  })
                }
                className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                提交
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
