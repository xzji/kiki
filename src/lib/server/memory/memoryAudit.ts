import path from "path";

import { getUserMemoryDir } from "@/lib/server/storage/paths";
import {
  readMemoryFile,
  writeMemoryFileAtomic,
} from "@/lib/server/memory/markdownMemoryDocument";

export type MemoryAuditSource = "自动提炼" | "用户手动" | "后台晋升";

export type MemoryAuditEvent = {
  id: string;
  target: "profile" | "session" | "candidate";
  conversationId?: string;
  source: MemoryAuditSource;
  action: "read" | "write" | "clear" | "promote" | "digest";
  createdAt: string;
  hash?: string;
};

function getMemoryAuditFilePath() {
  return path.join(getUserMemoryDir(), "audit.jsonl");
}

export function appendMemoryAuditEvent(event: Omit<MemoryAuditEvent, "id" | "createdAt">) {
  const filePath = getMemoryAuditFilePath();
  const current = readMemoryFile(filePath).content;
  const nextEvent: MemoryAuditEvent = {
    ...event,
    id: `memory-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  writeMemoryFileAtomic(filePath, `${current}${JSON.stringify(nextEvent)}\n`);
  return nextEvent;
}

export function getLatestMemoryAuditSource(input: {
  target: "profile" | "session";
  conversationId?: string;
}): MemoryAuditSource | null {
  const content = readMemoryFile(getMemoryAuditFilePath()).content.trim();
  if (!content) return null;
  const lines = content.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as MemoryAuditEvent;
      if (event.target !== input.target) continue;
      if (input.target === "session" && event.conversationId !== input.conversationId) continue;
      return event.source;
    } catch {
      continue;
    }
  }
  return null;
}
