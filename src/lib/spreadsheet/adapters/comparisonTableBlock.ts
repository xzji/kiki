import { cellText } from "@/lib/spreadsheet/adapters/cell";
import type { TableData } from "@/lib/spreadsheet/types";
import type { ComparisonTableBlock } from "@/types/taskResult";

export function comparisonTableBlockToTable(block: ComparisonTableBlock, opts?: { title?: string }): TableData {
  return {
    title: opts?.title,
    headers: block.columns,
    rows: block.rows.map((row) => block.columns.map((column) => cellText(row[column] ?? ""))),
    highlight: block.highlight,
  };
}
