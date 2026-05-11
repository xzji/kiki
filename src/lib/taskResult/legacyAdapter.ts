import type { TaskRunArtifact } from "@/types/kiki";
import type { ResultBlock, ResultCell, TaskResult } from "@/types/taskResult";

function cellText(cell: ResultCell) {
  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return cell.text;
}

function renderBlock(block: ResultBlock) {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return block.text;
    case "markdown":
      return block.content;
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n");
    case "key_value":
      return block.entries.map((entry) => `- ${entry.label}: ${cellText(entry.value)}`).join("\n");
    case "comparison_table": {
      const header = `| ${block.columns.join(" | ")} |`;
      const divider = `| ${block.columns.map(() => "---").join(" | ")} |`;
      const rows = block.rows.map((row) => `| ${block.columns.map((column) => cellText(row[column] ?? "")).join(" | ")} |`);
      return [header, divider, ...rows].join("\n");
    }
    case "decision":
      return [
        `**${block.question}**`,
        ...block.options.map((option) => `- ${option.recommended ? "[推荐] " : ""}${option.label}${option.rationale ? `：${option.rationale}` : ""}`),
      ].join("\n");
    case "callout":
      return `> ${block.text}`;
  }
}

function firstMeaningfulText(result: TaskResult) {
  for (const block of result.blocks) {
    if (block.kind === "heading") return block.text;
    if (block.kind === "paragraph") return block.text;
    if (block.kind === "markdown") return block.content.replace(/[#*_`>\-]/g, "").trim();
    if (block.kind === "callout") return block.text;
    if (block.kind === "decision") return block.question;
  }
  return result.title;
}

export function renderTaskResultToMarkdown(result: TaskResult) {
  return result.blocks.map(renderBlock).filter(Boolean).join("\n\n");
}

export function deriveLegacyTaskResult(result: TaskResult): {
  summary: string;
  finalMessage: string;
  artifacts: TaskRunArtifact[];
} {
  const finalMessage = renderTaskResultToMarkdown(result);
  const headline = firstMeaningfulText(result);
  const summary = headline.length > 140 ? `${headline.slice(0, 140)}...` : headline;
  return {
    summary: summary || result.title,
    finalMessage,
    artifacts: [
      {
        id: "task-result-blocks",
        label: result.title || "结构化任务结果",
        kind: "markdown",
        content: finalMessage,
      },
    ],
  };
}
