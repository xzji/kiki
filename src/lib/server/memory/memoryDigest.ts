import { normalizeClaudeJsonText, buildJsonParseCandidates, parseJsonWithCandidates } from "@/lib/server/claude/jsonRepair";
import { runRuntimePromptJson } from "@/lib/server/runtime/runtimeTransport";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import { applySessionMemoryDigest, readSessionMemoryForPrompt } from "@/lib/server/memory/conversationMemoryService";
import { applyUserMemoryDigest, readRelevantUserProfileMemoryForPrompt } from "@/lib/server/memory/userMemoryService";
import { recordUserMemoryCandidates } from "@/lib/server/memory/userMemoryCandidates";
import { maybeRunBackgroundMemoryReview } from "@/lib/server/memory/backgroundMemoryReview";
import { getCurrentUserId } from "@/lib/server/context/userContext";
import { runUserMemoryConsolidation } from "@/lib/server/memory/userMemoryConsolidation";
import type { MemoryDigestResult, UserMemoryPatch } from "@/lib/server/memory/memoryTypes";
import { sanitizeConversationMessages } from "@/lib/server/workspace/contextPack";
import type { RuntimeEnvironment } from "@/types/runtime";

function isConfidence(value: unknown): value is MemoryDigestResult["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}

function isUserMemoryPatch(value: unknown): value is UserMemoryPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.op === "add" || record.op === "replace" || record.op === "remove") &&
    typeof record.section === "string" &&
    typeof record.reason === "string" &&
    isConfidence(record.confidence)
  );
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function validateMemoryDigestResult(value: unknown): MemoryDigestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory digest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!isConfidence(record.confidence)) {
    throw new Error("memory digest confidence is invalid");
  }

  const result: MemoryDigestResult = { confidence: record.confidence };
  if (record.sessionPatch && typeof record.sessionPatch === "object" && !Array.isArray(record.sessionPatch)) {
    const patch = record.sessionPatch as Record<string, unknown>;
    result.sessionPatch = {
      role: readStringArray(patch, "role"),
      goals: readStringArray(patch, "goals"),
      facts: readStringArray(patch, "facts"),
      openItems: readStringArray(patch, "openItems"),
      decisions: readStringArray(patch, "decisions"),
      remove: readStringArray(patch, "remove"),
    };
  }
  if (Array.isArray(record.userPatch)) {
    result.userPatch = record.userPatch.filter(isUserMemoryPatch);
  }
  if (typeof record.profileBaseHash === "string") {
    result.profileBaseHash = record.profileBaseHash;
  }
  return result;
}

function buildMemoryDigestPrompt(input: {
  userMessage: string;
  assistantText: string;
  recentMessages: string;
  sessionMemory: string;
  userMemory: string;
  profileHash: string;
}) {
  return `你是 KiKi 的 memory digest 模块。你只输出 JSON，不输出 Markdown。

目标：从本轮对话中提炼后续仍有用的记忆。默认只更新 sessionPatch；只有用户明确表达长期偏好/长期事实时，才输出 high confidence 的 userPatch。

硬规则：
- 不要记录流水账、寒暄、一次性细节。
- 不要记录敏感信息，除非用户明确要求记住。
- 不要记录或复述 conv-*、goal-*、task-*、inst-* 等内部 ID。
- M1(sessionPatch) confidence >= medium 才会写入。
- M2(userPatch) 必须 confidence=high，且只接受 add/replace/remove patch。
- profileBaseHash 必须等于输入中的 profileHash。

输出 JSON 结构：
{
  "sessionPatch": {
    "role": string[],
    "goals": string[],
    "facts": string[],
    "openItems": string[],
    "decisions": string[],
    "remove": string[]
  },
  "userPatch": [
    {
      "op": "add" | "replace" | "remove",
      "section": "communicationPreferences" | "workPreferences" | "projectPreferences" | "longTermFacts" | "prohibitions",
      "content": string,
      "oldText": string,
      "reason": string,
      "confidence": "low" | "medium" | "high"
    }
  ],
  "profileBaseHash": string,
  "confidence": "low" | "medium" | "high"
}

当前 profileHash:
${input.profileHash}

当前用户长期记忆 M2:
${input.userMemory || "(空)"}

当前会话记忆 M1:
${input.sessionMemory || "(空)"}

最近消息:
${input.recentMessages || "(空)"}

本轮 user message:
${input.userMessage}

本轮 assistant final text:
${input.assistantText}`;
}

export async function runMemoryDigest(input: {
  conversationId: string;
  userMessage: string;
  assistantText: string;
  runtimeEnv: RuntimeEnvironment;
  cwd: string;
  explicitMemoryIntent?: boolean;
  signal?: AbortSignal;
}) {
  const recentMessages = sanitizeConversationMessages(
    listConversationMessages({ conversationId: input.conversationId, limit: 12 }),
  )
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const sessionMemory = readSessionMemoryForPrompt(input.conversationId);
  const userMemory = readRelevantUserProfileMemoryForPrompt(input.userMessage);

  const result = await runRuntimePromptJson({
    prompt: buildMemoryDigestPrompt({
      userMessage: input.userMessage,
      assistantText: input.assistantText,
      recentMessages,
      sessionMemory,
      userMemory: userMemory.content,
      profileHash: userMemory.hash,
    }),
    runtimeEnv: input.runtimeEnv,
    cwd: input.cwd,
    permissionMode: "readonly",
    filePolicy: input.runtimeEnv.filePolicy,
    channelPolicy: { mode: "readonly_json" },
    toolPolicy: { mode: "deny_all" },
    abortSignal: input.signal,
    failureMessage: "memory digest 调用失败",
    traceContext: { scope: "memory_digest", stepLabel: "会话记忆提炼" },
  });

  const normalized = normalizeClaudeJsonText(result.raw);
  const attempt = parseJsonWithCandidates(
    buildJsonParseCandidates(normalized),
    validateMemoryDigestResult,
  );
  if (!attempt.ok) {
    throw attempt.error;
  }

  await applySessionMemoryDigest({ conversationId: input.conversationId, digest: attempt.parsed });
  if (attempt.parsed.userPatch?.length) {
    if (input.explicitMemoryIntent) {
      const writeResult = await applyUserMemoryDigest({ digest: attempt.parsed });
      if ("overLimit" in writeResult && writeResult.overLimit) {
        const consolidatedPatches = await runUserMemoryConsolidation({
          profile: userMemory.content,
          pendingPatches: attempt.parsed.userPatch,
          runtimeEnv: input.runtimeEnv,
          cwd: input.cwd,
          signal: input.signal,
        });
        await applyUserMemoryDigest({
          digest: {
            confidence: "high",
            profileBaseHash: userMemory.hash,
            userPatch: consolidatedPatches,
          },
        });
      }
    } else {
      await recordUserMemoryCandidates({
        conversationId: input.conversationId,
        patches: attempt.parsed.userPatch,
      });
      maybeRunBackgroundMemoryReview({ userId: getCurrentUserId() });
    }
  }
  return attempt.parsed;
}
