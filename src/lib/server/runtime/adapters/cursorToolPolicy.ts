import fs from "fs/promises";
import path from "path";

import type { ResolvedToolPolicy } from "@/lib/runtime/toolPolicy";
import type { RuntimePermissionMode, RuntimeToolCapability } from "@/types/runtime";

const CURSOR_CAPABILITY_PATTERNS: Partial<Record<RuntimeToolCapability, string[]>> = {
  fileRead: ["Read(**)", "Grep(**)", "Glob(**)"],
  fileWrite: ["Write(**)", "StrReplace(**)"],
  shell: ["Shell(**)"],
  web: ["WebFetch(**)", "WebSearch(**)"],
};

export const CURSOR_MANAGED_PERMISSION_PATTERNS = Array.from(
  new Set(Object.values(CURSOR_CAPABILITY_PATTERNS).flatMap((patterns) => patterns ?? [])),
);

export function buildCursorPermissionPatterns(enabledCapabilities: RuntimeToolCapability[]) {
  const patterns = new Set<string>();
  for (const capability of enabledCapabilities) {
    for (const pattern of CURSOR_CAPABILITY_PATTERNS[capability] ?? []) {
      patterns.add(pattern);
    }
  }
  return Array.from(patterns).sort();
}

export function stripManagedAllowPatterns(allow: string[]) {
  const managed = new Set(CURSOR_MANAGED_PERMISSION_PATTERNS);
  return allow.filter((pattern) => !managed.has(pattern));
}

export async function writeCursorCliOverlay(input: {
  workingDirectory: string;
  permissionMode: RuntimePermissionMode;
  resolvedToolPolicy: ResolvedToolPolicy;
}) {
  if (input.permissionMode === "readonly") return;

  const allow = buildCursorPermissionPatterns(input.resolvedToolPolicy.enabledCapabilities);
  const cursorDir = path.join(input.workingDirectory, ".cursor");
  const overlayPath = path.join(cursorDir, "cli.json");
  await fs.mkdir(cursorDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(overlayPath, "utf8")) as Record<string, unknown>;
  } catch {
    // no existing overlay
  }
  const existingPermissions = (existing.permissions as { allow?: string[]; deny?: string[] } | undefined) ?? {};
  const preservedAllow = stripManagedAllowPatterns(existingPermissions.allow ?? []);
  const overlay = {
    ...existing,
    permissions: {
      ...existingPermissions,
      allow: Array.from(new Set([...preservedAllow, ...allow])).sort(),
      deny: existingPermissions.deny ?? [],
    },
  };
  await fs.writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
}

/** Map Cursor CLI tool names to KiKi permission rule namespace (Claude-style). */
export function mapCursorToolNameForPermission(toolName: string) {
  const normalized = toolName.trim();
  const lower = normalized.toLowerCase();
  if (lower === "shell") return "Bash";
  if (lower === "strreplace" || lower === "edit") return "Edit";
  if (lower === "write") return "Write";
  if (lower === "read") return "Read";
  if (lower === "grep") return "Grep";
  if (lower === "glob") return "Glob";
  if (lower === "webfetch") return "WebFetch";
  if (lower === "websearch") return "WebSearch";
  return normalized;
}
