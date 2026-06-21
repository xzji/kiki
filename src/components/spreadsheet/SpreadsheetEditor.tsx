"use client";

import { Download, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { SpreadsheetWorkbook } from "@/lib/spreadsheet/types";
import type { ArtifactRef } from "@/types/artifact";
import { cn } from "@/lib/utils";

type SpreadsheetEditorProps = {
  artifact: ArtifactRef;
};

type LoadState = "idle" | "loading" | "ready" | "error";

function cloneWorkbook(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  return {
    filename: workbook.filename,
    tables: workbook.tables.map((table) => ({
      ...table,
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row]),
      highlight: table.highlight ? [...table.highlight] : undefined,
    })),
  };
}

export function SpreadsheetEditor({ artifact }: SpreadsheetEditorProps) {
  const href = artifact.previewUrl || `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbook | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);

  const loadWorkbook = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`读取 Excel 失败：${response.status}`);
      const { parseXlsxArrayBuffer } = await import("@/lib/spreadsheet/client/xlsxIo");
      const parsed = parseXlsxArrayBuffer(await response.arrayBuffer());
      setWorkbook({
        ...parsed,
        filename: artifact.label || parsed.filename,
      });
      setActiveSheet(0);
      setState("ready");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取 Excel 失败");
      setState("error");
    }
  }, [artifact.label, href]);

  useEffect(() => {
    void loadWorkbook();
  }, [loadWorkbook]);

  function updateCell(rowIndex: number, columnIndex: number, value: string) {
    setWorkbook((current) => {
      if (!current) return current;
      const next = cloneWorkbook(current);
      const table = next.tables[activeSheet];
      if (!table) return current;
      table.rows[rowIndex] = table.headers.map((_, index) => (index === columnIndex ? value : table.rows[rowIndex]?.[index] ?? ""));
      return next;
    });
  }

  async function handleDownload() {
    if (!workbook || isDownloading) return;
    setIsDownloading(true);
    setError(null);
    try {
      const { triggerBrowserDownload, writeWorkbookToBlob } = await import("@/lib/spreadsheet/client/xlsxIo");
      triggerBrowserDownload(writeWorkbookToBlob(workbook), artifact.label || workbook.filename);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "下载已填写版本失败");
    } finally {
      setIsDownloading(false);
    }
  }

  const table = workbook?.tables[activeSheet];

  return (
    <div className="mt-4 text-[13px] text-[#374151]">
      {state === "loading" ? <div className="text-[#8C9198]">正在读取 Excel...</div> : null}
      {state === "error" ? <div className="text-[#B42318]">{error}</div> : null}
      {state === "ready" && workbook && table ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {workbook.tables.map((sheet, index) => (
                <button
                  key={`${sheet.title || "sheet"}-${index}`}
                  type="button"
                  onClick={() => setActiveSheet(index)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[12px]",
                    activeSheet === index ? "bg-[#F4F8FF] text-[#0D47A1]" : "text-[#8C9198] hover:bg-[#F6F8FA] hover:text-[#1F2328]",
                  )}
                >
                  {sheet.title || `Sheet${index + 1}`}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-[#8C9198] md:hidden">表格可左右滑动</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadWorkbook()}
                disabled={isDownloading}
                className="inline-flex items-center gap-1 text-[12px] text-[#6B7280] hover:text-[#1F2328] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重置
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={isDownloading}
                className="inline-flex items-center gap-1 text-[12px] text-[#1F2328] hover:text-[#0D47A1] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                {isDownloading ? "导出中" : "下载已填写版本"}
              </button>
            </div>
          </div>
            <div className="mt-3 overflow-x-auto rounded-xl border border-[#E5E7EB] shadow-[inset_-12px_0_12px_-12px_rgba(15,23,42,0.25)]">
            <table className="min-w-full border-collapse text-left text-[13px]">
              <thead className="bg-[#F8F9FB] text-[#6B7280]">
                <tr>
                  {table.headers.map((header, index) => (
                    <th key={`${index}-${header}`} className="border-b border-[#E5E7EB] px-3 py-2 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`row-${rowIndex}`} className={table.highlight?.includes(rowIndex) ? "bg-[#FFF9E8]" : "bg-white"}>
                    {table.headers.map((_, columnIndex) => (
                      <td key={columnIndex} className="border-b border-[#EEF1F4] p-0 align-top">
                        <input
                          value={row[columnIndex] ?? ""}
                          onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                          className="h-full min-w-[96px] bg-transparent px-3 py-2 text-[#374151] outline-none hover:bg-[#F8F9FB] focus:bg-[#F4F8FF]"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error ? <div className="mt-2 text-[12px] text-[#B42318]">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
