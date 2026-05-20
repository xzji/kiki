export const GOAL_EVENT_CURSOR_STORAGE_KEY = "kiki.goal-events.cursor.v1";
export const GOAL_EVENT_CURSOR_CHANNEL = "kiki.goal-events.cursor";

export type GoalEventCursorMap = Record<string, number>;

function sanitizeCursor(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeGoalEventCursors(value: unknown): GoalEventCursorMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([goalId, cursor]) => [goalId, sanitizeCursor(cursor)] as const)
      .filter(([, cursor]) => cursor > 0),
  );
}

export function mergeGoalEventCursors(current: GoalEventCursorMap, incoming: GoalEventCursorMap): GoalEventCursorMap {
  const next = { ...current };
  for (const [goalId, cursor] of Object.entries(incoming)) {
    next[goalId] = Math.max(next[goalId] ?? 0, sanitizeCursor(cursor));
    if (!next[goalId]) delete next[goalId];
  }
  return next;
}

export function readGoalEventCursors(storage: Pick<Storage, "getItem"> | null = getBrowserStorage()) {
  if (!storage) return {};
  try {
    return normalizeGoalEventCursors(JSON.parse(storage.getItem(GOAL_EVENT_CURSOR_STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export function writeGoalEventCursors(
  cursors: GoalEventCursorMap,
  storage: Pick<Storage, "setItem"> | null = getBrowserStorage(),
) {
  if (!storage) return;
  storage.setItem(GOAL_EVENT_CURSOR_STORAGE_KEY, JSON.stringify(normalizeGoalEventCursors(cursors)));
}

export function advanceGoalEventCursor(cursors: GoalEventCursorMap, goalId: string, cursor: number) {
  const nextCursor = sanitizeCursor(cursor);
  if (!goalId || nextCursor <= (cursors[goalId] ?? 0)) return cursors;
  return {
    ...cursors,
    [goalId]: nextCursor,
  };
}

function getBrowserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}
