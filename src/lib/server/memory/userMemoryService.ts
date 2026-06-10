import { getCurrentUserId } from "@/lib/server/context/userContext";
import { getUserProfileMemoryFilePath } from "@/lib/server/storage/paths";
import {
  hashMemoryContent,
  normalizeMemoryLine,
  readMemoryFile,
  writeMemoryFileAtomic,
} from "@/lib/server/memory/markdownMemoryDocument";
import { withMemoryMutex } from "@/lib/server/memory/memoryMutex";
import { dedupeUserMemoryMarkdown } from "@/lib/server/memory/userMemoryConsolidation";
import type { MemoryDigestResult, UserMemoryPatch } from "@/lib/server/memory/memoryTypes";
import { redactInternalIdentifiers } from "@/lib/server/workspace/contextPack";
import { appendMemoryAuditEvent } from "@/lib/server/memory/memoryAudit";

const USER_MEMORY_PROMPT_LIMIT_BYTES = 6 * 1024;
const USER_MEMORY_FILE_LIMIT_BYTES = 24 * 1024;

const USER_SECTION_TITLES: Record<UserMemoryPatch["section"], string> = {
  communicationPreferences: "沟通偏好",
  workPreferences: "工作偏好",
  projectPreferences: "项目偏好",
  longTermFacts: "长期事实",
  prohibitions: "禁止事项",
};

const DEFAULT_USER_MEMORY = `# User Memory

## 沟通偏好

## 工作偏好

## 项目偏好

## 长期事实

## 禁止事项
`;

const USER_MEMORY_SECTION_PRIORITY = [
  "禁止事项",
  "沟通偏好",
  "工作偏好",
  "项目偏好",
  "长期事实",
];

export function readUserProfileMemory() {
  return readMemoryFile(getUserProfileMemoryFilePath());
}

export async function writeUserProfileMemoryManual(input: {
  content: string;
  expectedHash?: string;
}) {
  const userId = getCurrentUserId();
  return withMemoryMutex(`user:${userId}`, () => {
    const current = readUserProfileMemory();
    if (input.expectedHash && current.hash !== input.expectedHash) {
      return { updated: false, conflict: true as const, currentHash: current.hash };
    }
    const content = redactInternalIdentifiers(input.content.trim());
    let next = content ? `${content}\n` : "";
    if (Buffer.byteLength(next, "utf8") > USER_MEMORY_FILE_LIMIT_BYTES) {
      next = dedupeUserMemoryMarkdown(next);
    }
    if (Buffer.byteLength(next, "utf8") > USER_MEMORY_FILE_LIMIT_BYTES) {
      return { updated: false, overLimit: true as const, currentHash: current.hash };
    }
    writeMemoryFileAtomic(getUserProfileMemoryFilePath(), next);
    const hash = hashMemoryContent(next);
    appendMemoryAuditEvent({
      target: "profile",
      source: "用户手动",
      action: next.trim() ? "write" : "clear",
      hash,
    });
    return { updated: true, hash };
  });
}

export function readUserProfileMemoryForPrompt() {
  const memory = readUserProfileMemory();
  const content = memory.content.trim();
  if (!content || content === DEFAULT_USER_MEMORY.trim()) {
    return { content: "", hash: memory.hash };
  }
  return {
    content: redactInternalIdentifiers(selectUserMemoryHotZoneForPrompt(content, "", USER_MEMORY_PROMPT_LIMIT_BYTES)),
    hash: memory.hash,
  };
}

export function readRelevantUserProfileMemoryForPrompt(query: string) {
  const memory = readUserProfileMemory();
  const content = memory.content.trim();
  if (!content || content === DEFAULT_USER_MEMORY.trim()) {
    return { content: "", hash: memory.hash };
  }
  return {
    content: redactInternalIdentifiers(selectUserMemoryHotZoneForPrompt(content, query, USER_MEMORY_PROMPT_LIMIT_BYTES)),
    hash: memory.hash,
  };
}

export function selectUserMemoryHotZoneForPrompt(content: string, query: string, maxBytes = USER_MEMORY_PROMPT_LIMIT_BYTES) {
  const trimmed = content.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;

  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/[\s,，。；;:：/\\|()[\]{}"'`]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  );
  const sectionRank = new Map(USER_MEMORY_SECTION_PRIORITY.map((section, index) => [section, index]));
  const entries: Array<{ section: string; text: string; score: number }> = [];
  let currentSection = "";
  for (const line of trimmed.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      currentSection = heading[1];
      continue;
    }
    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (!bullet?.[1] || !currentSection) continue;
    const lower = bullet[1].toLowerCase();
    let score = 100 - (sectionRank.get(currentSection) ?? 50);
    queryTerms.forEach((term) => {
      if (lower.includes(term)) score += 20;
    });
    entries.push({ section: currentSection, text: bullet[1], score });
  }

  const grouped = new Map<string, string[]>();
  for (const entry of entries.sort((a, b) => b.score - a.score)) {
    const next = new Map(grouped);
    next.set(entry.section, [...(next.get(entry.section) ?? []), entry.text]);
    const candidate = buildUserMemoryDocumentFromTitles(next);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      grouped.set(entry.section, next.get(entry.section) ?? []);
    }
  }
  return buildUserMemoryDocumentFromTitles(grouped).trim();
}

function buildUserMemoryDocumentFromTitles(sections: Map<string, string[]>) {
  const lines = ["# User Memory", ""];
  for (const title of USER_MEMORY_SECTION_PRIORITY) {
    const items = sections.get(title) ?? [];
    if (items.length === 0) continue;
    lines.push(`## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseSections(content: string) {
  const sections = new Map<UserMemoryPatch["section"], string[]>();
  for (const key of Object.keys(USER_SECTION_TITLES) as Array<UserMemoryPatch["section"]>) {
    sections.set(key, []);
  }

  let current: UserMemoryPatch["section"] | null = null;
  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current =
        (Object.entries(USER_SECTION_TITLES).find(([, title]) => title === heading[1])?.[0] as
          | UserMemoryPatch["section"]
          | undefined) ?? null;
      continue;
    }
    if (!current) continue;
    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (bullet?.[1]) sections.get(current)?.push(bullet[1]);
  }
  return sections;
}

function buildUserMemoryDocument(sections: Map<UserMemoryPatch["section"], string[]>) {
  const lines = ["# User Memory", ""];
  for (const key of Object.keys(USER_SECTION_TITLES) as Array<UserMemoryPatch["section"]>) {
    lines.push(`## ${USER_SECTION_TITLES[key]}`);
    for (const item of sections.get(key) ?? []) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function findExactIndex(items: string[], oldText: string | undefined) {
  if (!oldText) return -1;
  const target = normalizeMemoryLine(oldText).toLowerCase();
  return items.findIndex((item) => normalizeMemoryLine(item).toLowerCase() === target);
}

function applyUserPatch(sections: Map<UserMemoryPatch["section"], string[]>, patch: UserMemoryPatch) {
  if (patch.confidence !== "high") return;
  const items = sections.get(patch.section) ?? [];
  if (patch.op === "add") {
    const content = redactInternalIdentifiers(normalizeMemoryLine(patch.content ?? ""));
    if (!content) return;
    const exists = items.some((item) => normalizeMemoryLine(item).toLowerCase() === content.toLowerCase());
    if (!exists) items.push(content);
    sections.set(patch.section, items);
    return;
  }
  const matchIndex = findExactIndex(items, patch.oldText);
  if (matchIndex < 0) return;
  if (patch.op === "remove") {
    items.splice(matchIndex, 1);
  } else {
    const content = redactInternalIdentifiers(normalizeMemoryLine(patch.content ?? ""));
    if (!content) return;
    items[matchIndex] = content;
  }
  sections.set(patch.section, items);
}

export async function applyUserMemoryDigest(input: { digest: MemoryDigestResult }) {
  const patches = input.digest.userPatch?.filter((patch) => patch.confidence === "high") ?? [];
  if (patches.length === 0) return { updated: false };

  const userId = getCurrentUserId();
  return withMemoryMutex(`user:${userId}`, () => {
    const current = readUserProfileMemory();
    const sections = parseSections(current.content || DEFAULT_USER_MEMORY);
    for (const patch of patches) applyUserPatch(sections, patch);

    let next = buildUserMemoryDocument(sections);
    if (Buffer.byteLength(next, "utf8") > USER_MEMORY_FILE_LIMIT_BYTES) {
      next = dedupeUserMemoryMarkdown(next);
    }
    if (Buffer.byteLength(next, "utf8") > USER_MEMORY_FILE_LIMIT_BYTES) {
      return { updated: false, overLimit: true as const };
    }
    writeMemoryFileAtomic(getUserProfileMemoryFilePath(), next);
    appendMemoryAuditEvent({
      target: "profile",
      source: "自动提炼",
      action: "digest",
      hash: hashMemoryContent(next),
    });
    return { updated: true };
  });
}
