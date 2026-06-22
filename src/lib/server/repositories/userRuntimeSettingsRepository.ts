import { getDatabase } from "@/lib/server/db/client";

export type UserRuntimeSettings = {
  maxConcurrentTasks: number;
};

const SETTINGS_KEY = "runtime";
const DEFAULT_USER_RUNTIME_SETTINGS: UserRuntimeSettings = {
  maxConcurrentTasks: 3,
};

type UserRuntimeSettingsRow = {
  value_json: string;
};

export function clampMaxConcurrentTasks(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_USER_RUNTIME_SETTINGS.maxConcurrentTasks;
  }
  return Math.min(Math.max(Math.round(value), 1), 10);
}

function normalizeUserRuntimeSettings(input: Partial<UserRuntimeSettings> | null | undefined): UserRuntimeSettings {
  return {
    maxConcurrentTasks: clampMaxConcurrentTasks(input?.maxConcurrentTasks),
  };
}

function parseSettings(raw: string): Partial<UserRuntimeSettings> {
  try {
    const parsed = JSON.parse(raw) as Partial<UserRuntimeSettings>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readUserRuntimeSettings(): UserRuntimeSettings {
  const row = getDatabase()
    .prepare(`SELECT value_json FROM user_runtime_settings WHERE key = ? LIMIT 1`)
    .get(SETTINGS_KEY) as UserRuntimeSettingsRow | undefined;
  return normalizeUserRuntimeSettings(row ? parseSettings(row.value_json) : null);
}

export function writeUserRuntimeSettings(input: Partial<UserRuntimeSettings>): UserRuntimeSettings {
  const current = readUserRuntimeSettings();
  const next = normalizeUserRuntimeSettings({
    ...current,
    ...input,
  });
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `
        INSERT INTO user_runtime_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
    )
    .run(SETTINGS_KEY, JSON.stringify(next), now);
  return next;
}
