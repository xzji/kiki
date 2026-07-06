"use client";

import { ExternalLink, Play } from "lucide-react";
import { useMemo, useState } from "react";

import type { ArtifactRef } from "@/types/artifact";

function hostnameFromUrl(value?: string) {
  if (!value) return "外部网站";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "外部网站";
  }
}

export function ExternalEmbedSurface({ artifact }: { artifact: ArtifactRef }) {
  const [loaded, setLoaded] = useState(false);
  const embedUrl = artifact.embedUrl || artifact.previewUrl || artifact.url;
  const host = useMemo(() => hostnameFromUrl(embedUrl), [embedUrl]);

  if (!embedUrl) return null;

  return (
    <section className="rounded-xl border border-line bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-ink-faint">外部嵌入</div>
          <h3 className="mt-1 text-[15px] font-semibold text-ink">{artifact.label}</h3>
          <p className="mt-1 text-[13px] text-ink-soft">
            内容由 {host} 提供。若该网站禁止嵌入，可在新窗口打开。
          </p>
        </div>
        <a
          href={artifact.url || embedUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-white px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-subtle"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          新窗口打开
        </a>
      </div>
      {loaded ? (
        <iframe
          src={embedUrl}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen={artifact.allowFullScreen !== false}
          referrerPolicy="strict-origin-when-cross-origin"
            className="h-[60dvh] max-h-[420px] w-full rounded-xl border border-line-strong bg-black md:h-[420px]"
          title={artifact.label}
        />
      ) : (
        <button
          type="button"
          onClick={() => setLoaded(true)}
          className="flex h-[220px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface-subtle text-center hover:bg-info-bg"
        >
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-white text-info-strong shadow-sm">
            <Play className="h-5 w-5 fill-current" />
          </span>
          <span className="text-[14px] font-semibold text-ink">加载外部内容</span>
          <span className="mt-1 text-[12px] text-ink-soft">点击后会从 {host} 加载 iframe 内容</span>
        </button>
      )}
    </section>
  );
}
