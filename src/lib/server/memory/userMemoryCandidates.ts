import { getCurrentUserId } from "@/lib/server/context/userContext";
import { getUserMemoryDir } from "@/lib/server/storage/paths";
import {
  hashMemoryContent,
  normalizeMemoryLine,
  readMemoryFile,
  writeMemoryFileAtomic,
} from "@/lib/server/memory/markdownMemoryDocument";
import { withMemoryMutex } from "@/lib/server/memory/memoryMutex";
import type { UserMemoryPatch } from "@/lib/server/memory/memoryTypes";
import { redactInternalIdentifiers } from "@/lib/server/workspace/contextPack";
import path from "path";

export type UserMemoryCandidate = {
  candidateKey: string;
  patch: UserMemoryPatch;
  sourceConversationIds: string[];
  hitCount: number;
  confidence: UserMemoryPatch["confidence"];
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

type CandidateFile = {
  version: 1;
  candidates: UserMemoryCandidate[];
};

function getUserMemoryCandidatesFilePath() {
  return path.join(getUserMemoryDir(), "candidates.json");
}

function stableCandidateKey(patch: UserMemoryPatch) {
  return [
    patch.section,
    patch.op,
    normalizeMemoryLine(patch.content || patch.oldText || "").toLowerCase(),
  ].join(":");
}

function sanitizePatch(patch: UserMemoryPatch): UserMemoryPatch {
  return {
    ...patch,
    content: patch.content ? redactInternalIdentifiers(normalizeMemoryLine(patch.content)) : patch.content,
    oldText: patch.oldText ? redactInternalIdentifiers(normalizeMemoryLine(patch.oldText)) : patch.oldText,
  };
}

function readCandidatesFile(): CandidateFile {
  const file = readMemoryFile(getUserMemoryCandidatesFilePath());
  if (!file.content.trim()) return { version: 1, candidates: [] };
  try {
    const parsed = JSON.parse(file.content) as CandidateFile;
    return {
      version: 1,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    };
  } catch {
    return { version: 1, candidates: [] };
  }
}

function writeCandidatesFile(file: CandidateFile) {
  writeMemoryFileAtomic(getUserMemoryCandidatesFilePath(), `${JSON.stringify(file, null, 2)}\n`);
}

export async function recordUserMemoryCandidates(input: {
  conversationId: string;
  patches: UserMemoryPatch[];
}) {
  const highConfidencePatches = input.patches.filter((patch) => patch.confidence === "high");
  if (highConfidencePatches.length === 0) return { recorded: 0 };

  const userId = getCurrentUserId();
  return withMemoryMutex(`user-candidates:${userId}`, () => {
    const now = new Date().toISOString();
    const file = readCandidatesFile();
    const byKey = new Map(file.candidates.map((candidate) => [candidate.candidateKey, candidate]));

    for (const rawPatch of highConfidencePatches) {
      const patch = sanitizePatch(rawPatch);
      const candidateKey = stableCandidateKey(patch);
      const existing = byKey.get(candidateKey);
      if (existing) {
        existing.hitCount += 1;
        existing.lastSeenAt = now;
        if (!existing.sourceConversationIds.includes(input.conversationId)) {
          existing.sourceConversationIds.push(input.conversationId);
        }
        continue;
      }
      byKey.set(candidateKey, {
        candidateKey,
        patch,
        sourceConversationIds: [input.conversationId],
        hitCount: 1,
        confidence: patch.confidence,
        contentHash: hashMemoryContent(patch.content || patch.oldText || ""),
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }

    writeCandidatesFile({ version: 1, candidates: Array.from(byKey.values()) });
    return { recorded: highConfidencePatches.length };
  });
}

export function listUserMemoryCandidates() {
  return readCandidatesFile().candidates;
}

export async function removeUserMemoryCandidates(candidateKeys: string[]) {
  if (candidateKeys.length === 0) return { removed: 0 };
  const userId = getCurrentUserId();
  return withMemoryMutex(`user-candidates:${userId}`, () => {
    const remove = new Set(candidateKeys);
    const file = readCandidatesFile();
    const next = file.candidates.filter((candidate) => !remove.has(candidate.candidateKey));
    writeCandidatesFile({ version: 1, candidates: next });
    return { removed: file.candidates.length - next.length };
  });
}

export async function cleanupUserMemoryCandidatesForConversation(conversationId: string) {
  const userId = getCurrentUserId();
  return withMemoryMutex(`user-candidates:${userId}`, () => {
    return cleanupUserMemoryCandidatesForConversationSync(conversationId);
  });
}

export function cleanupUserMemoryCandidatesForConversationSync(conversationId: string) {
  const file = readCandidatesFile();
  let prunedSources = 0;
  const nextCandidates = file.candidates
    .map((candidate) => {
      const sourceConversationIds = candidate.sourceConversationIds.filter((id) => id !== conversationId);
      if (sourceConversationIds.length !== candidate.sourceConversationIds.length) {
        prunedSources += candidate.sourceConversationIds.length - sourceConversationIds.length;
      }
      return {
        ...candidate,
        sourceConversationIds,
      };
    })
    .filter((candidate) => candidate.sourceConversationIds.length > 0);
  writeCandidatesFile({ version: 1, candidates: nextCandidates });
  return {
    removed: file.candidates.length - nextCandidates.length,
    prunedSources,
  };
}
