import fs from "fs";
import path from "path";

import {
  assertPathInsideWorkspace,
  getConversationWorkspaceDir,
} from "@/lib/server/workspace/conversationWorkspace";

export type RecoveredJsonArtifact = {
  label: string;
  path: string;
  relativePath: string;
  value: string;
};

const MAX_ARTIFACT_CANDIDATES = 3;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const ALLOWED_TOP_LEVEL_DIRS = new Set(["tasks", "outputs", "planning"]);

function extractJsonPathCandidates(text: string) {
  const pattern = /\b([A-Za-z0-9_.\-/]+\.json)\b/g;
  const seen = new Set<string>();
  const candidates: string[] = [];
  let match = pattern.exec(text);
  while (match) {
    const value = match[1]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
      if (candidates.length >= MAX_ARTIFACT_CANDIDATES) break;
    }
    match = pattern.exec(text);
  }
  return candidates;
}

function isSafeRelativeJsonPath(relativePath: string) {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  if (relativePath.includes("\0")) return false;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) return false;
  if (!normalized.endsWith(".json")) return false;
  const parts = normalized.split(path.sep);
  if (parts.some((part) => !part || part.startsWith("."))) return false;
  return ALLOWED_TOP_LEVEL_DIRS.has(parts[0]);
}

export function recoverJsonArtifactsFromClaudeOutput(input: {
  conversationId?: string;
  outputText: string;
}): RecoveredJsonArtifact[] {
  if (!input.conversationId || !input.outputText.trim()) return [];
  const workspaceDir = getConversationWorkspaceDir(input.conversationId);
  const candidates = extractJsonPathCandidates(input.outputText);
  const recovered: RecoveredJsonArtifact[] = [];

  for (const candidate of candidates) {
    if (!isSafeRelativeJsonPath(candidate)) continue;
    const normalizedRelativePath = path.normalize(candidate);
    const filePath = path.join(workspaceDir, normalizedRelativePath);
    try {
      assertPathInsideWorkspace({ workspaceDir, targetPath: filePath });
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
      const value = fs.readFileSync(filePath, "utf8");
      if (!value.trim()) continue;
      recovered.push({
        label: `artifact:${normalizedRelativePath}`,
        path: filePath,
        relativePath: normalizedRelativePath,
        value,
      });
    } catch {
      continue;
    }
  }

  return recovered;
}
