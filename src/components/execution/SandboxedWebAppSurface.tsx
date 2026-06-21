"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import type { ArtifactRef } from "@/types/artifact";

type SaveStatus = "idle" | "loading" | "saving" | "saved" | "failed";

type WebAppEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

type WebAppMessage = {
  source?: string;
  type?: string;
  artifactId?: string;
  bridgeVersion?: number;
  state?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  event?: WebAppEvent;
  height?: number;
  requestId?: string;
  url?: string;
  options?: {
    responseType?: "json" | "text";
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function messageSize(value: unknown) {
  return new Blob([JSON.stringify(value ?? null)]).size;
}

function statusText(status: SaveStatus, savedAt?: string) {
  if (status === "loading") return "加载状态中";
  if (status === "saving") return "保存中";
  if (status === "failed") return "保存失败";
  if (status === "saved" && savedAt) return `已保存 ${new Date(savedAt).toLocaleTimeString()}`;
  return "运行中";
}

export function SandboxedWebAppSurface({ artifact }: { artifact: ArtifactRef }) {
  const isMobile = useIsMobileViewport();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const stateRef = useRef<Record<string, unknown>>({});
  const pendingEventRef = useRef<WebAppEvent | undefined>(undefined);
  const saveTimerRef = useRef<number | null>(null);
  const [height, setHeight] = useState(420);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const previewUrl = artifact.previewUrl || `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`;

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({
      source: "kiki-host",
      artifactId: artifact.id,
      ...message,
    }, "*");
  }, [artifact.id]);

  const saveState = useCallback(async () => {
    setStatus("saving");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: stateRef.current,
          event: pendingEventRef.current,
        }),
      });
      const payload = await response.json() as { ok?: boolean; reason?: string; updatedAt?: string; state?: Record<string, unknown> };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.reason || "保存失败");
      }
      if (isRecord(payload.state)) stateRef.current = payload.state;
      setSavedAt(payload.updatedAt ?? new Date().toISOString());
      setStatus("saved");
      setError(null);
      pendingEventRef.current = undefined;
      postToFrame({ type: "state.saved", savedAt: payload.updatedAt ?? new Date().toISOString() });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "保存失败";
      setStatus("failed");
      setError(message);
      postToFrame({ type: "error", message });
    }
  }, [artifact.id, postToFrame]);

  const scheduleSave = useCallback((event?: WebAppEvent) => {
    pendingEventRef.current = event;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveState();
    }, 300);
  }, [saveState]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/state`)
      .then(async (response) => {
        const payload = await response.json() as { ok?: boolean; state?: Record<string, unknown>; updatedAt?: string; reason?: string };
        if (!response.ok || !payload.ok) throw new Error(payload.reason || "状态加载失败");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        stateRef.current = isRecord(payload.state) ? payload.state : {};
        setSavedAt(payload.updatedAt);
        setStatus(payload.updatedAt ? "saved" : "idle");
        postToFrame({ type: "state.init", state: stateRef.current });
      })
      .catch((loadError) => {
        if (cancelled) return;
        setStatus("failed");
        setError(loadError instanceof Error ? loadError.message : "状态加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, postToFrame, reloadKey]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data as WebAppMessage;
      if (!message || message.source !== "kiki-webapp") return;
      if (message.artifactId !== artifact.id || message.bridgeVersion !== 1) return;
      if (messageSize(message) > 16 * 1024) {
        setError("小应用消息过大，已拒绝保存");
        return;
      }

      if (message.type === "ready") {
        postToFrame({ type: "state.init", state: stateRef.current });
        return;
      }
      if (message.type === "height.report" && typeof message.height === "number") {
        setHeight(Math.min(Math.max(message.height, 320), 1200));
        return;
      }
      if (message.type === "state.replace" && isRecord(message.state)) {
        stateRef.current = message.state;
        scheduleSave(message.event);
        return;
      }
      if (message.type === "state.patch" && isRecord(message.patch)) {
        stateRef.current = { ...stateRef.current, ...message.patch };
        scheduleSave(message.event);
        return;
      }
      if (message.type === "internet.fetch" && typeof message.requestId === "string" && typeof message.url === "string") {
        if (messageSize({ url: message.url, options: message.options }) > 8 * 1024) {
          postToFrame({ type: "internet.fetch.error", requestId: message.requestId, reason: "公网请求参数过大" });
          return;
        }
        fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/internet-fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: message.url,
            responseType: message.options?.responseType,
          }),
        })
          .then(async (response) => {
            const payload = await response.json() as { ok?: boolean; reason?: string };
            if (!response.ok || !payload.ok) throw new Error(payload.reason || "公网请求失败");
            postToFrame({ type: "internet.fetch.result", requestId: message.requestId, result: payload });
          })
          .catch((fetchError) => {
            postToFrame({
              type: "internet.fetch.error",
              requestId: message.requestId,
              reason: fetchError instanceof Error ? fetchError.message : "公网请求失败",
            });
          });
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [artifact.id, postToFrame, scheduleSave]);

  return (
    <section className="rounded-xl border border-[#DDE7FF] bg-[#F8FBFF] p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-[#0D47A1]">可执行小应用</div>
          <h3 className="mt-1 text-[15px] font-semibold text-[#1F2328]">{artifact.label}</h3>
          {artifact.summary ? <p className="mt-1 text-[13px] text-[#6B7280]">{artifact.summary}</p> : null}
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <span className={status === "failed" ? "text-[#B42318]" : "text-[#4B5563]"}>{statusText(status, savedAt)}</span>
          <button
            type="button"
            onClick={() => {
              setReloadKey((value) => value + 1);
              setError(null);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-[#D0D7DE] bg-white px-2 py-1 text-[#1F2328] hover:bg-[#F6F8FA]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重载
          </button>
        </div>
      </div>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        sandbox="allow-scripts"
        src={previewUrl}
        className="w-full rounded-xl border border-[#D0D7DE] bg-white"
          style={{ height: isMobile ? `min(${height}px, 60dvh)` : height }}
        title={artifact.label}
        referrerPolicy="strict-origin-when-cross-origin"
      />
      {error ? <div className="mt-2 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[12px] text-[#B42318]">{error}</div> : null}
    </section>
  );
}
