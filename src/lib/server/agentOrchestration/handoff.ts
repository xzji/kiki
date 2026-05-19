import type { AgentHandoff, AgentHandoffClaim, AgentRole } from "@/types/agentOrchestration";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function safeSummary(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : fallback;
}

export function createFallbackHandoff(input: {
  fromRole: AgentRole;
  toRole: AgentRole;
  rawOutput: string;
}): AgentHandoff {
  return {
    fromRole: input.fromRole,
    toRole: input.toRole,
    summary: input.rawOutput.trim().slice(0, 1200) || `${input.fromRole} 已完成，交给 ${input.toRole}。`,
    claims: [],
    decisions: [],
    openQuestions: [],
    risks: [],
    createdAt: new Date().toISOString(),
  };
}

export function normalizeHandoff(input: {
  fromRole: AgentRole;
  toRole: AgentRole;
  value: unknown;
  rawOutput: string;
}): AgentHandoff {
  const record = asRecord(input.value);
  if (!record) return createFallbackHandoff(input);
  const rawClaims = Array.isArray(record.claims) ? record.claims : [];
  const claims: AgentHandoffClaim[] = [];
  rawClaims.forEach((claim) => {
    const item = asRecord(claim);
    if (!item || typeof item.text !== "string" || !item.text.trim()) return;
    const confidence = item.confidence === "low" || item.confidence === "high" ? item.confidence : "medium";
    claims.push({
      text: item.text.trim(),
      confidence,
      evidence: stringArray(item.evidence),
    });
  });
  return {
    fromRole: input.fromRole,
    toRole: input.toRole,
    summary: safeSummary(record.summary, input.rawOutput.trim().slice(0, 1200) || `${input.fromRole} 已完成。`),
    claims,
    decisions: stringArray(record.decisions),
    openQuestions: stringArray(record.openQuestions),
    risks: stringArray(record.risks),
    filesTouched: stringArray(record.filesTouched),
    artifactRefs: stringArray(record.artifactRefs),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  };
}
