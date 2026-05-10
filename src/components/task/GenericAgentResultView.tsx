"use client";

import { useState } from "react";

import type { TaskInstanceNotificationState, TaskRunArtifact } from "@/types/kiki";

export function GenericAgentResultView({
  summary,
  finalMessage,
  artifacts,
  structuredOutput,
  notification,
  hideSummaryCard = false,
}: {
  summary?: string;
  finalMessage?: string;
  artifacts?: TaskRunArtifact[];
  structuredOutput?: Record<string, unknown> | null;
  notification?: TaskInstanceNotificationState;
  hideSummaryCard?: boolean;
}) {
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const headline = notification?.resultSummary.headline || summary || finalMessage || "KiKi 已完成本轮执行。";
  const keyPoints = notification?.resultSummary.keyPoints ?? [];
  const nextActions = notification?.resultSummary.nextActions ?? [];
  const visibleArtifacts = artifacts ?? [];

  return (
    <div className="space-y-4">
      {!hideSummaryCard ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[12px] font-medium text-[#8C9198]">结果摘要</div>
            {notification?.badge ? (
              <span className="rounded-full bg-[#FFF3CD] px-2 py-0.5 text-[11px] text-[#8A6D3B]">
                {notification.badge === "need_confirm" ? "需要确认" : "需要作答"}
              </span>
            ) : null}
          </div>
          <div className="mt-2 whitespace-pre-wrap text-[15px] font-medium leading-7 text-[#1F2328]">
            {headline}
          </div>
          {keyPoints.length ? (
            <ul className="mt-3 space-y-2 text-[13px] leading-6 text-[#374151]">
              {keyPoints.map((point) => (
                <li key={point} className="rounded-lg bg-[#F8F9FB] px-3 py-2">
                  {point}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {nextActions.length ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] p-4">
          <div className="text-[12px] font-medium text-[#8C9198]">建议下一步</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {nextActions.map((action) => (
              <span key={action} className="rounded-full border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] text-[#374151]">
                {action}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {visibleArtifacts.length ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
          <div className="text-[12px] font-medium text-[#8C9198]">关键产物</div>
          <div className="mt-3 space-y-3">
            {visibleArtifacts.map((artifact) => {
              const expanded = expandedArtifacts[artifact.id] ?? false;
              const content = artifact.content ?? "";
              const clipped = content.length > 500 && !expanded;
              return (
                <div key={artifact.id} className="rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[13px] font-medium text-[#1F2328]">{artifact.label}</div>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-[#8C9198]">{artifact.kind}</span>
                  </div>
                  {artifact.content ? (
                    <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-6 text-[#374151]">
                      {clipped ? `${content.slice(0, 500)}...` : content}
                    </pre>
                  ) : null}
                  {content.length > 500 ? (
                    <button
                      type="button"
                      onClick={() => setExpandedArtifacts((prev) => ({ ...prev, [artifact.id]: !expanded }))}
                      className="mt-2 text-[12px] text-[#2563EB] hover:underline"
                    >
                      {expanded ? "收起" : "展开全部"}
                    </button>
                  ) : null}
                  {artifact.href ? (
                    <a href={artifact.href} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] text-[#2563EB] hover:underline">
                      {artifact.href}
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {(finalMessage && finalMessage !== summary) || structuredOutput ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white">
          <button
            type="button"
            onClick={() => setDetailsOpen((value) => !value)}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] font-medium text-[#1F2328]"
          >
            <span>更多结果细节</span>
            <span className="text-[12px] text-[#8C9198]">{detailsOpen ? "收起" : "展开"}</span>
          </button>
          {detailsOpen ? (
            <div className="space-y-4 border-t border-[#E5E7EB] p-4">
              {finalMessage && finalMessage !== summary ? (
                <div>
                  <div className="text-[12px] text-[#8C9198]">完整说明</div>
                  <div className="mt-2 whitespace-pre-wrap text-[13px] leading-7 text-[#1F2328]">{finalMessage}</div>
                </div>
              ) : null}
              {structuredOutput ? (
                <div>
                  <div className="text-[12px] text-[#8C9198]">结构化数据</div>
                  <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#F8F9FB] p-3 text-[12px] leading-6 text-[#374151]">
                    {JSON.stringify(structuredOutput, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
