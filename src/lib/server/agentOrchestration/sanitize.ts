import type { ResultBlock, ResultCell, TaskResult } from "@/types/taskResult";

const TOOL_ENV_PATTERN = /runtime|sandbox|工具|权限|写入文件|fileWrite|Write|Edit|MultiEdit|NotebookEdit/i;
const SYSTEM_PROCESS_PATTERN = /已禁用|落盘状态|请\s*Presenter|待.*授权.*写入|待用户确认事项|当前运行环境|当前\s*runtime/i;

function cellText(value: ResultCell) {
  if (typeof value === "object") return value.text;
  return String(value);
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
      return block.entries.map((entry) => `${entry.label}: ${cellText(entry.value)}`).join("\n");
    case "comparison_table":
      return [
        block.columns.join(" "),
        ...block.rows.map((row) => block.columns.map((column) => {
          const value = row[column];
          return value === undefined ? "" : cellText(value);
        }).join(" ")),
      ].join("\n");
    case "decision":
      return [block.question, ...block.options.map((option) => option.label)].join("\n");
    case "callout":
      return block.text;
  }
}

function isUnsafeMetaNarration(block: ResultBlock) {
  if (block.kind !== "callout" && block.kind !== "paragraph") return false;
  const text = blockText(block);
  return TOOL_ENV_PATTERN.test(text) && SYSTEM_PROCESS_PATTERN.test(text);
}

export function sanitizeDeliverableMetaNarration(taskResult: TaskResult): TaskResult {
  const blocks = taskResult.blocks.filter((block) => !isUnsafeMetaNarration(block));
  if (blocks.length === taskResult.blocks.length || blocks.length === 0) return taskResult;
  return {
    ...taskResult,
    blocks,
  };
}
