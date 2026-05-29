"use client";

import { Download } from "lucide-react";
import { useState } from "react";

import type { TableData } from "@/lib/spreadsheet/types";
import { cn } from "@/lib/utils";

type TablePreviewProps = {
  data: TableData;
  variant?: "plain" | "with-toolbar";
  filename?: string;
  cellClassName?: (rowIndex: number, columnIndex: number) => string;
};

function defaultFilename(data: TableData) {
  return `${data.title || "table"}.xlsx`;
}

export function TablePreview({
  data,
  variant = "plain",
  filename,
  cellClassName,
}: TablePreviewProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showToolbar = variant === "with-toolbar";

  async function handleDownload() {
    setIsDownloading(true);
    setError(null);
    try {
      const { triggerBrowserDownload, writeTableDataToBlob } = await import("@/lib/spreadsheet/client/xlsxIo");
      triggerBrowserDownload(writeTableDataToBlob(data), filename || defaultFilename(data));
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Excel 下载失败");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="group/table-preview">
      {showToolbar ? (
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading}
            className="inline-flex items-center gap-1 text-[12px] text-[#6B7280] transition-opacity hover:text-[#1F2328] disabled:cursor-not-allowed disabled:opacity-50 md:opacity-0 md:group-hover/table-preview:opacity-100 md:focus-visible:opacity-100"
          >
            <Download className="h-3.5 w-3.5" />
            {isDownloading ? "导出中" : "下载 Excel"}
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]">
        <table className="min-w-full border-collapse text-left text-[13px]">
          <thead className="bg-[#F8F9FB] text-[#6B7280]">
            <tr>
              {data.headers.map((header, headerIndex) => (
                <th key={`${headerIndex}-${header}`} className="border-b border-[#E5E7EB] px-3 py-2 font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className={data.highlight?.includes(rowIndex) ? "bg-[#FFF9E8]" : "bg-white"}>
                {data.headers.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={cn("border-b border-[#EEF1F4] px-3 py-2 align-top", cellClassName?.(rowIndex, cellIndex))}
                  >
                    {row[cellIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <div className="mt-1 text-[12px] text-[#B42318]">{error}</div> : null}
    </div>
  );
}
