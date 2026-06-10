import { applyUserMemoryDigest } from "@/lib/server/memory/userMemoryService";
import {
  listUserMemoryCandidates,
  removeUserMemoryCandidates,
} from "@/lib/server/memory/userMemoryCandidates";
import { readUserProfileMemory } from "@/lib/server/memory/userMemoryService";
import type { MemoryDigestResult, UserMemoryPatch } from "@/lib/server/memory/memoryTypes";

function isPromotablePatch(patch: UserMemoryPatch) {
  if (patch.confidence !== "high") return false;
  const text = patch.content || patch.oldText || "";
  if (!text.trim()) return false;
  if (/\b(?:conv|goal|sub|task|inst)-[A-Za-z0-9_-]+\b/.test(text)) return false;
  return true;
}

export async function promoteStableUserMemoryCandidates() {
  const candidates = listUserMemoryCandidates();
  const promotable = candidates.filter(
    (candidate) =>
      candidate.confidence === "high" &&
      candidate.sourceConversationIds.length >= 2 &&
      isPromotablePatch(candidate.patch),
  );
  if (promotable.length === 0) return { promoted: 0 };

  const profile = readUserProfileMemory();
  const digest: MemoryDigestResult = {
    confidence: "high",
    profileBaseHash: profile.hash,
    userPatch: promotable.map((candidate) => candidate.patch),
  };
  const result = await applyUserMemoryDigest({ digest });
  if (!result.updated) return { promoted: 0, result };

  await removeUserMemoryCandidates(promotable.map((candidate) => candidate.candidateKey));
  return { promoted: promotable.length };
}
