import { getRecentArtifactInteractionStates } from "@/lib/server/repositories/artifactInteractionRepository";

const MAX_CONTEXT_CHARS = 3000;

type InteractionStateSummary = {
  artifactId: string;
  taskId?: string;
  instanceId?: string;
  state: Record<string, unknown>;
  events: Array<{ type: string }>;
  updatedAt: string;
};

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 10).map(compactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, item]) => [key, compactValue(item)]),
    );
  }
  if (typeof value === "string" && value.length > 300) return `${value.slice(0, 300)}...`;
  return value;
}

export function buildWebAppInteractionContext(input: { conversationId?: string }) {
  if (!input.conversationId) return "";
  const states = getRecentArtifactInteractionStates(input.conversationId, 5);
  if (!states.length) return "";
  const lines = (states as InteractionStateSummary[]).map((item, index) => {
    const stateSummary = JSON.stringify(compactValue(item.state), null, 2);
    const eventSummary = item.events.slice(-5).map((event) => event.type).join("、") || "无";
    return [
      `${index + 1}. artifactId: ${item.artifactId}`,
      `   updatedAt: ${item.updatedAt}`,
      `   taskId: ${item.taskId ?? "unknown"}`,
      `   instanceId: ${item.instanceId ?? "unknown"}`,
      `   state: ${stateSummary}`,
      `   recentEvents: ${eventSummary}`,
    ].join("\n");
  });
  const context = [
    "【用户小应用交互状态】",
    "以下数据来自用户在可执行 HTML 小应用中的真实操作，后续任务必须视为用户已明确提供的信息；如与用户最新输入冲突，以用户最新输入为准。",
    ...lines,
  ].join("\n");
  return context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n（小应用状态摘要已截断）` : context;
}
