import type { ToolPermissionDecision, ToolPermissionRequest } from "./types";

type PendingRequest = {
  request: ToolPermissionRequest;
  resolve: (decision: ToolPermissionDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  state: "active" | "detached";
};

const pending = new Map<string, PendingRequest>();

export function getPendingToolPermissionRequest(requestId: string) {
  return pending.get(requestId)?.request ?? null;
}

export function getToolPermissionRequestState(requestId: string) {
  return pending.get(requestId)?.state ?? null;
}

export function createToolPermissionRequest(
  request: ToolPermissionRequest,
  options: { timeoutMs?: number } = {},
) {
  const existing = pending.get(request.id);
  if (existing) return existing.request;
  const timer =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? setTimeout(() => {
          resolveToolPermissionDecision({
            requestId: request.id,
            decision: "deny",
            scope: "deny",
          });
        }, options.timeoutMs)
      : undefined;
  pending.set(request.id, {
    request,
    resolve: () => undefined,
    timer,
    settled: false,
    state: "active",
  });
  return request;
}

export function waitForToolPermissionDecision(
  request: ToolPermissionRequest,
  options: { timeoutMs?: number } = {},
) {
  const existing = pending.get(request.id);
  if (existing) {
    return new Promise<ToolPermissionDecision>((resolve) => {
      existing.resolve = resolve;
    });
  }
  return new Promise<ToolPermissionDecision>((resolve) => {
    const timer =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? setTimeout(() => {
            resolveToolPermissionDecision({
              requestId: request.id,
              decision: "deny",
              scope: "deny",
            });
          }, options.timeoutMs)
        : undefined;
    pending.set(request.id, {
      request,
      resolve,
      timer,
      settled: false,
      state: "active",
    });
  });
}

export function resolveToolPermissionDecision(decision: ToolPermissionDecision) {
  const item = pending.get(decision.requestId);
  if (!item || item.settled) return false;
  const hadActiveWaiter = item.state === "active";
  item.settled = true;
  if (item.timer) clearTimeout(item.timer);
  pending.delete(decision.requestId);
  if (hadActiveWaiter) item.resolve(decision);
  return hadActiveWaiter;
}

export function cancelToolPermissionRequest(requestId: string) {
  return resolveToolPermissionDecision({
    requestId,
    decision: "deny",
    scope: "deny",
  });
}

export function detachToolPermissionRequest(requestId: string, reason = "process_lost") {
  const item = pending.get(requestId);
  if (!item || item.settled) return false;
  if (item.state === "detached") return true;
  if (item.timer) {
    clearTimeout(item.timer);
    item.timer = undefined;
  }
  item.state = "detached";
  item.request = {
    ...item.request,
    detachedAt: new Date().toISOString(),
    detachedReason: reason,
  };
  const resolve = item.resolve;
  item.resolve = () => undefined;
  resolve({
    requestId,
    decision: "deny",
    scope: "deny",
    detached: true,
  });
  return true;
}
