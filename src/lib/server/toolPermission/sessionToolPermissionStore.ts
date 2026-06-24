import type { RuntimeToolPermissionRule } from "@/types/runtime";

// 与 toolPermissionBroker 同理：respond 路由（API bundle）写入会话级授权规则，匹配侧在另一份
// 模块实例读取，模块级 const 不共享。挂到 globalThis 保证「本会话内始终允许」跨 bundle 生效。
const SESSION_RULES_STATE_KEY = Symbol.for("kiki.server.toolPermission.sessionRules");

function getSessionRulesMap(): Map<string, RuntimeToolPermissionRule[]> {
  const globalRef = globalThis as typeof globalThis & {
    [SESSION_RULES_STATE_KEY]?: Map<string, RuntimeToolPermissionRule[]>;
  };
  if (!globalRef[SESSION_RULES_STATE_KEY]) {
    globalRef[SESSION_RULES_STATE_KEY] = new Map<string, RuntimeToolPermissionRule[]>();
  }
  return globalRef[SESSION_RULES_STATE_KEY];
}

const sessionRules = getSessionRulesMap();

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

export function addSessionToolPermissionRules(key: string, rules: RuntimeToolPermissionRule[] | undefined) {
  let next = sessionRules.get(key) ?? [];
  for (const rule of rules ?? []) {
    if (!rule.pattern || next.some((item) => item.pattern === rule.pattern)) continue;
    next = [...next, rule];
  }
  if (next.length > 0) sessionRules.set(key, next);
  return next;
}

export function seedSessionToolPermissionRules(input: {
  conversationId?: string;
  taskInstanceId?: string;
  runtimeEnvId?: string;
  rules?: RuntimeToolPermissionRule[];
}) {
  if (!input.runtimeEnvId) return [];
  const key = getToolPermissionSessionKey({
    conversationId: input.conversationId,
    taskInstanceId: input.taskInstanceId,
    runtimeEnvId: input.runtimeEnvId,
  });
  return addSessionToolPermissionRules(key, input.rules);
}

export function clearSessionToolPermissionRules(key: string) {
  sessionRules.delete(key);
}
