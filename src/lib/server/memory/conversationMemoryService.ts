import {
  getConversationSessionMemoryFilePath,
} from "@/lib/server/workspace/conversationWorkspace";
import {
  hashMemoryContent,
  normalizeMemoryLine,
  readMemoryFile,
  truncateMemoryForPrompt,
  writeMemoryFileAtomic,
} from "@/lib/server/memory/markdownMemoryDocument";
import { withMemoryMutex } from "@/lib/server/memory/memoryMutex";
import type { MemoryDigestResult } from "@/lib/server/memory/memoryTypes";
import { redactInternalIdentifiers } from "@/lib/server/workspace/contextPack";
import { appendMemoryAuditEvent } from "@/lib/server/memory/memoryAudit";

const SESSION_MEMORY_PROMPT_LIMIT_BYTES = 4 * 1024;
const SESSION_MEMORY_FILE_LIMIT_BYTES = 6 * 1024;

const SESSION_SECTIONS = [
  ["role", "会话角色"],
  ["goals", "当前目标"],
  ["facts", "已确认事实"],
  ["openItems", "未完成事项"],
  ["decisions", "决策记录"],
] as const;

type SessionSectionKey = (typeof SESSION_SECTIONS)[number][0];

const DEFAULT_SESSION_MEMORY = `# Session Memory

## 会话角色

## 当前目标

## 已确认事实

## 未完成事项

## 决策记录
`;

export function readSessionMemory(conversationId: string) {
  return readMemoryFile(getConversationSessionMemoryFilePath(conversationId));
}

export async function writeSessionMemoryManual(input: {
  conversationId: string;
  content: string;
  expectedHash?: string;
}) {
  return withMemoryMutex(`session:${input.conversationId}`, () => {
    const current = readSessionMemory(input.conversationId);
    if (input.expectedHash && current.hash !== input.expectedHash) {
      return { updated: false, conflict: true as const, currentHash: current.hash };
    }
    const content = redactInternalIdentifiers(input.content.trim());
    if (Buffer.byteLength(content, "utf8") > SESSION_MEMORY_FILE_LIMIT_BYTES) {
      return { updated: false, overLimit: true as const, currentHash: current.hash };
    }
    const next = content ? `${content}\n` : "";
    writeMemoryFileAtomic(getConversationSessionMemoryFilePath(input.conversationId), next);
    const hash = hashMemoryContent(next);
    appendMemoryAuditEvent({
      target: "session",
      conversationId: input.conversationId,
      source: "用户手动",
      action: next.trim() ? "write" : "clear",
      hash,
    });
    return { updated: true, hash };
  });
}

export function readSessionMemoryForPrompt(conversationId: string) {
  const memory = readSessionMemory(conversationId);
  const content = memory.content.trim();
  if (!content || content === DEFAULT_SESSION_MEMORY.trim()) return "";
  return redactInternalIdentifiers(truncateMemoryForPrompt(content, SESSION_MEMORY_PROMPT_LIMIT_BYTES));
}

function parseSectionItems(content: string) {
  const items = new Map<SessionSectionKey, string[]>();
  for (const [key] of SESSION_SECTIONS) items.set(key, []);

  let currentKey: SessionSectionKey | null = null;
  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      currentKey = SESSION_SECTIONS.find(([, title]) => title === heading[1])?.[0] ?? null;
      continue;
    }
    if (!currentKey) continue;
    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (bullet?.[1]) {
      items.get(currentKey)?.push(bullet[1]);
    }
  }
  return items;
}

function buildSessionMemoryDocument(items: Map<SessionSectionKey, string[]>) {
  const lines = ["# Session Memory", ""];
  for (const [key, title] of SESSION_SECTIONS) {
    lines.push(`## ${title}`);
    for (const item of items.get(key) ?? []) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendUnique(target: string[], additions: string[]) {
  const seen = new Set(target.map((item) => normalizeMemoryLine(item).toLowerCase()));
  for (const raw of additions) {
    const normalized = redactInternalIdentifiers(normalizeMemoryLine(raw));
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(normalized);
  }
}

function removeItems(items: Map<SessionSectionKey, string[]>, removals: string[] | undefined) {
  if (!removals?.length) return;
  const removalKeys = new Set(removals.map((item) => normalizeMemoryLine(item).toLowerCase()).filter(Boolean));
  for (const [key] of SESSION_SECTIONS) {
    const values = items.get(key) ?? [];
    items.set(
      key,
      values.filter((value: string) => !removalKeys.has(normalizeMemoryLine(value).toLowerCase())),
    );
  }
}

function enforceSessionLimit(content: string) {
  if (Buffer.byteLength(content, "utf8") <= SESSION_MEMORY_FILE_LIMIT_BYTES) return content;
  return truncateMemoryForPrompt(content, SESSION_MEMORY_FILE_LIMIT_BYTES);
}

export async function applySessionMemoryDigest(input: {
  conversationId: string;
  digest: MemoryDigestResult;
}) {
  if (input.digest.confidence === "low" || !input.digest.sessionPatch) return { updated: false };

  return withMemoryMutex(`session:${input.conversationId}`, () => {
    const current = readSessionMemory(input.conversationId).content || DEFAULT_SESSION_MEMORY;
    const items = parseSectionItems(current);
    const patch = input.digest.sessionPatch;
    if (!patch) return { updated: false };

    appendUnique(items.get("role") ?? [], patch.role ?? []);
    appendUnique(items.get("goals") ?? [], patch.goals ?? []);
    appendUnique(items.get("facts") ?? [], patch.facts ?? []);
    appendUnique(items.get("openItems") ?? [], patch.openItems ?? []);
    appendUnique(items.get("decisions") ?? [], patch.decisions ?? []);
    removeItems(items, patch.remove);

    const next = enforceSessionLimit(buildSessionMemoryDocument(items));
    writeMemoryFileAtomic(getConversationSessionMemoryFilePath(input.conversationId), next);
    appendMemoryAuditEvent({
      target: "session",
      conversationId: input.conversationId,
      source: "自动提炼",
      action: "digest",
      hash: hashMemoryContent(next),
    });
    return { updated: true };
  });
}
