import "server-only";

import ExcelJS from "exceljs";

import type { SpreadsheetWorkbook, TableData } from "@/lib/spreadsheet/types";

const HEADER_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF4F8FF" } };
const HIGHLIGHT_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF9E8" } };
const INVALID_SHEET_NAME_CHARS = /[\\/?*\[\]:]/g;

function safeSheetName(name: string, used: Set<string>) {
  const base = (name || "Sheet")
    .replace(INVALID_SHEET_NAME_CHARS, "_")
    .trim()
    .slice(0, 31) || "Sheet";
  let candidate = base;
  let suffix = 2;

  while (used.has(candidate)) {
    const suffixText = ` (${suffix})`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }

  used.add(candidate);
  return candidate;
}

function textLength(value: string) {
  return Array.from(value).length;
}

function applyTable(worksheet: ExcelJS.Worksheet, table: TableData) {
  worksheet.addRow(table.headers);
  table.rows.forEach((row) => {
    worksheet.addRow(table.headers.map((_, index) => row[index] ?? ""));
  });

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  table.highlight?.forEach((rowIndex) => {
    const worksheetRow = worksheet.getRow(rowIndex + 2);
    worksheetRow.eachCell((cell) => {
      cell.fill = HIGHLIGHT_FILL;
    });
  });

  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: "top" };
    });
  });

  table.headers.forEach((header, columnIndex) => {
    const values = [header, ...table.rows.map((row) => row[columnIndex] ?? "")];
    const width = Math.min(Math.max(8, ...values.map(textLength)) + 2, 40);
    worksheet.getColumn(columnIndex + 1).width = width;
  });
}

export async function buildXlsxBuffer(workbookData: SpreadsheetWorkbook): Promise<Buffer> {
  if (workbookData.tables.length === 0) {
    throw new Error("没有可写入 Excel 的表格");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KiKi";
  workbook.created = new Date();
  const usedSheetNames = new Set<string>();

  workbookData.tables.forEach((table, index) => {
    const worksheet = workbook.addWorksheet(safeSheetName(table.title || `Sheet${index + 1}`, usedSheetNames));
    applyTable(worksheet, table);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
