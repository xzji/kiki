"use client";

import type { Ref, ReactNode } from "react";

import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { DeliverableArticle } from "@/components/execution/DeliverableArticle";
import { TablePreview } from "@/components/spreadsheet/TablePreview";
import { cellClassName, cellText } from "@/lib/spreadsheet/adapters/cell";
import { comparisonTableBlockToTable } from "@/lib/spreadsheet/adapters/comparisonTableBlock";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

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

function BlockRenderer({ block }: { block: ResultBlock }) {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return <Tag className="text-[15px] font-semibold leading-7 text-[#1F2328]">{block.text}</Tag>;
    }
    case "paragraph":
      return <p className="whitespace-pre-wrap text-[14px] leading-7 text-[#374151]">{block.text}</p>;
    case "markdown":
      return <MarkdownRenderer content={block.content} className="text-[14px] leading-7" tableVariant="with-toolbar" />;
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
            <div key={entry.label} className="grid gap-1 rounded-lg bg-[#F8F9FB] px-3 py-2 text-[13px] md:grid-cols-[96px_1fr] md:gap-3">
              <div className="text-[#8C9198]">{entry.label}</div>
              <div className={entry.emphasis ? "font-medium text-[#1F2328]" : "text-[#374151]"}>{cellText(entry.value)}</div>
            </div>
          ))}
        </div>
      );
    case "comparison_table":
      return (
        <TablePreview
          data={comparisonTableBlockToTable(block)}
          variant="with-toolbar"
          cellClassName={(rowIndex, columnIndex) => cellClassName(block.rows[rowIndex]?.[block.columns[columnIndex]] ?? "")}
        />
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
    .replace(/[（(]\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*[）)]/g, "")
    .replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g, "")
    .replace(/\d{4}年\d{1,2}月\d{1,2}日?/g, "")
    .replace(/[\s\-_.,，。:：;；!?！？()[\]【】"'“”‘’·／/\\（）]+/g, "");
}

function isDuplicateTitleText(title: string, text: string) {
  const normalizedTitle = normalizeTitleForCompare(title);
  const normalizedText = normalizeTitleForCompare(text);
  if (!normalizedTitle || !normalizedText) return false;
  return normalizedTitle.includes(normalizedText) || normalizedText.includes(normalizedTitle);
}

/** 去掉与 result.title 重复的首个 block（heading / markdown 标题行 / 同文段落） */
function preprocessDisplayBlock(title: string, block: ResultBlock): ResultBlock | null {
  if (block.kind === "heading") {
    return isDuplicateTitleText(title, block.text) ? null : block;
  }
  if (block.kind === "paragraph") {
    return isDuplicateTitleText(title, block.text) ? null : block;
  }
  if (block.kind === "markdown") {
    const lines = block.content.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const headingMatch = firstLine.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch && isDuplicateTitleText(title, headingMatch[1])) {
      const rest = lines.slice(1).join("\n").trimStart();
      if (!rest) return null;
      return { ...block, content: rest };
    }
  }
  return block;
}

function getDisplayBlocks(title: string, blocks: ResultBlock[]) {
  if (!blocks.length) return blocks;
  const first = preprocessDisplayBlock(title, blocks[0]);
  if (first === null) return blocks.slice(1);
  if (first !== blocks[0]) return [first, ...blocks.slice(1)];
  return blocks;
}

export function TaskResultBlockView({
  result,
  headerActions,
  clipMaxHeight,
  bodyRef,
  bodyOverlay,
  embedded = false,
}: {
  result: TaskResult;
  headerActions?: React.ReactNode;
  /** 限制卡片总高度，仅正文区域滚动 */
  clipMaxHeight?: number;
  bodyRef?: Ref<HTMLDivElement>;
  /** 正文区域底部叠层，如截断渐变 */
  bodyOverlay?: ReactNode;
  /** 仅渲染 blocks 正文，不包含产出物卡片外壳 */
  embedded?: boolean;
}) {
  const presentationLabel = result.meta.presentation ? PRESENTATION_LABEL[result.meta.presentation] : "结构化产物";
  const displayBlocks = getDisplayBlocks(result.title, result.blocks);
  const blockNodes = displayBlocks.map((block, index) => (
    <BlockRenderer key={`${block.kind}-${index}`} block={block} />
  ));

  if (embedded) {
    return <div className="space-y-4">{blockNodes}</div>;
  }

  return (
    <DeliverableArticle
      label={`产出物 · ${presentationLabel}`}
      title={result.title}
      headerActions={headerActions}
      clipMaxHeight={clipMaxHeight}
      bodyRef={bodyRef}
      bodyOverlay={bodyOverlay}
    >
      <div className="space-y-4">{blockNodes}</div>
    </DeliverableArticle>
  );
}
