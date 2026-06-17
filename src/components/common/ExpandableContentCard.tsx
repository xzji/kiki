"use client";

import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";

import { useElementOverflowing } from "@/hooks/useElementOverflowing";
import { useMainContentInsets } from "@/hooks/useMainContentInsets";
import { cn } from "@/lib/utils";

export type ExpandableContentCardContext = {
  expandButton: ReactNode | null;
  bodyRef: Ref<HTMLDivElement>;
  bodyOverlay: ReactNode | null;
  clipMaxHeight: number | undefined;
  overflowing: boolean;
  expanded: boolean;
};

type ExpandableContentCardProps = {
  title: string;
  maxHeight?: number;
  expandLabel?: string;
  collapseLabel?: string;
  /** 开始全屏展开时回调，例如收起结果抽屉 */
  onExpandStart?: () => void;
  renderContent: (context: ExpandableContentCardContext) => ReactNode;
};

/**
 * 承载大块内容的可展开卡片：折叠态限高预览，超出时右上角全屏展开。
 * 展开层对齐主内容区，不遮挡左右侧栏；同一 React 树内 fixed 展开，避免 iframe 重建。
 */
export function ExpandableContentCard({
  title,
  maxHeight = 520,
  expandLabel = "全屏展开",
  collapseLabel = "收起",
  onExpandStart,
  renderContent,
}: ExpandableContentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { leftInset, rightInset } = useMainContentInsets();
  const overflowing = useElementOverflowing(bodyRef, [maxHeight, expanded]);

  const close = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, expanded]);

  const startExpand = useCallback(() => {
    onExpandStart?.();
    setExpanded(true);
  }, [onExpandStart]);

  const expandButton =
    !expanded && overflowing ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          startExpand();
        }}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[#57606A] transition hover:bg-[#F5F6F8] hover:text-[#1F2328]"
        aria-label={expandLabel}
      >
        <Maximize2 className="h-3.5 w-3.5" />
        {expandLabel}
      </button>
    ) : null;

  const bodyOverlay =
    !expanded && overflowing ? (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white via-white/90 to-transparent"
      />
    ) : null;

  const content = renderContent({
    expandButton,
    bodyRef,
    bodyOverlay,
    clipMaxHeight: expanded ? undefined : maxHeight,
    overflowing,
    expanded,
  });

  return (
    <div
      className={cn(
        expanded && "fixed inset-y-0 z-[120] flex min-h-0 flex-col bg-white",
      )}
      style={expanded ? { left: leftInset, right: rightInset } : undefined}
    >
      {expanded ? (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#E5E7EB] px-4">
          <div id={titleId} className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1F2328]">
            {title}
          </div>
          <button
            type="button"
            aria-label={collapseLabel}
            onClick={close}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[#57606A] transition hover:bg-[#F5F6F8] hover:text-[#1F2328]"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            {collapseLabel}
          </button>
        </header>
      ) : null}
      <div
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded ? true : undefined}
        aria-labelledby={expanded ? titleId : undefined}
        className={cn(
          expanded && "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        )}
      >
        <div className={cn(expanded && "mx-auto w-full max-w-3xl px-6 py-6")}>{content}</div>
      </div>
    </div>
  );
}
