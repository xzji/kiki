"use client";

import { Download, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";

import { SpreadsheetEditor } from "@/components/spreadsheet/SpreadsheetEditor";
import { XLSX_MIME } from "@/lib/spreadsheet/constants";
import type { ArtifactRef } from "@/types/artifact";

function formatBytes(size?: number) {
  if (!size || size <= 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function FileCard({ artifact }: { artifact: ArtifactRef }) {
  const href = artifact.previewUrl || `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const [showEditor, setShowEditor] = useState(false);
  const isXlsx = artifact.mime === XLSX_MIME || artifact.label.toLowerCase().endsWith(".xlsx");
  return (
    <div className="rounded-xl border border-[#E5E7EB] bg-white p-4 shadow-[0_6px_18px_rgba(15,23,42,0.03)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-[#F4F8FF] p-2 text-[#0D47A1]">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-[#1F2328]">{artifact.label}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
            <span>{artifact.mime || "文件"}</span>
            <span className="text-[#D0D7DE]">/</span>
            <span>{formatBytes(artifact.size)}</span>
          </div>
          {artifact.summary ? <div className="mt-2 text-[13px] leading-5 text-[#6B7280]">{artifact.summary}</div> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#D0D7DE] px-3 py-1.5 text-[12px] text-[#1F2328] hover:bg-[#F6F8FA]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          预览
        </a>
        <a
          href={href}
          download
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#1F2328] px-3 py-1.5 text-[12px] text-white hover:bg-[#374151]"
        >
          <Download className="h-3.5 w-3.5" />
          下载
        </a>
        {isXlsx ? (
          <button
            type="button"
            onClick={() => setShowEditor((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#D0D7DE] px-3 py-1.5 text-[12px] text-[#1F2328] hover:bg-[#F6F8FA]"
          >
            {showEditor ? "收起表格" : "展开为可编辑表格"}
          </button>
        ) : null}
      </div>
      {isXlsx && showEditor ? <SpreadsheetEditor artifact={artifact} /> : null}
    </div>
  );
}
