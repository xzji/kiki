"use client";

import { ExternalLink, Link } from "lucide-react";

import type { ArtifactRef } from "@/types/artifact";

export function LinkCard({ artifact }: { artifact: ArtifactRef }) {
  const href = artifact.previewUrl || `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  return (
    <div className="rounded-xl border border-[#E5E7EB] bg-white p-4 shadow-[0_6px_18px_rgba(15,23,42,0.03)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-[#F8F9FB] p-2 text-[#6B7280]">
          <Link className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-[#1F2328]">{artifact.label}</div>
          {artifact.summary ? <div className="mt-1 text-[13px] leading-5 text-[#6B7280]">{artifact.summary}</div> : null}
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#D0D7DE] px-3 py-1.5 text-[12px] text-[#1F2328] hover:bg-[#F6F8FA]"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        打开链接
      </a>
    </div>
  );
}
