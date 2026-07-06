"use client";

import { FileCard } from "@/components/execution/FileCard";
import { LinkCard } from "@/components/execution/LinkCard";
import type { ArtifactRef } from "@/types/artifact";

export function ArtifactRenderer({
  refs,
  hasInteractiveSurface,
  bare = false,
}: {
  refs?: ArtifactRef[];
  hasInteractiveSurface?: boolean;
  bare?: boolean;
}) {
  const visibleRefs = refs?.filter((ref) => ref.kind === "file" || ref.kind === "external_link") ?? [];
  if (!visibleRefs.length) return null;

  const fileList = (
    <div className="space-y-3">
      {visibleRefs.map((ref) => {
        if (ref.kind === "file") return <FileCard key={ref.id} artifact={ref} />;
        return <LinkCard key={ref.id} artifact={ref} />;
      })}
    </div>
  );

  if (bare) {
    return (
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[12px] font-medium text-ink-faint">
              {hasInteractiveSurface ? "文件区域" : "文件产物"}
            </div>
            <h3 className="mt-1 text-[15px] font-semibold text-ink">
              {hasInteractiveSurface ? "可预览和下载的文件" : "本任务产出为文件"}
            </h3>
          </div>
          <span className="rounded-full bg-info-bg px-2 py-0.5 text-[12px] text-info-strong">{visibleRefs.length} 个文件</span>
        </div>
        {fileList}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[12px] font-medium text-ink-faint">
            {hasInteractiveSurface ? "文件区域" : "文件产物"}
          </div>
          <h3 className="mt-1 text-[15px] font-semibold text-ink">
            {hasInteractiveSurface ? "可预览和下载的文件" : "本任务产出为文件"}
          </h3>
        </div>
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-[12px] text-info-strong">{visibleRefs.length} 个文件</span>
      </div>
      {fileList}
    </section>
  );
}

export function ArtifactRefList({
  refs,
  hasInteractiveSurface,
  bare = false,
}: {
  refs?: ArtifactRef[];
  hasInteractiveSurface?: boolean;
  bare?: boolean;
}) {
  return <ArtifactRenderer refs={refs} hasInteractiveSurface={hasInteractiveSurface} bare={bare} />;
}

export function ArtifactSummaryChip({ refs, hasInteractiveSurface }: { refs?: ArtifactRef[]; hasInteractiveSurface?: boolean }) {
  const fileCount = refs?.filter((ref) => ref.kind === "file" || ref.kind === "external_link").length ?? 0;
  const webappCount = refs?.filter((ref) => ref.kind === "webapp").length ?? 0;
  const externalEmbedCount = refs?.filter((ref) => ref.kind === "external_embed").length ?? 0;
  if (!fileCount && !webappCount && !externalEmbedCount) return null;
  return (
    <>
      {webappCount ? (
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-info-strong">可执行小应用 {webappCount} 个</span>
      ) : null}
      {externalEmbedCount ? (
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-info-strong">外部嵌入 {externalEmbedCount} 个</span>
      ) : null}
      {fileCount ? (
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-info-strong">{hasInteractiveSurface ? "含文件产物" : "文件产物"} {fileCount} 个</span>
      ) : null}
    </>
  );
}
