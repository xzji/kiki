"use client";

import type { ReactNode } from "react";

import { TablePreview } from "@/components/spreadsheet/TablePreview";
import { looksLikeTable, splitTableRow } from "@/lib/spreadsheet/adapters/markdownTables";
import { cn } from "@/lib/utils";

type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language?: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" };

function isFence(line: string) {
  return line.trimStart().startsWith("```");
}

function isHeading(line: string) {
  return /^(#{1,6})\s+/.test(line.trimStart());
}

function isHr(line: string) {
  return /^\s*(---|\*\*\*|___)\s*$/.test(line);
}

function getListMatch(line: string) {
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1] };
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[1] };
  return null;
}

function normalizeTableRow(row: string[], width: number) {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function isBlockStart(line: string, nextLine?: string) {
  if (!line.trim()) return true;
  if (isFence(line) || isHeading(line) || isHr(line) || getListMatch(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  return Boolean(nextLine && looksLikeTable(line, nextLine));
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const language = trimmed.replace(/^```/, "").trim() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    const listMatch = getListMatch(line);
    if (listMatch) {
      const items: string[] = [];
      const ordered = listMatch.ordered;
      while (index < lines.length) {
        const match = getListMatch(lines[index] ?? "");
        if (!match || match.ordered !== ordered) break;
        items.push(match.text);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (looksLikeTable(line, nextLine)) {
      const headers = splitTableRow(line);
      if (headers.every((header) => header.length === 0)) {
        index += 2;
        while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
          index += 1;
        }
        continue;
      }
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(normalizeTableRow(splitTableRow(lines[index] ?? ""), headers.length));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines[index] ?? "", lines[index + 1])) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}

function safeHref(href: string) {
  const value = href.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(value)) return value;
  return "#";
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-surface-subtle px-1 py-0.5 font-mono text-[0.92em] text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key}
            href={safeHref(link[2])}
            target={link[2].startsWith("#") || link[2].startsWith("/") ? undefined : "_blank"}
            rel="noreferrer"
            className="font-medium text-info-strong underline underline-offset-2 hover:text-info-strong"
          >
            {link[1]}
          </a>,
        );
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function MarkdownRenderer({
  content,
  className,
  tableVariant = "plain",
}: {
  content: string;
  className?: string;
  tableVariant?: "plain" | "with-toolbar";
}) {
  const blocks = parseMarkdown(content);

  return (
    <div className={cn("space-y-3 break-words text-sm leading-6 text-ink-strong", className)}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case "heading": {
            const Tag = (`h${block.level}` as keyof JSX.IntrinsicElements);
            return (
              <Tag key={key} className="mt-4 text-[15px] font-semibold leading-7 text-ink first:mt-0">
                {renderInline(block.text)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(block.text)}
              </p>
            );
          case "blockquote":
            return (
              <blockquote key={key} className="border-l-4 border-line-strong pl-3 text-ink-soft">
                <p className="whitespace-pre-wrap">{renderInline(block.text)}</p>
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-xl bg-ink-strong p-3 text-[12px] leading-5 text-line"
              >
                <code>{block.code}</code>
              </pre>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={key}
                className={cn(
                  "space-y-1 pl-5",
                  block.ordered ? "list-decimal" : "list-disc",
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
                ))}
              </ListTag>
            );
          }
          case "table":
            return (
              <TablePreview key={key} data={{ headers: block.headers, rows: block.rows }} variant={tableVariant} />
            );
          case "hr":
            return <hr key={key} className="border-line" />;
        }
      })}
    </div>
  );
}
