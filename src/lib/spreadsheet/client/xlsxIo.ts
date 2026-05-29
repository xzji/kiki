"use client";

import * as XLSX from "xlsx";

import type { SpreadsheetWorkbook, TableData } from "@/lib/spreadsheet/types";

function tableToAoa(table: TableData) {
  return [
    table.headers,
    ...table.rows.map((row) => table.headers.map((_, index) => row[index] ?? "")),
  ];
}

function safeSheetName(name: string, index: number) {
  return (name || `Sheet${index + 1}`)
    .replace(/[\\/?*\[\]:]/g, "_")
    .slice(0, 31) || `Sheet${index + 1}`;
}

function aoaToTable(title: string, aoa: unknown[][]): TableData {
  const [headerRow, ...bodyRows] = aoa;
  const headers = (headerRow ?? []).map((cell, index) => String(cell || `列${index + 1}`));
  return {
    title,
    headers,
    rows: bodyRows.map((row) => headers.map((_, index) => String(row[index] ?? ""))),
  };
}

function workbookToArrayBuffer(workbook: SpreadsheetWorkbook) {
  const book = XLSX.utils.book_new();
  workbook.tables.forEach((table, index) => {
    const worksheet = XLSX.utils.aoa_to_sheet(tableToAoa(table));
    XLSX.utils.book_append_sheet(book, worksheet, safeSheetName(table.title || "", index), true);
  });
  return XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

function safeDownloadName(filename: string) {
  const trimmed = filename.trim() || "table.xlsx";
  const normalized = trimmed.toLowerCase().endsWith(".xlsx") ? trimmed : `${trimmed}.xlsx`;
  return normalized.replace(/[\\/:*?"<>|]/g, "_");
}

export function parseXlsxArrayBuffer(buf: ArrayBuffer): SpreadsheetWorkbook {
  const book = XLSX.read(buf, { type: "array" });
  const tables = book.SheetNames.map((sheetName, index) => {
    const sheet = book.Sheets[sheetName];
    const aoa = sheet ? (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][]) : [];
    return aoaToTable(sheetName || `Sheet${index + 1}`, aoa);
  }).filter((table) => table.headers.length > 0);

  return {
    filename: "spreadsheet.xlsx",
    tables,
  };
}

export function writeWorkbookToBlob(workbook: SpreadsheetWorkbook): Blob {
  return new Blob([workbookToArrayBuffer(workbook)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function writeTableDataToBlob(table: TableData): Blob {
  return writeWorkbookToBlob({
    filename: `${table.title || "table"}.xlsx`,
    tables: [table],
  });
}

export function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(filename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
