import { constants } from "fs";
import fs from "fs";
import { access, readdir, realpath, rm } from "fs/promises";
import os from "os";
import path from "path";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeClaudeProjectPath(workingDirectory: string) {
  const normalized = path.resolve(workingDirectory).replace(/\\/g, "/");
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureInsideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function collectSessionFileCandidates(projectsRoot: string, sessionId: string, workingDirectory?: string) {
  const fileName = `${sessionId}.jsonl`;
  const candidates = new Set<string>();

  if (workingDirectory?.trim()) {
    candidates.add(path.join(projectsRoot, encodeClaudeProjectPath(workingDirectory.trim()), fileName));
  }

  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.add(path.join(projectsRoot, entry.name, fileName));
      }
    }
  } catch {
    return [];
  }

  return Array.from(candidates);
}

function pathExistsSync(filePath: string) {
  try {
    fs.accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function collectSessionFileCandidatesSync(projectsRoot: string, sessionId: string, workingDirectory?: string) {
  const fileName = `${sessionId}.jsonl`;
  const candidates = new Set<string>();

  if (workingDirectory?.trim()) {
    candidates.add(path.join(projectsRoot, encodeClaudeProjectPath(workingDirectory.trim()), fileName));
  }

  try {
    const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.add(path.join(projectsRoot, entry.name, fileName));
      }
    }
  } catch {
    return [];
  }

  return Array.from(candidates);
}

export async function deleteClaudeSessionFile(input: {
  sessionId: string;
  workingDirectory?: string;
}) {
  const sessionId = input.sessionId.trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("无效的 Claude sessionId");
  }

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!(await pathExists(projectsRoot))) {
    return { deleted: false, deletedCount: 0 };
  }

  const rootRealPath = await realpath(projectsRoot);
  const candidates = await collectSessionFileCandidates(projectsRoot, sessionId, input.workingDirectory);
  let deletedCount = 0;

  for (const candidate of candidates) {
    const parentRealPath = await realpath(path.dirname(candidate)).catch(() => null);
    if (!parentRealPath || !ensureInsideRoot(rootRealPath, candidate)) continue;
    if (!ensureInsideRoot(rootRealPath, parentRealPath)) continue;
    if (!(await pathExists(candidate))) continue;
    await rm(candidate, { force: false });
    deletedCount += 1;
  }

  return { deleted: deletedCount > 0, deletedCount };
}

export function deleteClaudeSessionFileSync(input: {
  sessionId: string;
  workingDirectory?: string;
}) {
  const sessionId = input.sessionId.trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("无效的 Claude sessionId");
  }

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!pathExistsSync(projectsRoot)) {
    return { deleted: false, deletedCount: 0 };
  }

  const rootRealPath = fs.realpathSync(projectsRoot);
  const candidates = collectSessionFileCandidatesSync(projectsRoot, sessionId, input.workingDirectory);
  let deletedCount = 0;

  for (const candidate of candidates) {
    let parentRealPath: string | null = null;
    try {
      parentRealPath = fs.realpathSync(path.dirname(candidate));
    } catch {
      parentRealPath = null;
    }
    if (!parentRealPath || !ensureInsideRoot(rootRealPath, candidate)) continue;
    if (!ensureInsideRoot(rootRealPath, parentRealPath)) continue;
    if (!pathExistsSync(candidate)) continue;
    fs.rmSync(candidate, { force: false });
    deletedCount += 1;
  }

  return { deleted: deletedCount > 0, deletedCount };
}
