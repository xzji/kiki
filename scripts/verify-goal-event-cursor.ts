import {
  advanceGoalEventCursor,
  GOAL_EVENT_CURSOR_STORAGE_KEY,
  mergeGoalEventCursors,
  normalizeGoalEventCursors,
  readGoalEventCursors,
  writeGoalEventCursors,
} from "../src/lib/goalEventCursor";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const normalized = normalizeGoalEventCursors({
  goalA: 10.9,
  goalB: -1,
  goalC: "bad",
  goalD: 0,
});
assert(normalized.goalA === 10, "cursor normalization should floor positive finite numbers");
assert(!("goalB" in normalized), "cursor normalization should drop negative values");
assert(!("goalC" in normalized), "cursor normalization should drop non-number values");
assert(!("goalD" in normalized), "cursor normalization should drop zero values");

const advanced = advanceGoalEventCursor({ goalA: 10 }, "goalA", 12);
assert(advanced.goalA === 12, "advance should move cursor forward");
assert(advanceGoalEventCursor(advanced, "goalA", 11) === advanced, "advance should ignore stale cursor");

const merged = mergeGoalEventCursors({ goalA: 12, goalB: 5 }, { goalA: 20, goalC: 7 });
assert(merged.goalA === 20, "merge should keep max cursor for same goal");
assert(merged.goalB === 5, "merge should retain existing goals");
assert(merged.goalC === 7, "merge should add new goals");

const storage = new MemoryStorage();
writeGoalEventCursors(merged, storage);
assert(storage.getItem(GOAL_EVENT_CURSOR_STORAGE_KEY) === JSON.stringify(merged), "write should persist normalized cursor map");
const readBack = readGoalEventCursors(storage);
assert(readBack.goalA === 20 && readBack.goalB === 5 && readBack.goalC === 7, "read should restore persisted cursors");

storage.setItem(GOAL_EVENT_CURSOR_STORAGE_KEY, "{bad json");
assert(Object.keys(readGoalEventCursors(storage)).length === 0, "read should tolerate malformed storage");

console.log("Goal event cursor verification passed.");
