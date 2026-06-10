import type { UserMemoryPatch } from "@/lib/server/memory/memoryTypes";
import { normalizeClaudeJsonText, buildJsonParseCandidates, parseJsonWithCandidates } from "@/lib/server/claude/jsonRepair";
import { runRuntimePromptJson } from "@/lib/server/runtime/runtimeTransport";
import type { RuntimeEnvironment } from "@/types/runtime";

export function dedupeUserMemoryMarkdown(content: string) {
  const seenBySection = new Map<string, Set<string>>();
  let currentSection = "";
  const lines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      currentSection = heading[1];
      if (!seenBySection.has(currentSection)) seenBySection.set(currentSection, new Set());
      lines.push(line);
      continue;
    }

    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (bullet && currentSection) {
      const normalized = bullet[1].replace(/\s+/g, " ").trim().toLowerCase();
      const seen = seenBySection.get(currentSection) ?? new Set<string>();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      seenBySection.set(currentSection, seen);
    }
    lines.push(line);
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function buildUserMemoryConsolidationPrompt(input: {
  profile: string;
  pendingPatches: UserMemoryPatch[];
}) {
  return `你是 KiKi 的用户长期记忆 consolidation 模块。只输出 UserMemoryPatch[] JSON。

目标：在 profile.md 超过容量或出现重复时，输出 add/replace/remove patch，合并同义、重复、过时条目。

硬规则：
- 不输出整份 Markdown。
- 禁止删除用户显式写入或最近强调的偏好，除非 pending patch 明确替换。
- 不记录敏感信息或内部 ID。
- 所有 patch 必须 confidence=high。

当前 profile.md：
${input.profile || "(空)"}

待合并 patches：
${JSON.stringify(input.pendingPatches, null, 2)}`;
}

function validateConsolidationPatches(value: unknown): UserMemoryPatch[] {
  if (!Array.isArray(value)) throw new Error("consolidation result must be an array");
  return value.filter((item): item is UserMemoryPatch => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return (
      (record.op === "add" || record.op === "replace" || record.op === "remove") &&
      typeof record.section === "string" &&
      typeof record.reason === "string" &&
      record.confidence === "high"
    );
  });
}

export async function runUserMemoryConsolidation(input: {
  profile: string;
  pendingPatches: UserMemoryPatch[];
  runtimeEnv: RuntimeEnvironment;
  cwd: string;
  signal?: AbortSignal;
}) {
  const result = await runRuntimePromptJson({
    prompt: buildUserMemoryConsolidationPrompt({
      profile: input.profile,
      pendingPatches: input.pendingPatches,
    }),
    runtimeEnv: input.runtimeEnv,
    cwd: input.cwd,
    permissionMode: "readonly",
    filePolicy: input.runtimeEnv.filePolicy,
    channelPolicy: { mode: "readonly_json" },
    toolPolicy: { mode: "deny_all" },
    abortSignal: input.signal,
    failureMessage: "用户记忆 consolidation 调用失败",
    traceContext: { scope: "memory_consolidation", stepLabel: "用户长期记忆整理" },
  });
  const attempt = parseJsonWithCandidates(
    buildJsonParseCandidates(normalizeClaudeJsonText(result.raw)),
    validateConsolidationPatches,
  );
  if (!attempt.ok) throw attempt.error;
  return attempt.parsed;
}
