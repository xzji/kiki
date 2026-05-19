"use client";

import { useState } from "react";

import type { InteractionRequirement } from "@/types/kiki";

export function OptionalFeedbackSuggestions({
  requirement,
  onSelect,
}: {
  requirement: InteractionRequirement & { options: string[] };
  onSelect?: (message: string) => Promise<void> | void;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  if (submitted || !onSelect) return null;

  const submit = async (value: string, index: number) => {
    if (pendingValue) return;
    console.info("[optional-feedback] suggestion clicked", {
      index,
      value,
      source: "task-result",
    });
    setPendingValue(value);
    try {
      await onSelect(value);
      setSubmitted(true);
    } finally {
      setPendingValue(null);
    }
  };

  return (
    <div className="mt-4 grid max-w-[720px] gap-1.5" aria-label={requirement.question ?? "可选后续反馈"}>
      {requirement.options.map((option, index) => (
        <button
          key={`${option}-${index}`}
          type="button"
          disabled={Boolean(pendingValue)}
          onClick={() => void submit(option, index)}
          className="flex w-fit max-w-full items-center gap-3 rounded-lg bg-[#EEF0F3] px-3.5 py-2 text-left text-[13px] leading-5 text-[#6B7280] transition hover:bg-[#E2E6EB] hover:text-[#1F2328] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="min-w-0 truncate">{option}</span>
          <span className="relative h-3 w-[18px] shrink-0 text-[#8C9198]" aria-hidden="true">
            <span className="absolute right-px top-1/2 h-px w-3.5 -translate-y-1/2 bg-current" />
            <span className="absolute right-px top-1/2 h-1.5 w-1.5 -translate-y-1/2 rotate-45 border-r border-t border-current" />
          </span>
        </button>
      ))}
    </div>
  );
}
