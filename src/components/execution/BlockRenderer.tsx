"use client";

import type { ResultBlock, ResultCell, TaskResult } from "@/types/taskResult";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

const PRESENTATION_LABEL: Record<NonNullable<TaskResult["meta"]["presentation"]>, string> = {
  summary_card: "摘要卡片",
  visual_report: "可视化报告",
  comparison_table: "对比表",
  checklist: "检查清单",
  timeline: "时间线",
  document: "结构化文档",
  dashboard: "数据看板",
  handoff_package: "交付包",
};

function cellText(cell: ResultCell) {
  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return cell.text;
}

function cellClassName(cell: ResultCell) {
  if (typeof cell !== "object" || cell === null || !("tone" in cell)) return "";
  if (cell.tone === "good") return "text-[#25663A]";
  if (cell.tone === "bad") return "text-[#B42318]";
  if (cell.tone === "warn") return "text-[#8A6D3B]";
  return "";
}

function BlockRenderer({ block }: { block: ResultBlock }) {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return <Tag className="text-[15px] font-semibold leading-7 text-[#1F2328]">{block.text}</Tag>;
    }
    case "paragraph":
      return <p className="whitespace-pre-wrap text-[14px] leading-7 text-[#374151]">{block.text}</p>;
    case "markdown":
      return <MarkdownRenderer content={block.content} className="text-[14px] leading-7" />;
    case "list":
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-5 text-[14px] leading-7 text-[#374151]">
          {block.items.map((item) => <li key={item}>{item}</li>)}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-[14px] leading-7 text-[#374151]">
          {block.items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      );
    case "key_value":
      return (
        <div className="grid gap-2">
          {block.entries.map((entry) => (
            <div key={entry.label} className="grid grid-cols-[96px_1fr] gap-3 rounded-lg bg-[#F8F9FB] px-3 py-2 text-[13px]">
              <div className="text-[#8C9198]">{entry.label}</div>
              <div className={entry.emphasis ? "font-medium text-[#1F2328]" : "text-[#374151]"}>{cellText(entry.value)}</div>
            </div>
          ))}
        </div>
      );
    case "comparison_table":
      return (
        <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]">
          <table className="min-w-full border-collapse text-left text-[13px]">
            <thead className="bg-[#F8F9FB] text-[#6B7280]">
              <tr>
                {block.columns.map((column) => (
                  <th key={column} className="border-b border-[#E5E7EB] px-3 py-2 font-medium">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`} className={block.highlight?.includes(rowIndex) ? "bg-[#FFF9E8]" : "bg-white"}>
                  {block.columns.map((column) => (
                    <td key={column} className={`border-b border-[#EEF1F4] px-3 py-2 align-top ${cellClassName(row[column] ?? "")}`}>
                      {cellText(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "decision":
      return (
        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] p-4">
          <div className="text-[13px] font-medium text-[#1F2328]">{block.question}</div>
          <div className="mt-3 space-y-2">
            {block.options.map((option) => (
              <div key={option.id} className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[#1F2328]">
                  <span>{option.label}</span>
                  {option.recommended ? <span className="rounded-full bg-[#E8F5E9] px-2 py-0.5 text-[11px] text-[#25663A]">推荐</span> : null}
                </div>
                {option.rationale ? <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{option.rationale}</div> : null}
              </div>
            ))}
          </div>
        </div>
      );
    case "callout": {
      const toneClass =
        block.tone === "success"
          ? "border-[#B7E4C7] bg-[#F0FFF4] text-[#25663A]"
          : block.tone === "warn"
            ? "border-[#F5D58B] bg-[#FFF9E8] text-[#8A6D3B]"
            : block.tone === "risk"
              ? "border-[#F5B5B8] bg-[#FFF1F2] text-[#B42318]"
              : "border-[#D8E7FF] bg-[#F4F8FF] text-[#0D47A1]";
      return <div className={`rounded-xl border px-4 py-3 text-[13px] leading-6 ${toneClass}`}>{block.text}</div>;
    }
  }
}

function normalizeTitleForCompare(value: string) {
  return value
    .toLowerCase()
    .replace(/demo|报告|结果|分析|复盘|产出物/g, "")
    .replace(/[\s\-_.,，。:：;；!?！？()[\]【】"'“”‘’/\\]+/g, "");
}

function isDuplicateLeadingHeading(title: string, block: ResultBlock) {
  if (block.kind !== "heading") return false;
  const normalizedTitle = normalizeTitleForCompare(title);
  const normalizedHeading = normalizeTitleForCompare(block.text);
  if (!normalizedTitle || !normalizedHeading) return false;
  return normalizedTitle.includes(normalizedHeading) || normalizedHeading.includes(normalizedTitle);
}

export function TaskResultBlockView({ result }: { result: TaskResult }) {
  const presentationLabel = result.meta.presentation ? PRESENTATION_LABEL[result.meta.presentation] : "结构化产物";
  const displayBlocks = isDuplicateLeadingHeading(result.title, result.blocks[0])
    ? result.blocks.slice(1)
    : result.blocks;

  return (
    <article className="rounded-xl border border-[#E5E7EB] bg-white p-5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="text-[12px] font-medium text-[#8C9198]">
        产出物 · {presentationLabel}
      </div>
      <h3 className="mt-2 text-[16px] font-semibold leading-7 text-[#1F2328]">{result.title}</h3>
      <div className="mt-4 space-y-4">
        {displayBlocks.map((block, index) => (
          <BlockRenderer key={`${block.kind}-${index}`} block={block} />
        ))}
      </div>
    </article>
  );
}
