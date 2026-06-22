import { SUPPORTED_RUNTIME_KINDS, type LocalRuntimeKind } from "@/types/runtime";
import { codexAdapter } from "@/lib/server/runtime/adapters/codexAdapter";
import { claudeAdapter } from "@/lib/server/runtime/adapters/claudeAdapter";
import { cursorAdapter } from "@/lib/server/runtime/adapters/cursorAdapter";
import { piAdapter } from "@/lib/server/runtime/adapters/piAdapter";
import type { RuntimeAdapter } from "@/lib/server/runtime/adapters/types";

const adapters: Partial<Record<LocalRuntimeKind, RuntimeAdapter>> = {
  claude: claudeAdapter,
  pi: piAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
};

export function getRuntimeAdapter(kind: LocalRuntimeKind = "claude"): RuntimeAdapter {
  const adapter = adapters[kind || "claude"];
  if (!adapter) {
    throw new Error(`暂不支持的 Agent Runtime：${kind}`);
  }
  return adapter;
}

export function listRuntimeAdapters(): RuntimeAdapter[] {
  return SUPPORTED_RUNTIME_KINDS.map((kind) => getRuntimeAdapter(kind));
}

export function isRuntimeSupported(kind?: LocalRuntimeKind): boolean {
  return Boolean(adapters[kind || "claude"]);
}

export function getRegisteredRuntimeKinds(): LocalRuntimeKind[] {
  return Object.keys(adapters).filter((kind): kind is LocalRuntimeKind => Boolean(adapters[kind as LocalRuntimeKind]));
}
