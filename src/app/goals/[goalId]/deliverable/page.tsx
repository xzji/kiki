"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { GoalDeliverable } from "@/lib/server/services/goalDeliverableService";
import { goalDetailPath } from "@/lib/routes";
import type { ResultBlock, ResultCell } from "@/types/taskResult";

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function renderCell(value: ResultCell) {
  if (typeof value === "object") return value.text;
  return String(value);
}

function ResultBlockView({ block }: { block: ResultBlock }) {
  if (block.kind === "heading") {
    return <h3 className="mt-4 text-base font-semibold text-[#1F2328]">{block.text}</h3>;
  }
  if (block.kind === "paragraph") {
    return <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#4B5563]">{block.text}</p>;
  }
  if (block.kind === "markdown") {
    return <pre className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-[#F5F6F8] p-3 text-sm leading-6 text-[#4B5563]">{block.content}</pre>;
  }
  if (block.kind === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag className="mt-3 list-inside space-y-1 text-sm leading-6 text-[#4B5563]">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ListTag>
    );
  }
  if (block.kind === "key_value") {
    return (
      <dl className="mt-3 grid gap-2 text-sm text-[#4B5563]">
        {block.entries.map((entry) => (
          <div key={entry.label} className="rounded-xl bg-[#F5F6F8] px-3 py-2">
            <dt className="text-xs text-[#8C9198]">{entry.label}</dt>
            <dd className={entry.emphasis ? "mt-1 font-medium text-[#1F2328]" : "mt-1"}>{renderCell(entry.value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (block.kind === "callout") {
    return <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-3 text-sm text-[#4B5563]">{block.text}</div>;
  }
  if (block.kind === "decision") {
    return <p className="mt-3 text-sm leading-6 text-[#4B5563]">{block.question}</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-[#E5E7EB]">
      <table className="min-w-full text-left text-sm text-[#4B5563]">
        <thead className="bg-[#F5F6F8] text-xs text-[#6B7280]">
          <tr>
            {block.columns.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index} className="border-t border-[#E5E7EB]">
              {block.columns.map((column) => (
                <td key={column} className="px-3 py-2">{renderCell(row[column] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
              {section.blocks.length ? (
                <div className="mt-4">
                  {section.blocks.map((block, index) => (
                    <ResultBlockView key={`${section.instanceId}-block-${index}`} block={block} />
                  ))}
                </div>
              ) : null}
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
