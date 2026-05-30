"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { GoalDeliverable } from "@/lib/server/services/goalDeliverableService";
import { goalDetailPath } from "@/lib/routes";

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function GoalDeliverablePage({ params }: { params: { goalId: string } }) {
  const goalId = safeDecodeRouteParam(params.goalId);
  const [deliverable, setDeliverable] = useState<GoalDeliverable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/goals/${encodeURIComponent(goalId)}/deliverable`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { ok?: boolean; reason?: string; deliverable?: GoalDeliverable };
        if (!response.ok || !payload.deliverable) throw new Error(payload.reason || "目标交付包加载失败");
        if (!cancelled) {
          setDeliverable(payload.deliverable);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "目标交付包加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [goalId]);

  if (loading) {
    return <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">正在生成交付包...</div>;
  }

  if (error || !deliverable) {
    return (
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">
        {error || "暂无交付包。"}
      </div>
    );
  }

  return (
    <main className="max-w-[920px] pb-12">
      <div className="mb-4 text-right text-xs text-[#6B7280]">
        <Link href={goalDetailPath(goalId)} className="font-medium text-[#1F2328] hover:text-[#111]">
          返回目标规划
        </Link>
      </div>
      <section className="rounded-[20px] border border-[#E5E7EB] bg-white p-6">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-[#8C9198]">Goal Deliverable</div>
        <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.02em] text-[#1F2328]">{deliverable.title}</h1>
        <p className="mt-3 text-sm leading-6 text-[#6B7280]">{deliverable.summary}</p>
        <div className="mt-5 text-xs text-[#8C9198]">
          生成时间 {new Date(deliverable.generatedAt).toLocaleString()} · revision {deliverable.revision}
        </div>
      </section>

      <section className="mt-5 space-y-4">
        {deliverable.sections.length ? (
          deliverable.sections.map((section) => (
            <article key={`${section.taskId}-${section.instanceId}`} className="rounded-[18px] border border-[#E5E7EB] bg-white p-5">
              <div className="text-xs text-[#8C9198]">{section.taskTitle}</div>
              <h2 className="mt-2 text-lg font-semibold text-[#1F2328]">{section.headline}</h2>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#4B5563]">{section.summary}</p>
              {section.artifactRefs.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {section.artifactRefs.map((ref) => (
                    <span key={`${ref.adapter}:${ref.key}`} className="rounded-full bg-[#F5F6F8] px-3 py-1 text-xs text-[#6B7280]">
                      {ref.adapter}:{ref.key}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <div className="rounded-[18px] border border-dashed border-[#D0D7DE] bg-white p-6 text-sm text-[#8C9198]">
            当前目标还没有已完成任务，交付包会在任务完成后自动聚合。
          </div>
        )}
      </section>
    </main>
  );
}
