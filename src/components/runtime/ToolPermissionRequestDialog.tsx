"use client";

import { useEffect, useState } from "react";

import type { ClaudeStreamEvent } from "@/types/runtime";

type ToolPermissionRequestEvent = Extract<ClaudeStreamEvent, { type: "tool_permission_request" }>;
type ToolPermissionScope = "once" | "conversation" | "runtime" | "deny";
const resolvedRequestIds = new Set<string>();
const RESOLVED_EVENT = "kiki:tool-permission-resolved";

export function ToolPermissionRequestDialog({
  request,
  onResolved,
  onClose,
  variant = "modal",
}: {
  request: ToolPermissionRequestEvent;
  onResolved: () => void;
  onClose?: () => void;
  variant?: "modal" | "inline";
}) {
  const [rule, setRule] = useState(request.suggestedRule || request.toolName);
  const [pendingScope, setPendingScope] = useState<ToolPermissionScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(() => resolvedRequestIds.has(request.requestId));

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string }>).detail;
      if (detail?.requestId === request.requestId) setResolved(true);
    };
    window.addEventListener(RESOLVED_EVENT, listener);
    return () => window.removeEventListener(RESOLVED_EVENT, listener);
  }, [request.requestId]);

  const submit = async (scope: ToolPermissionScope) => {
    if (pendingScope) return;
    setPendingScope(scope);
    setError(null);
    try {
      const decision = scope === "deny" ? "deny" : "allow";
      const response = await fetch(`/api/tool-permissions/${request.requestId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          scope,
          rule: decision === "allow" ? rule.trim() : undefined,
          runtimeEnvId: request.runtimeEnvId,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (!response.ok || data.ok === false) {
        throw new Error(data.reason || "工具权限决策提交失败");
      }
      resolvedRequestIds.add(request.requestId);
      window.dispatchEvent(new CustomEvent(RESOLVED_EVENT, { detail: { requestId: request.requestId } }));
      setResolved(true);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "工具权限决策提交失败");
    } finally {
      setPendingScope(null);
    }
  };

  const content = (
    <div className={variant === "modal" ? "w-full max-w-[560px] rounded-2xl border border-line bg-white p-5 shadow-xl" : "rounded-2xl border border-line bg-surface-subtle p-4"}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[14px] font-semibold text-[#111]">需要授权工具运行</div>
            <div className="mt-1 text-[12px] leading-5 text-ink-soft">
              Claude 请求使用未预授权工具。你可以只允许本次，也可以沉淀为会话或 Runtime 规则。
            </div>
          </div>
          {onClose ? (
            <button type="button" onClick={onClose} className="text-[18px] leading-none text-ink-soft">
              ×
            </button>
          ) : null}
        </div>

        <div className="mt-4 grid gap-2 text-[12px]">
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-ink-soft">工具</span>
            <span className="break-all font-mono text-[#111]">{request.toolName}</span>
          </div>
          <label className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
            <span className="text-ink-soft">规则</span>
            <input
              value={rule}
              onChange={(event) => setRule(event.target.value)}
              className="h-8 rounded-lg border border-line px-2 font-mono text-[12px] outline-none focus:border-[#111]"
            />
          </label>
        </div>

        {resolved ? (
          <div className="mt-4 rounded-xl border border-success-border bg-success-bg px-3 py-2 text-[12px] text-success">
            已处理该授权请求。
          </div>
        ) : (
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => void submit("once")}
            disabled={Boolean(pendingScope)}
            className="h-10 rounded-xl border border-[#111] bg-[#111] px-3 text-left text-[13px] text-white disabled:opacity-60"
          >
            本次允许
          </button>
          <button
            type="button"
            onClick={() => void submit("conversation")}
            disabled={Boolean(pendingScope)}
            className="h-10 rounded-xl border border-line bg-white px-3 text-left text-[13px] text-[#111] disabled:opacity-60"
          >
            本会话内始终允许
          </button>
          <button
            type="button"
            onClick={() => void submit("runtime")}
            disabled={Boolean(pendingScope)}
            className="h-10 rounded-xl border border-line bg-white px-3 text-left text-[13px] text-[#111] disabled:opacity-60"
          >
            始终允许并写入 Runtime 策略
          </button>
          <button
            type="button"
            onClick={() => void submit("deny")}
            disabled={Boolean(pendingScope)}
            className="h-10 rounded-xl border border-danger-border bg-white px-3 text-left text-[13px] text-danger-hover disabled:opacity-60"
          >
            拒绝
          </button>
        </div>
        )}

        {error ? <div className="mt-3 text-[12px] leading-5 text-danger-hover">{error}</div> : null}
      </div>
  );

  if (variant === "inline") return content;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      {content}
    </div>
  );
}
