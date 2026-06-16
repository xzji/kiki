import type { RuntimeToolPermissionRule } from "@/types/runtime";

const sessionRules = new Map<string, RuntimeToolPermissionRule[]>();

export function getToolPermissionSessionKey(input: {
  conversationId?: string;
  taskInstanceId?: string;
  runtimeEnvId: string;
}) {
  if (input.taskInstanceId) return `task:${input.taskInstanceId}:${input.runtimeEnvId}`;
  if (input.conversationId) return `conversation:${input.conversationId}:${input.runtimeEnvId}`;
  return `runtime:${input.runtimeEnvId}`;
}

export function getSessionToolPermissionRules(key: string) {
  return sessionRules.get(key) ?? [];
}

export function addSessionToolPermissionRule(key: string, rule: RuntimeToolPermissionRule) {
  const current = sessionRules.get(key) ?? [];
  if (current.some((item) => item.pattern === rule.pattern)) return current;
  const next = [...current, rule];
  sessionRules.set(key, next);
  return next;
}

export function clearSessionToolPermissionRules(key: string) {
  sessionRules.delete(key);
}
