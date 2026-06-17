"use client";

import { useEffect, useState, type Ref } from "react";

export function useElementOverflowing(ref: Ref<HTMLDivElement>, deps: unknown[]) {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node =
      typeof ref === "function" || !ref || !("current" in ref) ? null : ref.current;
    if (!node) return;

    const check = () => {
      setOverflowing(node.scrollHeight > node.clientHeight + 2);
    };

    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return overflowing;
}
