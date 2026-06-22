"use client";

import type { ReactNode, Ref } from "react";

export function DeliverableArticle({
  label,
  title,
  headerActions,
  clipMaxHeight,
  bodyRef,
  bodyOverlay,
  children,
}: {
  label: string;
  title?: string;
  headerActions?: ReactNode;
  /** 限制卡片总高度，仅正文区域滚动 */
  clipMaxHeight?: number;
  bodyRef?: Ref<HTMLDivElement>;
  bodyOverlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      className={
        clipMaxHeight
          ? "flex flex-col rounded-xl border border-[#E5E7EB] bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)] md:p-5"
          : "rounded-xl border border-[#E5E7EB] bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)] md:p-5"
      }
      style={clipMaxHeight ? { maxHeight: clipMaxHeight } : undefined}
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="text-[12px] font-medium text-[#8C9198]">{label}</div>
        {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
      </div>
      {title ? (
        <h3 className="mt-2 shrink-0 text-[16px] font-semibold leading-7 text-[#1F2328]">{title}</h3>
      ) : null}
      {clipMaxHeight ? (
        <div className="relative mt-4 flex min-h-0 flex-1 flex-col">
          <div
            ref={bodyRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {children}
          </div>
          {bodyOverlay}
        </div>
      ) : (
        <div className="mt-4">{children}</div>
      )}
    </article>
  );
}
