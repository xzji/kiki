import { createHash } from "crypto";
import fs from "fs";
import path from "path";

import type { MemoryReadResult } from "@/lib/server/memory/memoryTypes";

export function hashMemoryContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function readMemoryFile(filePath: string): MemoryReadResult {
  if (!fs.existsSync(filePath)) {
    return { content: "", hash: hashMemoryContent(""), exists: false };
  }
  const content = fs.readFileSync(filePath, "utf8");
  return { content, hash: hashMemoryContent(content), exists: true };
}

export function writeMemoryFileAtomic(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function normalizeMemoryLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateMemoryForPrompt(content: string, maxBytes: number) {
  const normalized = content.trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return `${normalized.slice(0, end).trimEnd()}\n\n...`;
}
