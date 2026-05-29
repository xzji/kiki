import type { SpreadsheetWorkbook, TableData } from "@/lib/spreadsheet/types";

export const TABLE_SEPARATOR_RE = /^\s*\|?[\s:-]+\|[\s|:-]*\s*$/;

export function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function looksLikeTable(line: string, nextLine: string) {
  return line.includes("|") && TABLE_SEPARATOR_RE.test(nextLine);
}

function headingText(line: string) {
  return line.trim().match(/^(#{1,6})\s+(.+)$/)?.[2]?.trim();
}

function normalizeRow(row: string[], width: number) {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function fallbackFilename(filename: string) {
  return filename.toLowerCase().endsWith(".xlsx")
    ? filename
    : filename.replace(/\.[^.]+$/, "") + ".xlsx";
}

export function parseTablesFromMarkdown(markdown: string): TableData[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const tables: TableData[] = [];
  let index = 0;
  let latestHeading: string | undefined;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    const heading = headingText(line);

    if (heading) {
      latestHeading = heading;
      index += 1;
      continue;
    }

    if (!looksLikeTable(line, nextLine)) {
      index += 1;
      continue;
    }

    const rawHeaders = splitTableRow(line);
    if (rawHeaders.every((header) => header.length === 0)) {
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        index += 1;
      }
      continue;
    }
    const headers = rawHeaders.map((header, headerIndex) => header || `列${headerIndex + 1}`);
    const width = headers.length;
    const rows: string[][] = [];
    index += 2;

    while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
      rows.push(normalizeRow(splitTableRow(lines[index] ?? ""), width));
      index += 1;
    }

    if (width > 0) {
      tables.push({
        title: latestHeading || `Sheet${tables.length + 1}`,
        headers,
        rows,
      });
    }
  }

  return tables;
}

export function markdownToWorkbook(markdown: string, opts: { filename: string }): SpreadsheetWorkbook | null {
  const tables = parseTablesFromMarkdown(markdown);
  if (tables.length === 0) return null;
  return {
    filename: fallbackFilename(opts.filename),
    tables,
  };
}
