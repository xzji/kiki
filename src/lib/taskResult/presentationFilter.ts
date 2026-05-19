import type { ResultBlock, TaskResult } from "@/types/taskResult";

const AGENT_ROLE_PATTERN = /\b(Coordinator|Executor|Reviewer|Synthesizer|Researcher)\b/gi;
const PROCESS_HEADING_PATTERN = /多\s*Agent|协同结果|协同过程|角色分工|执行过程|审阅过程/;
const PROCESS_TEXT_PATTERN = /第一轮|第二轮|打回|复查通过|移交|审阅意见|blocking\s*问题/i;
const PROCESS_TABLE_HINTS = new Set(["关键动作", "状态", "职责", "输出", "审阅"]);

function countAgentRoleMentions(text: string) {
  const roles = new Set<string>();
  AGENT_ROLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AGENT_ROLE_PATTERN.exec(text)) !== null) {
    roles.add(match[1].toLowerCase());
  }
  return roles.size;
}

function blockText(block: ResultBlock) {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "paragraph":
      return block.text;
    case "markdown":
      return block.content;
    case "list":
      return block.items.join("\n");
    case "key_value":
      return block.entries.map((entry) => `${entry.label}: ${typeof entry.value === "object" ? entry.value.text : entry.value}`).join("\n");
    case "comparison_table":
      return [
        block.columns.join(" "),
        ...block.rows.map((row) => block.columns.map((column) => {
          const value = row[column];
          if (typeof value === "object" && value !== null) return value.text;
          return value ?? "";
        }).join(" ")),
      ].join("\n");
    case "decision":
      return [block.question, ...block.options.map((option) => `${option.label} ${option.rationale ?? ""}`)].join("\n");
    case "callout":
      return block.text;
  }
}

function isProcessTable(block: ResultBlock) {
  if (block.kind !== "comparison_table") return false;
  const hasRoleColumn = block.columns.includes("角色");
  const hasProcessColumn = block.columns.some((column) => PROCESS_TABLE_HINTS.has(column));
  return hasRoleColumn && hasProcessColumn;
}

function isProcessBlock(block: ResultBlock) {
  if (block.kind === "heading") return PROCESS_HEADING_PATTERN.test(block.text);
  if (isProcessTable(block)) return true;
  if (block.kind === "paragraph" || block.kind === "markdown") {
    const text = blockText(block);
    return countAgentRoleMentions(text) >= 2 || (PROCESS_TEXT_PATTERN.test(text) && countAgentRoleMentions(text) >= 1);
  }
  return false;
}

export function filterTaskResultForPresentation(taskResult: TaskResult): TaskResult {
  const filteredBlocks = taskResult.blocks.filter((block) => !isProcessBlock(block));
  if (taskResult.blocks.length > 0 && filteredBlocks.length === 0) return taskResult;
  if (filteredBlocks.length === taskResult.blocks.length) return taskResult;
  return {
    ...taskResult,
    blocks: filteredBlocks,
  };
}
