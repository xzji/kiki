"use client";

import { useEffect, useState } from "react";

function readDocumentVisible() {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function useDocumentVisible() {
  const [visible, setVisible] = useState(readDocumentVisible);

  useEffect(() => {
    const update = () => setVisible(readDocumentVisible());
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}
